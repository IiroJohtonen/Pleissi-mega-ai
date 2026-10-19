import fs from "node:fs/promises";
import path from "node:path";
import express, { type Router } from "express";
import { z } from "zod";
import { canSeeTicket, companyIdFromContext, getAuthorizedTicket, RESTRICTED_SUBJECT } from "../access.js";
import { attachmentsDir, db } from "../db.js";
import { type OutgoingAttachment, sendEmail } from "../mail.js";
import { notifyTicketStatus } from "../notify.js";
import { id, now, VALID_EMAIL } from "../util.js";
import { formatTicketNumber } from "../numbers.js";

export const workOrdersRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Työtilaukset: tehtävältä huoltoyhtiölle lähetettävä tilaus ja sen kuittaus tehdyksi.
// ---------------------------------------------------------------------------------------------
const WORK_ORDER_SELECT = `
  SELECT w.*, t.subject AS ticket_subject, t.ticket_number,
         t.sensitive, t.assignee_id, t.company_pending
  FROM work_orders w
  JOIN tickets t ON t.id = w.ticket_id
`;

workOrdersRouter.get("/companies/:companyId/work-orders", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  // Arkaluonteisen tehtävän työtilauksesta ei näytetä otsikkoa eikä kuvausta käyttäjälle, jolta tehtävä on rajattu.
  const rows = db.prepare(`${WORK_ORDER_SELECT} WHERE w.company_id = ? ORDER BY w.ordered_at DESC`).all(companyId) as
    (Record<string, unknown> & { ticket_id: string; sensitive?: number | null; assignee_id?: string | null; ticket_subject?: string })[];
  res.json(rows.map(row => canSeeTicket({ ...row, company_id: companyId })
    ? row
    : { ...row, ticket_subject: RESTRICTED_SUBJECT, description: "", contractor_name: "", contractor_email: "" }));
});

workOrdersRouter.post("/tickets/:id/work-orders", async (req, res) => {
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
  const number = formatTicketNumber(ticket.ticket_number);
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
      const sent = await sendEmail({ to: contractorEmail, subject, body, attachments: outgoing, companyId: ticket.company_id });
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
  if (ticket.status !== "closed") notifyTicketStatus(req.params.id, "work_ordered", actor, contractorName);

  res.status(201).json({ ok: true, workOrderId, emailSent });
});

// Uusi viesti huoltoyhtiölle työtilauksen sähköpostiketjuun. Tehtävän tila ei muutu.
workOrdersRouter.post("/work-orders/:id/messages", async (req, res) => {
  const parsed = z.object({
    body: z.string().trim().min(1).max(4000),
    attachmentIds: z.array(z.string()).max(10).default([])
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita viesti huoltoyhtiölle." });

  const order = db.prepare(`${WORK_ORDER_SELECT} WHERE w.id = ?`).get(req.params.id) as
    | { id: string; ticket_id: string; company_id: string; contractor_name: string; contractor_email: string;
        ordered_at: string; ticket_subject: string; ticket_number: number | null }
    | undefined;
  if (!order || !companyIdFromContext(order.company_id) || !getAuthorizedTicket(order.ticket_id)) {
    return res.status(404).json({ error: "Työtilausta ei löytynyt." });
  }

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
  const number = formatTicketNumber(order.ticket_number);
  const subject = `Re: Työtilaus: ${order.ticket_subject} (${company.name}, tehtävä #${number})`;
  // Alkuperäinen tilausviesti tallennettiin samalla aikaleimalla kuin tilaus, joten ketju löytyy siitä.
  const thread = db.prepare("SELECT gmail_message_id FROM gmail_imports WHERE ticket_id = ? AND created_at = ?")
    .get(order.ticket_id, order.ordered_at) as { gmail_message_id: string } | undefined;

  const timestamp = now();
  try {
    const sent = await sendEmail({
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

workOrdersRouter.post("/work-orders/:id/done", (req, res) => {
  const order = db.prepare("SELECT * FROM work_orders WHERE id = ?").get(req.params.id) as
    | { id: string; ticket_id: string; company_id: string; status: string; contractor_name: string }
    | undefined;
  if (!order || !companyIdFromContext(order.company_id) || !getAuthorizedTicket(order.ticket_id)) {
    return res.status(404).json({ error: "Työtilausta ei löytynyt." });
  }
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
  notifyTicketStatus(order.ticket_id, "work_done", actor);
  res.json({ ok: true });
});
