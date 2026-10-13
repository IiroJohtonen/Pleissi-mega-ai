import express, { type Router } from "express";
import { z } from "zod";
import { visibleCompanyIds } from "../access.js";
import { isAdmin, requireAdmin, requireManager } from "../auth.js";
import { db } from "../db.js";

export const officeRouter: Router = express.Router();

// Isännöitsijätoimiston omat tiedot. Lukea saa jokainen käyttäjä, muuttaa vain pääkäyttäjä.
const OFFICE_SELECT = `
  SELECT name, business_id AS businessId, address, phone,
         reminder_emails AS reminderEmails, retention_months AS retentionMonths, ai_priority AS aiPriority
  FROM office_settings WHERE id = 1
`;

// aiAvailable kertoo, onko palvelimelle asetettu AI-avain; ilman sitä AI-asetukset eivät vaikuta.
function officeSettings() {
  return { ...(db.prepare(OFFICE_SELECT).get() as Record<string, unknown>), aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY) };
}

// Arvioiko AI saapuvan tehtävän prioriteetin. Oletuksena pois, kunnes pääkäyttäjä kytkee sen päälle.
export function aiPriorityEnabled(): boolean {
  const row = db.prepare("SELECT ai_priority FROM office_settings WHERE id = 1").get() as { ai_priority: number } | undefined;
  return Boolean(row?.ai_priority);
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
    aiPriority: z.boolean().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista toimiston nimi ja tiedot." });
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
           t.ticket_number, t.subject AS ticket_subject, c.name AS company_name,
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
  `).all(...companyIds, isAdmin(res) ? 1 : 0);
  res.json(rows);
});
