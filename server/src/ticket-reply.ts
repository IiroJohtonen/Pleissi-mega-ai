import { db } from "./db.js";
import { type OutgoingAttachment, parseSender, type ReplyAccount, sendEmail } from "./mail.js";
import { id, now } from "./util.js";

export type TicketReplyResult =
  | { ok: true; to: string; subject: string; timestamp: string }
  | { ok: false; status: number; error: string };

// Lähettää tehtävän vastauksen sähköpostina ja kirjaa sen tehtävän viestiketjuun. Vastaus ketjutetaan
// asukkaan sähköpostiin, jotta hänen vastauksensa palaa samalle tehtävälle. Kutsuja päivittää tehtävän
// tilan ja lokin: käsittelijän vastaus ja AI-agentin vastaus kirjataan eri tavoin.
export async function sendTicketReply(input: {
  ticket: { id: string; company_id: string; subject: string };
  body: string;
  // Lähettäjän nimi tehtävän aikajanalla.
  actor: string;
  // Aikajanan viesti, johon vastataan. Ilman tätä vastataan tehtävän viimeisimpään saapuneeseen viestiin.
  messageId?: string;
  account?: ReplyAccount;
  cc?: string[];
  attachments?: OutgoingAttachment[];
}): Promise<TicketReplyResult> {
  const { ticket } = input;
  type InboundRow = { sender: string; subject: string; created_at: string };
  const inbound = input.messageId
    ? db.prepare(`
        SELECT sender, subject, created_at
        FROM messages
        WHERE id = ? AND ticket_id = ? AND direction = 'inbound'
      `).get(input.messageId, ticket.id) as InboundRow | undefined
    : db.prepare(`
        SELECT sender, subject, created_at
        FROM messages
        WHERE ticket_id = ? AND direction = 'inbound'
        ORDER BY created_at DESC
        LIMIT 1
      `).get(ticket.id) as InboundRow | undefined;

  if (input.messageId && !inbound) {
    return { ok: false, status: 404, error: "Viestiä, johon vastataan, ei löytynyt tältä tehtävältä." };
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
  `).all(ticket.id) as { email: string }[])
    .map(row => row.email.trim())
    .filter(email => /^[^\s<>,;@]+@[^\s<>,;@]+$/.test(email));

  const recipient = replyTo || reporterEmails.join(", ");
  if (!recipient) {
    return { ok: false, status: 400, error: "Tehtävällä ei ole sähköpostiosoitetta, johon vastauksen voisi lähettää." };
  }

  // Vastaus ketjutetaan siihen sähköpostiin, johon vastataan. Viestin ja sen tunnisteen
  // yhdistää sama tallennushetki; vanhoilla viesteillä käytetään tehtävän ensimmäistä tuontia.
  const gmailImport = replyTo && inbound
    ? (db.prepare(
        "SELECT gmail_message_id FROM gmail_imports WHERE ticket_id = ? AND created_at = ?"
      ).get(ticket.id, inbound.created_at)
      ?? db.prepare(
        "SELECT gmail_message_id FROM gmail_imports WHERE ticket_id = ? ORDER BY created_at LIMIT 1"
      ).get(ticket.id)) as { gmail_message_id: string } | undefined
    : undefined;

  const subject = !replyTo || !inbound
    ? ticket.subject as string
    : /^re:/i.test(inbound.subject.trim()) ? inbound.subject : `Re: ${inbound.subject}`;

  let sentMessageId: string;
  try {
    const sent = await sendEmail({
      to: recipient,
      cc: input.cc?.join(", ") || undefined,
      subject,
      body: input.body,
      sourceMessageId: gmailImport?.gmail_message_id,
      attachments: (input.attachments ?? []).map(({ filename, mimeType, content }) => ({ filename, mimeType, content })),
      companyId: ticket.company_id,
      accountId: input.account?.id
    });
    sentMessageId = sent.id;
    console.log(`Vastaus lähetetty tehtävältä ${ticket.id} osoitteeseen ${recipient} tililtä ${input.account?.email || input.account?.id || "oletus"}.`);
  } catch (error: any) {
    console.error("Vastauksen lähetys epäonnistui:", error?.message ?? error);
    const status = error?.status ?? error?.response?.status;
    return {
      ok: false,
      status: 502,
      error: status === 403
        ? "Sähköpostitililtä puuttuu lähetysoikeus. Yhdistä tili uudelleen asetuksista."
        : "Sähköpostin lähetys epäonnistui. Yritä uudelleen."
    };
  }

  const timestamp = now();

  // Lähetetty viesti kirjataan ketjuun, jotta asukkaan vastaus siihen löytää tämän tehtävän
  // silloinkin, kun tehtävä ei alun perin tullut sähköpostista.
  if (sentMessageId) {
    db.prepare(`
      INSERT OR IGNORE INTO gmail_imports
        (gmail_message_id, ticket_id, created_at)
      VALUES (?, ?, ?)
    `).run(sentMessageId, ticket.id, timestamp);
  }

  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id("message"),
    ticket.id,
    "outbound",
    input.actor,
    subject,
    input.body,
    timestamp,
    "email"
  );

  return { ok: true, to: recipient, subject, timestamp };
}
