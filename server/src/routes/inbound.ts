import express, { type Router } from "express";
import { z } from "zod";
import { companyIdForRecipients, companyIdFromContext, getAuthorizedTicket } from "../access.js";
import { triage } from "../ai.js";
import { db } from "../db.js";
import { alertEmergency } from "../notify.js";
import { id, now } from "../util.js";
import { getKnowledge } from "./knowledge.js";
import { findResident } from "./residents.js";
import { assignToCompanyManager } from "./tickets.js";

export const inboundRouter: Router = express.Router();

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

inboundRouter.post("/inbound/messages", async (req, res) => {
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

  if (result.emergency) void alertEmergency(ticketId);

  res.status(201).json({
    ticketId,
    emergency: result.emergency,
    action: result.emergency ? "emergency_routed" : "decision_queue"
  });
});
