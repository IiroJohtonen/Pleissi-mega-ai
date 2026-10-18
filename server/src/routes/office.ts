import express, { type Router } from "express";
import { z } from "zod";
import { canSeeTicket, isQueueHandler, RESTRICTED_SUBJECT, unidentifiedQueueSettings, visibleCompanyIds } from "../access.js";
import { isAdmin, requireAdmin, requireManager, USER_ROLES } from "../auth.js";
import { aiUsageSummary, refreshBudgetAlerts } from "../ai-budget.js";
import { aiRequestPayload } from "../ai-log.js";
import { listAlerts, markAlertResolved } from "../alerts.js";
import { db } from "../db.js";
import { id, now } from "../util.js";
import { AI_MODEL_CHOICES, getMasterData, MASTER_DATA_DEFAULTS, masterDataSchema, saveMasterData } from "../master-data.js";
import { loginCodeMailReady, loginCodeSetting } from "../login-codes.js";

export const officeRouter: Router = express.Router();

// Isännöitsijätoimiston omat tiedot. Lukea saa jokainen käyttäjä, muuttaa vain pääkäyttäjä.
const OFFICE_SELECT = `
  SELECT name, business_id AS businessId, address, phone,
         reminder_emails AS reminderEmails, retention_months AS retentionMonths, ai_priority AS aiPriority,
         ai_relevance AS aiRelevance, reply_reminder_days AS replyReminderDays, due_reminder_days AS dueReminderDays,
         ai_monthly_limit AS aiMonthlyLimit, ai_warning_percent AS aiWarningPercent, two_factor AS twoFactor,
         resident_status_updates AS residentStatusUpdates
  FROM office_settings WHERE id = 1
`;

// aiAvailable kertoo, onko palvelimelle asetettu AI-avain; ilman sitä AI-asetukset eivät vaikuta.
// twoFactorOverridden: palvelimen ympäristömuuttuja on kytkenyt kirjautumiskoodin pois asetuksesta huolimatta.
function officeSettings() {
  const queue = unidentifiedQueueSettings();
  return {
    ...(db.prepare(OFFICE_SELECT).get() as Record<string, unknown>),
    // Taloyhtiö tunnistamatta -jonon käsittelijät ja se, kuuluuko pyynnön tekijä heihin.
    unidentifiedQueueRoles: queue.roles,
    unidentifiedQueueUsers: queue.users,
    canHandleUnidentified: isQueueHandler(),
    aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY),
    twoFactorOverridden: process.env.TWO_FACTOR_DISABLED === "1"
  };
}

// Arvioiko AI saapuvan tehtävän prioriteetin. Oletuksena pois, kunnes pääkäyttäjä kytkee sen päälle.
export function aiPriorityEnabled(): boolean {
  const row = db.prepare("SELECT ai_priority FROM office_settings WHERE id = 1").get() as { ai_priority: number } | undefined;
  return Boolean(row?.ai_priority);
}

// Tarkistaako AI, koskeeko saapuva sähköposti taloyhtiön asioita. Oletuksena pois.
export function aiRelevanceEnabled(): boolean {
  const row = db.prepare("SELECT ai_relevance FROM office_settings WHERE id = 1").get() as { ai_relevance: number } | undefined;
  return Boolean(row?.ai_relevance);
}

officeRouter.get("/office", (_req, res) => {
  res.json(officeSettings());
});

officeRouter.put("/office", requireAdmin, (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(120),
    businessId: z.string().trim().max(30).default(""),
    address: z.string().trim().max(200).default(""),
    phone: z.string().trim().max(40).default(""),
    // Muistutukset ja säilytysaika päivitetään vain, kun ne ovat pyynnössä mukana.
    reminderEmails: z.boolean().optional(),
    retentionMonths: z.number().int().min(0).max(240).optional(),
    aiPriority: z.boolean().optional(),
    aiRelevance: z.boolean().optional(),
    replyReminderDays: z.number().int().min(1).max(30).optional(),
    dueReminderDays: z.number().int().min(0).max(30).optional(),
    // AI-kulujen kuukausiraja dollareina (0 = ei rajaa) ja varoitusraja prosentteina.
    aiMonthlyLimit: z.number().min(0).max(100000).optional(),
    aiWarningPercent: z.number().int().min(0).max(100).optional(),
    unidentifiedQueueRoles: z.array(z.enum(USER_ROLES)).max(10).optional(),
    unidentifiedQueueUsers: z.array(z.string().min(1)).max(500).optional(),
    // Kirjautumiskoodi sähköpostiin henkilökunnalle.
    twoFactor: z.boolean().optional(),
    // Asukas saa sähköpostin, kun hänen tehtävänsä tila muuttuu.
    residentStatusUpdates: z.boolean().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista toimiston nimi ja tiedot." });
  if (parsed.data.twoFactor && !loginCodeSetting() && !loginCodeMailReady()) {
    return res.status(400).json({ error: "Yhdistä ensin toimiston sähköpostitili. Kirjautumiskoodit lähetetään sen kautta." });
  }
  db.prepare("UPDATE office_settings SET name = ?, business_id = ?, address = ?, phone = ? WHERE id = 1")
    .run(parsed.data.name, parsed.data.businessId, parsed.data.address, parsed.data.phone);
  if (parsed.data.reminderEmails !== undefined) {
    db.prepare("UPDATE office_settings SET reminder_emails = ? WHERE id = 1").run(parsed.data.reminderEmails ? 1 : 0);
  }
  if (parsed.data.retentionMonths !== undefined) {
    db.prepare("UPDATE office_settings SET retention_months = ? WHERE id = 1").run(parsed.data.retentionMonths);
  }
  if (parsed.data.aiPriority !== undefined) {
    db.prepare("UPDATE office_settings SET ai_priority = ? WHERE id = 1").run(parsed.data.aiPriority ? 1 : 0);
  }
  if (parsed.data.replyReminderDays !== undefined) {
    db.prepare("UPDATE office_settings SET reply_reminder_days = ? WHERE id = 1").run(parsed.data.replyReminderDays);
  }
  if (parsed.data.dueReminderDays !== undefined) {
    db.prepare("UPDATE office_settings SET due_reminder_days = ? WHERE id = 1").run(parsed.data.dueReminderDays);
  }
  if (parsed.data.unidentifiedQueueRoles !== undefined) {
    db.prepare("UPDATE office_settings SET unidentified_queue_roles = ? WHERE id = 1").run(JSON.stringify(parsed.data.unidentifiedQueueRoles));
  }
  if (parsed.data.unidentifiedQueueUsers !== undefined) {
    const known = new Set((db.prepare("SELECT id FROM users").all() as { id: string }[]).map(user => user.id));
    db.prepare("UPDATE office_settings SET unidentified_queue_users = ? WHERE id = 1")
      .run(JSON.stringify(parsed.data.unidentifiedQueueUsers.filter(userId => known.has(userId))));
  }
  if (parsed.data.aiRelevance !== undefined) {
    db.prepare("UPDATE office_settings SET ai_relevance = ? WHERE id = 1").run(parsed.data.aiRelevance ? 1 : 0);
  }
  if (parsed.data.aiMonthlyLimit !== undefined) {
    db.prepare("UPDATE office_settings SET ai_monthly_limit = ? WHERE id = 1").run(Math.round(parsed.data.aiMonthlyLimit * 100) / 100);
  }
  if (parsed.data.aiWarningPercent !== undefined) {
    db.prepare("UPDATE office_settings SET ai_warning_percent = ? WHERE id = 1").run(parsed.data.aiWarningPercent);
  }
  if (parsed.data.twoFactor !== undefined) {
    db.prepare("UPDATE office_settings SET two_factor = ? WHERE id = 1").run(parsed.data.twoFactor ? 1 : 0);
  }
  if (parsed.data.residentStatusUpdates !== undefined) {
    db.prepare("UPDATE office_settings SET resident_status_updates = ? WHERE id = 1").run(parsed.data.residentStatusUpdates ? 1 : 0);
  }
  refreshBudgetAlerts();
  res.json(officeSettings());
});

// Koko alustan loki: kaikkien hallinnoitavien yhtiöiden tehtävien tapahtumat uusimmasta alkaen.
// Lähetetyn sähköpostin sisältö haetaan samalla hetkellä tallennetusta lähteneestä viestistä.
// Loki näkyy isännöitsijälle omien yhtiöidensä osalta. Tehtävään liittymättömät merkinnät
// (käyttäjän tai asukkaan poisto, säilytysajan poistot) näkyvät vain pääkäyttäjälle.
officeRouter.get("/audit", requireManager, (_req, res) => {
  const companyIds = visibleCompanyIds();
  const rows = db.prepare(`
    SELECT a.id, a.ticket_id, a.actor, a.action, a.details, a.created_at,
           t.ticket_number, t.subject AS ticket_subject, c.name AS company_name, t.company_id, t.sensitive, t.assignee_id, t.company_pending,
           (SELECT m.body FROM messages m
            WHERE a.action = 'reply_sent' AND m.ticket_id = a.ticket_id
              AND m.direction = 'outbound' AND m.created_at = a.created_at
            LIMIT 1) AS email_body
    FROM audit_log a
    LEFT JOIN tickets t ON t.id = a.ticket_id
    LEFT JOIN companies c ON c.id = t.company_id
    WHERE t.company_id IN (${companyIds.map(() => "?").join(", ")})
       OR (a.ticket_id IS NULL AND ?)
    ORDER BY a.created_at DESC
    LIMIT 2000
  `).all(...companyIds, isAdmin(res) ? 1 : 0) as ({
    company_id: string | null; sensitive: number | null; assignee_id: string | null; company_pending: number | null;
  } & Record<string, unknown>)[];
  // Arkaluonteisen tehtävän sisältö ei näy lokissa käyttäjälle, jolta tehtävä on rajattu.
  res.json(rows.map(({ company_id, sensitive, assignee_id, company_pending, ...row }) =>
    company_id && !canSeeTicket({ company_id, sensitive, assignee_id, company_pending })
      ? { ...row, ticket_subject: RESTRICTED_SUBJECT, email_body: null, details: "{}" }
      : row));
});

// AI:lle lähetetty sisältö lokimerkinnästä. Tehtävään liittyvän näkee se, joka näkee tehtävän;
// muut (esim. dokumenttien pilkonta) vain pääkäyttäjä.
officeRouter.get("/audit/:id/ai-request", requireManager, (req, res) => {
  const request = aiRequestPayload(req.params.id);
  if (!request) return res.status(404).json({ error: "AI-pyynnön sisältöä ei löytynyt." });
  if (request.ticket_id) {
    const ticket = db.prepare("SELECT company_id, sensitive, assignee_id, company_pending FROM tickets WHERE id = ?").get(request.ticket_id) as
      Parameters<typeof canSeeTicket>[0] | undefined;
    if (!ticket || !visibleCompanyIds().includes(ticket.company_id) || !canSeeTicket(ticket)) {
      return res.status(404).json({ error: "AI-pyynnön sisältöä ei löytynyt." });
    }
  } else if (!isAdmin(res)) {
    return res.status(404).json({ error: "AI-pyynnön sisältöä ei löytynyt." });
  }
  res.json(request);
});

// AI:n käyttö ja kustannusarvio tältä kuulta sekä kuuden edellisen kuukauden historia.
officeRouter.get("/office/ai-usage", requireAdmin, (_req, res) => {
  res.json(aiUsageSummary());
});

// Järjestelmähälytykset (palvelimen virheet, postiyhteydet, varmuuskopiot, AI-kulut) pääkäyttäjälle.
officeRouter.get("/system/alerts", requireAdmin, (_req, res) => {
  res.json(listAlerts());
});

officeRouter.post("/system/alerts/:id/resolve", requireAdmin, (req, res) => {
  if (!markAlertResolved(String(req.params.id))) return res.status(404).json({ error: "Hälytystä ei löytynyt tai se on jo kuitattu." });
  res.json({ ok: true });
});

// Perustiedot: hätä- ja arkaluonteisuussanat, maskaus, määräajat ja AI-mallit. Vain pääkäyttäjälle.
officeRouter.get("/master-data", requireAdmin, (_req, res) => {
  res.json({ values: getMasterData(), defaults: MASTER_DATA_DEFAULTS, modelChoices: AI_MODEL_CHOICES });
});

officeRouter.put("/master-data", requireAdmin, (req, res) => {
  const parsed = masterDataSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista perustiedot." });
  saveMasterData(parsed.data);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), null, res.locals.user?.name ?? "Pääkäyttäjä", "master_data_updated",
    JSON.stringify({ fields: Object.keys(parsed.data) }), now()
  );
  res.json(getMasterData());
});
