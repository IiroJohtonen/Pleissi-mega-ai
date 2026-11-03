import { db } from "./db.js";
import { embed, embeddingEnabled } from "./embedding.js";
import { isTopic } from "./incidents.js";
import { id, now } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Ilmoitusten yhdistäminen ja häiriöhistoria:
// - AI:n luokittelema aihe ja häiriö- tai turvallisuusilmoituksen kohdeasunto (applyClassification)
// - yhdistämisehdotus: sama asukas, sama aihe ja avoin tehtävä 14 päivän sisällä (mergeSuggestion);
//   käsittelijä yhdistää yhdellä klikkauksella (mergeTickets), ei koskaan automaattisesti
// - kohdeasunnon häiriöhistoria kaikilta ilmoittajilta (targetHistory), vain henkilökunnalle
// ---------------------------------------------------------------------------------------------

export const MERGE_WINDOW_DAYS = 14;
// Aiheet, joissa ilmoitus koskee toista asuntoa.
export const TARGET_TOPICS = ["noise", "safety"];

const normalizeApartment = (value: string) => value.toLowerCase().replace(/[^a-z0-9åäö]/g, "");

// Tallentaa AI:n aiheen (jos aihetta ei vielä ole) ja ehdottaa kohdeasunnon taloyhtiön asunnoista.
export function applyClassification(ticketId: string, result: { topic?: string; targetApartment?: string | null }) {
  if (result.topic && isTopic(result.topic) && result.topic !== "other") {
    db.prepare("UPDATE tickets SET topic = ?, topic_source = 'ai' WHERE id = ? AND topic IS NULL").run(result.topic, ticketId);
  }
  const ticket = db.prepare("SELECT company_id, apartment_id, topic FROM tickets WHERE id = ?").get(ticketId) as
    { company_id: string; apartment_id: string | null; topic: string | null } | undefined;
  const text = result.targetApartment?.trim();
  if (!ticket || !text || !TARGET_TOPICS.includes(ticket.topic ?? "")) return;
  const wanted = normalizeApartment(text);
  const matches = (db.prepare("SELECT id, apartment_number FROM apartments WHERE company_id = ?").all(ticket.company_id) as
    { id: string; apartment_number: string }[]).filter(apartment => normalizeApartment(apartment.apartment_number) === wanted && apartment.id !== ticket.apartment_id);
  db.prepare("UPDATE tickets SET target_apartment_text = ?, target_apartment_id = ?, target_apartment_confirmed = 0 WHERE id = ?")
    .run(text.slice(0, 20), matches.length === 1 ? matches[0].id : null, ticketId);
}

// Käsittelijä vahvistaa tai vaihtaa kohdeasunnon (null = ei kohdetta).
export function confirmTargetApartment(ticketId: string, apartmentId: string | null, actor: string) {
  db.prepare("UPDATE tickets SET target_apartment_id = ?, target_apartment_confirmed = 1, updated_at = ? WHERE id = ?").run(apartmentId, now(), ticketId);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), ticketId, actor, "target_apartment_confirmed", "{}", now());
}

type MergeCandidate = { id: string; ticket_number: number | null; subject: string; created_at: string; topic: string | null; summary: string };

const senderOf = (ticketId: string) => ((db.prepare(`
  SELECT sender FROM messages WHERE ticket_id = ? AND direction = 'inbound' ORDER BY created_at LIMIT 1
`).get(ticketId) as { sender: string } | undefined)?.sender ?? "").toLowerCase().replace(/^.*</, "").replace(/>.*$/, "").trim();

const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);

// Yhdistämisehdotus: saman asukkaan (tai tunnistamattoman lähettäjän) avoin tehtävä samasta aiheesta 14 päivän
// sisällä ennen tätä tehtävää. Kun merkityshaku on taloyhtiössä käytössä, aiheeltaan eri tai aiheettomista
// ehdokkaista kelpaa myös merkitykseltään lähes sama.
export async function mergeSuggestion(ticketId: string): Promise<MergeCandidate | null> {
  const ticket = db.prepare(`
    SELECT id, company_id, resident_id, topic, subject, summary, created_at, status, merged_into FROM tickets WHERE id = ?
  `).get(ticketId) as { id: string; company_id: string; resident_id: string | null; topic: string | null; subject: string; summary: string;
    created_at: string; status: string; merged_into: string | null } | undefined;
  if (!ticket || ticket.merged_into || ticket.status === "closed") return null;
  const since = new Date(Date.parse(ticket.created_at) - MERGE_WINDOW_DAYS * 86_400_000).toISOString();
  const sender = ticket.resident_id ? "" : senderOf(ticket.id);
  if (!ticket.resident_id && !sender) return null;
  const candidates = (db.prepare(`
    SELECT t.id, t.ticket_number, t.subject, t.created_at, t.topic, t.summary FROM tickets t
    WHERE t.company_id = ? AND t.id != ? AND t.kind = 'ticket' AND t.status != 'closed' AND t.merged_into IS NULL
      AND t.created_at >= ? AND t.created_at <= ? AND t.sensitive = 0
      ${ticket.resident_id ? "AND t.resident_id = ?" : ""}
    ORDER BY t.created_at DESC LIMIT 20
  `).all(ticket.company_id, ticket.id, since, ticket.created_at, ...(ticket.resident_id ? [ticket.resident_id] : [])) as MergeCandidate[])
    .filter(candidate => ticket.resident_id || senderOf(candidate.id) === sender);
  const sameTopic = ticket.topic && ticket.topic !== "other" ? candidates.find(candidate => candidate.topic === ticket.topic) : undefined;
  if (sameTopic) return sameTopic;
  if (!candidates.length || !embeddingEnabled(ticket.company_id, "similarTickets")) return null;
  try {
    const [vector, ...others] = await embed([`${ticket.subject}\n${ticket.summary}`, ...candidates.map(candidate => `${candidate.subject}\n${candidate.summary}`)], "passage");
    const threshold = Number(process.env.EMBEDDING_MIN_SIMILARITY) || 0.8;
    const best = others.map((other, index) => ({ candidate: candidates[index], score: cosine(vector, other) })).sort((a, b) => b.score - a.score)[0];
    return best && best.score >= threshold ? best.candidate : null;
  } catch (error) {
    console.error("Yhdistämisehdotuksen merkityshaku epäonnistui:", error instanceof Error ? error.message : error);
    return null;
  }
}

// Yhdistää tehtävän (source) aiempaan (target): viestit, liitteet, muistiinpanot, ilmoittajat ja postiketju
// siirtyvät; yhdistetty tehtävä suljetaan ja siitä jää viittaus. Kirjataan molempiin lokeihin.
export function mergeTickets(sourceId: string, targetId: string, actor: string) {
  const timestamp = now();
  db.transaction(() => {
    for (const table of ["messages", "attachments", "ticket_notes", "gmail_imports"]) {
      db.prepare(`UPDATE ${table} SET ticket_id = ? WHERE ticket_id = ?`).run(targetId, sourceId);
    }
    db.prepare("INSERT OR IGNORE INTO ticket_reporters (ticket_id, resident_id) SELECT ?, resident_id FROM ticket_reporters WHERE ticket_id = ?").run(targetId, sourceId);
    db.prepare("UPDATE tickets SET merged_into = ?, status = 'closed', updated_at = ? WHERE id = ?").run(targetId, timestamp, sourceId);
    // Uusi viesti avaa yhdistetyn tehtävän uudelleen käsiteltäväksi.
    db.prepare("UPDATE tickets SET status = CASE status WHEN 'closed' THEN 'open' WHEN 'answered' THEN 'active' ELSE status END, updated_at = ? WHERE id = ?")
      .run(timestamp, targetId);
    const target = db.prepare("SELECT ticket_number FROM tickets WHERE id = ?").get(targetId) as { ticket_number: number | null };
    const source = db.prepare("SELECT ticket_number FROM tickets WHERE id = ?").get(sourceId) as { ticket_number: number | null };
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), sourceId, actor, "ticket_merged", JSON.stringify({ into: targetId, number: target.ticket_number }), timestamp);
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), targetId, actor, "ticket_merged_from", JSON.stringify({ from: sourceId, number: source.ticket_number }), timestamp);
  })();
}

// Kohdeasunnon häiriöhistoria kaikilta ilmoittajilta (2 v). Vain henkilökunnalle; ilmoittajaa ei näytetä.
export function targetHistory(ticketId: string) {
  const ticket = db.prepare("SELECT company_id, target_apartment_id, target_apartment_confirmed FROM tickets WHERE id = ?").get(ticketId) as
    { company_id: string; target_apartment_id: string | null; target_apartment_confirmed: number } | undefined;
  if (!ticket?.target_apartment_id || !ticket.target_apartment_confirmed) return null;
  const apartment = db.prepare("SELECT apartment_number FROM apartments WHERE id = ?").get(ticket.target_apartment_id) as { apartment_number: string } | undefined;
  const since = new Date(Date.now() - 730 * 86_400_000).toISOString();
  const rows = db.prepare(`
    SELECT id, ticket_number, subject, topic, status, created_at, sensitive FROM tickets
    WHERE target_apartment_id = ? AND target_apartment_confirmed = 1 AND id != ? AND created_at >= ? AND merged_into IS NULL
    ORDER BY created_at DESC LIMIT 20
  `).all(ticket.target_apartment_id, ticketId, since) as { id: string; ticket_number: number | null; subject: string; topic: string | null;
    status: string; created_at: string; sensitive: number }[];
  return {
    apartmentNumber: apartment?.apartment_number ?? null,
    reports: rows.map(row => ({
      id: row.id, ticketNumber: row.ticket_number, subject: row.sensitive ? "Arkaluonteinen tehtävä" : row.subject,
      topic: row.topic, status: row.status, createdAt: row.created_at
    }))
  };
}
