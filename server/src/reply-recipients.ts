import { db } from "./db.js";
import { parseSender } from "./mail.js";
import { id, now } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Vastauksen vastaanottajat: oletuksena vastaus menee viimeisimmän saapuneen viestin lähettäjälle (tai tehtävän
// asukkaiden osoitteisiin, jos sähköpostia ei ole). Käsittelijä voi muokata listaa tehtävällä kuten sähköpostissa:
// lisätä ja poistaa osoitteita. Muokattu lista tallentuu tehtävälle, ja kaikki vastaukset menevät sen jälkeen siihen.
// ---------------------------------------------------------------------------------------------

{
  const columns = (db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[]).map(column => column.name);
  // JSON-lista osoitteista; NULL = oletus (lähettäjä tai asukkaat).
  if (!columns.includes("reply_recipients")) db.exec("ALTER TABLE tickets ADD COLUMN reply_recipients TEXT");
}

export const EMAIL_PATTERN = /^[^\s<>,;@]+@[^\s<>,;@]+\.[^\s<>,;@]+$/;
export const MAX_RECIPIENTS = 20;

// Oletusvastaanottajat: viimeisimmän saapuneen sähköpostin lähettäjä, muuten tehtävän asukkaiden osoitteet.
export function defaultRecipients(ticketId: string): string[] {
  const inbound = db.prepare(`
    SELECT sender FROM messages WHERE ticket_id = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1
  `).get(ticketId) as { sender: string } | undefined;
  const sender = inbound ? parseSender(inbound.sender).email : "";
  if (sender && EMAIL_PATTERN.test(sender)) return [sender];
  return (db.prepare(`
    SELECT r.email FROM ticket_reporters tr JOIN residents r ON r.id = tr.resident_id
    WHERE tr.ticket_id = ? AND r.email IS NOT NULL AND trim(r.email) != '' ORDER BY r.name
  `).all(ticketId) as { email: string }[]).map(row => row.email.trim()).filter(email => EMAIL_PATTERN.test(email));
}

// Käsittelijän tallentama lista; tyhjä = ei muokattu.
export function storedRecipients(ticketId: string): string[] {
  const row = db.prepare("SELECT reply_recipients FROM tickets WHERE id = ?").get(ticketId) as { reply_recipients: string | null } | undefined;
  if (!row?.reply_recipients) return [];
  try {
    const list = JSON.parse(row.reply_recipients) as unknown;
    return Array.isArray(list) ? list.filter((email): email is string => typeof email === "string" && EMAIL_PATTERN.test(email)) : [];
  } catch {
    return [];
  }
}

export function replyRecipients(ticketId: string): { recipients: string[]; custom: boolean } {
  const stored = storedRecipients(ticketId);
  return stored.length ? { recipients: stored, custom: true } : { recipients: defaultRecipients(ticketId), custom: false };
}

// Tallentaa listan (pienaakkoset, ei kaksoiskappaleita). Tyhjä lista palauttaa oletuksen.
export function saveRecipients(ticketId: string, recipients: string[], actor: string) {
  const before = replyRecipients(ticketId).recipients;
  const seen = new Set<string>();
  const unique = recipients.map(email => email.trim()).filter(email => {
    const key = email.toLowerCase();
    if (!email || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  db.prepare("UPDATE tickets SET reply_recipients = ?, updated_at = ? WHERE id = ?")
    .run(unique.length ? JSON.stringify(unique) : null, now(), ticketId);
  const after = replyRecipients(ticketId).recipients;
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), ticketId, actor, "reply_recipients_changed", JSON.stringify({ from: before.join(", "), to: after.join(", ") }), now()
  );
  return after;
}
