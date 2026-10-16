import fs from "node:fs/promises";
import path from "node:path";
import express, { type Router } from "express";
import { z } from "zod";
import { triage } from "../ai.js";
import type { ResidentAccount } from "../auth.js";
import { attachmentsDir, db } from "../db.js";
import { alertEmergency } from "../notify.js";
import { isImageOrPdf } from "../scan.js";
import { QUEUE_POSITION_SQL } from "../booking-queue.js";
import { id, now, unsafeFileMessage, statusAfterResidentReply } from "../util.js";
import {
  BOOKING_RESOURCES, bookingKindError, bookingRules, bookingTimes, createBookings, deleteBooking,
  MAX_BOOKING_OCCURRENCES
} from "./bookings.js";
import { aiPriorityEnabled } from "./office.js";
import { assignToCompanyManager } from "./tickets.js";

export const portalRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Asukasportaali. Jokainen reitti rajataan kirjautuneeseen asukkaaseen (res.locals.resident):
// asukas näkee vain oman taloyhtiönsä sauna- ja pyykkitupavuorot, eikä muiden varaajien nimiä.
// ---------------------------------------------------------------------------------------------
export const portalResident = (res: express.Response) => res.locals.resident as ResidentAccount;

portalRouter.get("/portal/me", (_req, res) => {
  res.json(portalResident(res));
});

// Asukkaan itse luoma tehtävä. Yhtiö, asunto ja ilmoittaja tulevat kirjautumisesta, eivät pyynnöstä.
// Tehtävä käsitellään kuten saapunut viesti: se luokitellaan paikallisesti ja menee päätösjonoon.
const PORTAL_TICKET_TYPES = ["Vikailmoitus", "Kysymys", "Ilmoitus", "Pyyntö", "Muu"] as const;

portalRouter.post("/portal/tickets", async (req, res) => {
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
  const result = await triage(
    parsed.data.subject, parsed.data.description, [], company?.maintenance_emergency_phone || undefined,
    // Kirjautuneen asukkaan ilmoitus koskee aina taloyhtiötä, joten asiaankuuluvuutta ei tarkisteta.
    { aiPriority: aiPriorityEnabled(), sender: resident.name }
  );

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

  if (result.emergency) void alertEmergency(ticketId);

  const attachmentError = await savePortalAttachments(ticketId, parsed.data.attachments, timestamp);
  res.status(201).json({ ok: true, ticketId, attachmentError });
});

// Asukkaan liitteet (kuvat ja PDF:t) tehtävälle. Tallennetaan suunnalla 'portal'.
export const portalAttachmentsSchema = z.array(z.object({
  filename: z.string().trim().min(1).max(200),
  mimeType: z.string().max(120),
  data: z.string()
})).max(5).default([]);

export async function savePortalAttachments(ticketId: string, attachments: z.infer<typeof portalAttachmentsSchema>, timestamp: string) {
  const files = attachments.map(attachment => ({ ...attachment, content: Buffer.from(attachment.data, "base64") }));
  if (files.some(file => !/^(image\/(png|jpeg|gif|webp|heic)|application\/pdf)$/.test(file.mimeType))) {
    return "Liitteeksi kelpaa kuva tai PDF.";
  }
  if (files.some(file => file.content.length === 0)) return "Liitetiedosto on tyhjä tai sitä ei voitu lukea.";
  if (files.reduce((total, file) => total + file.content.length, 0) > 10 * 1024 * 1024) {
    return "Liitteiden yhteiskoko saa olla enintään 10 Mt.";
  }
  // Selaimen ilmoittama tyyppi ei riitä: sisällön pitää olla oikeasti kuva tai PDF.
  if (files.some(file => !isImageOrPdf(file.content))) return "Liitteeksi kelpaa kuva tai PDF.";
  const unsafe = await unsafeFileMessage(files);
  if (unsafe) return unsafe;
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
portalRouter.get("/portal/tickets/:id", (req, res) => {
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
    SELECT id, filename, mime_type, size, created_at, direction FROM attachments
    WHERE ticket_id = ? AND direction IN ('portal', 'outbound') ORDER BY created_at
  `).all(ticket.id);
  res.json({ ticket, messages, attachments });
});

portalRouter.post("/portal/tickets/:id/messages", async (req, res) => {
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
  // Suljettu tai vastattu tehtävä palaa päätösjonoon, kuten sähköpostivastauksessakin.
  const nextStatus = statusAfterResidentReply(ticket.status);
  const reopened = nextStatus !== ticket.status;
  db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, timestamp, ticket.id);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), ticket.id, resident.name, reopened ? "reply_received_reopened" : "portal_message",
    JSON.stringify({ attachments: parsed.data.attachments.length }), timestamp
  );
  res.status(201).json({ ok: true, reopened });
});

portalRouter.get("/portal/attachments/:id", (req, res) => {
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
portalRouter.get("/portal/tickets", (_req, res) => {
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

portalRouter.get("/portal/booking-settings", (_req, res) => {
  res.json(bookingRules(portalResident(res).companyId));
});

portalRouter.get("/portal/bookings", (req, res) => {
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

  // Vuoron jono: jonottajien määrä sekä asukkaan oma jonopaikka ja sija, jos hän on jonossa.
  const queue = db.prepare(`
    SELECT q.id, q.starts_at, q.ends_at, q.resident_id, ${QUEUE_POSITION_SQL} AS position
    FROM booking_queue q
    WHERE q.company_id = ? AND q.resource = ? AND q.status = 'waiting' AND q.starts_at < ? AND q.ends_at > ?
  `).all(resident.companyId, parsed.data.resource, parsed.data.to, parsed.data.from) as
    { id: string; starts_at: string; ends_at: string; resident_id: string | null; position: number }[];

  // Muiden varauksista kerrotaan vain, että vuoro on varattu.
  res.json(rows.map(row => {
    const waiting = queue.filter(entry => entry.starts_at === row.starts_at && entry.ends_at === row.ends_at);
    const own = waiting.find(entry => entry.resident_id === resident.id);
    return {
      id: row.id,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      mine: row.resident_id === resident.id,
      // Sarjatieto vain omista varauksista, jotta sarjan voi perua kerralla.
      series_id: row.resident_id === resident.id ? row.series_id : null,
      queue_count: waiting.length,
      queue_entry_id: own?.id ?? null,
      queue_position: own?.position ?? null
    };
  }));
});

portalRouter.post("/portal/bookings", (req, res) => {
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

portalRouter.delete("/portal/bookings/:id", (req, res) => {
  const resident = portalResident(res);
  const booking = db.prepare(
    "SELECT id, series_id, starts_at FROM bookings WHERE id = ? AND resident_id = ?"
  ).get(req.params.id, resident.id) as { id: string; series_id: string | null; starts_at: string } | undefined;
  if (!booking) return res.status(404).json({ error: "Omaa varausta ei löytynyt." });
  res.json({ ok: true, deleted: deleteBooking(booking, req.query.series === "1") });
});
