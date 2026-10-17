import fs from "node:fs/promises";
import path from "node:path";
import express, { type Router } from "express";
import { z } from "zod";
import {
  companyIdFromContext, DEFAULT_COMPANY_ID, getAuthorizedTicket, isRestrictedTicket, redactRestrictedTicket, visibleCompanyIds
} from "../access.js";
import { isAdmin, requireManager } from "../auth.js";
import { attachmentsDir, db } from "../db.js";
import { replyAccountsFor } from "../mail.js";
import { renderSignature } from "../signature.js";
import { alertEmergency, notifyTicketStatus, statusEventFor } from "../notify.js";
import { AI_SUGGESTED_SQL, id, NEW_REPLY_SQL, now, WAITING_SINCE_SQL, TICKET_STATUSES } from "../util.js";
import { pendingErasure, processPendingErasures } from "../resident-erasure.js";
import { ticketForm } from "../portal-form-data.js";

export const ticketsRouter: Router = express.Router();

// Uusi saapunut tehtävä osoitetaan taloyhtiön vastuuisännöitsijälle. Tila ei muutu, joten
// tehtävä näkyy edelleen päätösjonossa.
export function assignToCompanyManager(ticketId: string, companyId: string) {
  db.prepare("UPDATE tickets SET assignee_id = (SELECT manager_id FROM companies WHERE id = ?) WHERE id = ?")
    .run(companyId, ticketId);
}

// Poistaa tehtävän pysyvästi viesteineen, muistiinpanoineen, työtilauksineen, liitteineen ja lokeineen.
export async function deleteTicket(ticketId: string) {
  const files = db.prepare("SELECT id FROM attachments WHERE ticket_id = ?").all(ticketId) as { id: string }[];
  db.transaction(() => {
    // Tehtävän sähköpostit merkitään poistetuiksi, jotta postin tarkistus ei tuo niitä uudelleen.
    db.prepare(`
      INSERT OR IGNORE INTO deleted_mail_messages (message_id, deleted_at)
      SELECT gmail_message_id, ? FROM gmail_imports WHERE ticket_id = ?
    `).run(now(), ticketId);
    for (const table of ["messages", "gmail_imports", "work_orders", "ticket_reporters", "ticket_notes", "attachments", "audit_log"]) {
      db.prepare(`DELETE FROM ${table} WHERE ticket_id = ?`).run(ticketId);
    }
    db.prepare("DELETE FROM renovation_notices WHERE ticket_id = ?").run(ticketId);
    db.prepare("DELETE FROM portal_forms WHERE ticket_id = ?").run(ticketId);
    db.prepare("DELETE FROM tickets WHERE id = ?").run(ticketId);
  })();
  for (const file of files) await fs.rm(path.join(attachmentsDir, file.id), { force: true });
}

// Tehtävän poisto käyttöliittymästä. Poistoa ei voi perua, joten se kuuluu isännöitsijälle ja
// pääkäyttäjälle. Lokiin jää merkintä poistajasta ja tehtävän numerosta ilman tehtävän sisältöä.
ticketsRouter.delete("/tickets/:id", requireManager, async (req, res) => {
  const ticket = getAuthorizedTicket(req.params.id) as { id: string; ticket_number: number | null; company_id: string } | undefined;
  if (!ticket) return res.status(404).json({ error: "Tehtävää ei löytynyt." });

  await deleteTicket(ticket.id);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), null, res.locals.user?.name ?? "Isännöitsijä", "ticket_deleted",
    JSON.stringify({ ticket_number: ticket.ticket_number, company_id: ticket.company_id }), now()
  );
  res.json({ ok: true });
});

// companyId=all palauttaa kaikkien käyttäjälle näkyvien taloyhtiöiden tehtävät yhdellä haulla.
ticketsRouter.get("/tickets", (req, res) => {
  const all = req.query.companyId === "all";
  const companyId = all ? null : companyIdFromContext(req.query.companyId);
  if (!all && !companyId) return res.status(403).json({ error: "Company not authorized" });
  const companyIds = all ? visibleCompanyIds() : [companyId as string];
  if (companyIds.length === 0) return res.json([]);
  const rows = db.prepare(`
    SELECT t.*, r.name AS resident_name, a.apartment_number, u.name AS assignee_name, c.name AS company_name,
           ${NEW_REPLY_SQL} AS has_new_reply, ${AI_SUGGESTED_SQL} AS ai_suggested, ${WAITING_SINCE_SQL} AS waiting_since
    FROM tickets t
    JOIN companies c ON c.id = t.company_id
    LEFT JOIN residents r ON r.id = t.resident_id
    LEFT JOIN apartments a ON a.id = t.apartment_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.company_id IN (${companyIds.map(() => "?").join(", ")})
    ORDER BY
      CASE t.priority
        WHEN 'emergency' THEN 1
        WHEN 'urgent' THEN 2
        WHEN 'normal' THEN 3
        ELSE 4
      END,
      t.created_at DESC
  `).all(...companyIds) as Parameters<typeof redactRestrictedTicket>[0][];
  res.json(rows.map(redactRestrictedTicket));
});

ticketsRouter.post("/tickets", (req, res) => {
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

  if (parsed.data.priority === "emergency") void alertEmergency(ticketId, res.locals.user?.id);

  res.status(201).json({ ok: true, ticketId, status: "waiting_manager" });
});

ticketsRouter.get("/my-tickets", (req, res) => {
  const companyId = companyIdFromContext(req.query.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const rows = db.prepare(`
    SELECT t.*, r.name AS resident_name, a.apartment_number, u.name AS assignee_name, ${NEW_REPLY_SQL} AS has_new_reply, ${AI_SUGGESTED_SQL} AS ai_suggested, ${WAITING_SINCE_SQL} AS waiting_since
    FROM tickets t
    LEFT JOIN residents r ON r.id = t.resident_id
    LEFT JOIN apartments a ON a.id = t.apartment_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.company_id = ?
      -- Omissa ovat käsittelijän kaikki aloitetut tehtävät, myös vastatut ja kolmatta osapuolta odottavat.
      AND t.status IN ('active', 'waiting_manager', 'answered', 'waiting_third_party')
      AND t.assignee_id = ?
    ORDER BY t.updated_at DESC
  `).all(companyId, res.locals.user?.id ?? "") as Parameters<typeof redactRestrictedTicket>[0][];
  res.json(rows.map(redactRestrictedTicket));
});

ticketsRouter.get("/decision-queue", (req, res) => {
  const companyId = companyIdFromContext(req.query.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const rows = db.prepare(`
    SELECT t.*, r.name AS resident_name, a.apartment_number, u.name AS assignee_name, ${NEW_REPLY_SQL} AS has_new_reply, ${AI_SUGGESTED_SQL} AS ai_suggested, ${WAITING_SINCE_SQL} AS waiting_since
    FROM tickets t
    LEFT JOIN residents r ON r.id = t.resident_id
    LEFT JOIN apartments a ON a.id = t.apartment_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.company_id = ?
      AND t.status IN ('open', 'active')
      -- Remonttitehtävät ovat auki pitkään, joten ne ovat Remontit-osiossa eivätkä päätösjonossa.
      AND t.kind != 'renovation'
    ORDER BY t.priority = 'emergency' DESC, t.created_at DESC
  `).all(companyId) as Parameters<typeof redactRestrictedTicket>[0][];
  res.json(rows.map(redactRestrictedTicket));
});

const PREVIEW_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

type TicketAttachment = { id: string; created_at: string; direction?: string; message_id?: string | null };
type TimelineMessageRow = { id: string; direction: string; created_at: string; channel?: string | null };

// Liite näytetään aikajanalla sen viestin alla, jonka mukana se tuli. Vanhoilla liitteillä viestiä ei
// ole tallennettu: portaalin viestin ja lähetetyn vastauksen liitteillä on sama tallennushetki kuin
// viestillä, ja sähköpostin liite tallennettiin heti viestin jälkeen.
export function linkAttachmentsToMessages<T extends TicketAttachment>(attachments: T[], messages: TimelineMessageRow[]): T[] {
  return attachments.map(attachment => {
    if (attachment.message_id || attachment.direction === "internal") return attachment;
    const sameTime = messages.find(message => message.created_at === attachment.created_at);
    const previousEmail = attachment.direction === "inbound"
      ? messages.filter(message => message.direction === "inbound" && message.channel === "email" && message.created_at <= attachment.created_at)
        .at(-1)
      : undefined;
    return { ...attachment, message_id: (sameTime ?? previousEmail)?.id ?? null };
  });
}

// Arkaluonteisen tehtävän avaukset kirjataan lokiin, kukin käyttäjä kerran päivässä.
function logSensitiveView(ticketId: string, actor: string | undefined) {
  if (!actor) return;
  const ticket = db.prepare("SELECT sensitive FROM tickets WHERE id = ?").get(ticketId) as { sensitive: number } | undefined;
  if (!ticket?.sensitive) return;
  const timestamp = now();
  const seen = db.prepare(`
    SELECT 1 FROM audit_log WHERE ticket_id = ? AND action = 'sensitive_viewed' AND actor = ? AND substr(created_at, 1, 10) = ?
  `).get(ticketId, actor, timestamp.slice(0, 10));
  if (!seen) {
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), ticketId, actor, "sensitive_viewed", "{}", timestamp);
  }
}

ticketsRouter.get("/tickets/:id", (req, res) => {
  if (!getAuthorizedTicket(req.params.id)) {
    if (isRestrictedTicket(req.params.id)) {
      return res.status(403).json({
        error: "Tehtävä on arkaluonteinen. Sen näkevät vain käsittelijä, taloyhtiön vastuuisännöitsijä ja pääkäyttäjät.",
        restricted: true
      });
    }
    return res.status(404).json({ error: "Ticket not found" });
  }
  logSensitiveView(req.params.id, res.locals.user?.name);
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

  const attachments = linkAttachmentsToMessages(
    db.prepare("SELECT * FROM attachments WHERE ticket_id = ? ORDER BY created_at, filename")
      .all(req.params.id) as TicketAttachment[],
    messages as TimelineMessageRow[]
  );

  const workOrders = db.prepare(
    "SELECT * FROM work_orders WHERE ticket_id = ? ORDER BY ordered_at DESC"
  ).all(req.params.id);

  // Huoltoyhtiön yhteystiedot työtilausta varten.
  const contractor = db.prepare(
    "SELECT maintenance_name AS name, maintenance_email AS email, maintenance_phone AS phone FROM companies WHERE id = (SELECT company_id FROM tickets WHERE id = ?)"
  ).get(req.params.id);

  // Tilit, joilta vastauksen voi lähettää; ensimmäinen on oletus.
  const replyAccounts = replyAccountsFor(ticket as { id: string; company_id: string; mail_account_id?: string | null }, res.locals.user?.id);

  // Allekirjoitus, joka lisätään vastauksen loppuun; näytetään vastauslomakkeessa.
  const signature = renderSignature(res.locals.user?.id);

  // Remonttitehtävän muutostyöilmoituksen tiedot.
  const renovation = db.prepare("SELECT * FROM renovation_notices WHERE ticket_id = ?").get(req.params.id) ?? null;

  // Asukasportaalin lomakkeen kentät (huoltotyötilaus, häiriöilmoitus jne.).
  const form = ticketForm(req.params.id);

  // Poistopyynnön vuoksi säilytetty tehtävä: anonymisoidaan, kun tehtävä suljetaan.
  const erasurePending = pendingErasure(req.params.id) ?? null;

  res.json({
    ticket, messages, audit, reporters, apartments, notes, attachments, workOrders, contractor, replyAccounts, signature,
    renovation, form, erasurePending
  });
});

ticketsRouter.put("/tickets/:id/fields", async (req, res) => {
  const schema = z.object({
    type: z.string().trim().min(1).max(60).optional(),
    priority: z.enum(["emergency", "urgent", "normal", "low"]).optional(),
    // Käsittelijä: toimiston käyttäjän tunniste, null = ei käsittelijää.
    assigneeId: z.string().nullable().optional(),
    // Määräaika VVVV-KK-PP, null = ei määräaikaa.
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    // Tilan voi vaihtaa käsin mihin tahansa tilaan.
    status: z.enum(TICKET_STATUSES).optional(),
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
    // Tehtävän voi aina ottaa itselleen ("Osoita minulle").
    const takingForSelf = Boolean(parsed.data.assigneeId) && parsed.data.assigneeId === res.locals.user?.id;
    if (company.manager_id && company.manager_id !== res.locals.user?.id && !isAdmin(res) && !takingForSelf) {
      return res.status(403).json({ error: "Vain taloyhtiön vastuuisännöitsijä voi antaa tehtävän toiselle." });
    }
    const assignedAt = now();
    // Kun avoin tehtävä annetaan jollekulle, se poistuu päätösjonosta ja siirtyy tämän omiin tehtäviin.
    // Kaikissa tehtävissä se näkyy edelleen kaikille, myös vastuuisännöitsijälle. Käsittelijän
    // poistaminen ei muuta tilaa.
    const status = assignee && ticket.status === "open" ? "waiting_manager" : ticket.status;
    db.prepare("UPDATE tickets SET assignee_id = ?, status = ?, updated_at = ? WHERE id = ?").run(
      assignee?.id ?? null, status, assignedAt, req.params.id
    );
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), req.params.id, res.locals.user?.name ?? parsed.data.actor, "ticket_assigned",
      JSON.stringify({ to: assignee?.name ?? null }), assignedAt
    );
  }

  if (parsed.data.status && parsed.data.status !== ticket.status) {
    const changedAt = now();
    db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(parsed.data.status, changedAt, req.params.id);
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), req.params.id, res.locals.user?.name ?? parsed.data.actor, "status_changed",
      JSON.stringify({ from: ticket.status, to: parsed.data.status }), changedAt
    );
    const event = statusEventFor(parsed.data.status);
    if (event) notifyTicketStatus(req.params.id, event, res.locals.user?.name ?? parsed.data.actor);
    // Poistopyynnön vuoksi säilytetty tehtävä anonymisoidaan heti, kun se suljetaan.
    if (parsed.data.status === "closed") await processPendingErasures();
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

  // Hälytys lähtee myös, kun olemassa oleva tehtävä nostetaan hätätapaukseksi.
  if (priority === "emergency" && ticket.priority !== "emergency") void alertEmergency(req.params.id, res.locals.user?.id);

  res.json({ ok: true });
});

ticketsRouter.post("/tickets/:id/reporters", (req, res) => {
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
  // Remonttitehtävän ilmoittaja on myös remontti-ilmoituksen ilmoittaja.
  db.prepare("UPDATE renovation_notices SET resident_id = ?, apartment_id = ? WHERE ticket_id = ?")
    .run(resident.id, resident.apartment_id, req.params.id);

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

ticketsRouter.delete("/tickets/:id/reporters/:residentId", (req, res) => {
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

ticketsRouter.post("/tickets/:id/notes", (req, res) => {
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

ticketsRouter.get("/attachments/:id", (req, res) => {
  const attachment = db.prepare("SELECT * FROM attachments WHERE id = ?")
    .get(req.params.id) as { id: string; ticket_id: string; filename: string; mime_type: string } | undefined;

  if (!attachment || !getAuthorizedTicket(attachment.ticket_id)) {
    return res.status(404).json({ error: "Attachment not found" });
  }

  // Aikajanan pikkukuva: vain tavalliset bittikarttakuvat näytetään selaimessa, muut ladataan tiedostona.
  if (req.query.inline === "1" && PREVIEW_IMAGE_TYPES.has(attachment.mime_type.toLowerCase())) {
    return res.sendFile(path.join(attachmentsDir, attachment.id), {
      headers: {
        "Content-Type": attachment.mime_type.toLowerCase(),
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600"
      }
    });
  }

  res.download(path.join(attachmentsDir, attachment.id), attachment.filename, {
    headers: { "Content-Type": "application/octet-stream" }
  });
});
