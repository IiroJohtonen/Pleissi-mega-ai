import fs from "node:fs/promises";
import path from "node:path";
import { attachmentsDir, db } from "./db.js";
import { id, now } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Asukkaan tietojen poisto tehtävistä (tietosuoja-asetuksen poistopyyntö). Avoimen tehtävän voi
// säilyttää, kun asia on kesken ja tietoja tarvitaan sen hoitamiseen (esim. vesivahinko): silloin
// tehtävä anonymisoidaan vasta, kun se suljetaan. Peruste ja päätös kirjautuvat lokiin.
// ---------------------------------------------------------------------------------------------
export const ERASED_NAME = "Poistettu asukas";
export const ERASED_TEXT = "[Poistettu]";

db.exec(`
CREATE TABLE IF NOT EXISTS erasure_pending (
  ticket_id TEXT NOT NULL,
  resident_id TEXT NOT NULL,
  -- Asukkaan nimi ja osoite tarvitaan, jotta hänen viestinsä tunnistetaan yhteisestä tehtävästä
  -- vielä anonymisoinnin hetkellä. Rivi poistetaan anonymisoinnin jälkeen.
  name TEXT NOT NULL,
  email TEXT,
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, resident_id)
);
`);

export type ErasedResident = { id: string; name: string; email: string | null };

// Viestin lähettäjä on muotoa "Nimi <osoite>" tai pelkkä nimi.
export function sentByResident(sender: string, resident: { name: string; email: string | null }) {
  const value = sender.toLowerCase();
  const name = resident.name.toLowerCase();
  return value === name || value.startsWith(`${name} <`)
    || Boolean(resident.email && value.includes(`<${resident.email.toLowerCase()}>`));
}

export function residentTicketIds(residentId: string) {
  return (db.prepare(`
    SELECT id FROM tickets
    WHERE resident_id = ? OR id IN (SELECT ticket_id FROM ticket_reporters WHERE resident_id = ?)
    ORDER BY created_at
  `).all(residentId, residentId) as { id: string }[]).map(ticket => ticket.id);
}

// Asukkaan avoimet tehtävät, jotka poiston yhteydessä voi säilyttää.
export function openResidentTickets(residentId: string) {
  const ids = residentTicketIds(residentId);
  if (!ids.length) return [];
  return db.prepare(`
    SELECT id, ticket_number, subject, type, status, created_at FROM tickets
    WHERE id IN (${ids.map(() => "?").join(", ")}) AND status != 'closed'
    ORDER BY created_at
  `).all(...ids) as { id: string; ticket_number: number | null; subject: string; type: string; status: string; created_at: string }[];
}

// Poistaa asukkaan tiedot yhdestä tehtävästä. Asukkaan oma tehtävä anonymisoidaan kokonaan: viestit,
// liitteet, luonnos, otsikko, tiivistelmä ja AI:n peruste. Yhteisestä tehtävästä poistetaan vain tämän
// asukkaan viestit, ja tehtävä jää muille ilmoittajille. Palauttaa poistettavien liitetiedostojen tunnisteet.
// Kutsutaan transaktion sisällä.
export function eraseResidentFromTicket(ticketId: string, resident: ErasedResident): string[] {
  const removedFiles: string[] = [];
  const others = db.prepare(`
    SELECT r.id, r.apartment_id FROM ticket_reporters tr JOIN residents r ON r.id = tr.resident_id
    WHERE tr.ticket_id = ? AND tr.resident_id != ? ORDER BY r.name
  `).all(ticketId, resident.id) as { id: string; apartment_id: string }[];

  if (others.length === 0) {
    db.prepare("UPDATE messages SET body = ?, subject = ? WHERE ticket_id = ? AND channel != 'contractor'").run(ERASED_TEXT, ERASED_TEXT, ticketId);
    db.prepare("UPDATE messages SET sender = ? WHERE ticket_id = ? AND direction = 'inbound'").run(ERASED_NAME, ticketId);
    db.prepare("UPDATE tickets SET draft = '', subject = ?, summary = '', ai_reason = '' WHERE id = ?").run(ERASED_TEXT, ticketId);
    const files = db.prepare(
      "SELECT id FROM attachments WHERE ticket_id = ? AND direction IN ('inbound', 'portal')"
    ).all(ticketId) as { id: string }[];
    removedFiles.push(...files.map(file => file.id));
    db.prepare("DELETE FROM attachments WHERE ticket_id = ? AND direction IN ('inbound', 'portal')").run(ticketId);
  } else {
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

  // Asukkaan täyttämän lomakkeen kentät (esim. uusi osoite) poistetaan; tehtävän viesti on jo tyhjennetty.
  db.prepare("DELETE FROM portal_forms WHERE ticket_id = ? AND resident_id = ?").run(ticketId, resident.id);
  db.prepare("UPDATE audit_log SET actor = ? WHERE ticket_id = ? AND actor = ?").run(ERASED_NAME, ticketId, resident.name);
  db.prepare(`
    UPDATE audit_log SET details = '{}'
    WHERE ticket_id = ? AND action IN ('reporter_linked', 'reply_received', 'reply_received_reopened')
  `).run(ticketId);
  return removedFiles;
}

export async function removeAttachmentFiles(fileIds: string[]) {
  for (const fileId of fileIds) await fs.rm(path.join(attachmentsDir, fileId), { force: true });
}

// Säilytetty tehtävä odottaa anonymisointia, kunnes se suljetaan.
export function deferTicketErasure(ticketId: string, resident: ErasedResident, reason: string, requestedBy: string) {
  db.prepare(`
    INSERT OR REPLACE INTO erasure_pending (ticket_id, resident_id, name, email, reason, requested_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ticketId, resident.id, resident.name, resident.email, reason, requestedBy, now());
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), ticketId, requestedBy, "erasure_deferred", JSON.stringify({ reason }), now()
  );
}

// Anonymisoi suljetut tehtävät, joiden poisto odotti tehtävän valmistumista.
export async function processPendingErasures() {
  const pending = db.prepare(`
    SELECT p.* FROM erasure_pending p JOIN tickets t ON t.id = p.ticket_id WHERE t.status = 'closed'
  `).all() as { ticket_id: string; resident_id: string; name: string; email: string | null; reason: string }[];
  // Poistettu tehtävä ei enää tarvitse anonymisointia.
  db.prepare("DELETE FROM erasure_pending WHERE ticket_id NOT IN (SELECT id FROM tickets)").run();
  for (const row of pending) {
    let files: string[] = [];
    db.transaction(() => {
      files = eraseResidentFromTicket(row.ticket_id, { id: row.resident_id, name: row.name, email: row.email });
      db.prepare("DELETE FROM erasure_pending WHERE ticket_id = ? AND resident_id = ?").run(row.ticket_id, row.resident_id);
      db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
        id("audit"), row.ticket_id, "system", "erasure_completed", JSON.stringify({ reason: row.reason }), now()
      );
    })();
    await removeAttachmentFiles(files);
  }
  return pending.length;
}

export function pendingErasure(ticketId: string) {
  return db.prepare("SELECT reason, requested_by, created_at FROM erasure_pending WHERE ticket_id = ? ORDER BY created_at LIMIT 1")
    .get(ticketId) as { reason: string; requested_by: string; created_at: string } | undefined;
}
