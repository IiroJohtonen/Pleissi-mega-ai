import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { attachmentsDir, db, knowledgeFilesDir, seed } from "./db.js";
import {
  aiAvailable,
  analyzeRecurringTopics,
  answerFromKnowledge,
  suggestReply,
  triage,
  type KnowledgeItem,
  type RecurringTopic,
  type TopicTicket
} from "./ai.js";
import {
  ADMIN_ROLE, authRouter, consumePasswordReset, createPasswordResets, isAdmin, MANAGER_ROLES, requireAdmin, requireAuth,
  requireManager, setResidentPassword, type ResidentAccount, type User
} from "./auth.js";
import { extractText, UnsupportedDocumentError } from "./extract.js";
import {
  connectGmailAccount, disconnectGmailAccount, getGmailStatus, gmailAccountFor, gmailAuthUrl, OFFICE_ACCOUNT,
  parseSender, sendGmailReply, startGmailPolling, type OutgoingAttachment
} from "./gmail.js";

seed();

const app = express();
app.use(cors());
// Raja kattaa vastauksen liitteet, jotka kulkevat pyynnössä base64-muodossa.
app.use(express.json({ limit: "30mb" }));
app.use("/api", requireAuth);

// Kirjautunut henkilökunnan käyttäjä pyynnön ajan, jotta yhtiörajaus toimii kaikissa tarkistuksissa.
// Asukkaan ja palvelimen omissa kutsuissa käyttäjää ei ole.
const requestUser = new AsyncLocalStorage<User | undefined>();
app.use("/api", (_req, res, next) => requestUser.run(res.locals.user as User | undefined, next));

app.use("/api", authRouter);

const PORT = Number(process.env.PORT || 4000);
const DEFAULT_COMPANY_ID = process.env.DEFAULT_COMPANY_ID || "demo-company";
const AUTHORIZED_COMPANY_IDS = new Set(
  (process.env.AUTHORIZED_COMPANY_IDS || DEFAULT_COMPANY_ID)
    .split(",")
    .map(companyId => companyId.trim())
    .filter(Boolean)
);

for (const company of db.prepare("SELECT id FROM companies WHERE managed = 1").all() as { id: string }[]) {
  AUTHORIZED_COMPANY_IDS.add(company.id);
}

// Yhtiöt, jotka pyynnön tekijä näkee. Isännöitsijä näkee yhtiöt, joissa hän on vastuuisännöitsijä tai
// muu isännöitsijä, sekä yhtiöt, joilla ei ole vastuuisännöitsijää. Pääkäyttäjä ja asiakaspalvelu
// näkevät kaikki.
function visibleCompanyIds(): string[] {
  const companyIds = [...AUTHORIZED_COMPANY_IDS];
  const user = requestUser.getStore();
  if (!user || user.role !== "Isännöitsijä") return companyIds;
  const own = new Set((db.prepare(`
    SELECT id FROM companies
    WHERE manager_id IS NULL OR manager_id = ?
       OR id IN (SELECT company_id FROM company_managers WHERE user_id = ?)
  `).all(user.id, user.id) as { id: string }[]).map(company => company.id));
  return companyIds.filter(companyId => own.has(companyId));
}

function companyIdFromContext(requestedCompanyId?: unknown) {
  const companyId = typeof requestedCompanyId === "string" && requestedCompanyId
    ? requestedCompanyId
    : DEFAULT_COMPANY_ID;
  return visibleCompanyIds().includes(companyId) ? companyId : null;
}

const inboundSchema = z.object({
  companyId: z.string(),
  channel: z.enum(["email", "portal", "quick_note"]).default("email"),
  senderName: z.string().default("Tuntematon"),
  senderEmail: z.string().optional(),
  subject: z.string().default("Uusi yhteydenotto"),
  body: z.string().min(1),
  sourceMessageId: z.string().optional(),
  // Saman sähköpostiketjun aiempien viestien tunnisteet; niiden avulla vastaus löytää tehtävänsä.
  threadMessageIds: z.array(z.string()).max(200).optional(),
  recipientEmails: z.array(z.string()).optional()
});

// Saapuva sähköposti ohjataan yhtiölle, jonka vastaanotto-osoitteeseen se on lähetetty.
function companyIdForRecipients(recipientEmails: string[] = []) {
  const recipients = new Set(recipientEmails.map(email => email.trim().toLowerCase()));
  if (recipients.size === 0) return null;
  const companies = db.prepare("SELECT id, email_address FROM companies").all() as
    { id: string; email_address: string }[];
  const match = companies.find(company =>
    AUTHORIZED_COMPANY_IDS.has(company.id)
    && recipients.has(company.email_address.trim().toLowerCase())
  );
  return match?.id ?? null;
}


function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

// 1, kun tehtävän viimeisin viesti on asukkaalta ja keskustelussa on jo aiempia viestejä,
// eli asukas on vastannut eikä hänelle ole vielä vastattu.
const NEW_REPLY_SQL = `(
  (SELECT COUNT(*) FROM messages m WHERE m.ticket_id = t.id) > 1
  AND (SELECT m.direction FROM messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) = 'inbound'
)`;

// 1, kun tehtävälle on pyydetty AI-ehdotus; vasta silloin näytetään ehdotettu dokumentti.
const AI_SUGGESTED_SQL = `EXISTS(
  SELECT 1 FROM audit_log al WHERE al.ticket_id = t.id AND al.action = 'ai_suggested'
)`;

// Ehto asukkaalle, joka asuu yhtiössä tänään (ei ole muuttanut pois).
const ACTIVE_RESIDENT = "(r.moved_out_at IS NULL OR r.moved_out_at > date('now', 'localtime'))";

// Vanhat "Osoitettu minulle" -tehtävät saavat käsittelijän lokin perusteella; jos tekijää ei
// tunnisteta, tehtävä osoitetaan pääkäyttäjälle, jotta se ei katoa kenenkään Omista tehtävistä.
{
  const unassigned = db.prepare("SELECT id FROM tickets WHERE assignee_id IS NULL AND status = 'waiting_manager'").all() as { id: string }[];
  const admin = db.prepare("SELECT id FROM users WHERE role = ? ORDER BY created_at LIMIT 1").get(ADMIN_ROLE) as { id: string } | undefined;
  const byActor = db.prepare(`
    SELECT u.id FROM audit_log l JOIN users u ON u.name = l.actor
    WHERE l.ticket_id = ? AND l.action IN ('decision_human', 'ticket_created_manual')
    ORDER BY l.created_at DESC LIMIT 1
  `);
  for (const ticket of unassigned) {
    const assignee = (byActor.get(ticket.id) as { id: string } | undefined) ?? admin;
    if (assignee) db.prepare("UPDATE tickets SET assignee_id = ? WHERE id = ?").run(assignee.id, ticket.id);
  }
}

// Uusi saapunut tehtävä osoitetaan taloyhtiön vastuuisännöitsijälle. Tila ei muutu, joten
// tehtävä näkyy edelleen päätösjonossa.
function assignToCompanyManager(ticketId: string, companyId: string) {
  db.prepare("UPDATE tickets SET assignee_id = (SELECT manager_id FROM companies WHERE id = ?) WHERE id = ?")
    .run(companyId, ticketId);
}

// Huoltoyhtiölle lähetetyt viestit erotetaan asukkaalle lähetetyistä kanavalla 'contractor', jotta
// niitä ei näytetä asukkaalle portaalissa. Ennen tätä muutosta lähetetyt tunnistetaan otsikosta.
db.prepare(`
  UPDATE messages SET channel = 'contractor'
  WHERE direction = 'outbound' AND channel = 'email' AND (subject LIKE 'Työtilaus:%' OR subject LIKE 'Re: Työtilaus:%')
`).run();

// Ilmoitus asukkaalle sähköpostilla. Lähetys tehdään taustalla: epäonnistuminen kirjataan lokiin,
// mutta ei kaada varsinaista toimintoa. Asukkaalle ilman kelvollista osoitetta ei lähetetä mitään.
async function notifyResident(residentId: string, subject: string, lines: string[]) {
  const resident = db.prepare(`
    SELECT r.name, r.email, r.company_id, c.name AS company FROM residents r JOIN companies c ON c.id = r.company_id WHERE r.id = ?
  `).get(residentId) as { name: string; email: string | null; company: string; company_id: string } | undefined;
  const email = (resident?.email ?? "").trim();
  if (!resident || !/^[^\s<>,;@]+@[^\s<>,;@]+$/.test(email)) return;
  const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string };
  try {
    await sendGmailReply({
      to: email,
      companyId: resident.company_id,
      subject: `${subject} (${resident.company})`,
      body: [`Hei ${resident.name},`, "", ...lines, "", "Ystävällisin terveisin", office.name].join("\n")
    });
  } catch (error: any) {
    console.error("Ilmoituksen lähetys asukkaalle epäonnistui:", error?.message ?? error);
  }
}

function getAuthorizedTicket(ticketId: string) {
  const companyIds = visibleCompanyIds();
  const placeholders = companyIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT *
    FROM tickets
    WHERE id = ? AND company_id IN (${placeholders})
  `).get(ticketId, ...companyIds);
}

function today() {
  return new Date().toLocaleDateString("sv-SE");
}

// AI:n käytössä ovat vain yhtiön omat, voimassa olevat tietueet, joiden teksti on saatu luettua.
function getKnowledge(companyId: string) {
  const date = today();
  return db.prepare(`
    SELECT id, title, content, kind, tags
    FROM knowledge
    WHERE company_id = ?
      AND status = 'active'
      AND extraction_ok = 1
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_until IS NULL OR valid_until >= ?)
  `).all(companyId, date, date) as KnowledgeItem[];
}

type KnowledgeRow = {
  id: string;
  company_id: string;
  title: string;
  content: string;
  kind: string;
  valid_from: string | null;
  valid_until: string | null;
  file_name: string | null;
  mime_type: string | null;
  version: number;
  group_id: string;
  status: string;
  extraction_ok: number;
  created_at: string;
};

function knowledgeState(row: KnowledgeRow) {
  const date = today();
  if (row.status !== "active") return row.status;
  if (!row.extraction_ok) return "unreadable";
  if (row.valid_until && row.valid_until < date) return "expired";
  if (row.valid_from && row.valid_from > date) return "upcoming";
  return "in_use";
}

function serializeKnowledge(row: KnowledgeRow) {
  return {
    ...row,
    content: row.kind === "document" ? row.content.slice(0, 600) : row.content,
    content_length: row.content.length,
    state: knowledgeState(row)
  };
}

function getAuthorizedKnowledge(knowledgeId: string) {
  const row = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(knowledgeId) as KnowledgeRow | undefined;
  return row && companyIdFromContext(row.company_id) ? row : null;
}

const validityDate = z.string().trim()
  .pipe(z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]))
  .default("");

// Tallentaa uuden tietueen. Jos se korvaa aiemman, vanha versio jää historiaan.
function saveKnowledge(input: {
  companyId: string;
  kind: "fact" | "document";
  title: string;
  content: string;
  validFrom: string;
  validUntil: string;
  replaces?: string;
  fileName?: string;
  mimeType?: string;
  extractionOk?: boolean;
  tags?: string[];
}) {
  const replaced = input.replaces
    ? db.prepare(
        "SELECT * FROM knowledge WHERE id = ? AND company_id = ? AND status = 'active'"
      ).get(input.replaces, input.companyId) as KnowledgeRow | undefined
    : undefined;
  if (input.replaces && !replaced) return null;

  const knowledgeId = id("knowledge");
  db.transaction(() => {
    if (replaced) {
      db.prepare("UPDATE knowledge SET status = 'replaced' WHERE id = ?").run(replaced.id);
    }
    db.prepare(`
      INSERT INTO knowledge
      (id, company_id, title, content, kind, valid_from, valid_until, file_name, mime_type,
       version, group_id, status, extraction_ok, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      knowledgeId,
      input.companyId,
      input.title,
      input.content,
      input.kind,
      input.validFrom || null,
      input.validUntil || null,
      input.fileName ?? null,
      input.mimeType ?? null,
      replaced ? replaced.version + 1 : 1,
      replaced ? replaced.group_id : knowledgeId,
      input.extractionOk === false ? 0 : 1,
      now()
    );
    // Uusi versio perii aiemman version avainsanat, ellei uusia anneta.
    const tags = input.tags ? input.tags.join(", ") : replaced ? (replaced as KnowledgeRow & { tags?: string }).tags ?? "" : "";
    if (tags) db.prepare("UPDATE knowledge SET tags = ? WHERE id = ?").run(tags, knowledgeId);
  })();

  return knowledgeId;
}

function findResident(companyId: string, senderEmail?: string, senderName?: string) {
  if (senderEmail) {
    const r = db.prepare(`
      SELECT r.*, a.apartment_number
      FROM residents r
      JOIN apartments a ON a.id = r.apartment_id
      WHERE r.company_id = ? AND lower(r.email) = lower(?)
    `).get(companyId, senderEmail);
    if (r) return r as any;
  }

  if (senderName) {
    const r = db.prepare(`
      SELECT r.*, a.apartment_number
      FROM residents r
      JOIN apartments a ON a.id = r.apartment_id
      WHERE r.company_id = ? AND lower(r.name) = lower(?)
    `).get(companyId, senderName);
    if (r) return r as any;
  }

  return null;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "kiito-api" });
});

app.get("/api/companies", (_req, res) => {
  const companyIds = visibleCompanyIds();
  const placeholders = companyIds.map(() => "?").join(", ");
  const companies = db.prepare(`
    SELECT id, name, email_address, business_id, address, phone,
      maintenance_name, maintenance_phone, maintenance_email, maintenance_emergency_phone,
      manager_id, (SELECT u.name FROM users u WHERE u.id = companies.manager_id) AS manager_name,
      (SELECT group_concat(cm.user_id) FROM company_managers cm WHERE cm.company_id = companies.id) AS manager_ids_csv,
      (SELECT COUNT(*) FROM residents r WHERE r.company_id = companies.id) AS resident_count
    FROM companies
    WHERE id IN (${placeholders})
    ORDER BY name
  `).all(...companyIds) as ({ manager_ids_csv: string | null } & Record<string, unknown>)[];
  // manager_ids = taloyhtiön muut isännöitsijät (ilman vastuuisännöitsijää).
  res.json(companies.map(({ manager_ids_csv, ...company }) => ({
    ...company,
    manager_ids: manager_ids_csv ? manager_ids_csv.split(",") : []
  })));
});

const companySchema = z.object({
  name: z.string().trim().min(1),
  emailAddress: z.string().trim().pipe(z.union([z.literal(""), z.email()])).default(""),
  businessId: z.string().trim().default(""),
  address: z.string().trim().default(""),
  phone: z.string().trim().default(""),
  // Vastuuisännöitsijä: käyttäjän tunniste, null = ei valittu. Puuttuessaan kenttää ei muuteta.
  managerId: z.string().nullable().optional(),
  // Taloyhtiön muut isännöitsijät. Puuttuessaan listaa ei muuteta.
  managerIds: z.array(z.string()).max(50).optional(),
  // Huoltoyhtiön tiedot päivitetään vain, kun ne ovat pyynnössä mukana.
  maintenance: z.object({
    name: z.string().trim().default(""),
    phone: z.string().trim().default(""),
    email: z.string().trim().pipe(z.union([z.literal(""), z.email()])).default(""),
    emergencyPhone: z.string().trim().default("")
  }).optional()
});

function companyEmailInUse(emailAddress: string, exceptCompanyId = "") {
  if (!emailAddress) return false;
  return Boolean(db.prepare(
    "SELECT id FROM companies WHERE id != ? AND lower(email_address) = lower(?)"
  ).get(exceptCompanyId, emailAddress));
}

app.post("/api/companies", requireManager, (req, res) => {
  const parsed = companySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Tarkista taloyhtiön nimi ja sähköpostiosoite." });
  }
  if (companyEmailInUse(parsed.data.emailAddress)) {
    return res.status(409).json({ error: "Sähköpostiosoite on jo toisen yhtiön käytössä." });
  }

  const companyId = id("company");
  db.prepare(`
    INSERT INTO companies (id, name, email_address, business_id, address, phone, managed)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(
    companyId,
    parsed.data.name,
    parsed.data.emailAddress,
    parsed.data.businessId,
    parsed.data.address,
    parsed.data.phone
  );
  AUTHORIZED_COMPANY_IDS.add(companyId);

  res.status(201).json({ ok: true, companyId });
});

app.put("/api/companies/:companyId", requireManager, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = companySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Tarkista nimi ja sähköpostiosoitteet." });
  }

  if (companyEmailInUse(parsed.data.emailAddress, companyId)) {
    return res.status(409).json({ error: "Sähköpostiosoite on jo toisen yhtiön käytössä." });
  }

  // Vastuuisännöitsijäksi kelpaa isännöitsijä tai pääkäyttäjä.
  const managerId = parsed.data.managerId === undefined ? undefined : parsed.data.managerId || null;
  if (managerId) {
    const manager = db.prepare("SELECT role FROM users WHERE id = ?").get(managerId) as { role: string } | undefined;
    if (!manager || !MANAGER_ROLES.includes(manager.role)) {
      return res.status(400).json({ error: "Vastuuisännöitsijän pitää olla isännöitsijä-käyttäjä." });
    }
  }

  const result = db.prepare(`
    UPDATE companies
    SET name = ?, email_address = ?, business_id = ?, address = ?, phone = ?
    WHERE id = ?
  `).run(
    parsed.data.name,
    parsed.data.emailAddress,
    parsed.data.businessId,
    parsed.data.address,
    parsed.data.phone,
    companyId
  );
  if (result.changes === 0) return res.status(404).json({ error: "Company not found" });
  if (parsed.data.managerIds !== undefined) {
    const responsible = managerId !== undefined
      ? managerId
      : (db.prepare("SELECT manager_id FROM companies WHERE id = ?").get(companyId) as { manager_id: string | null }).manager_id;
    // Vastuuisännöitsijää ei tallenneta toiseen kertaan muiden joukkoon.
    const others = [...new Set(parsed.data.managerIds)].filter(userId => userId !== responsible);
    for (const userId of others) {
      const user = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined;
      if (!user || !MANAGER_ROLES.includes(user.role)) {
        return res.status(400).json({ error: "Taloyhtiön isännöitsijäksi voi valita vain isännöitsijä-käyttäjän." });
      }
    }
    db.transaction(() => {
      db.prepare("DELETE FROM company_managers WHERE company_id = ?").run(companyId);
      for (const userId of others) db.prepare("INSERT INTO company_managers (company_id, user_id) VALUES (?, ?)").run(companyId, userId);
    })();
  }
  if (managerId !== undefined) {
    db.prepare("DELETE FROM company_managers WHERE company_id = ? AND user_id = ?").run(companyId, managerId ?? "");
    db.prepare("UPDATE companies SET manager_id = ? WHERE id = ?").run(managerId, companyId);
    // Jonossa jo odottavat tehtävät, joilla ei ole käsittelijää, siirtyvät uudelle vastuuisännöitsijälle.
    if (managerId) {
      db.prepare("UPDATE tickets SET assignee_id = ? WHERE company_id = ? AND status = 'open' AND assignee_id IS NULL")
        .run(managerId, companyId);
    }
  }

  const maintenance = parsed.data.maintenance;
  if (maintenance) {
    db.prepare(`
      UPDATE companies
      SET maintenance_name = ?, maintenance_phone = ?, maintenance_email = ?,
          maintenance_emergency_phone = ?
      WHERE id = ?
    `).run(
      maintenance.name,
      maintenance.phone,
      maintenance.email,
      maintenance.emergencyPhone,
      companyId
    );
  }

  res.json({ ok: true });
});

app.get("/api/gmail/status", async (_req, res) => {
  // Ilman taloyhtiötä palautetaan toimiston tili. Taloyhtiölle palautetaan sen käyttämä tili ja tieto,
  // onko se taloyhtiön oma (own) vai toimiston yhteinen.
  const companyId = typeof _req.query.companyId === "string" ? companyIdFromContext(_req.query.companyId) : null;
  const accountId = companyId ? await gmailAccountFor(companyId) : OFFICE_ACCOUNT;
  res.json({ ...(await getGmailStatus(accountId)), own: accountId !== OFFICE_ACCOUNT });
});

// Gmail-tilin yhdistäminen: palauttaa Googlen kirjautumisosoitteen. target = "office" tai taloyhtiön tunniste.
const gmailConnectStates = new Map<string, { target: string; userName: string; returnTo: string; expiresAt: number }>();

app.post("/api/gmail/connect", requireAdmin, async (req, res) => {
  const target = req.body?.target === OFFICE_ACCOUNT ? OFFICE_ACCOUNT : companyIdFromContext(req.body?.target);
  if (!target || (target !== OFFICE_ACCOUNT && typeof req.body?.target !== "string")) {
    return res.status(400).json({ error: "Valitse toimisto tai taloyhtiö." });
  }
  const state = crypto.randomBytes(24).toString("hex");
  const origin = typeof req.headers.origin === "string" && /^https?:\/\/[^\s/]+$/.test(req.headers.origin)
    ? req.headers.origin
    : process.env.APP_URL || "http://localhost:5173";
  gmailConnectStates.set(state, { target, userName: res.locals.user?.name ?? "Pääkäyttäjä", returnTo: origin, expiresAt: Date.now() + 10 * 60 * 1000 });
  try {
    res.json({ url: await gmailAuthUrl(state) });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Gmail-kirjautumisen aloitus epäonnistui." });
  }
});

// Google ohjaa selaimen tänne kirjautumisen jälkeen. Vastaus on pieni sivu, jolta palataan alustalle.
app.get("/api/gmail/callback", async (req, res) => {
  const escape = (text: string) => text.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] as string));
  const page = (title: string, text: string, returnTo = "") => res.status(200).type("html").send(
    `<!doctype html><meta charset="utf-8"><title>Kotilo</title>
<body style="font-family:system-ui,sans-serif;background:#171c22;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="background:#fff;color:#1d2329;border-radius:16px;padding:32px;max-width:440px">
<h1 style="font-size:20px;margin:0 0 10px">${escape(title)}</h1><p style="margin:0 0 18px;line-height:1.5">${escape(text)}</p>
${returnTo ? `<a href="${escape(returnTo)}/#/settings" style="color:#2f6ba8;font-weight:700">Palaa Kotiloon</a>` : ""}</div></body>`
  );
  const state = typeof req.query.state === "string" ? gmailConnectStates.get(req.query.state) : undefined;
  if (typeof req.query.state === "string") gmailConnectStates.delete(req.query.state);
  if (!state || state.expiresAt < Date.now()) {
    return page("Yhdistäminen epäonnistui", "Kirjautumispyyntö on vanhentunut tai virheellinen. Aloita yhdistäminen uudelleen Kotilon asetuksista.");
  }
  if (typeof req.query.code !== "string") {
    return page("Yhdistäminen peruttiin", "Gmail-tiliä ei yhdistetty.", state.returnTo);
  }
  try {
    const email = await connectGmailAccount(state.target, req.query.code, state.userName);
    page("Gmail-tili yhdistetty", `Tili ${email} on nyt käytössä. Voit sulkea tämän välilehden.`, state.returnTo);
  } catch (error: any) {
    console.error("Gmail-tilin yhdistäminen epäonnistui:", error?.message ?? error);
    page("Yhdistäminen epäonnistui", error?.message ?? "Tuntematon virhe.", state.returnTo);
  }
});

// Poistaa taloyhtiön oman tilin, jolloin taloyhtiö palaa käyttämään toimiston tiliä.
app.delete("/api/gmail/accounts/:companyId", requireAdmin, async (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId || req.params.companyId === OFFICE_ACCOUNT) return res.status(400).json({ error: "Toimiston tiliä ei voi poistaa; vaihda se toiseen." });
  if (!(await disconnectGmailAccount(companyId))) return res.status(404).json({ error: "Taloyhtiöllä ei ole omaa Gmail-tiliä." });
  res.json({ ok: true });
});

app.get("/api/companies/:companyId/knowledge", (req, res) => {
  if (!companyIdFromContext(req.params.companyId)) {
    return res.status(403).json({ error: "Company not authorized" });
  }
  const rows = db.prepare(
    "SELECT * FROM knowledge WHERE company_id = ? AND status = 'active' ORDER BY title"
  ).all(req.params.companyId) as KnowledgeRow[];
  res.json(rows.map(serializeKnowledge));
});

app.post("/api/companies/:companyId/knowledge/facts", requireManager, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const schema = z.object({
    question: z.string().trim().min(1),
    answer: z.string().trim().min(1),
    validFrom: validityDate,
    validUntil: validityDate,
    replaces: z.string().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(12).optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Täytä kysymys ja vastaus ja tarkista päivämäärät." });
  }

  const knowledgeId = saveKnowledge({
    companyId,
    kind: "fact",
    title: parsed.data.question,
    content: parsed.data.answer,
    validFrom: parsed.data.validFrom,
    validUntil: parsed.data.validUntil,
    replaces: parsed.data.replaces,
    tags: parsed.data.tags
  });
  if (!knowledgeId) return res.status(404).json({ error: "Korvattavaa tietuetta ei löytynyt." });

  res.status(201).json({ ok: true, knowledgeId });
});

app.post(
  "/api/companies/:companyId/knowledge/documents",
  requireManager,
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    const companyId = companyIdFromContext(req.params.companyId);
    if (!companyId) return res.status(403).json({ error: "Company not authorized" });

    const schema = z.object({
      fileName: z.string().trim().min(1),
      mimeType: z.string().default(""),
      title: z.string().trim().default(""),
      validFrom: validityDate,
      validUntil: validityDate,
      replaces: z.string().optional()
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "Valitse ladattava tiedosto ja tarkista päivämäärät." });
    }

    const fileName = path.basename(parsed.data.fileName);
    let text = "";
    let extractionOk = true;
    try {
      text = await extractText(req.body, fileName, parsed.data.mimeType);
      extractionOk = text.length > 0;
    } catch (error) {
      if (error instanceof UnsupportedDocumentError) {
        return res.status(400).json({ error: error.message });
      }
      console.error("Dokumentin tekstin lukeminen epäonnistui:", error instanceof Error ? error.message : error);
      extractionOk = false;
    }

    const knowledgeId = saveKnowledge({
      companyId,
      kind: "document",
      title: parsed.data.title || path.parse(fileName).name,
      content: text,
      validFrom: parsed.data.validFrom,
      validUntil: parsed.data.validUntil,
      replaces: parsed.data.replaces,
      fileName,
      mimeType: parsed.data.mimeType || "application/octet-stream",
      extractionOk
    });
    if (!knowledgeId) return res.status(404).json({ error: "Korvattavaa tietuetta ei löytynyt." });

    await fs.writeFile(path.join(knowledgeFilesDir, knowledgeId), req.body);

    res.status(201).json({ ok: true, knowledgeId, extractionOk, textLength: text.length });
  }
);

app.post("/api/companies/:companyId/knowledge/test", async (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = z.object({ question: z.string().trim().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita kysymys." });

  const answer = await answerFromKnowledge(parsed.data.question, getKnowledge(companyId));
  res.json(answer
    ? { found: true, answer: answer.answer, source: { id: answer.sourceId, title: answer.sourceTitle } }
    : { found: false });
});

app.put("/api/knowledge/:id/validity", requireManager, (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.status !== "active") return res.status(404).json({ error: "Knowledge not found" });

  const parsed = z.object({ validFrom: validityDate, validUntil: validityDate }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista päivämäärät." });
  if (parsed.data.validFrom && parsed.data.validUntil && parsed.data.validFrom > parsed.data.validUntil) {
    return res.status(400).json({ error: "Voimassaolon alku ei voi olla lopun jälkeen." });
  }

  db.prepare("UPDATE knowledge SET valid_from = ?, valid_until = ? WHERE id = ?").run(
    parsed.data.validFrom || null,
    parsed.data.validUntil || null,
    row.id
  );
  res.json({ ok: true });
});

app.delete("/api/knowledge/:id", requireManager, (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.status !== "active") return res.status(404).json({ error: "Knowledge not found" });

  // Tietue poistuu AI:n käytöstä, mutta jää historiaan.
  db.prepare("UPDATE knowledge SET status = 'deleted' WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

app.get("/api/knowledge/:id", (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row) return res.status(404).json({ error: "Knowledge not found" });

  const company = db.prepare("SELECT name FROM companies WHERE id = ?")
    .get(row.company_id) as { name: string } | undefined;
  const versions = db.prepare(
    "SELECT * FROM knowledge WHERE group_id = ? ORDER BY version DESC"
  ).all(row.group_id) as KnowledgeRow[];

  res.json({
    ...row,
    content_length: row.content.length,
    state: knowledgeState(row),
    company_name: company?.name ?? "",
    versions: versions.map(serializeKnowledge)
  });
});

app.get("/api/knowledge/:id/history", (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row) return res.status(404).json({ error: "Knowledge not found" });

  const versions = db.prepare(
    "SELECT * FROM knowledge WHERE group_id = ? ORDER BY version DESC"
  ).all(row.group_id) as KnowledgeRow[];
  res.json(versions.map(serializeKnowledge));
});

app.get("/api/knowledge/:id/file", (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.kind !== "document" || !row.file_name) {
    return res.status(404).json({ error: "File not found" });
  }

  res.download(path.join(knowledgeFilesDir, row.id), row.file_name, {
    headers: { "Content-Type": "application/octet-stream" }
  });
});

app.get("/api/companies/:companyId/residents", (req, res) => {
  if (!companyIdFromContext(req.params.companyId)) {
    return res.status(403).json({ error: "Company not authorized" });
  }
  res.json(
    db.prepare(`
      SELECT r.id, r.name, r.email, a.apartment_number, a.address,
             EXISTS(SELECT 1 FROM resident_credentials rc WHERE rc.resident_id = r.id) AS has_password
      FROM residents r
      JOIN apartments a ON a.id = r.apartment_id
      WHERE r.company_id = ? AND ${ACTIVE_RESIDENT}
      ORDER BY r.name
    `).all(req.params.companyId)
  );
});

const residentSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().pipe(z.union([z.literal(""), z.email()])).default(""),
  address: z.string().trim().min(1),
  apartmentNumber: z.string().trim().min(1)
});

// Lisää asukkaan yhtiöön ja luo asunnon, jos sitä ei vielä ole. Palauttaa virheen tekstinä.
function addResident(companyId: string, input: unknown): { residentId: string } | { error: string; status: number } {
  const parsed = residentSchema.safeParse(input);
  if (!parsed.success) return { error: "Tarkista nimi, sähköposti, osoite ja asunto.", status: 400 };

  const { name, email, address, apartmentNumber } = parsed.data;

  if (email) {
    const existing = db.prepare(
      `SELECT r.id FROM residents r WHERE r.company_id = ? AND lower(r.email) = lower(?) AND ${ACTIVE_RESIDENT}`
    ).get(companyId, email);
    if (existing) return { error: "Tällä sähköpostiosoitteella on jo asukas.", status: 409 };
  }

  let apartment = db.prepare(`
    SELECT id FROM apartments
    WHERE company_id = ? AND lower(apartment_number) = lower(?) AND lower(address) = lower(?)
  `).get(companyId, apartmentNumber, address) as { id: string } | undefined;

  if (!apartment) {
    apartment = { id: id("apt") };
    db.prepare("INSERT INTO apartments VALUES (?, ?, ?, ?)").run(
      apartment.id, companyId, apartmentNumber, address
    );
  }

  const residentId = id("resident");
  db.prepare("INSERT INTO residents (id, company_id, apartment_id, name, email) VALUES (?, ?, ?, ?, ?)").run(
    residentId, companyId, apartment.id, name, email || null
  );

  return { residentId };
}

app.post("/api/companies/:companyId/residents", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password && !isAdmin(res)) {
    return res.status(403).json({ error: "Vain pääkäyttäjä voi asettaa asukkaan salasanan." });
  }
  if (password && password.length < 8) {
    return res.status(400).json({ error: "Salasanassa pitää olla vähintään 8 merkkiä." });
  }
  if (password && !String(req.body?.email ?? "").trim()) {
    return res.status(400).json({ error: "Kirjautumiseen tarvitaan sähköposti." });
  }

  const result = addResident(companyId, req.body);
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  if (password) setResidentPassword(result.residentId, password);

  res.status(201).json({ ok: true, residentId: result.residentId });
});

// Tuo asukkaat CSV-tiedostosta luetuista riveistä. Kelvolliset rivit lisätään, ja ohitetut
// palautetaan rivinumeron ja syyn kanssa.
app.post("/api/companies/:companyId/residents/import", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = z.object({
    rows: z.array(z.object({
      line: z.number().int(),
      name: z.string().default(""),
      email: z.string().default(""),
      address: z.string().default(""),
      apartmentNumber: z.string().default("")
    })).min(1).max(2000)
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Tiedostossa ei ole tuotavia rivejä tai rivejä on yli 2000." });
  }

  let added = 0;
  const skipped: { line: number; name: string; reason: string }[] = [];

  db.transaction(() => {
    for (const row of parsed.data.rows) {
      const result = addResident(companyId, row);
      if ("error" in result) skipped.push({ line: row.line, name: row.name.trim(), reason: result.error });
      else added++;
    }
  })();

  res.json({ added, skipped });
});

// Salasanan palautus kirjautumissivulta. Vastaus on aina sama, jotta siitä ei voi päätellä,
// onko osoitteella tunnusta. Pyyntöjä rajoitetaan osoitetta kohden.
const resetRequests = new Map<string, { count: number; firstAt: number }>();

app.post("/api/auth/forgot", async (req, res) => {
  const parsed = z.object({ email: z.email() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Anna sähköpostiosoite." });

  const key = parsed.data.email.toLowerCase();
  const recent = resetRequests.get(key);
  if (recent && Date.now() - recent.firstAt > 15 * 60 * 1000) resetRequests.delete(key);
  const attempts = resetRequests.get(key) ?? { count: 0, firstAt: Date.now() };
  if (attempts.count >= 3) return res.status(429).json({ error: "Liian monta pyyntöä. Yritä uudelleen 15 minuutin kuluttua." });
  resetRequests.set(key, { count: attempts.count + 1, firstAt: attempts.firstAt });

  const resets = createPasswordResets(parsed.data.email);
  if (resets.length > 0) {
    // Linkki osoittaa siihen osoitteeseen, josta pyyntö tuli (selain lähettää Origin-otsakkeen).
    const origin = typeof req.headers.origin === "string" && /^https?:\/\/[^\s/]+$/.test(req.headers.origin)
      ? req.headers.origin
      : process.env.APP_URL || "http://localhost:5173";
    const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string };
    const body = [
      "Hei,",
      "",
      "saimme pyynnön vaihtaa Kotilo-tunnuksesi salasana. Aseta uusi salasana alla olevasta linkistä.",
      "Linkki on voimassa tunnin ja toimii vain kerran.",
      "",
      ...resets.flatMap(reset => [`${reset.label} (${reset.name}):`, `${origin}/#/reset/${reset.token}`, ""]),
      "Jos et pyytänyt salasanan vaihtoa, voit jättää tämän viestin huomiotta.",
      "",
      office.name
    ].join("\n");
    try {
      await sendGmailReply({ to: parsed.data.email, subject: "Kotilo: salasanan vaihto", body });
    } catch (error: any) {
      console.error("Palautuslinkin lähetys epäonnistui:", error?.message ?? error);
      return res.status(502).json({ error: "Palautuslinkin lähetys epäonnistui. Yritä uudelleen tai pyydä pääkäyttäjää vaihtamaan salasana." });
    }
  }
  res.json({ ok: true });
});

app.post("/api/auth/reset", (req, res) => {
  const parsed = z.object({ token: z.string().min(20).max(200), password: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Palautuslinkki on virheellinen." });
  const error = consumePasswordReset(parsed.data.token, parsed.data.password);
  if (error) return res.status(400).json({ error });
  res.json({ ok: true });
});

// Isännöitsijätoimiston omat tiedot. Lukea saa jokainen käyttäjä, muuttaa vain pääkäyttäjä.
const OFFICE_SELECT = `
  SELECT name, business_id AS businessId, address, phone,
         reminder_emails AS reminderEmails, retention_months AS retentionMonths
  FROM office_settings WHERE id = 1
`;

app.get("/api/office", (_req, res) => {
  res.json(db.prepare(OFFICE_SELECT).get());
});

app.put("/api/office", requireAdmin, (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(120),
    businessId: z.string().trim().max(30).default(""),
    address: z.string().trim().max(200).default(""),
    phone: z.string().trim().max(40).default(""),
    // Muistutukset ja säilytysaika päivitetään vain, kun ne ovat pyynnössä mukana.
    reminderEmails: z.boolean().optional(),
    retentionMonths: z.number().int().min(0).max(240).optional()
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
  res.json(db.prepare(OFFICE_SELECT).get());
});

// Autopaikat: taloyhtiön paikat, niiden tyyppi ja haltija.
const PARKING_TYPES = ["Autotalli", "Ulkopaikka", "Hallipaikka"] as const;

const parkingSchema = z.object({
  label: z.string().trim().min(1).max(40),
  type: z.enum(PARKING_TYPES),
  residentId: z.string().nullable().default(null),
  note: z.string().trim().max(300).default("")
});

const PARKING_SELECT = `
  SELECT p.id, p.company_id, p.label, p.type, p.resident_id, p.note,
         r.name AS resident_name, a.apartment_number
  FROM parking_spaces p
  LEFT JOIN residents r ON r.id = p.resident_id
  LEFT JOIN apartments a ON a.id = r.apartment_id
`;

// Tarkistaa paikan tiedot: haltijan pitää olla saman yhtiön asukas ja tunnuksen yksilöllinen yhtiössä.
function parkingError(companyId: string, data: z.infer<typeof parkingSchema>, exceptId = "") {
  if (data.residentId) {
    const resident = db.prepare("SELECT 1 FROM residents WHERE id = ? AND company_id = ?").get(data.residentId, companyId);
    if (!resident) return { status: 404, error: "Asukasta ei löytynyt tästä yhtiöstä." };
  }
  const duplicate = db.prepare(
    "SELECT 1 FROM parking_spaces WHERE company_id = ? AND lower(label) = lower(?) AND id != ?"
  ).get(companyId, data.label, exceptId);
  if (duplicate) return { status: 409, error: "Tällä tunnuksella on jo autopaikka tässä taloyhtiössä." };
  return null;
}

app.get("/api/companies/:companyId/parking", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  syncParkingHolders();
  res.json(db.prepare(`${PARKING_SELECT} WHERE p.company_id = ? ORDER BY p.label COLLATE NOCASE`).all(companyId));
});

app.post("/api/companies/:companyId/parking", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = parkingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista paikan tunnus ja tyyppi." });
  const problem = parkingError(companyId, parsed.data);
  if (problem) return res.status(problem.status).json({ error: problem.error });

  const parkingId = id("parking");
  db.prepare("INSERT INTO parking_spaces (id, company_id, label, type, resident_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(parkingId, companyId, parsed.data.label, parsed.data.type, null, parsed.data.note, now());
  if (parsed.data.residentId) setParkingHolder(parkingId, companyId, parsed.data.residentId);
  res.status(201).json({ ok: true, parkingId });
});

app.put("/api/parking/:id", (req, res) => {
  const space = db.prepare("SELECT id, company_id FROM parking_spaces WHERE id = ?").get(req.params.id) as
    | { id: string; company_id: string }
    | undefined;
  if (!space || !companyIdFromContext(space.company_id)) return res.status(404).json({ error: "Autopaikkaa ei löytynyt." });

  const parsed = parkingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista paikan tunnus ja tyyppi." });
  const problem = parkingError(space.company_id, parsed.data, space.id);
  if (problem) return res.status(problem.status).json({ error: problem.error });

  syncParkingHolders();
  const current = db.prepare("SELECT resident_id FROM parking_spaces WHERE id = ?").get(space.id) as { resident_id: string | null };
  db.prepare("UPDATE parking_spaces SET label = ?, type = ?, note = ? WHERE id = ?")
    .run(parsed.data.label, parsed.data.type, parsed.data.note, space.id);
  // Haltijan vaihtuessa vanha jakso päättyy ja uusi alkaa tästä päivästä.
  if (current.resident_id !== parsed.data.residentId) setParkingHolder(space.id, space.company_id, parsed.data.residentId);
  res.json({ ok: true });
});

app.delete("/api/parking/:id", (req, res) => {
  const space = db.prepare("SELECT id, company_id FROM parking_spaces WHERE id = ?").get(req.params.id) as
    | { id: string; company_id: string }
    | undefined;
  if (!space || !companyIdFromContext(space.company_id)) return res.status(404).json({ error: "Autopaikkaa ei löytynyt." });
  db.prepare("DELETE FROM parking_assignments WHERE parking_id = ?").run(space.id);
  db.prepare("DELETE FROM parking_spaces WHERE id = ?").run(space.id);
  res.json({ ok: true });
});

// Vaihtaa autopaikan haltijan ja kirjaa muutoksen haltijahistoriaan tästä päivästä alkaen.
function setParkingHolder(parkingId: string, companyId: string, residentId: string | null) {
  const date = today();
  db.prepare("UPDATE parking_assignments SET end_date = ? WHERE parking_id = ? AND (end_date IS NULL OR end_date > ?)")
    .run(date, parkingId, date);
  // Samana päivänä alkanut ja päättynyt jakso ei ole laskutettava.
  db.prepare("DELETE FROM parking_assignments WHERE parking_id = ? AND end_date <= start_date").run(parkingId);
  if (residentId) {
    db.prepare("INSERT INTO parking_assignments (id, parking_id, company_id, resident_id, start_date) VALUES (?, ?, ?, ?, ?)")
      .run(id("pa"), parkingId, companyId, residentId, date);
  }
  db.prepare("UPDATE parking_spaces SET resident_id = ? WHERE id = ?").run(residentId, parkingId);
}

// Paikan nykyinen haltija on se, jonka jakso on voimassa tänään. Ajetaan ennen lukemista, jotta
// tulevaisuuteen päivätty luopuminen (muutto) vapauttaa paikan oikeana päivänä.
function syncParkingHolders() {
  const date = today();
  db.prepare(`
    UPDATE parking_spaces SET resident_id = (
      SELECT pa.resident_id FROM parking_assignments pa
      WHERE pa.parking_id = parking_spaces.id AND pa.start_date <= ? AND (pa.end_date IS NULL OR pa.end_date > ?)
      ORDER BY pa.start_date DESC LIMIT 1
    )
    WHERE EXISTS (SELECT 1 FROM parking_assignments pa WHERE pa.parking_id = parking_spaces.id)
  `).run(date, date);
}

// Laskutus: kuukauden aikana voimassa olleet haltijajaksot. month = VVVV-KK.
app.get("/api/companies/:companyId/parking-billing", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const month = typeof req.query.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month) ? req.query.month : "";
  if (!month) return res.status(400).json({ error: "Anna kuukausi muodossa VVVV-KK." });

  const [year, monthNumber] = month.split("-").map(Number);
  const firstDay = `${month}-01`;
  const nextMonth = new Date(year, monthNumber, 1).toLocaleDateString("sv-SE");
  res.json(db.prepare(`
    SELECT pa.id, p.label, p.type, pa.resident_id, r.name AS resident_name, a.apartment_number,
           pa.start_date, pa.end_date
    FROM parking_assignments pa
    JOIN parking_spaces p ON p.id = pa.parking_id
    LEFT JOIN residents r ON r.id = pa.resident_id
    LEFT JOIN apartments a ON a.id = r.apartment_id
    WHERE pa.company_id = ? AND pa.start_date < ? AND (pa.end_date IS NULL OR pa.end_date > ?)
    ORDER BY p.label COLLATE NOCASE
  `).all(companyId, nextMonth, firstDay));
});

// Autopaikkojen kuukausihinnat (euroa) paikkatyypeittäin.
function parkingPrices(companyId: string) {
  const prices = Object.fromEntries(PARKING_TYPES.map(type => [type, 0])) as Record<(typeof PARKING_TYPES)[number], number>;
  const rows = db.prepare("SELECT type, monthly_price FROM parking_prices WHERE company_id = ?").all(companyId) as
    { type: string; monthly_price: number }[];
  for (const row of rows) {
    if ((PARKING_TYPES as readonly string[]).includes(row.type)) prices[row.type as (typeof PARKING_TYPES)[number]] = row.monthly_price;
  }
  return prices;
}

app.get("/api/companies/:companyId/parking-prices", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(parkingPrices(companyId));
});

app.put("/api/companies/:companyId/parking-prices", requireAdmin, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const price = z.number().min(0).max(10000);
  const parsed = z.object({ Autotalli: price, Ulkopaikka: price, Hallipaikka: price }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista hinnat." });

  const save = db.prepare(`
    INSERT INTO parking_prices (company_id, type, monthly_price) VALUES (?, ?, ?)
    ON CONFLICT(company_id, type) DO UPDATE SET monthly_price = excluded.monthly_price
  `);
  for (const type of PARKING_TYPES) save.run(companyId, type, parsed.data[type]);
  res.json(parkingPrices(companyId));
});

// Yhteistilojen vuorovaraukset (sauna ja pyykkitupa). Sama rakenne molemmille tiloille.
const BOOKING_RESOURCES = ["sauna", "laundry"] as const;
const MAX_BOOKING_OCCURRENCES = 26;
const DEFAULT_WEEKLY_WEEKS = 12;

const bookingTimes = z.object({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() });

// weeklyWeeks = kuinka monelle viikolle viikoittainen vuoro varataan kerralla.
// singlePrice = yhden vuoron hinta, monthlyPrice = viikoittaisen vuoron hinta kuukaudessa (euroa).
type BookingRule = { single: boolean; weekly: boolean; weeklyWeeks: number; singlePrice: number; monthlyPrice: number };
type BookingRules = Record<(typeof BOOKING_RESOURCES)[number], BookingRule>;

// Taloyhtiön asetukset: saako tilaan varata yksittäisiä ja viikoittaisia vuoroja.
function bookingRules(companyId: string): BookingRules {
  const rules: BookingRules = {
    sauna: { single: true, weekly: true, weeklyWeeks: DEFAULT_WEEKLY_WEEKS, singlePrice: 0, monthlyPrice: 0 },
    laundry: { single: true, weekly: true, weeklyWeeks: DEFAULT_WEEKLY_WEEKS, singlePrice: 0, monthlyPrice: 0 }
  };
  const rows = db.prepare(`
    SELECT resource, allow_single, allow_weekly, weekly_weeks, single_price, monthly_price
    FROM booking_settings WHERE company_id = ?
  `).all(companyId) as {
    resource: string; allow_single: number; allow_weekly: number; weekly_weeks: number;
    single_price: number; monthly_price: number;
  }[];
  for (const row of rows) {
    if (row.resource === "sauna" || row.resource === "laundry") {
      rules[row.resource] = {
        single: Boolean(row.allow_single),
        weekly: Boolean(row.allow_weekly),
        weeklyWeeks: row.weekly_weeks,
        singlePrice: row.single_price,
        monthlyPrice: row.monthly_price
      };
    }
  }
  return rules;
}

// Palauttaa virhetekstin, jos pyydetty vuorotyyppi on kytketty pois taloyhtiön asetuksista tai
// viikoittaista vuoroa yritetään varata pidemmäksi ajaksi kuin asetus sallii.
function bookingKindError(companyId: string, resource: (typeof BOOKING_RESOURCES)[number], repeats: number) {
  const rule = bookingRules(companyId)[resource];
  const weekly = repeats > 0;
  if (weekly && rule.weekly && repeats + 1 > rule.weeklyWeeks) {
    return `Viikoittaisen vuoron voi varata enintään ${rule.weeklyWeeks} viikoksi.`;
  }
  if (weekly ? rule.weekly : rule.single) return null;
  return weekly
    ? "Viikoittaisten vuorojen varaaminen ei ole käytössä tässä taloyhtiössä."
    : "Yksittäisten vuorojen varaaminen ei ole käytössä tässä taloyhtiössä.";
}

app.get("/api/companies/:companyId/booking-settings", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(bookingRules(companyId));
});

app.put("/api/companies/:companyId/booking-settings", requireAdmin, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const rule = z.object({
    single: z.boolean(),
    weekly: z.boolean(),
    weeklyWeeks: z.number().int().min(2).max(MAX_BOOKING_OCCURRENCES).default(DEFAULT_WEEKLY_WEEKS),
    singlePrice: z.number().min(0).max(10000).default(0),
    monthlyPrice: z.number().min(0).max(10000).default(0)
  });
  const parsed = z.object({ sauna: rule, laundry: rule }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista asetukset." });

  const save = db.prepare(`
    INSERT INTO booking_settings
      (company_id, resource, allow_single, allow_weekly, weekly_weeks, single_price, monthly_price)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, resource) DO UPDATE SET
      allow_single = excluded.allow_single, allow_weekly = excluded.allow_weekly,
      weekly_weeks = excluded.weekly_weeks, single_price = excluded.single_price,
      monthly_price = excluded.monthly_price
  `);
  for (const resource of BOOKING_RESOURCES) {
    const value = parsed.data[resource];
    save.run(companyId, resource, value.single ? 1 : 0, value.weekly ? 1 : 0, value.weeklyWeeks,
      value.singlePrice, value.monthlyPrice);
  }
  res.json(bookingRules(companyId));
});

// Tallentaa yhden tai useamman vuoron. Viikoittaisessa varauksessa selain lähettää jokaisen
// viikon ajat (paikallinen kellonaika säilyy kesä- ja talviajan vaihtuessa), ja ne saavat yhteisen
// sarjatunnisteen. Jo varatut tai menneet vuorot ohitetaan ja palautetaan kutsujalle.
function createBookings(input: {
  companyId: string;
  resource: string;
  occurrences: { startsAt: string; endsAt: string }[];
  residentId: string | null;
  note: string;
  createdBy: string;
}): { created: number; skipped: string[] } {
  const seriesId = input.occurrences.length > 1 ? id("series") : null;
  const overlap = db.prepare(`
    SELECT 1 FROM bookings
    WHERE company_id = ? AND resource = ? AND starts_at < ? AND ends_at > ?
    LIMIT 1
  `);
  const insert = db.prepare(`
    INSERT INTO bookings (id, company_id, resource, resident_id, note, starts_at, ends_at, created_by, created_at, series_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let created = 0;
  const skipped: string[] = [];
  db.transaction(() => {
    for (const { startsAt, endsAt } of input.occurrences) {
      const valid = endsAt > startsAt
        && Date.parse(endsAt) > Date.now()
        && Date.parse(endsAt) - Date.parse(startsAt) <= 4 * 60 * 60 * 1000;
      if (!valid || overlap.get(input.companyId, input.resource, endsAt, startsAt)) {
        skipped.push(startsAt);
        continue;
      }
      insert.run(id("booking"), input.companyId, input.resource, input.residentId, input.note,
        startsAt, endsAt, input.createdBy, now(), seriesId);
      created++;
    }
  })();
  return { created, skipped };
}

// Poistaa varauksen. series=1 poistaa myös saman sarjan myöhemmät vuorot.
function deleteBooking(booking: { id: string; series_id: string | null; starts_at: string }, wholeSeries: boolean) {
  if (wholeSeries && booking.series_id) {
    return db.prepare("DELETE FROM bookings WHERE series_id = ? AND starts_at >= ?")
      .run(booking.series_id, booking.starts_at).changes;
  }
  return db.prepare("DELETE FROM bookings WHERE id = ?").run(booking.id).changes;
}

app.get("/api/companies/:companyId/bookings", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = z.object({
    resource: z.enum(BOOKING_RESOURCES),
    from: z.iso.datetime(),
    to: z.iso.datetime()
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista tila ja aikaväli." });

  res.json(db.prepare(`
    SELECT b.id, b.resource, b.resident_id, b.note, b.starts_at, b.ends_at, b.created_by, b.series_id,
           r.name AS resident_name, a.apartment_number
    FROM bookings b
    LEFT JOIN residents r ON r.id = b.resident_id
    LEFT JOIN apartments a ON a.id = r.apartment_id
    WHERE b.company_id = ? AND b.resource = ? AND b.starts_at < ? AND b.ends_at > ?
    ORDER BY b.starts_at
  `).all(companyId, parsed.data.resource, parsed.data.to, parsed.data.from));
});

app.post("/api/companies/:companyId/bookings", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = z.object({
    resource: z.enum(BOOKING_RESOURCES),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    residentId: z.string().optional(),
    note: z.string().trim().max(200).default(""),
    // Viikoittaisen varauksen myöhemmät viikot; ensimmäinen vuoro on startsAt–endsAt.
    repeats: z.array(bookingTimes).max(MAX_BOOKING_OCCURRENCES - 1).default([])
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista varauksen tiedot." });

  const { resource, startsAt, endsAt, residentId, note } = parsed.data;
  if (endsAt <= startsAt) return res.status(400).json({ error: "Varauksen pitää päättyä alkamisen jälkeen." });
  if (!residentId && !note) return res.status(400).json({ error: "Valitse asukas tai kirjoita varauksen tieto." });

  if (residentId) {
    const resident = db.prepare("SELECT id FROM residents WHERE id = ? AND company_id = ?").get(residentId, companyId);
    if (!resident) return res.status(404).json({ error: "Asukasta ei löytynyt tästä yhtiöstä." });
  }

  const kindError = bookingKindError(companyId, resource, parsed.data.repeats.length);
  if (kindError) return res.status(403).json({ error: kindError });

  // Samaan tilaan ei voi tehdä päällekkäisiä varauksia; varatut viikot ohitetaan.
  const result = createBookings({
    companyId,
    resource,
    occurrences: [{ startsAt, endsAt }, ...parsed.data.repeats],
    residentId: residentId ?? null,
    note,
    createdBy: res.locals.user?.name ?? "Tuntematon"
  });
  if (result.created === 0) return res.status(409).json({ error: "Vuoro on jo varattu tai aika on mennyt." });

  res.status(201).json({ ok: true, ...result });
});

app.delete("/api/bookings/:id", (req, res) => {
  const booking = db.prepare("SELECT id, company_id, series_id, starts_at FROM bookings WHERE id = ?").get(req.params.id) as
    | { id: string; company_id: string; series_id: string | null; starts_at: string }
    | undefined;
  if (!booking || !companyIdFromContext(booking.company_id)) {
    return res.status(404).json({ error: "Varausta ei löytynyt." });
  }
  res.json({ ok: true, deleted: deleteBooking(booking, req.query.series === "1") });
});

// ---------------------------------------------------------------------------------------------
// Asukasportaali. Jokainen reitti rajataan kirjautuneeseen asukkaaseen (res.locals.resident):
// asukas näkee vain oman taloyhtiönsä sauna- ja pyykkitupavuorot, eikä muiden varaajien nimiä.
// ---------------------------------------------------------------------------------------------
const portalResident = (res: express.Response) => res.locals.resident as ResidentAccount;

app.get("/api/portal/me", (_req, res) => {
  res.json(portalResident(res));
});

// Asukkaan itse luoma tehtävä. Yhtiö, asunto ja ilmoittaja tulevat kirjautumisesta, eivät pyynnöstä.
// Tehtävä käsitellään kuten saapunut viesti: se luokitellaan paikallisesti ja menee päätösjonoon.
const PORTAL_TICKET_TYPES = ["Vikailmoitus", "Kysymys", "Ilmoitus", "Pyyntö", "Muu"] as const;

app.post("/api/portal/tickets", async (req, res) => {
  const resident = portalResident(res);
  const parsed = z.object({
    subject: z.string().trim().min(3).max(150),
    description: z.string().trim().min(5).max(5000),
    type: z.enum(PORTAL_TICKET_TYPES),
    attachments: portalAttachmentsSchema
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita otsikko ja kuvaus. Liitteitä voi olla enintään 5." });

  const company = db.prepare("SELECT maintenance_emergency_phone FROM companies WHERE id = ?").get(resident.companyId) as
    | { maintenance_emergency_phone: string }
    | undefined;
  const result = await triage(parsed.data.subject, parsed.data.description, [], company?.maintenance_emergency_phone || undefined);

  const ticketId = id("ticket");
  const timestamp = now();
  db.prepare(`
    INSERT INTO tickets
    (id, company_id, apartment_id, resident_id, type, priority, status, subject,
     summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticketId,
    resident.companyId,
    resident.apartmentId || null,
    resident.id,
    parsed.data.type,
    result.priority,
    "open",
    parsed.data.subject,
    result.summary,
    "portal",
    result.emergency ? "emergency" : "pending_decision",
    result.reason,
    // Vastauskenttä alkaa tyhjänä; luonnos syntyy vasta käsittelijän tai AI-ehdotuksen kautta.
    "",
    timestamp,
    timestamp
  );

  assignToCompanyManager(ticketId, resident.companyId);

  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id("message"),
    ticketId,
    "inbound",
    resident.email ? `${resident.name} <${resident.email}>` : resident.name,
    parsed.data.subject,
    parsed.data.description,
    timestamp,
    "portal"
  );

  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"),
    ticketId,
    resident.name,
    "ticket_created_portal",
    JSON.stringify({ subject: parsed.data.subject, source_channel: "portal" }),
    timestamp
  );

  const attachmentError = await savePortalAttachments(ticketId, parsed.data.attachments, timestamp);
  res.status(201).json({ ok: true, ticketId, attachmentError });
});

// Asukkaan liitteet (kuvat ja PDF:t) tehtävälle. Tallennetaan suunnalla 'portal'.
const portalAttachmentsSchema = z.array(z.object({
  filename: z.string().trim().min(1).max(200),
  mimeType: z.string().max(120),
  data: z.string()
})).max(5).default([]);

async function savePortalAttachments(ticketId: string, attachments: z.infer<typeof portalAttachmentsSchema>, timestamp: string) {
  const files = attachments.map(attachment => ({ ...attachment, content: Buffer.from(attachment.data, "base64") }));
  if (files.some(file => !/^(image\/(png|jpeg|gif|webp|heic)|application\/pdf)$/.test(file.mimeType))) {
    return "Liitteeksi kelpaa kuva tai PDF.";
  }
  if (files.some(file => file.content.length === 0)) return "Liitetiedosto on tyhjä tai sitä ei voitu lukea.";
  if (files.reduce((total, file) => total + file.content.length, 0) > 10 * 1024 * 1024) {
    return "Liitteiden yhteiskoko saa olla enintään 10 Mt.";
  }
  for (const file of files) {
    const attachmentId = id("attachment");
    await fs.writeFile(path.join(attachmentsDir, attachmentId), file.content);
    db.prepare(`
      INSERT INTO attachments (id, ticket_id, filename, mime_type, size, created_at, direction)
      VALUES (?, ?, ?, ?, ?, ?, 'portal')
    `).run(attachmentId, ticketId, file.filename, file.mimeType, file.content.length, timestamp);
  }
  return null;
}

// Asukkaan oma tehtävä: hän on sen ilmoittaja. Muiden tehtäviin ei pääse tunnisteella.
function portalTicket(res: express.Response, ticketId: string) {
  const resident = portalResident(res);
  return db.prepare(`
    SELECT id, ticket_number, subject, type, status, created_at, updated_at
    FROM tickets
    WHERE id = ? AND company_id = ?
      AND (resident_id = ? OR id IN (SELECT ticket_id FROM ticket_reporters WHERE resident_id = ?))
  `).get(ticketId, resident.companyId, resident.id, resident.id) as
    | { id: string; ticket_number: number; subject: string; type: string; status: string; created_at: string; updated_at: string }
    | undefined;
}

// Tehtävän viestiketju asukkaalle: hänen omat viestinsä ja isännöitsijän vastaukset hänelle.
// Sisäisiä muistiinpanoja, lokia ja huoltoyhtiön kanssa käytyä viestintää ei palauteta.
app.get("/api/portal/tickets/:id", (req, res) => {
  const ticket = portalTicket(res, req.params.id);
  if (!ticket) return res.status(404).json({ error: "Tehtävää ei löytynyt." });
  const resident = portalResident(res);
  const messages = db.prepare(`
    SELECT id, direction, body, created_at
    FROM messages
    WHERE ticket_id = ?
      AND ((direction = 'outbound' AND channel != 'contractor')
        OR (direction = 'inbound' AND (channel = 'portal' OR (? != '' AND lower(sender) LIKE '%' || lower(?) || '%'))))
    ORDER BY created_at
  `).all(ticket.id, resident.email ?? "", resident.email ?? "");
  const attachments = db.prepare(`
    SELECT id, filename, size, created_at, direction FROM attachments
    WHERE ticket_id = ? AND direction IN ('portal', 'outbound') ORDER BY created_at
  `).all(ticket.id);
  res.json({ ticket, messages, attachments });
});

app.post("/api/portal/tickets/:id/messages", async (req, res) => {
  const ticket = portalTicket(res, req.params.id);
  if (!ticket) return res.status(404).json({ error: "Tehtävää ei löytynyt." });
  const parsed = z.object({
    body: z.string().trim().min(1).max(5000),
    attachments: portalAttachmentsSchema
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita viesti. Liitteitä voi olla enintään 5." });

  const resident = portalResident(res);
  const timestamp = now();
  const attachmentError = await savePortalAttachments(ticket.id, parsed.data.attachments, timestamp);
  if (attachmentError) return res.status(400).json({ error: attachmentError });

  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id("message"), ticket.id, "inbound",
    resident.email ? `${resident.name} <${resident.email}>` : resident.name,
    ticket.subject, parsed.data.body, timestamp, "portal"
  );
  // Suljettu tehtävä avataan uudelleen päätösjonoon, kuten sähköpostivastauksessakin.
  const reopened = ticket.status === "closed";
  db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(reopened ? "open" : ticket.status, timestamp, ticket.id);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), ticket.id, resident.name, reopened ? "reply_received_reopened" : "portal_message",
    JSON.stringify({ attachments: parsed.data.attachments.length }), timestamp
  );
  res.status(201).json({ ok: true, reopened });
});

app.get("/api/portal/attachments/:id", (req, res) => {
  const attachment = db.prepare("SELECT id, ticket_id, filename, direction FROM attachments WHERE id = ?").get(req.params.id) as
    | { id: string; ticket_id: string; filename: string; direction: string }
    | undefined;
  if (!attachment || !["portal", "outbound"].includes(attachment.direction) || !portalTicket(res, attachment.ticket_id)) {
    return res.status(404).json({ error: "Liitettä ei löytynyt." });
  }
  res.download(path.join(attachmentsDir, attachment.id), attachment.filename, {
    headers: { "Content-Type": "application/octet-stream" }
  });
});

// Asukkaan omat tehtävät: vain otsikko, tyyppi, tila ja ajat. Käsittelyn sisäisiä tietoja ei palauteta.
app.get("/api/portal/tickets", (_req, res) => {
  const resident = portalResident(res);
  res.json(db.prepare(`
    SELECT id, ticket_number, subject, type, status, created_at, updated_at
    FROM tickets
    WHERE company_id = ?
      AND (resident_id = ? OR id IN (SELECT ticket_id FROM ticket_reporters WHERE resident_id = ?))
    ORDER BY created_at DESC
    LIMIT 100
  `).all(resident.companyId, resident.id, resident.id));
});

app.get("/api/portal/booking-settings", (_req, res) => {
  res.json(bookingRules(portalResident(res).companyId));
});

app.get("/api/portal/bookings", (req, res) => {
  const resident = portalResident(res);
  const parsed = z.object({
    resource: z.enum(BOOKING_RESOURCES),
    from: z.iso.datetime(),
    to: z.iso.datetime()
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista tila ja aikaväli." });

  const rows = db.prepare(`
    SELECT id, resident_id, starts_at, ends_at, series_id
    FROM bookings
    WHERE company_id = ? AND resource = ? AND starts_at < ? AND ends_at > ?
    ORDER BY starts_at
  `).all(resident.companyId, parsed.data.resource, parsed.data.to, parsed.data.from) as
    { id: string; resident_id: string | null; starts_at: string; ends_at: string; series_id: string | null }[];

  // Muiden varauksista kerrotaan vain, että vuoro on varattu.
  res.json(rows.map(row => ({
    id: row.id,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    mine: row.resident_id === resident.id,
    // Sarjatieto vain omista varauksista, jotta sarjan voi perua kerralla.
    series_id: row.resident_id === resident.id ? row.series_id : null
  })));
});

app.post("/api/portal/bookings", (req, res) => {
  const resident = portalResident(res);
  const parsed = z.object({
    resource: z.enum(BOOKING_RESOURCES),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    repeats: z.array(bookingTimes).max(MAX_BOOKING_OCCURRENCES - 1).default([])
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista varauksen tiedot." });

  const { resource, startsAt, endsAt } = parsed.data;
  const kindError = bookingKindError(resident.companyId, resource, parsed.data.repeats.length);
  if (kindError) return res.status(403).json({ error: kindError });

  const result = createBookings({
    companyId: resident.companyId,
    resource,
    occurrences: [{ startsAt, endsAt }, ...parsed.data.repeats],
    residentId: resident.id,
    note: "",
    createdBy: resident.name
  });
  if (result.created === 0) return res.status(409).json({ error: "Vuoro on jo varattu tai aika on mennyt." });

  res.status(201).json({ ok: true, ...result });
});

app.delete("/api/portal/bookings/:id", (req, res) => {
  const resident = portalResident(res);
  const booking = db.prepare(
    "SELECT id, series_id, starts_at FROM bookings WHERE id = ? AND resident_id = ?"
  ).get(req.params.id, resident.id) as { id: string; series_id: string | null; starts_at: string } | undefined;
  if (!booking) return res.status(404).json({ error: "Omaa varausta ei löytynyt." });
  res.json({ ok: true, deleted: deleteBooking(booking, req.query.series === "1") });
});

// Koko alustan loki: kaikkien hallinnoitavien yhtiöiden tehtävien tapahtumat uusimmasta alkaen.
// Lähetetyn sähköpostin sisältö haetaan samalla hetkellä tallennetusta lähteneestä viestistä.
// Loki näkyy isännöitsijälle omien yhtiöidensä osalta. Tehtävään liittymättömät merkinnät
// (käyttäjän tai asukkaan poisto, säilytysajan poistot) näkyvät vain pääkäyttäjälle.
app.get("/api/audit", requireManager, (_req, res) => {
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

const REPORT_PERIODS = ["week", "month", "year"] as const;
const MAX_TOPIC_TICKETS = 400;

function storedTopicReport(companyId: string, period: string) {
  const row = db.prepare(
    "SELECT generated_at, generated_by, ticket_count, topics FROM topic_reports WHERE company_id = ? AND period = ?"
  ).get(companyId, period) as
    | { generated_at: string; generated_by: string; ticket_count: number; topics: string }
    | undefined;
  return row
    ? {
        generatedAt: row.generated_at,
        generatedBy: row.generated_by,
        ticketCount: row.ticket_count,
        topics: JSON.parse(row.topics)
      }
    : null;
}

// Viimeksi luotu AI-raportti toistuvista aiheista; null, jos jaksolle ei ole vielä luotu raporttia.
app.get("/api/companies/:companyId/reports/topics", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const period = z.enum(REPORT_PERIODS).safeParse(req.query.period);
  if (!period.success) return res.status(400).json({ error: "Tuntematon jakso." });

  res.json({ report: storedTopicReport(companyId, period.data), aiAvailable: aiAvailable() });
});

// Luo tai päivittää toistuvien aiheiden raportin AI:lla jakson tehtävistä.
app.post("/api/companies/:companyId/reports/topics", async (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = z.object({
    period: z.enum(REPORT_PERIODS),
    since: z.iso.datetime()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista jakso." });

  if (!aiAvailable()) {
    return res.status(503).json({ error: "AI ei ole käytössä. Lisää ANTHROPIC_API_KEY palvelimen .env-tiedostoon." });
  }

  const tickets = db.prepare(`
    SELECT t.id, t.ticket_number, t.type, t.subject, t.summary,
           (SELECT m.body FROM messages m
            WHERE m.ticket_id = t.id AND m.direction = 'outbound'
            ORDER BY m.created_at LIMIT 1) AS reply
    FROM tickets t
    WHERE t.company_id = ? AND t.created_at >= ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(companyId, parsed.data.since, MAX_TOPIC_TICKETS) as TopicTicket[];

  let topics: RecurringTopic[] = [];
  if (tickets.length >= 2) {
    try {
      topics = await analyzeRecurringTopics(tickets);
    } catch (error) {
      console.error("Toistuvien aiheiden analyysi epäonnistui:", error);
      return res.status(502).json({ error: "AI-analyysi epäonnistui. Yritä uudelleen." });
    }
  }

  db.prepare(`
    INSERT OR REPLACE INTO topic_reports
      (company_id, period, generated_at, generated_by, ticket_count, topics)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(companyId, parsed.data.period, now(), res.locals.user?.name ?? "Tuntematon", tickets.length, JSON.stringify(topics));

  res.json({ report: storedTopicReport(companyId, parsed.data.period), aiAvailable: true });
});

app.put("/api/residents/:residentId", (req, res) => {
  const resident = db.prepare(
    "SELECT id, company_id, apartment_id FROM residents WHERE id = ?"
  ).get(req.params.residentId) as { id: string; company_id: string; apartment_id: string } | undefined;
  const companyId = resident && companyIdFromContext(resident.company_id);
  if (!resident || !companyId) return res.status(404).json({ error: "Asukasta ei löytynyt." });

  const schema = z.object({
    name: z.string().trim().min(1),
    email: z.string().trim().pipe(z.union([z.literal(""), z.email()])).default(""),
    address: z.string().trim().min(1),
    apartmentNumber: z.string().trim().min(1)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Tarkista nimi, sähköposti, osoite ja asunto." });
  }

  const { name, email, address, apartmentNumber } = parsed.data;

  if (email) {
    const existing = db.prepare(
      `SELECT r.id FROM residents r WHERE r.company_id = ? AND lower(r.email) = lower(?) AND r.id != ? AND ${ACTIVE_RESIDENT}`
    ).get(companyId, email, resident.id);
    if (existing) {
      return res.status(409).json({ error: "Tällä sähköpostiosoitteella on jo asukas." });
    }
  }

  let apartment = db.prepare(`
    SELECT id FROM apartments
    WHERE company_id = ? AND lower(apartment_number) = lower(?) AND lower(address) = lower(?)
  `).get(companyId, apartmentNumber, address) as { id: string } | undefined;

  if (!apartment) {
    apartment = { id: id("apt") };
    db.prepare("INSERT INTO apartments VALUES (?, ?, ?, ?)").run(
      apartment.id, companyId, apartmentNumber, address
    );
  }

  // Salasana on valinnainen: tyhjä jättää nykyisen ennalleen.
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password) {
    if (!isAdmin(res)) return res.status(403).json({ error: "Vain pääkäyttäjä voi vaihtaa asukkaan salasanan." });
    if (!email) return res.status(400).json({ error: "Kirjautumiseen tarvitaan sähköposti." });
    const passwordError = setResidentPassword(resident.id, password);
    if (passwordError) return res.status(400).json({ error: passwordError });
  }

  db.prepare("UPDATE residents SET name = ?, email = ?, apartment_id = ? WHERE id = ?").run(
    name, email || null, apartment.id, resident.id
  );

  // Asukkaan tehtävät seuraavat asukasta uuteen asuntoon.
  db.prepare("UPDATE tickets SET apartment_id = ? WHERE resident_id = ? AND apartment_id = ?").run(
    apartment.id, resident.id, resident.apartment_id
  );

  res.json({ ok: true });
});

type ResidentRow = {
  id: string; company_id: string; apartment_id: string; name: string; email: string | null;
  moved_out_at: string | null; erased_at: string | null;
};

// Asukas, jonka tietoihin pyynnön tekijällä on oikeus ja jota ei ole jo poistettu.
function getAuthorizedResident(residentId: string) {
  const resident = db.prepare(
    "SELECT id, company_id, apartment_id, name, email, moved_out_at, erased_at FROM residents WHERE id = ?"
  ).get(residentId) as ResidentRow | undefined;
  return resident && !resident.erased_at && companyIdFromContext(resident.company_id) ? resident : null;
}

// Tehtävät, joissa asukas on yhteyshenkilö tai ilmoittaja.
function residentTicketIds(residentId: string) {
  return (db.prepare(`
    SELECT id FROM tickets
    WHERE resident_id = ? OR id IN (SELECT ticket_id FROM ticket_reporters WHERE resident_id = ?)
    ORDER BY created_at
  `).all(residentId, residentId) as { id: string }[]).map(ticket => ticket.id);
}

// Viestin lähettäjä on muotoa "Nimi <osoite>" tai pelkkä nimi.
function sentByResident(sender: string, resident: { name: string; email: string | null }) {
  const value = sender.toLowerCase();
  const name = resident.name.toLowerCase();
  return value === name || value.startsWith(`${name} <`)
    || Boolean(resident.email && value.includes(`<${resident.email.toLowerCase()}>`));
}

// Asukkaasta tallennetut tiedot yhtenä tiedostona (tietosuoja-asetuksen mukainen tietopyyntö).
// Mukana ovat asukkaan omat viestit ja hänelle lähetetyt vastaukset, ei sisäisiä muistiinpanoja.
app.get("/api/residents/:residentId/export", requireManager, (req, res) => {
  const resident = getAuthorizedResident(req.params.residentId);
  if (!resident) return res.status(404).json({ error: "Asukasta ei löytynyt." });

  const ticketIds = residentTicketIds(resident.id);
  const tickets = ticketIds.map(ticketId => ({
    ...(db.prepare(`
      SELECT ticket_number AS number, subject, type, status, source_channel AS channel, created_at, updated_at
      FROM tickets WHERE id = ?
    `).get(ticketId) as Record<string, unknown>),
    messages: (db.prepare(`
      SELECT direction, sender, subject, body, channel, created_at FROM messages
      WHERE ticket_id = ? AND channel != 'contractor' ORDER BY created_at
    `).all(ticketId) as { direction: string; sender: string }[])
      .filter(message => message.direction === "outbound" || sentByResident(message.sender, resident)),
    attachments: db.prepare(`
      SELECT filename, size, direction, created_at FROM attachments WHERE ticket_id = ? ORDER BY created_at
    `).all(ticketId)
  }));

  res.json({
    exported_at: now(),
    resident: {
      ...(db.prepare(`
        SELECT r.name, r.email, r.moved_out_at, c.name AS company, a.apartment_number, a.address
        FROM residents r
        JOIN companies c ON c.id = r.company_id
        JOIN apartments a ON a.id = r.apartment_id
        WHERE r.id = ?
      `).get(resident.id) as Record<string, unknown>),
      has_portal_account: Boolean(db.prepare("SELECT 1 FROM resident_credentials WHERE resident_id = ?").get(resident.id))
    },
    tickets,
    bookings: db.prepare("SELECT resource, starts_at, ends_at, note, created_at FROM bookings WHERE resident_id = ? ORDER BY starts_at").all(resident.id),
    parking: db.prepare(`
      SELECT p.label, p.type, pa.start_date, pa.end_date
      FROM parking_assignments pa JOIN parking_spaces p ON p.id = pa.parking_id
      WHERE pa.resident_id = ? ORDER BY pa.start_date
    `).all(resident.id),
    waitlist: db.prepare("SELECT resource, parking_type, note, status, created_at FROM waitlist WHERE resident_id = ? ORDER BY created_at").all(resident.id),
    move_notices: db.prepare(`
      SELECT move_date, moves_out, new_residents, door_name, note, status, created_at
      FROM move_notices WHERE resident_id = ? ORDER BY created_at
    `).all(resident.id)
  });
});

const ERASED_NAME = "Poistettu asukas";
const ERASED_TEXT = "[Poistettu]";

// Poistaa asukkaan henkilötiedot (tietosuoja-asetuksen mukainen poistopyyntö). Asukkaan rivi ja
// tehtävät jäävät tilastoihin ilman nimeä: viestit, liitteet, tunnukset, tulevat vuorot, jonot ja
// muuttoilmoitukset poistetaan. Jo laskutetuksi merkityt kuukaudet ovat kirjanpitoaineistoa ja säilyvät.
app.delete("/api/residents/:residentId", requireManager, async (req, res) => {
  const resident = getAuthorizedResident(req.params.residentId);
  if (!resident) return res.status(404).json({ error: "Asukasta ei löytynyt." });

  const date = today();
  const removedFiles: string[] = [];

  db.transaction(() => {
    for (const ticketId of residentTicketIds(resident.id)) {
      const others = db.prepare(`
        SELECT r.id, r.apartment_id FROM ticket_reporters tr JOIN residents r ON r.id = tr.resident_id
        WHERE tr.ticket_id = ? AND tr.resident_id != ? ORDER BY r.name
      `).all(ticketId, resident.id) as { id: string; apartment_id: string }[];

      if (others.length === 0) {
        // Asukkaan oma tehtävä: koko keskustelu ja asukkaan lähettämät liitteet poistetaan.
        db.prepare("UPDATE messages SET body = ? WHERE ticket_id = ? AND channel != 'contractor'").run(ERASED_TEXT, ticketId);
        db.prepare("UPDATE messages SET sender = ? WHERE ticket_id = ? AND direction = 'inbound'").run(ERASED_NAME, ticketId);
        db.prepare("UPDATE tickets SET draft = '' WHERE id = ?").run(ticketId);
        const files = db.prepare(
          "SELECT id FROM attachments WHERE ticket_id = ? AND direction IN ('inbound', 'portal')"
        ).all(ticketId) as { id: string }[];
        removedFiles.push(...files.map(file => file.id));
        db.prepare("DELETE FROM attachments WHERE ticket_id = ? AND direction IN ('inbound', 'portal')").run(ticketId);
      } else {
        // Yhteinen tehtävä: vain tämän asukkaan viestit poistetaan, ja tehtävä jää muille ilmoittajille.
        const messages = db.prepare(
          "SELECT id, sender FROM messages WHERE ticket_id = ? AND direction = 'inbound'"
        ).all(ticketId) as { id: string; sender: string }[];
        for (const message of messages.filter(item => sentByResident(item.sender, resident))) {
          db.prepare("UPDATE messages SET sender = ?, body = ? WHERE id = ?").run(ERASED_NAME, ERASED_TEXT, message.id);
        }
        db.prepare("DELETE FROM ticket_reporters WHERE ticket_id = ? AND resident_id = ?").run(ticketId, resident.id);
        db.prepare("UPDATE tickets SET resident_id = ?, apartment_id = ? WHERE id = ? AND resident_id = ?")
          .run(others[0].id, others[0].apartment_id, ticketId, resident.id);
      }

      db.prepare("UPDATE audit_log SET actor = ? WHERE ticket_id = ? AND actor = ?").run(ERASED_NAME, ticketId, resident.name);
      db.prepare(`
        UPDATE audit_log SET details = '{}'
        WHERE ticket_id = ? AND action IN ('reporter_linked', 'reply_received', 'reply_received_reopened')
      `).run(ticketId);
    }

    db.prepare("DELETE FROM resident_credentials WHERE resident_id = ?").run(resident.id);
    db.prepare("DELETE FROM resident_sessions WHERE resident_id = ?").run(resident.id);
    db.prepare("DELETE FROM password_resets WHERE kind = 'resident' AND subject_id = ?").run(resident.id);
    db.prepare("DELETE FROM bookings WHERE resident_id = ? AND starts_at >= ?").run(resident.id, now());
    db.prepare("UPDATE bookings SET note = '' WHERE resident_id = ?").run(resident.id);
    db.prepare("DELETE FROM waitlist WHERE resident_id = ?").run(resident.id);
    db.prepare("DELETE FROM move_notices WHERE resident_id = ?").run(resident.id);

    // Autopaikka vapautuu tänään; mennyt haltijajakso jää laskutusta varten ilman nimeä.
    db.prepare("UPDATE parking_assignments SET end_date = ? WHERE resident_id = ? AND (end_date IS NULL OR end_date > ?)")
      .run(date, resident.id, date);
    db.prepare("DELETE FROM parking_assignments WHERE resident_id = ? AND end_date <= start_date").run(resident.id);
    db.prepare("UPDATE parking_spaces SET resident_id = NULL WHERE resident_id = ?").run(resident.id);

    db.prepare("UPDATE residents SET name = ?, email = NULL, moved_out_at = ?, erased_at = ? WHERE id = ?").run(
      ERASED_NAME,
      resident.moved_out_at && resident.moved_out_at < date ? resident.moved_out_at : date,
      now(),
      resident.id
    );

    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), null, res.locals.user?.name ?? "Isännöitsijä", "resident_erased",
      JSON.stringify({ resident_id: resident.id, company_id: resident.company_id }), now()
    );
  })();

  for (const fileId of removedFiles) await fs.rm(path.join(attachmentsDir, fileId), { force: true });

  res.json({ ok: true });
});

app.get("/api/tickets", (req, res) => {
  const companyId = companyIdFromContext(req.query.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const rows = db.prepare(`
    SELECT t.*, r.name AS resident_name, a.apartment_number, ${NEW_REPLY_SQL} AS has_new_reply, ${AI_SUGGESTED_SQL} AS ai_suggested
    FROM tickets t
    LEFT JOIN residents r ON r.id = t.resident_id
    LEFT JOIN apartments a ON a.id = t.apartment_id
    WHERE t.company_id = ?
    ORDER BY
      CASE t.priority
        WHEN 'emergency' THEN 1
        WHEN 'urgent' THEN 2
        WHEN 'normal' THEN 3
        ELSE 4
      END,
      t.created_at DESC
  `).all(companyId);
  res.json(rows);
});

app.post("/api/tickets", (req, res) => {
  const schema = z.object({
    companyId: z.string().default(DEFAULT_COMPANY_ID),
    subject: z.string().min(1),
    summary: z.string().min(1),
    type: z.string().default("Ilmoitus"),
    priority: z.enum(["emergency", "urgent", "normal", "low"]).default("normal"),
    residentName: z.string().optional(),
    apartmentNumber: z.string().optional(),
    sourceChannel: z.string().default("manual")
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const companyId = companyIdFromContext(parsed.data.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const company = db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId) as { id: string } | undefined;
  if (!company) return res.status(404).json({ error: "Company not found" });

  const ticketId = id("ticket");
  const timestamp = now();
  const apartment = parsed.data.apartmentNumber
    ? db.prepare("SELECT id FROM apartments WHERE company_id = ? AND apartment_number = ?").get(companyId, parsed.data.apartmentNumber) as { id: string } | undefined
    : undefined;
  const resident = parsed.data.residentName
    ? db.prepare("SELECT id FROM residents WHERE company_id = ? AND lower(name) = lower(?)").get(companyId, parsed.data.residentName) as { id: string } | undefined
    : undefined;

  db.prepare(`
    INSERT INTO tickets
    (id, company_id, apartment_id, resident_id, type, priority, status, subject, summary,
     source_channel, ai_action, ai_reason, draft, created_at, updated_at, assignee_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticketId,
    companyId,
    apartment?.id ?? null,
    resident?.id ?? null,
    parsed.data.type,
    parsed.data.priority,
    "waiting_manager",
    parsed.data.subject,
    parsed.data.summary,
    parsed.data.sourceChannel,
    "human",
    "Manuaalinen tehtävä",
    "",
    timestamp,
    timestamp,
    // Käsin luotu tehtävä on luojansa käsittelyssä.
    res.locals.user?.id ?? null
  );

  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"),
    ticketId,
    "isannoitsija",
    "ticket_created_manual",
    JSON.stringify({ subject: parsed.data.subject, source_channel: parsed.data.sourceChannel }),
    timestamp
  );

  res.status(201).json({ ok: true, ticketId, status: "waiting_manager" });
});

app.get("/api/my-tickets", (req, res) => {
  const companyId = companyIdFromContext(req.query.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const rows = db.prepare(`
    SELECT t.*, r.name AS resident_name, a.apartment_number, ${NEW_REPLY_SQL} AS has_new_reply, ${AI_SUGGESTED_SQL} AS ai_suggested
    FROM tickets t
    LEFT JOIN residents r ON r.id = t.resident_id
    LEFT JOIN apartments a ON a.id = t.apartment_id
    WHERE t.company_id = ?
      -- Myös kolmatta osapuolta (esim. huoltoyhtiötä) odottava tehtävä pysyy käsittelijänsä omissa.
      AND t.status IN ('waiting_manager', 'waiting_third_party')
      AND t.assignee_id = ?
    ORDER BY t.updated_at DESC
  `).all(companyId, res.locals.user?.id ?? "");
  res.json(rows);
});

app.get("/api/decision-queue", (req, res) => {
  const companyId = companyIdFromContext(req.query.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const rows = db.prepare(`
    SELECT t.*, r.name AS resident_name, a.apartment_number, ${NEW_REPLY_SQL} AS has_new_reply, ${AI_SUGGESTED_SQL} AS ai_suggested
    FROM tickets t
    LEFT JOIN residents r ON r.id = t.resident_id
    LEFT JOIN apartments a ON a.id = t.apartment_id
    WHERE t.company_id = ?
      AND t.status = 'open'
    ORDER BY t.priority = 'emergency' DESC, t.created_at DESC
  `).all(companyId);
  res.json(rows);
});

app.get("/api/tickets/:id", (req, res) => {
  if (!getAuthorizedTicket(req.params.id)) {
    return res.status(404).json({ error: "Ticket not found" });
  }
  const ticket = db.prepare(`
    SELECT t.*, r.name AS resident_name, a.apartment_number, c.name AS company_name
    FROM tickets t
    LEFT JOIN residents r ON r.id = t.resident_id
    LEFT JOIN apartments a ON a.id = t.apartment_id
    LEFT JOIN companies c ON c.id = t.company_id
    WHERE t.id = ?
  `).get(req.params.id);

  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const messages = db.prepare(
    "SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at"
  ).all(req.params.id);

  const audit = db.prepare(
    "SELECT * FROM audit_log WHERE ticket_id = ? ORDER BY created_at DESC"
  ).all(req.params.id);

  const reporters = db.prepare(`
    SELECT r.id, r.name, r.email, a.apartment_number
    FROM ticket_reporters tr
    JOIN residents r ON r.id = tr.resident_id
    LEFT JOIN apartments a ON a.id = r.apartment_id
    WHERE tr.ticket_id = ?
    ORDER BY r.name
  `).all(req.params.id);

  const apartments = db.prepare(`
    SELECT a.id, a.apartment_number, a.address
    FROM apartments a
    WHERE a.id = (SELECT apartment_id FROM tickets WHERE id = ?)
       OR a.id IN (
         SELECT r.apartment_id
         FROM ticket_reporters tr
         JOIN residents r ON r.id = tr.resident_id
         WHERE tr.ticket_id = ?
       )
    ORDER BY a.apartment_number
  `).all(req.params.id, req.params.id);

  const notes = db.prepare(
    "SELECT * FROM ticket_notes WHERE ticket_id = ? ORDER BY created_at"
  ).all(req.params.id);

  const attachments = db.prepare(
    "SELECT * FROM attachments WHERE ticket_id = ? ORDER BY created_at, filename"
  ).all(req.params.id);

  const workOrders = db.prepare(
    "SELECT * FROM work_orders WHERE ticket_id = ? ORDER BY ordered_at DESC"
  ).all(req.params.id);

  // Huoltoyhtiön yhteystiedot työtilausta varten.
  const contractor = db.prepare(
    "SELECT maintenance_name AS name, maintenance_email AS email, maintenance_phone AS phone FROM companies WHERE id = (SELECT company_id FROM tickets WHERE id = ?)"
  ).get(req.params.id);

  res.json({ ticket, messages, audit, reporters, apartments, notes, attachments, workOrders, contractor });
});

app.put("/api/tickets/:id/fields", (req, res) => {
  const schema = z.object({
    type: z.string().trim().min(1).max(60).optional(),
    priority: z.enum(["emergency", "urgent", "normal", "low"]).optional(),
    // Käsittelijä: toimiston käyttäjän tunniste, null = ei käsittelijää.
    assigneeId: z.string().nullable().optional(),
    // Määräaika VVVV-KK-PP, null = ei määräaikaa.
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    actor: z.string().default("isannoitsija")
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista tyyppi, prioriteetti ja määräaika." });

  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  if (parsed.data.assigneeId !== undefined && parsed.data.assigneeId !== (ticket.assignee_id ?? null)) {
    const assignee = parsed.data.assigneeId
      ? db.prepare("SELECT id, name FROM users WHERE id = ?").get(parsed.data.assigneeId) as { id: string; name: string } | undefined
      : undefined;
    if (parsed.data.assigneeId && !assignee) return res.status(404).json({ error: "Käyttäjää ei löytynyt." });
    // Tehtävän saa antaa toiselle taloyhtiön vastuuisännöitsijä tai pääkäyttäjä. Jos taloyhtiöllä ei
    // ole vastuuisännöitsijää, jakaminen on sallittu kaikille, jotta tehtävät eivät jää jumiin.
    const company = db.prepare("SELECT manager_id FROM companies WHERE id = ?").get(ticket.company_id) as { manager_id: string | null };
    if (company.manager_id && company.manager_id !== res.locals.user?.id && !isAdmin(res)) {
      return res.status(403).json({ error: "Vain taloyhtiön vastuuisännöitsijä voi antaa tehtävän toiselle." });
    }
    const assignedAt = now();
    // Käsittelijän vaihto ei muuta tilaa: avoin tehtävä pysyy päätösjonossa uuden käsittelijän nimissä.
    db.prepare("UPDATE tickets SET assignee_id = ?, updated_at = ? WHERE id = ?").run(
      assignee?.id ?? null, assignedAt, req.params.id
    );
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), req.params.id, res.locals.user?.name ?? parsed.data.actor, "ticket_assigned",
      JSON.stringify({ to: assignee?.name ?? null }), assignedAt
    );
  }

  const type = parsed.data.type ?? ticket.type;
  const priority = parsed.data.priority ?? ticket.priority;
  const dueDate = parsed.data.dueDate === undefined ? ticket.due_date ?? null : parsed.data.dueDate;
  if (type === ticket.type && priority === ticket.priority && dueDate === (ticket.due_date ?? null)) {
    return res.json({ ok: true });
  }

  const timestamp = now();
  db.prepare("UPDATE tickets SET type = ?, priority = ?, due_date = ?, updated_at = ? WHERE id = ?").run(
    type, priority, dueDate, timestamp, req.params.id
  );
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"),
    req.params.id,
    parsed.data.actor,
    "ticket_updated",
    JSON.stringify({
      type: type === ticket.type ? undefined : { from: ticket.type, to: type },
      priority: priority === ticket.priority ? undefined : { from: ticket.priority, to: priority },
      due_date: dueDate === (ticket.due_date ?? null) ? undefined : { from: ticket.due_date ?? null, to: dueDate }
    }),
    timestamp
  );

  res.json({ ok: true });
});

app.post("/api/tickets/:id/reporters", (req, res) => {
  const schema = z.object({
    residentId: z.string().min(1),
    actor: z.string().default("isannoitsija")
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const resident = db.prepare(
    "SELECT id, name, apartment_id FROM residents WHERE id = ? AND company_id = ?"
  ).get(parsed.data.residentId, ticket.company_id) as
    | { id: string; name: string; apartment_id: string }
    | undefined;
  if (!resident) return res.status(404).json({ error: "Asukasta ei löytynyt tästä yhtiöstä." });

  const timestamp = now();
  const result = db.prepare(
    "INSERT OR IGNORE INTO ticket_reporters (ticket_id, resident_id) VALUES (?, ?)"
  ).run(req.params.id, resident.id);

  // Tehtävällä on yksi ilmoittaja: yhteyshenkilö ja asunto seuraavat aina viimeksi valittua asukasta.
  db.prepare(`
    UPDATE tickets
    SET resident_id = ?,
        apartment_id = ?,
        updated_at = ?
    WHERE id = ?
  `).run(resident.id, resident.apartment_id, timestamp, req.params.id);

  if (result.changes > 0) {
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"),
      req.params.id,
      parsed.data.actor,
      "reporter_linked",
      JSON.stringify({ resident_id: resident.id, name: resident.name }),
      timestamp
    );
  }

  res.status(201).json({ ok: true });
});

app.delete("/api/tickets/:id/reporters/:residentId", (req, res) => {
  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const result = db.prepare(
    "DELETE FROM ticket_reporters WHERE ticket_id = ? AND resident_id = ?"
  ).run(req.params.id, req.params.residentId);
  if (result.changes === 0) return res.status(404).json({ error: "Reporter not linked" });

  const timestamp = now();

  if (ticket.resident_id === req.params.residentId) {
    const removed = db.prepare("SELECT apartment_id FROM residents WHERE id = ?")
      .get(req.params.residentId) as { apartment_id: string } | undefined;
    const next = db.prepare(`
      SELECT r.id, r.apartment_id
      FROM ticket_reporters tr
      JOIN residents r ON r.id = tr.resident_id
      WHERE tr.ticket_id = ?
      ORDER BY r.name
      LIMIT 1
    `).get(req.params.id) as { id: string; apartment_id: string } | undefined;

    db.prepare("UPDATE tickets SET resident_id = ?, apartment_id = ? WHERE id = ?").run(
      next?.id ?? null,
      ticket.apartment_id === removed?.apartment_id ? next?.apartment_id ?? null : ticket.apartment_id,
      req.params.id
    );
  }

  db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(timestamp, req.params.id);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"),
    req.params.id,
    typeof req.query.actor === "string" && req.query.actor ? req.query.actor : "isannoitsija",
    "reporter_unlinked",
    JSON.stringify({ resident_id: req.params.residentId }),
    timestamp
  );

  res.json({ ok: true });
});

app.post("/api/tickets/:id/notes", (req, res) => {
  const schema = z.object({
    body: z.string().trim().min(1),
    author: z.string().default("isannoitsija")
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  if (!getAuthorizedTicket(req.params.id)) {
    return res.status(404).json({ error: "Ticket not found" });
  }

  const timestamp = now();
  db.prepare("INSERT INTO ticket_notes VALUES (?, ?, ?, ?, ?)").run(
    id("note"),
    req.params.id,
    parsed.data.author,
    parsed.data.body,
    timestamp
  );
  db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(timestamp, req.params.id);

  res.status(201).json({ ok: true });
});

app.get("/api/attachments/:id", (req, res) => {
  const attachment = db.prepare("SELECT * FROM attachments WHERE id = ?")
    .get(req.params.id) as { id: string; ticket_id: string; filename: string } | undefined;

  if (!attachment || !getAuthorizedTicket(attachment.ticket_id)) {
    return res.status(404).json({ error: "Attachment not found" });
  }

  res.download(path.join(attachmentsDir, attachment.id), attachment.filename, {
    headers: { "Content-Type": "application/octet-stream" }
  });
});

app.post("/api/inbound/messages", async (req, res) => {
  const parsed = inboundSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const input = parsed.data;
  const companyId = companyIdForRecipients(input.recipientEmails)
    ?? companyIdFromContext(input.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

if (input.sourceMessageId) {
  const existing = db.prepare(
    "SELECT ticket_id FROM gmail_imports WHERE gmail_message_id = ?"
  ).get(input.sourceMessageId) as
    | { ticket_id: string }
    | undefined;

  if (existing) {
    return res.json({
      ticketId: existing.ticket_id,
      duplicate: true
    });
  }
}

  // Vastaus ketjuun, jolla on jo tehtävä, lisätään sen tehtävän aikajanalle uuden tehtävän sijaan.
  const threadIds = input.threadMessageIds ?? [];
  if (threadIds.length > 0) {
    const linked = db.prepare(`
      SELECT ticket_id FROM gmail_imports
      WHERE gmail_message_id IN (${threadIds.map(() => "?").join(", ")})
      ORDER BY created_at
      LIMIT 1
    `).get(...threadIds) as { ticket_id: string } | undefined;
    const existingTicket = linked && getAuthorizedTicket(linked.ticket_id) as any;

    if (existingTicket) {
      const timestamp = now();
      // Suljettu tehtävä avataan uudelleen päätösjonoon; muuten se pysyy nykyisellä käsittelijällään.
      const reopened = existingTicket.status === "closed";

      db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        id("message"),
        existingTicket.id,
        "inbound",
        input.senderEmail ? `${input.senderName} <${input.senderEmail}>` : input.senderName,
        input.subject,
        input.body,
        timestamp,
        input.channel
      );

      db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(
        reopened ? "open" : existingTicket.status,
        timestamp,
        existingTicket.id
      );

      db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
        id("audit"),
        existingTicket.id,
        "system",
        reopened ? "reply_received_reopened" : "reply_received",
        JSON.stringify({ sender: input.senderEmail ?? input.senderName }),
        timestamp
      );

      if (input.sourceMessageId) {
        db.prepare(`
          INSERT INTO gmail_imports
            (gmail_message_id, ticket_id, created_at)
          VALUES (?, ?, ?)
        `).run(input.sourceMessageId, existingTicket.id, timestamp);
      }

      return res.status(201).json({ ticketId: existingTicket.id, appended: true, reopened });
    }
  }

  const company = db.prepare("SELECT * FROM companies WHERE id = ?")
    .get(companyId) as any;
  if (!company) return res.status(404).json({ error: "Company not found" });

  const knowledge = getKnowledge(companyId);

  const resident = findResident(
    companyId,
    input.senderEmail,
    input.senderName
  );

  // Saapuva viesti vain luokitellaan. Dokumentaatiota ei haeta eikä ehdoteta ennen kuin
  // käsittelijä pyytää tehtävällä AI-ehdotuksen.
  const result = await triage(
    input.subject,
    input.body,
    [],
    company.maintenance_emergency_phone || undefined
  );
  const source = knowledge.find(item => item.id === result.sourceId);

  const ticketId = id("ticket");
  const messageId = id("message");
  const auditId = id("audit");
  const timestamp = now();

  db.prepare(`
    INSERT INTO tickets
    (id, company_id, apartment_id, resident_id, type, priority, status, subject,
     summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticketId,
    companyId,
    resident?.apartment_id ?? null,
    resident?.id ?? null,
    result.type,
    result.priority,
    "open",
    input.subject,
    result.summary,
    input.channel,
    result.emergency ? "emergency" : "pending_decision",
    result.reason,
    // Vastauskenttä alkaa tyhjänä; luonnos syntyy vasta käsittelijän tai AI-ehdotuksen kautta.
    "",
    timestamp,
    timestamp
  );

  assignToCompanyManager(ticketId, companyId);

  if (source) {
    db.prepare(
      "UPDATE tickets SET knowledge_source_id = ?, knowledge_source_title = ? WHERE id = ?"
    ).run(source.id, source.title, ticketId);
  }

  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    messageId,
    ticketId,
    "inbound",
    input.senderEmail
      ? `${input.senderName} <${input.senderEmail}>`
      : input.senderName,
    input.subject,
    input.body,
    timestamp,
    input.channel
  );

  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    auditId,
    ticketId,
    "ai",
    result.emergency ? "emergency_routed" : "triaged",
    JSON.stringify(result),
    timestamp
  );

if (input.sourceMessageId) {
  db.prepare(`
    INSERT INTO gmail_imports
      (gmail_message_id, ticket_id, created_at)
    VALUES (?, ?, ?)
  `).run(input.sourceMessageId, ticketId, timestamp);
}

  res.status(201).json({
    ticketId,
    emergency: result.emergency,
    action: result.emergency ? "emergency_routed" : "decision_queue"
  });
});

app.post("/api/tickets/:id/decision", (req, res) => {
  const schema = z.discriminatedUnion("decision", [
    z.object({
      decision: z.literal("skip"),
      reason: z.enum(["already_handled", "no_action_required", "spam"]),
      actor: z.string().default("isannoitsija")
    }),
    z.object({
      decision: z.enum(["ai", "human"]),
      actor: z.string().default("isannoitsija")
    })
  ]);

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const ticket = getAuthorizedTicket(req.params.id) as any;

  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const timestamp = now();

  let status = ticket.status;
  if (parsed.data.decision === "skip") status = "closed";
  if (parsed.data.decision === "human") status = "waiting_manager";
  if (parsed.data.decision === "ai") status = "waiting_third_party";

  db.prepare(`
    UPDATE tickets
    SET ai_action = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(parsed.data.decision, status, timestamp, req.params.id);

  // "Osoita minulle" tekee päätöksen tekijästä tehtävän käsittelijän.
  if (parsed.data.decision === "human") {
    db.prepare("UPDATE tickets SET assignee_id = ? WHERE id = ?").run(res.locals.user?.id ?? null, req.params.id);
  }

  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"),
    req.params.id,
    parsed.data.actor,
    `decision_${parsed.data.decision}`,
    JSON.stringify({
      decision: parsed.data.decision,
      ...(parsed.data.decision === "skip" ? { reason: parsed.data.reason } : {})
    }),
    timestamp
  );

  // Sulkemisesta ilmoitetaan tehtävän ilmoittajille (ei roskapostiksi merkityistä).
  if (parsed.data.decision === "skip" && parsed.data.reason !== "spam" && ticket.status !== "closed") {
    const reporters = db.prepare("SELECT resident_id FROM ticket_reporters WHERE ticket_id = ?").all(req.params.id) as { resident_id: string }[];
    const number = String(ticket.ticket_number ?? "").padStart(4, "0");
    for (const reporter of reporters) {
      void notifyResident(reporter.resident_id, `Tehtävä #${number} on suljettu`, [
        `ilmoittamasi tehtävä "${ticket.subject}" (#${number}) on käsitelty ja suljettu.`,
        "Jos asia ei ole kunnossa, vastaa tähän viestiin tai lähetä uusi viesti asukasportaalista, niin tehtävä avataan uudelleen."
      ]);
    }
  }

  res.json({ ok: true, status });
});

// Pyytää AI:lta uuden vastausehdotuksen yhtiön dokumentaation pohjalta. Ehdotuksen peruste ja
// lähde tallennetaan tehtävälle; itse luonnos palautetaan käsittelijän muokattavaksi eikä sitä
// tallenneta ennen kuin käsittelijä tallentaa sen.
app.post("/api/tickets/:id/suggest", async (req, res) => {
  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const alreadySuggested = db.prepare(
    "SELECT 1 FROM audit_log WHERE ticket_id = ? AND action = 'ai_suggested' LIMIT 1"
  ).get(req.params.id);
  if (alreadySuggested) {
    return res.status(409).json({ error: "AI-ehdotus on jo pyydetty tälle tehtävälle." });
  }

  const messages = db.prepare(
    "SELECT direction, body FROM messages WHERE ticket_id = ? ORDER BY created_at"
  ).all(req.params.id) as { direction: string; body: string }[];
  const conversation = messages.length
    ? messages
        .slice(-6)
        .map(message => `${message.direction === "inbound" ? "Asukas" : "Isännöinti"}: ${message.body.slice(0, 2000)}`)
        .join("\n\n")
    : ticket.summary;

  const knowledge = getKnowledge(ticket.company_id);
  const suggestion = await suggestReply(ticket.subject, conversation, knowledge);
  const source = knowledge.find(item => item.id === suggestion.sourceId) ?? null;
  const timestamp = now();

  db.prepare(`
    UPDATE tickets
    SET ai_reason = ?, knowledge_source_id = ?, knowledge_source_title = ?, updated_at = ?
    WHERE id = ?
  `).run(suggestion.reason, source?.id ?? null, source?.title ?? null, timestamp, req.params.id);

  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"),
    req.params.id,
    "ai",
    "ai_suggested",
    JSON.stringify({ source_id: source?.id ?? null, used_ai: suggestion.usedAi }),
    timestamp
  );

  res.json({
    draft: suggestion.draft,
    reason: suggestion.reason,
    source: source ? { id: source.id, title: source.title } : null,
    usedAi: suggestion.usedAi
  });
});

app.post("/api/tickets/:id/draft", (req, res) => {
  const schema = z.object({
    draft: z.string().default("")
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const timestamp = now();

  db.prepare(`
    UPDATE tickets
    SET draft = ?, updated_at = ?
    WHERE id = ?
  `).run(parsed.data.draft, timestamp, req.params.id);

  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"),
    req.params.id,
    "isannoitsija",
    "draft_saved",
    JSON.stringify({ draft_length: parsed.data.draft.length }),
    timestamp
  );

  res.json({ ok: true, draft: parsed.data.draft });
});

app.post("/api/tickets/:id/message", (req, res) => {
  const schema = z.object({
    sender: z.string().default("Kotilo"),
    subject: z.string().default("Kotilo"),
    body: z.string().min(1),
    channel: z.enum(["email", "portal", "quick_note"]).default("portal")
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const timestamp = now();
  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id("message"),
    req.params.id,
    "outbound",
    parsed.data.sender,
    parsed.data.subject,
    parsed.data.body,
    timestamp,
    parsed.data.channel
  );

  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"),
    req.params.id,
    parsed.data.sender,
    "message_created",
    JSON.stringify({ subject: parsed.data.subject }),
    timestamp
  );

  res.json({ ok: true });
});

const MAX_REPLY_ATTACHMENTS = 10;
const MAX_REPLY_ATTACHMENT_BYTES = 15 * 1024 * 1024;

app.post("/api/tickets/:id/reply", async (req, res) => {
  const schema = z.object({
    body: z.string().trim().min(1),
    actor: z.string().default("isannoitsija"),
    // Aikajanan viesti, johon vastataan. Ilman tätä vastataan tehtävän viimeisimpään saapuneeseen viestiin.
    messageId: z.string().optional(),
    attachments: z.array(z.object({
      filename: z.string().trim().min(1).max(200),
      mimeType: z.string().max(120).default("application/octet-stream"),
      data: z.string()
    })).max(MAX_REPLY_ATTACHMENTS).optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `Vastaus ei voi olla tyhjä, ja liitteitä voi olla enintään ${MAX_REPLY_ATTACHMENTS}.` });
  }

  const outgoing: OutgoingAttachment[] = (parsed.data.attachments ?? []).map(attachment => ({
    filename: attachment.filename,
    mimeType: attachment.mimeType || "application/octet-stream",
    content: Buffer.from(attachment.data, "base64")
  }));
  if (outgoing.some(attachment => attachment.content.length === 0)) {
    return res.status(400).json({ error: "Liitetiedosto on tyhjä tai sitä ei voitu lukea." });
  }
  if (outgoing.reduce((total, attachment) => total + attachment.content.length, 0) > MAX_REPLY_ATTACHMENT_BYTES) {
    return res.status(413).json({ error: "Liitteiden yhteiskoko saa olla enintään 15 Mt." });
  }

  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  type InboundRow = { sender: string; subject: string; created_at: string };
  const inbound = parsed.data.messageId
    ? db.prepare(`
        SELECT sender, subject, created_at
        FROM messages
        WHERE id = ? AND ticket_id = ? AND direction = 'inbound'
      `).get(parsed.data.messageId, req.params.id) as InboundRow | undefined
    : db.prepare(`
        SELECT sender, subject, created_at
        FROM messages
        WHERE ticket_id = ? AND direction = 'inbound'
        ORDER BY created_at DESC
        LIMIT 1
      `).get(req.params.id) as InboundRow | undefined;

  if (parsed.data.messageId && !inbound) {
    return res.status(404).json({ error: "Viestiä, johon vastataan, ei löytynyt tältä tehtävältä." });
  }

  // Vastaus lähtee ensisijaisesti alkuperäisen viestin lähettäjälle. Jos tehtävällä ei ole
  // saapunutta sähköpostia, se lähtee tehtävään linkitettyjen asukkaiden osoitteisiin.
  const replyTo = inbound ? parseSender(inbound.sender).email : "";
  const reporterEmails = replyTo ? [] : (db.prepare(`
    SELECT r.email
    FROM ticket_reporters tr
    JOIN residents r ON r.id = tr.resident_id
    WHERE tr.ticket_id = ? AND r.email IS NOT NULL AND trim(r.email) != ''
    ORDER BY r.name
  `).all(req.params.id) as { email: string }[])
    .map(row => row.email.trim())
    .filter(email => /^[^\s<>,;@]+@[^\s<>,;@]+$/.test(email));

  const recipient = replyTo || reporterEmails.join(", ");
  if (!recipient) {
    return res.status(400).json({
      error: "Tehtävällä ei ole sähköpostiosoitetta, johon vastauksen voisi lähettää."
    });
  }

  // Vastaus ketjutetaan siihen Gmail-viestiin, johon vastataan. Viestin ja sen Gmail-tunnisteen
  // yhdistää sama tallennushetki; vanhoilla viesteillä käytetään tehtävän ensimmäistä tuontia.
  const gmailImport = replyTo && inbound
    ? (db.prepare(
        "SELECT gmail_message_id FROM gmail_imports WHERE ticket_id = ? AND created_at = ?"
      ).get(req.params.id, inbound.created_at)
      ?? db.prepare(
        "SELECT gmail_message_id FROM gmail_imports WHERE ticket_id = ? ORDER BY created_at LIMIT 1"
      ).get(req.params.id)) as { gmail_message_id: string } | undefined
    : undefined;

  const subject = !replyTo || !inbound
    ? ticket.subject as string
    : /^re:/i.test(inbound.subject.trim()) ? inbound.subject : `Re: ${inbound.subject}`;

  let sentMessageId = "";
  try {
    const sent = await sendGmailReply({
      to: recipient,
      subject,
      body: parsed.data.body,
      sourceMessageId: gmailImport?.gmail_message_id,
      attachments: outgoing,
      companyId: ticket.company_id
    });
    sentMessageId = sent.id;
  } catch (error: any) {
    console.error("Vastauksen lähetys epäonnistui:", error?.message ?? error);
    const status = error?.status ?? error?.response?.status;
    return res.status(502).json({
      error: status === 403
        ? "Gmail-valtuutuksesta puuttuu lähetysoikeus. Aja server-kansiossa 'node gmail-auth.js' ja kirjaudu uudelleen."
        : "Sähköpostin lähetys epäonnistui. Yritä uudelleen."
    });
  }

  const timestamp = now();

  // Lähetetty viesti kirjataan ketjuun, jotta asukkaan vastaus siihen löytää tämän tehtävän
  // silloinkin, kun tehtävä ei alun perin tullut sähköpostista.
  if (sentMessageId) {
    db.prepare(`
      INSERT OR IGNORE INTO gmail_imports
        (gmail_message_id, ticket_id, created_at)
      VALUES (?, ?, ?)
    `).run(sentMessageId, req.params.id, timestamp);
  }

  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id("message"),
    req.params.id,
    "outbound",
    parsed.data.actor,
    subject,
    parsed.data.body,
    timestamp,
    "email"
  );

  // Lähetetyt liitteet tallennetaan tehtävän liitteisiin samaan paikkaan kuin saapuneet.
  for (const attachment of outgoing) {
    const attachmentId = id("attachment");
    await fs.writeFile(path.join(attachmentsDir, attachmentId), attachment.content);
    db.prepare(`
      INSERT INTO attachments (id, ticket_id, filename, mime_type, size, created_at, direction)
      VALUES (?, ?, ?, ?, ?, ?, 'outbound')
    `).run(attachmentId, req.params.id, attachment.filename, attachment.mimeType, attachment.content.length, timestamp);
  }

  db.prepare(`
    UPDATE tickets
    SET draft = '', updated_at = ?
    WHERE id = ?
  `).run(timestamp, req.params.id);

  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"),
    req.params.id,
    parsed.data.actor,
    "reply_sent",
    JSON.stringify({ to: recipient, subject }),
    timestamp
  );

  res.json({ ok: true, to: recipient });
});


// ---------------------------------------------------------------------------------------------
// Työtilaukset: tehtävältä huoltoyhtiölle lähetettävä tilaus ja sen kuittaus tehdyksi.
// ---------------------------------------------------------------------------------------------
const WORK_ORDER_SELECT = `
  SELECT w.*, t.subject AS ticket_subject, t.ticket_number
  FROM work_orders w
  JOIN tickets t ON t.id = w.ticket_id
`;

const VALID_EMAIL = /^[^\s<>,;@]+@[^\s<>,;@]+$/;

app.get("/api/companies/:companyId/work-orders", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare(`${WORK_ORDER_SELECT} WHERE w.company_id = ? ORDER BY w.ordered_at DESC`).all(companyId));
});

app.post("/api/tickets/:id/work-orders", async (req, res) => {
  const parsed = z.object({
    description: z.string().trim().min(3).max(4000),
    // Tehtävän liitteet, jotka lähetetään tilauksen mukana.
    attachmentIds: z.array(z.string()).max(10).default([]),
    // false = tilaus vain kirjataan (esim. tilattu puhelimitse), sähköpostia ei lähetetä.
    sendEmail: z.boolean().default(true)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita työtilaukselle kuvaus." });

  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const company = db.prepare(
    "SELECT name, address, maintenance_name, maintenance_email, maintenance_phone FROM companies WHERE id = ?"
  ).get(ticket.company_id) as
    { name: string; address: string; maintenance_name: string; maintenance_email: string; maintenance_phone: string };
  const contractorEmail = company.maintenance_email.trim();
  const contractorName = company.maintenance_name.trim() || "Huoltoyhtiö";
  if (parsed.data.sendEmail && !VALID_EMAIL.test(contractorEmail)) {
    return res.status(400).json({ error: "Taloyhtiölle ei ole tallennettu huoltoyhtiön sähköpostia. Lisää se taloyhtiön tietoihin." });
  }

  const apartment = ticket.apartment_id
    ? db.prepare("SELECT apartment_number, address FROM apartments WHERE id = ?").get(ticket.apartment_id) as
      { apartment_number: string; address: string | null } | undefined
    : undefined;
  const reporter = db.prepare(`
    SELECT r.name FROM ticket_reporters tr JOIN residents r ON r.id = tr.resident_id
    WHERE tr.ticket_id = ? ORDER BY r.name LIMIT 1
  `).get(req.params.id) as { name: string } | undefined;

  const actor = res.locals.user?.name ?? "Isännöitsijä";
  const number = String(ticket.ticket_number ?? "").padStart(4, "0");
  const subject = `Työtilaus: ${ticket.subject} (${company.name}, tehtävä #${number})`;
  const body = [
    "Hei,",
    "",
    "tilaamme seuraavan työn:",
    "",
    parsed.data.description,
    "",
    `Taloyhtiö: ${company.name}`,
    `Osoite: ${apartment?.address || company.address || "-"}`,
    `Asunto: ${apartment?.apartment_number || "-"}`,
    ...(reporter ? [`Asukas: ${reporter.name}`] : []),
    `Tehtävä: #${number}`,
    "",
    "Kuittaathan vastaamalla tähän viestiin, kun työ on tehty.",
    "",
    "Ystävällisin terveisin",
    actor
  ].join("\n");

  const timestamp = now();
  let emailSent = false;
  if (parsed.data.sendEmail) {
    const outgoing: OutgoingAttachment[] = [];
    for (const attachmentId of parsed.data.attachmentIds) {
      const row = db.prepare("SELECT id, filename, mime_type FROM attachments WHERE id = ? AND ticket_id = ?")
        .get(attachmentId, req.params.id) as { id: string; filename: string; mime_type: string } | undefined;
      if (!row) return res.status(404).json({ error: "Liitettä ei löytynyt tältä tehtävältä." });
      outgoing.push({ filename: row.filename, mimeType: row.mime_type, content: await fs.readFile(path.join(attachmentsDir, row.id)) });
    }
    try {
      const sent = await sendGmailReply({ to: contractorEmail, subject, body, attachments: outgoing, companyId: ticket.company_id });
      // Huoltoyhtiön vastaus tähän viestiin ohjautuu samalle tehtävälle.
      db.prepare("INSERT OR IGNORE INTO gmail_imports (gmail_message_id, ticket_id, created_at) VALUES (?, ?, ?)")
        .run(sent.id, req.params.id, timestamp);
      emailSent = true;
    } catch (error: any) {
      console.error("Työtilauksen lähetys epäonnistui:", error?.message ?? error);
      return res.status(502).json({ error: "Työtilauksen lähetys sähköpostilla epäonnistui. Yritä uudelleen." });
    }
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id("message"), req.params.id, "outbound", actor, subject, body, timestamp, "contractor"
    );
  }

  const workOrderId = id("workorder");
  db.prepare(`
    INSERT INTO work_orders
      (id, ticket_id, company_id, contractor_name, contractor_email, description, status, email_sent, ordered_by, ordered_at)
    VALUES (?, ?, ?, ?, ?, ?, 'ordered', ?, ?, ?)
  `).run(workOrderId, req.params.id, ticket.company_id, contractorName, contractorEmail, parsed.data.description,
    emailSent ? 1 : 0, actor, timestamp);

  // Tehtävä odottaa nyt huoltoyhtiötä.
  if (ticket.status !== "closed") {
    db.prepare("UPDATE tickets SET status = 'waiting_third_party', updated_at = ? WHERE id = ?").run(timestamp, req.params.id);
  }
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), req.params.id, actor, "work_order_created",
    JSON.stringify({ contractor: contractorName, to: emailSent ? contractorEmail : null }), timestamp
  );

  res.status(201).json({ ok: true, workOrderId, emailSent });
});

// Tiedoston liittäminen suoraan tehtävälle (ei lähetä mitään). Sallittu tehtävän tilasta riippumatta.
app.post("/api/tickets/:id/attachments", async (req, res) => {
  const parsed = z.object({
    attachments: z.array(z.object({
      filename: z.string().trim().min(1).max(200),
      mimeType: z.string().max(120).default("application/octet-stream"),
      data: z.string()
    })).min(1).max(MAX_REPLY_ATTACHMENTS)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: `Valitse 1–${MAX_REPLY_ATTACHMENTS} tiedostoa.` });

  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const files = parsed.data.attachments.map(attachment => ({
    filename: attachment.filename,
    mimeType: attachment.mimeType || "application/octet-stream",
    content: Buffer.from(attachment.data, "base64")
  }));
  if (files.some(file => file.content.length === 0)) {
    return res.status(400).json({ error: "Liitetiedosto on tyhjä tai sitä ei voitu lukea." });
  }
  if (files.reduce((total, file) => total + file.content.length, 0) > MAX_REPLY_ATTACHMENT_BYTES) {
    return res.status(413).json({ error: "Liitteiden yhteiskoko saa olla enintään 15 Mt." });
  }

  const timestamp = now();
  const attachmentIds: string[] = [];
  for (const file of files) {
    const attachmentId = id("attachment");
    await fs.writeFile(path.join(attachmentsDir, attachmentId), file.content);
    db.prepare(`
      INSERT INTO attachments (id, ticket_id, filename, mime_type, size, created_at, direction)
      VALUES (?, ?, ?, ?, ?, ?, 'internal')
    `).run(attachmentId, req.params.id, file.filename, file.mimeType, file.content.length, timestamp);
    attachmentIds.push(attachmentId);
  }
  db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(timestamp, req.params.id);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), req.params.id, res.locals.user?.name ?? "Isännöitsijä", "attachment_added",
    JSON.stringify({ files: files.map(file => file.filename) }), timestamp
  );
  res.status(201).json({ ok: true, attachmentIds });
});

// Uusi viesti huoltoyhtiölle työtilauksen sähköpostiketjuun. Tehtävän tila ei muutu.
app.post("/api/work-orders/:id/messages", async (req, res) => {
  const parsed = z.object({
    body: z.string().trim().min(1).max(4000),
    attachmentIds: z.array(z.string()).max(10).default([])
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita viesti huoltoyhtiölle." });

  const order = db.prepare(`${WORK_ORDER_SELECT} WHERE w.id = ?`).get(req.params.id) as
    | { id: string; ticket_id: string; company_id: string; contractor_name: string; contractor_email: string;
        ordered_at: string; ticket_subject: string; ticket_number: number | null }
    | undefined;
  if (!order || !companyIdFromContext(order.company_id)) return res.status(404).json({ error: "Työtilausta ei löytynyt." });

  // Osoite otetaan tilaukselta; puhelimitse kirjatulla tilauksella käytetään taloyhtiön nykyistä huoltoyhtiön osoitetta.
  const company = db.prepare("SELECT name, maintenance_email FROM companies WHERE id = ?").get(order.company_id) as
    { name: string; maintenance_email: string };
  const to = (order.contractor_email || company.maintenance_email || "").trim();
  if (!VALID_EMAIL.test(to)) {
    return res.status(400).json({ error: "Huoltoyhtiöllä ei ole sähköpostiosoitetta. Lisää se taloyhtiön tietoihin." });
  }

  const outgoing: OutgoingAttachment[] = [];
  for (const attachmentId of parsed.data.attachmentIds) {
    const row = db.prepare("SELECT id, filename, mime_type FROM attachments WHERE id = ? AND ticket_id = ?")
      .get(attachmentId, order.ticket_id) as { id: string; filename: string; mime_type: string } | undefined;
    if (!row) return res.status(404).json({ error: "Liitettä ei löytynyt tältä tehtävältä." });
    outgoing.push({ filename: row.filename, mimeType: row.mime_type, content: await fs.readFile(path.join(attachmentsDir, row.id)) });
  }

  const actor = res.locals.user?.name ?? "Isännöitsijä";
  const number = String(order.ticket_number ?? "").padStart(4, "0");
  const subject = `Re: Työtilaus: ${order.ticket_subject} (${company.name}, tehtävä #${number})`;
  // Alkuperäinen tilausviesti tallennettiin samalla aikaleimalla kuin tilaus, joten ketju löytyy siitä.
  const thread = db.prepare("SELECT gmail_message_id FROM gmail_imports WHERE ticket_id = ? AND created_at = ?")
    .get(order.ticket_id, order.ordered_at) as { gmail_message_id: string } | undefined;

  const timestamp = now();
  try {
    const sent = await sendGmailReply({
      to, subject, body: `${parsed.data.body}\n\nYstävällisin terveisin\n${actor}`,
      sourceMessageId: thread?.gmail_message_id, attachments: outgoing, companyId: order.company_id
    });
    db.prepare("INSERT OR IGNORE INTO gmail_imports (gmail_message_id, ticket_id, created_at) VALUES (?, ?, ?)")
      .run(sent.id, order.ticket_id, timestamp);
  } catch (error: any) {
    console.error("Viestin lähetys huoltoyhtiölle epäonnistui:", error?.message ?? error);
    return res.status(502).json({ error: "Viestin lähetys huoltoyhtiölle epäonnistui. Yritä uudelleen." });
  }

  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id("message"), order.ticket_id, "outbound", actor, subject, parsed.data.body, timestamp, "contractor"
  );
  db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(timestamp, order.ticket_id);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), order.ticket_id, actor, "work_order_message", JSON.stringify({ contractor: order.contractor_name, to }), timestamp
  );
  res.json({ ok: true, to });
});

app.post("/api/work-orders/:id/done", (req, res) => {
  const order = db.prepare("SELECT * FROM work_orders WHERE id = ?").get(req.params.id) as
    | { id: string; ticket_id: string; company_id: string; status: string; contractor_name: string }
    | undefined;
  if (!order || !companyIdFromContext(order.company_id)) return res.status(404).json({ error: "Työtilausta ei löytynyt." });
  if (order.status === "done") return res.status(409).json({ error: "Työtilaus on jo kuitattu tehdyksi." });

  const actor = res.locals.user?.name ?? "Isännöitsijä";
  const timestamp = now();
  db.prepare("UPDATE work_orders SET status = 'done', done_by = ?, done_at = ? WHERE id = ?").run(actor, timestamp, order.id);

  // Kun tehtävän viimeinenkin työtilaus on tehty, tehtävä palaa isännöitsijälle päätettäväksi.
  const open = db.prepare("SELECT COUNT(*) AS n FROM work_orders WHERE ticket_id = ? AND status = 'ordered'").get(order.ticket_id) as { n: number };
  if (open.n === 0) {
    db.prepare("UPDATE tickets SET status = 'waiting_manager', updated_at = ? WHERE id = ? AND status = 'waiting_third_party'")
      .run(timestamp, order.ticket_id);
  }
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), order.ticket_id, actor, "work_order_done", JSON.stringify({ contractor: order.contractor_name }), timestamp
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// Tiedotteet: isännöitsijän viesti koko taloyhtiön tai yhden rapun asukkaille. Tiedote näkyy
// asukasportaalissa ja lähetetään haluttaessa sähköpostilla piilokopiona.
// ---------------------------------------------------------------------------------------------
// Rappu päätellään asunnon numeron alkukirjaimista ("B 34" -> "B"). Ilman kirjainta rappua ei ole.
function stairwellOf(apartmentNumber?: string | null) {
  return (apartmentNumber ?? "").trim().match(/^[A-Za-zÅÄÖåäö]+/)?.[0].toUpperCase() ?? "";
}

function announcementAudience(companyId: string) {
  const rows = db.prepare(`
    SELECT r.email, a.apartment_number
    FROM residents r LEFT JOIN apartments a ON a.id = r.apartment_id
    WHERE r.company_id = ? AND ${ACTIVE_RESIDENT}
  `).all(companyId) as { email: string | null; apartment_number: string | null }[];
  return rows.map(row => ({
    stairwell: stairwellOf(row.apartment_number),
    email: VALID_EMAIL.test((row.email ?? "").trim()) ? (row.email as string).trim() : ""
  }));
}

app.get("/api/companies/:companyId/announcement-audience", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const audience = announcementAudience(companyId);
  const stairwells = [...new Set(audience.map(item => item.stairwell).filter(Boolean))].sort();
  const count = (list: typeof audience) => ({ residents: list.length, emails: new Set(list.map(item => item.email).filter(Boolean)).size });
  res.json({
    all: count(audience),
    stairwells: stairwells.map(stairwell => ({ stairwell, ...count(audience.filter(item => item.stairwell === stairwell)) }))
  });
});

app.get("/api/companies/:companyId/announcements", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare("SELECT * FROM announcements WHERE company_id = ? ORDER BY created_at DESC").all(companyId));
});

app.post("/api/companies/:companyId/announcements", requireManager, async (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = z.object({
    title: z.string().trim().min(3).max(150),
    body: z.string().trim().min(5).max(8000),
    stairwell: z.string().trim().max(10).default(""),
    sendEmail: z.boolean().default(false)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita tiedotteelle otsikko ja teksti." });

  const company = db.prepare("SELECT name FROM companies WHERE id = ?").get(companyId) as { name: string } | undefined;
  if (!company) return res.status(404).json({ error: "Company not found" });
  const stairwell = parsed.data.stairwell.toUpperCase();
  const audience = announcementAudience(companyId).filter(item => !stairwell || item.stairwell === stairwell);
  if (stairwell && audience.length === 0) return res.status(400).json({ error: "Rapussa ei ole asukkaita." });

  const actor = res.locals.user?.name ?? "Isännöitsijä";
  let emailed = 0;
  let emailFailed = false;
  if (parsed.data.sendEmail) {
    const emails = [...new Set(audience.map(item => item.email).filter(Boolean))];
    const text = `${parsed.data.body}\n\nYstävällisin terveisin\n${actor}\n${company.name}`;
    try {
      // Lähetetään erissä, jotta yhden viestin vastaanottajamäärä pysyy kohtuullisena.
      for (let start = 0; start < emails.length; start += 50) {
        const batch = emails.slice(start, start + 50);
        await sendGmailReply({ bcc: batch.join(", "), subject: `Tiedote: ${parsed.data.title} (${company.name})`, body: text, companyId });
        emailed += batch.length;
      }
    } catch (error: any) {
      console.error("Tiedotteen lähetys epäonnistui:", error?.message ?? error);
      emailFailed = true;
    }
  }

  const announcementId = id("announcement");
  db.prepare(`
    INSERT INTO announcements (id, company_id, stairwell, title, body, emailed_count, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(announcementId, companyId, stairwell, parsed.data.title, parsed.data.body, emailed, actor, now());
  res.status(201).json({ ok: true, announcementId, emailed, emailFailed });
});

app.delete("/api/announcements/:id", requireManager, (req, res) => {
  const row = db.prepare("SELECT id, company_id FROM announcements WHERE id = ?").get(req.params.id) as
    | { id: string; company_id: string }
    | undefined;
  if (!row || !companyIdFromContext(row.company_id)) return res.status(404).json({ error: "Tiedotetta ei löytynyt." });
  db.prepare("DELETE FROM announcements WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

// Asukas näkee oman taloyhtiönsä tiedotteet: koko yhtiön ja oman rappunsa.
app.get("/api/portal/announcements", (_req, res) => {
  const resident = portalResident(res);
  res.json(db.prepare(`
    SELECT id, title, body, stairwell, created_at
    FROM announcements
    WHERE company_id = ? AND (stairwell = '' OR stairwell = ?)
    ORDER BY created_at DESC
    LIMIT 100
  `).all(resident.companyId, stairwellOf(resident.apartmentNumber)));
});

// ---------------------------------------------------------------------------------------------
// Muuttoilmoitukset: asukas ilmoittaa portaalissa, toimisto hyväksyy tai hylkää.
// ---------------------------------------------------------------------------------------------
const moveSchema = z.object({
  moveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // true = asunnon nykyiset asukkaat muuttavat pois muuttopäivänä.
  movesOut: z.boolean().default(false),
  newResidents: z.array(z.object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().pipe(z.union([z.literal(""), z.email()])).default("")
  })).max(8).default([]),
  doorName: z.string().trim().max(60).default(""),
  note: z.string().trim().max(1000).default("")
});

const MOVE_SELECT = `
  SELECT m.*, r.name AS resident_name, a.apartment_number, a.address
  FROM move_notices m
  LEFT JOIN residents r ON r.id = m.resident_id
  LEFT JOIN apartments a ON a.id = m.apartment_id
`;

app.post("/api/portal/moves", (req, res) => {
  const resident = portalResident(res);
  const parsed = moveSchema.safeParse(req.body);
  if (!parsed.success || Number.isNaN(Date.parse(parsed.success ? parsed.data.moveDate : ""))) {
    return res.status(400).json({ error: "Tarkista muuttopäivä ja uusien asukkaiden tiedot." });
  }
  if (!parsed.data.movesOut && parsed.data.newResidents.length === 0 && !parsed.data.doorName) {
    return res.status(400).json({ error: "Ilmoita poismuutto, uudet asukkaat tai oveen tuleva nimi." });
  }
  const pending = db.prepare("SELECT 1 FROM move_notices WHERE resident_id = ? AND status = 'pending'").get(resident.id);
  if (pending) return res.status(409).json({ error: "Sinulla on jo käsittelyä odottava muuttoilmoitus." });

  const moveId = id("move");
  db.prepare(`
    INSERT INTO move_notices (id, company_id, apartment_id, resident_id, move_date, moves_out, new_residents, door_name, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(moveId, resident.companyId, resident.apartmentId, resident.id, parsed.data.moveDate, parsed.data.movesOut ? 1 : 0,
    JSON.stringify(parsed.data.newResidents), parsed.data.doorName, parsed.data.note, now());
  res.status(201).json({ ok: true, moveId });
});

app.get("/api/portal/moves", (_req, res) => {
  res.json(db.prepare(`
    SELECT id, move_date, moves_out, new_residents, door_name, note, status, created_at
    FROM move_notices WHERE resident_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(portalResident(res).id));
});

app.get("/api/companies/:companyId/moves", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare(`${MOVE_SELECT} WHERE m.company_id = ? ORDER BY m.status = 'pending' DESC, m.created_at DESC`).all(companyId));
});

type MoveNotice = {
  id: string; company_id: string; apartment_id: string; resident_id: string; move_date: string;
  moves_out: number; new_residents: string; door_name: string; status: string;
};

function pendingMove(moveId: string) {
  const notice = db.prepare("SELECT * FROM move_notices WHERE id = ?").get(moveId) as MoveNotice | undefined;
  if (!notice || !companyIdFromContext(notice.company_id)) return { notice: null, error: "Muuttoilmoitusta ei löytynyt.", status: 404 };
  if (notice.status !== "pending") return { notice: null, error: "Muuttoilmoitus on jo käsitelty.", status: 409 };
  return { notice, error: "", status: 200 };
}

// Hyväksyntä päivittää asukastietokannan: lähtijät merkitään muuttaneiksi muuttopäivästä, heidän
// autopaikkansa päättyvät ja vuoronsa poistuvat muuttopäivästä alkaen, ja uudet asukkaat lisätään.
app.post("/api/moves/:id/approve", requireManager, (req, res) => {
  const found = pendingMove(req.params.id);
  if (!found.notice) return res.status(found.status).json({ error: found.error });
  const { notice } = found;
  const actor = res.locals.user?.name ?? "Isännöitsijä";
  const result = { movedOut: 0, parkingReleased: [] as string[], bookingsRemoved: 0, added: [] as string[], skipped: [] as string[] };

  db.transaction(() => {
    if (notice.moves_out) {
      const leaving = db.prepare(`SELECT r.id FROM residents r WHERE r.apartment_id = ? AND ${ACTIVE_RESIDENT}`)
        .all(notice.apartment_id) as { id: string }[];
      const moveStart = new Date(`${notice.move_date}T00:00:00`).toISOString();
      for (const { id: residentId } of leaving) {
        db.prepare("UPDATE residents SET moved_out_at = ? WHERE id = ?").run(notice.move_date, residentId);
        const spaces = db.prepare(`
          SELECT p.label FROM parking_assignments pa JOIN parking_spaces p ON p.id = pa.parking_id
          WHERE pa.resident_id = ? AND (pa.end_date IS NULL OR pa.end_date > ?)
        `).all(residentId, notice.move_date) as { label: string }[];
        result.parkingReleased.push(...spaces.map(space => space.label));
        db.prepare("UPDATE parking_assignments SET end_date = ? WHERE resident_id = ? AND (end_date IS NULL OR end_date > ?)")
          .run(notice.move_date, residentId, notice.move_date);
        db.prepare("DELETE FROM parking_assignments WHERE resident_id = ? AND end_date <= start_date").run(residentId);
        result.bookingsRemoved += db.prepare("DELETE FROM bookings WHERE resident_id = ? AND starts_at >= ?")
          .run(residentId, moveStart).changes;
        db.prepare("UPDATE waitlist SET status = 'cancelled', closed_at = ? WHERE resident_id = ? AND status IN ('waiting', 'offered')")
          .run(now(), residentId);
        result.movedOut++;
      }
      syncParkingHolders();
    }

    const apartment = db.prepare("SELECT apartment_number, address FROM apartments WHERE id = ?").get(notice.apartment_id) as
      { apartment_number: string; address: string | null };
    for (const person of JSON.parse(notice.new_residents) as { name: string; email: string }[]) {
      const duplicate = person.email && db.prepare(
        `SELECT 1 FROM residents r WHERE r.company_id = ? AND lower(r.email) = lower(?) AND ${ACTIVE_RESIDENT}`
      ).get(notice.company_id, person.email);
      if (duplicate) {
        result.skipped.push(`${person.name} (sähköposti on jo toisella asukkaalla)`);
        continue;
      }
      db.prepare("INSERT INTO residents (id, company_id, apartment_id, name, email) VALUES (?, ?, ?, ?, ?)")
        .run(id("resident"), notice.company_id, notice.apartment_id, person.name, person.email || null);
      result.added.push(person.name);
    }
    void apartment;

    db.prepare("UPDATE move_notices SET status = 'approved', decided_by = ?, decided_at = ?, result = ? WHERE id = ?")
      .run(actor, now(), JSON.stringify(result), notice.id);
  })();

  void notifyResident(notice.resident_id, "Muuttoilmoitus on hyväksytty", [
    `muuttoilmoituksesi (muuttopäivä ${notice.move_date.split("-").reverse().join(".")}) on hyväksytty ja asukastiedot on päivitetty.`,
    ...(result.added.length > 0 ? [`Asuntoon lisätyt asukkaat: ${result.added.join(", ")}.`] : []),
    ...(result.parkingReleased.length > 0 ? [`Autopaikka päättyy muuttopäivänä: ${result.parkingReleased.join(", ")}.`] : [])
  ]);
  res.json({ ok: true, result });
});

app.post("/api/moves/:id/reject", requireManager, (req, res) => {
  const found = pendingMove(req.params.id);
  if (!found.notice) return res.status(found.status).json({ error: found.error });
  db.prepare("UPDATE move_notices SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?")
    .run(res.locals.user?.name ?? "Isännöitsijä", now(), found.notice.id);
  void notifyResident(found.notice.resident_id, "Muuttoilmoitusta ei hyväksytty", [
    "muuttoilmoitustasi ei voitu hyväksyä sellaisenaan. Isännöitsijä on tarvittaessa yhteydessä; voit myös tehdä uuden ilmoituksen asukasportaalissa."
  ]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// Jonotuslistat autopaikoille ja saunavuoroille. Järjestys on ilmoittautumisjärjestys.
// ---------------------------------------------------------------------------------------------
const WAITLIST_RESOURCES = ["parking", "sauna"] as const;

const WAITLIST_SELECT = `
  SELECT w.*, r.name AS resident_name, r.email AS resident_email, a.apartment_number,
         (SELECT COUNT(*) FROM waitlist earlier
          WHERE earlier.company_id = w.company_id AND earlier.resource = w.resource
            AND earlier.status IN ('waiting', 'offered') AND earlier.created_at < w.created_at) + 1 AS position
  FROM waitlist w
  LEFT JOIN residents r ON r.id = w.resident_id
  LEFT JOIN apartments a ON a.id = r.apartment_id
`;

app.post("/api/portal/waitlist", (req, res) => {
  const resident = portalResident(res);
  const parsed = z.object({
    resource: z.enum(WAITLIST_RESOURCES),
    parkingType: z.union([z.literal(""), z.enum(PARKING_TYPES)]).default(""),
    note: z.string().trim().max(300).default("")
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista jonon tiedot." });

  const existing = db.prepare(
    "SELECT 1 FROM waitlist WHERE resident_id = ? AND resource = ? AND status IN ('waiting', 'offered')"
  ).get(resident.id, parsed.data.resource);
  if (existing) return res.status(409).json({ error: "Olet jo tässä jonossa." });

  const waitlistId = id("wait");
  db.prepare("INSERT INTO waitlist (id, company_id, resource, parking_type, resident_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(waitlistId, resident.companyId, parsed.data.resource,
      parsed.data.resource === "parking" ? parsed.data.parkingType : "", resident.id, parsed.data.note, now());
  res.status(201).json({ ok: true, waitlistId });
});

// Asukas näkee vain omat jonopaikkansa ja sijansa, ei muiden jonottajien tietoja.
app.get("/api/portal/waitlist", (_req, res) => {
  const rows = db.prepare(`${WAITLIST_SELECT} WHERE w.resident_id = ? AND w.status IN ('waiting', 'offered') ORDER BY w.created_at`)
    .all(portalResident(res).id) as Record<string, unknown>[];
  res.json(rows.map(row => ({
    id: row.id, resource: row.resource, parking_type: row.parking_type, note: row.note,
    status: row.status, created_at: row.created_at, position: row.position
  })));
});

app.delete("/api/portal/waitlist/:id", (req, res) => {
  const changed = db.prepare(
    "UPDATE waitlist SET status = 'cancelled', closed_at = ? WHERE id = ? AND resident_id = ? AND status IN ('waiting', 'offered')"
  ).run(now(), req.params.id, portalResident(res).id).changes;
  if (!changed) return res.status(404).json({ error: "Jonopaikkaa ei löytynyt." });
  res.json({ ok: true });
});

app.get("/api/companies/:companyId/waitlist", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare(`${WAITLIST_SELECT} WHERE w.company_id = ? AND w.status IN ('waiting', 'offered') ORDER BY w.resource, w.created_at`).all(companyId));
});

function activeWaitlistEntry(waitlistId: string) {
  const entry = db.prepare("SELECT * FROM waitlist WHERE id = ?").get(waitlistId) as
    | { id: string; company_id: string; resource: string; resident_id: string; status: string }
    | undefined;
  if (!entry || !companyIdFromContext(entry.company_id) || !["waiting", "offered"].includes(entry.status)) return null;
  return entry;
}

// Merkitsee, että jonottajalle on tarjottu paikkaa tai vuoroa.
app.post("/api/waitlist/:id/offer", (req, res) => {
  const entry = activeWaitlistEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: "Jonopaikkaa ei löytynyt." });
  db.prepare("UPDATE waitlist SET status = 'offered', offered_at = ?, offered_by = ? WHERE id = ?")
    .run(now(), res.locals.user?.name ?? "Isännöitsijä", entry.id);
  void notifyResident(entry.resident_id, entry.resource === "parking" ? "Sinulle on tarjolla autopaikka" : "Sinulle on tarjolla saunavuoro", [
    entry.resource === "parking"
      ? "olet autopaikkajonossa vuorossa, ja sinulle on tarjolla vapautunut autopaikka."
      : "olet saunavuorojonossa vuorossa, ja sinulle on tarjolla vapautunut vuoro.",
    "Isännöitsijä sopii yksityiskohdista kanssasi. Jos et enää tarvitse paikkaa, voit poistua jonosta asukasportaalissa."
  ]);
  res.json({ ok: true });
});

// Poistaa jonosta: outcome 'done' = sai paikan tai vuoron, 'cancelled' = poistettu muusta syystä.
app.post("/api/waitlist/:id/close", (req, res) => {
  const entry = activeWaitlistEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: "Jonopaikkaa ei löytynyt." });
  const outcome = req.body?.outcome === "done" ? "done" : "cancelled";
  db.prepare("UPDATE waitlist SET status = ?, closed_at = ? WHERE id = ?").run(outcome, now(), entry.id);
  res.json({ ok: true });
});

// Antaa vapaan autopaikan jonottajalle ja poistaa hänet jonosta.
app.post("/api/waitlist/:id/assign-parking", (req, res) => {
  const entry = activeWaitlistEntry(req.params.id);
  if (!entry || entry.resource !== "parking") return res.status(404).json({ error: "Jonopaikkaa ei löytynyt." });
  syncParkingHolders();
  const space = db.prepare("SELECT id, resident_id FROM parking_spaces WHERE id = ? AND company_id = ?")
    .get(typeof req.body?.parkingId === "string" ? req.body.parkingId : "", entry.company_id) as
    | { id: string; resident_id: string | null }
    | undefined;
  if (!space) return res.status(404).json({ error: "Autopaikkaa ei löytynyt tästä taloyhtiöstä." });
  if (space.resident_id) return res.status(409).json({ error: "Autopaikka on jo varattu." });

  db.transaction(() => {
    setParkingHolder(space.id, entry.company_id, entry.resident_id);
    db.prepare("UPDATE waitlist SET status = 'done', closed_at = ? WHERE id = ?").run(now(), entry.id);
  })();
  const assigned = db.prepare("SELECT label, type FROM parking_spaces WHERE id = ?").get(space.id) as { label: string; type: string };
  void notifyResident(entry.resident_id, "Sinulle on annettu autopaikka", [
    `sinulle on annettu autopaikka ${assigned.label} (${assigned.type}) tästä päivästä alkaen.`
  ]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// Laskutetut kuukaudet. Merkintä tallentaa raportin rivit ja käytetyt hinnat sellaisinaan, joten
// myöhempi hinnanmuutos tai asukasmuutos ei muuta jo laskutettua kuukautta.
// ---------------------------------------------------------------------------------------------
const billingKey = z.object({ kind: z.enum(["sauna", "parking"]), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });

app.get("/api/companies/:companyId/billing-periods", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = billingKey.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista raportti ja kuukausi." });
  const row = db.prepare("SELECT * FROM billing_periods WHERE company_id = ? AND kind = ? AND month = ?")
    .get(companyId, parsed.data.kind, parsed.data.month) as
    | { billed_at: string; billed_by: string; total: number; prices: string; rows: string }
    | undefined;
  res.json(row ? { billedAt: row.billed_at, billedBy: row.billed_by, total: row.total, prices: JSON.parse(row.prices), rows: JSON.parse(row.rows) } : null);
});

app.post("/api/companies/:companyId/billing-periods", requireManager, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = billingKey.extend({
    total: z.number().min(0).max(10_000_000),
    prices: z.record(z.string(), z.number().min(0)),
    rows: z.array(z.object({
      name: z.string().max(200),
      apartment: z.string().max(60),
      detail: z.string().max(2000),
      total: z.number().min(0)
    })).min(1).max(2000)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Laskutettavia rivejä ei ole tai tiedot ovat virheelliset." });

  const existing = db.prepare("SELECT 1 FROM billing_periods WHERE company_id = ? AND kind = ? AND month = ?")
    .get(companyId, parsed.data.kind, parsed.data.month);
  if (existing) return res.status(409).json({ error: "Kuukausi on jo merkitty laskutetuksi." });
  db.prepare(`
    INSERT INTO billing_periods (company_id, kind, month, billed_at, billed_by, total, prices, rows)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(companyId, parsed.data.kind, parsed.data.month, now(), res.locals.user?.name ?? "Isännöitsijä",
    parsed.data.total, JSON.stringify(parsed.data.prices), JSON.stringify(parsed.data.rows));
  res.status(201).json({ ok: true });
});

// Laskutusmerkinnän saa poistaa vain pääkäyttäjä.
app.delete("/api/companies/:companyId/billing-periods", requireAdmin, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = billingKey.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista raportti ja kuukausi." });
  const changes = db.prepare("DELETE FROM billing_periods WHERE company_id = ? AND kind = ? AND month = ?")
    .run(companyId, parsed.data.kind, parsed.data.month).changes;
  if (!changes) return res.status(404).json({ error: "Laskutusmerkintää ei löytynyt." });
  res.json({ ok: true });
});

// Avaa suljetun tehtävän uudelleen: käsittelijälle, jos sellainen on, muuten päätösjonoon.
app.post("/api/tickets/:id/reopen", (req, res) => {
  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  if (ticket.status !== "closed") return res.status(409).json({ error: "Tehtävä ei ole suljettu." });
  const status = ticket.assignee_id ? "waiting_manager" : "open";
  const timestamp = now();
  db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(status, timestamp, req.params.id);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), req.params.id, res.locals.user?.name ?? "Isännöitsijä", "ticket_reopened", JSON.stringify({ status }), timestamp
  );
  res.json({ ok: true, status });
});

// ---------------------------------------------------------------------------------------------
// Muistutukset: käsittelijä saa kerran päivässä koosteen tehtävistään, joiden määräaika on mennyt
// tai joissa asukkaan viesti on odottanut vastausta yli kaksi päivää. Käsittelijän puuttuessa kooste
// menee taloyhtiön vastuuisännöitsijälle. Lähetys on päällä vain, kun se on kytketty asetuksista.
// ---------------------------------------------------------------------------------------------
const REPLY_REMINDER_DAYS = 2;

async function sendReminderDigests() {
  const office = db.prepare("SELECT name, reminder_emails FROM office_settings WHERE id = 1").get() as
    { name: string; reminder_emails: number };
  const hour = new Date().getHours();
  if (!office.reminder_emails || hour < 7 || hour >= 18) return;

  const day = today();
  const replyCutoff = new Date(Date.now() - REPLY_REMINDER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = (db.prepare(`
    SELECT t.company_id, t.ticket_number, t.subject, t.due_date, c.name AS company,
           COALESCE(t.assignee_id, c.manager_id) AS user_id,
           (t.due_date IS NOT NULL AND t.due_date < ?) AS overdue
    FROM tickets t
    JOIN companies c ON c.id = t.company_id
    WHERE t.status != 'closed'
      AND ((t.due_date IS NOT NULL AND t.due_date < ?)
        OR (${NEW_REPLY_SQL} AND (SELECT MAX(m.created_at) FROM messages m WHERE m.ticket_id = t.id) < ?))
    ORDER BY t.due_date IS NULL, t.due_date, t.created_at
  `).all(day, day, replyCutoff) as {
    company_id: string; ticket_number: number | null; subject: string; due_date: string | null;
    company: string; user_id: string | null; overdue: number;
  }[]).filter(row => row.user_id && AUTHORIZED_COMPANY_IDS.has(row.company_id));

  for (const userId of new Set(rows.map(row => row.user_id as string))) {
    if (db.prepare("SELECT 1 FROM reminder_log WHERE user_id = ? AND day = ?").get(userId, day)) continue;
    const user = db.prepare("SELECT name, email FROM users WHERE id = ?").get(userId) as { name: string; email: string } | undefined;
    if (!user) continue;

    const lines = rows.filter(row => row.user_id === userId).map(row => {
      const number = String(row.ticket_number ?? "").padStart(4, "0");
      const reason = row.overdue
        ? `määräaika oli ${(row.due_date as string).split("-").reverse().join(".")}`
        : `asukkaan viesti on odottanut vastausta yli ${REPLY_REMINDER_DAYS} päivää`;
      return `#${number} ${row.subject} (${row.company}) – ${reason}`;
    });
    try {
      await sendGmailReply({
        to: user.email,
        subject: `Kotilo: ${lines.length} tehtävää odottaa toimenpiteitäsi`,
        body: [`Hei ${user.name},`, "", "nämä tehtävät odottavat toimenpiteitäsi:", "", ...lines, "", office.name].join("\n")
      });
      db.prepare("INSERT OR IGNORE INTO reminder_log (user_id, day) VALUES (?, ?)").run(userId, day);
    } catch (error: any) {
      console.error("Muistutuksen lähetys epäonnistui:", error?.message ?? error);
    }
  }
  db.prepare("DELETE FROM reminder_log WHERE day < ?").run(day);
}

// ---------------------------------------------------------------------------------------------
// Säilytysaika: kun pääkäyttäjä on asettanut säilytysajan, sitä kauemmin suljettuna olleet tehtävät
// poistetaan viesteineen ja liitteineen, samoin sitä vanhemmat lokimerkinnät. 0 = ei poisteta.
// ---------------------------------------------------------------------------------------------
async function deleteTicket(ticketId: string) {
  const files = db.prepare("SELECT id FROM attachments WHERE ticket_id = ?").all(ticketId) as { id: string }[];
  db.transaction(() => {
    for (const table of ["messages", "gmail_imports", "work_orders", "ticket_reporters", "ticket_notes", "attachments", "audit_log"]) {
      db.prepare(`DELETE FROM ${table} WHERE ticket_id = ?`).run(ticketId);
    }
    db.prepare("DELETE FROM tickets WHERE id = ?").run(ticketId);
  })();
  for (const file of files) await fs.rm(path.join(attachmentsDir, file.id), { force: true });
}

async function purgeExpiredData() {
  const { retention_months: months } = db.prepare("SELECT retention_months FROM office_settings WHERE id = 1").get() as
    { retention_months: number };
  if (!months) return;

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);
  const cutoff = cutoffDate.toISOString();

  const tickets = db.prepare("SELECT id FROM tickets WHERE status = 'closed' AND updated_at < ?").all(cutoff) as { id: string }[];
  for (const ticket of tickets) await deleteTicket(ticket.id);
  const logRows = db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoff).changes;

  if (tickets.length > 0 || logRows > 0) {
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), null, "system", "retention_purge",
      JSON.stringify({ tickets: tickets.length, log_rows: logRows, months }), now()
    );
  }
}

function startMaintenanceJobs() {
  const run = () => {
    sendReminderDigests().catch(error => console.error("Muistutusten käsittely epäonnistui:", error?.message ?? error));
    purgeExpiredData().catch(error => console.error("Säilytysajan poistot epäonnistuivat:", error?.message ?? error));
  };
  run();
  setInterval(run, 60 * 60 * 1000);
}

app.listen(PORT, (error?: Error) => {
  if (error) {
    console.error(`Kotilo API ei käynnistynyt: portti ${PORT} on jo käytössä. Sulje vanha palvelin ja yritä uudelleen.`);
    console.error(error.message);
    process.exit(1);
  }
  console.log(`Kotilo API running at http://localhost:${PORT}`);
  startGmailPolling();
  startMaintenanceJobs();
});
