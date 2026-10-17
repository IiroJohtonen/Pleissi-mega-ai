import fs from "node:fs/promises";
import path from "node:path";
import express, { type Router } from "express";
import { z } from "zod";
import { getAuthorizedTicket } from "../access.js";
import { suggestReply } from "../ai.js";
import { selectKnowledgeChunks } from "../knowledge-chunks.js";
import { detectSensitivity, setSensitivity } from "../ticket-sensitivity.js";
import { attachmentsDir, db } from "../db.js";
import { type OutgoingAttachment, parseSender, replyAccountsFor, sendEmail } from "../mail.js";
import { notifyTicketStatus } from "../notify.js";
import { renderSignature, withSignature } from "../signature.js";
import { id, now, unsafeFileMessage } from "../util.js";

export const ticketActionsRouter: Router = express.Router();

ticketActionsRouter.post("/tickets/:id/decision", (req, res) => {
  const schema = z.discriminatedUnion("decision", [
    z.object({
      decision: z.literal("skip"),
      reason: z.enum(["already_handled", "no_action_required", "spam"]),
      // Vapaa kommentti sulkemisesta; tallentuu tehtävän sisäiseksi muistiinpanoksi.
      comment: z.string().trim().max(2000).default(""),
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
      ...(parsed.data.decision === "skip" ? { reason: parsed.data.reason, comment: parsed.data.comment || undefined } : {})
    }),
    timestamp
  );

  // Sulkemisen kommentti näkyy aikajanalla sisäisenä muistiinpanona; asukas ei näe sitä.
  if (parsed.data.decision === "skip" && parsed.data.comment) {
    db.prepare("INSERT INTO ticket_notes VALUES (?, ?, ?, ?, ?)").run(
      id("note"), req.params.id, res.locals.user?.name ?? parsed.data.actor, parsed.data.comment, timestamp
    );
  }

  // Sulkemisesta ja käsittelyyn ottamisesta kerrotaan tehtävän ilmoittajille (ei roskapostiksi merkityistä).
  if (parsed.data.decision === "skip" && parsed.data.reason !== "spam" && ticket.status !== "closed") {
    notifyTicketStatus(req.params.id, "closed", res.locals.user?.name ?? parsed.data.actor);
  }
  if (parsed.data.decision === "human" && ticket.status !== "waiting_manager") {
    notifyTicketStatus(req.params.id, "in_progress", res.locals.user?.name ?? parsed.data.actor);
  }

  res.json({ ok: true, status });
});

// Pyytää AI:lta uuden vastausehdotuksen yhtiön dokumentaation pohjalta. Ehdotuksen peruste ja
// lähde tallennetaan tehtävälle; itse luonnos palautetaan käsittelijän muokattavaksi eikä sitä
// tallenneta ennen kuin käsittelijä tallentaa sen.
ticketActionsRouter.post("/tickets/:id/suggest", async (req, res) => {
  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const alreadySuggested = db.prepare(
    "SELECT 1 FROM audit_log WHERE ticket_id = ? AND action = 'ai_suggested' LIMIT 1"
  ).get(req.params.id);
  if (alreadySuggested) {
    return res.status(409).json({ error: "AI-ehdotus on jo pyydetty tälle tehtävälle." });
  }

  // Käsittelijän valinnainen lisätieto, jonka AI ottaa huomioon luonnoksessa.
  const options = z.object({ context: z.string().trim().max(2000).optional() }).safeParse(req.body ?? {});
  if (!options.success) return res.status(400).json({ error: "Lisätieto saa olla enintään 2000 merkkiä." });

  const messages = db.prepare(
    "SELECT direction, body FROM messages WHERE ticket_id = ? ORDER BY created_at"
  ).all(req.params.id) as { direction: string; body: string }[];
  const conversation = messages.length
    ? messages
        .slice(-6)
        .map(message => `${message.direction === "inbound" ? "Asukas" : "Isännöinti"}: ${message.body.slice(0, 2000)}`)
        .join("\n\n")
    : ticket.summary;

  // AI saa vain tehtävään osuvat palat: haku otsikon, viimeisimpien viestien ja lisätiedon perusteella.
  const chunks = selectKnowledgeChunks(ticket.company_id, [ticket.subject, conversation, options.data.context ?? ""].join("\n"));
  // Arkaluonteinen tehtävä ei mene AI:lle: ehdotus tehdään dokumentaatiohaulla.
  const sensitive = detectSensitivity(ticket.id, `${ticket.subject}\n${conversation}`);
  const suggestion = await suggestReply(ticket.subject, conversation, chunks, options.data.context ?? "", { allowAi: !sensitive });
  const source = chunks.find(chunk => chunk.id === suggestion.sourceId) ?? null;
  const timestamp = now();

  db.prepare(`
    UPDATE tickets
    SET ai_reason = ?, knowledge_source_id = ?, knowledge_source_title = ?, knowledge_source_chunk_id = ?,
        knowledge_source_page = ?, updated_at = ?
    WHERE id = ?
  `).run(
    suggestion.reason, source?.knowledgeId ?? null, source?.documentTitle ?? null, source?.id ?? null,
    source?.page ?? null, timestamp, req.params.id
  );

  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"),
    req.params.id,
    "ai",
    "ai_suggested",
    JSON.stringify({ source_id: source?.knowledgeId ?? null, chunk_id: source?.id ?? null, used_ai: suggestion.usedAi, sensitive }),
    timestamp
  );

  res.json({
    draft: suggestion.draft,
    reason: suggestion.reason,
    source: source ? { id: source.knowledgeId, title: source.documentTitle, chunkId: source.id, page: source.page } : null,
    usedAi: suggestion.usedAi,
    sensitive
  });
});

// Käsittelijä merkitsee tehtävän arkaluonteiseksi tai poistaa merkinnän.
ticketActionsRouter.put("/tickets/:id/sensitive", (req, res) => {
  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  const parsed = z.object({ sensitive: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valitse, onko tehtävä arkaluonteinen." });
  if (Boolean(ticket.sensitive) !== parsed.data.sensitive) {
    setSensitivity(ticket.id, parsed.data.sensitive, res.locals.user?.name ?? "Käsittelijä");
  }
  res.json({ ok: true, sensitive: parsed.data.sensitive });
});

ticketActionsRouter.post("/tickets/:id/draft", (req, res) => {
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

ticketActionsRouter.post("/tickets/:id/message", (req, res) => {
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

ticketActionsRouter.post("/tickets/:id/reply", async (req, res) => {
  const schema = z.object({
    body: z.string().trim().min(1),
    actor: z.string().default("isannoitsija"),
    // Aikajanan viesti, johon vastataan. Ilman tätä vastataan tehtävän viimeisimpään saapuneeseen viestiin.
    messageId: z.string().optional(),
    // Postitili, jolta vastaus lähetetään; oletuksena tili, johon tehtävän viesti saapui.
    fromAccountId: z.string().optional(),
    // Kopion saajat pilkulla tai puolipisteellä eroteltuina.
    cc: z.string().max(1000).optional(),
    // Lisätäänkö käyttäjän allekirjoitus vastauksen loppuun.
    signature: z.boolean().default(true),
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
  const unsafe = await unsafeFileMessage(outgoing);
  if (unsafe) return res.status(400).json({ error: unsafe });

  const ticket = getAuthorizedTicket(req.params.id) as any;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const cc = (parsed.data.cc ?? "").split(/[,;\s]+/).map(address => address.trim()).filter(Boolean);
  const invalidCc = cc.find(address => !/^[^\s<>,;@]+@[^\s<>,;@]+\.[^\s<>,;@]+$/.test(address));
  if (invalidCc) return res.status(400).json({ error: `Kopion osoite ${invalidCc} ei ole kelvollinen sähköpostiosoite.` });
  const body = parsed.data.signature ? withSignature(parsed.data.body, renderSignature(res.locals.user?.id)) : parsed.data.body;

  const accounts = replyAccountsFor(ticket, res.locals.user?.id);
  const fromAccount = parsed.data.fromAccountId
    ? accounts.find(account => account.id === parsed.data.fromAccountId)
    : accounts[0];
  if (parsed.data.fromAccountId && !fromAccount) {
    return res.status(400).json({ error: "Valitulta sähköpostitililtä ei voi lähettää. Valitse toinen lähettäjä." });
  }

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

  // Vastaus ketjutetaan siihen sähköpostiin, johon vastataan. Viestin ja sen tunnisteen
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

  let sentMessageId: string;
  try {
    const sent = await sendEmail({
      to: recipient,
      cc: cc.join(", ") || undefined,
      subject,
      body,
      sourceMessageId: gmailImport?.gmail_message_id,
      attachments: outgoing,
      companyId: ticket.company_id,
      accountId: fromAccount?.id
    });
    sentMessageId = sent.id;
    console.log(`Vastaus lähetetty tehtävältä ${ticket.id} osoitteeseen ${recipient} tililtä ${fromAccount?.email || fromAccount?.id || "oletus"}.`);
  } catch (error: any) {
    console.error("Vastauksen lähetys epäonnistui:", error?.message ?? error);
    const status = error?.status ?? error?.response?.status;
    return res.status(502).json({
      error: status === 403
        ? "Sähköpostitililtä puuttuu lähetysoikeus. Yhdistä tili uudelleen asetuksista."
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
    body,
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

  // Lähetetty vastaus siirtää tehtävän Vastattu-tilaan.
  db.prepare(`
    UPDATE tickets
    SET draft = '', status = 'answered', updated_at = ?
    WHERE id = ?
  `).run(timestamp, req.params.id);

  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"),
    req.params.id,
    parsed.data.actor,
    "reply_sent",
    JSON.stringify({ to: recipient, ...(cc.length > 0 ? { cc: cc.join(", ") } : {}), subject }),
    timestamp
  );

  res.json({ ok: true, to: recipient });
});

// Tiedoston liittäminen suoraan tehtävälle (ei lähetä mitään). Sallittu tehtävän tilasta riippumatta.
ticketActionsRouter.post("/tickets/:id/attachments", async (req, res) => {
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
  const unsafe = await unsafeFileMessage(files);
  if (unsafe) return res.status(400).json({ error: unsafe });

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

// Avaa suljetun tehtävän uudelleen: käsittelijälle, jos sellainen on, muuten päätösjonoon.
ticketActionsRouter.post("/tickets/:id/reopen", (req, res) => {
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
