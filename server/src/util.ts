import crypto from "node:crypto";
import { assertSafeFile, UnsafeFileError } from "./scan.js";

export function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function now() {
  return new Date().toISOString();
}

// 1, kun tehtävän viimeisin viesti on asukkaalta ja keskustelussa on jo aiempia viestejä,
// eli asukas on vastannut eikä hänelle ole vielä vastattu.
export const NEW_REPLY_SQL = `(
  (SELECT COUNT(*) FROM messages m WHERE m.ticket_id = t.id) > 1
  AND (SELECT m.direction FROM messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) = 'inbound'
)`;

// Milloin asukas alkoi odottaa vastausta: ensimmäinen saapunut viesti toimiston viimeisimmän vastauksen
// jälkeen. NULL, kun toimisto on vastannut viimeisimpään viestiin.
export const WAITING_SINCE_SQL = `(
  SELECT MIN(m.created_at) FROM messages m
  WHERE m.ticket_id = t.id AND m.direction = 'inbound'
    AND m.created_at > COALESCE((SELECT MAX(o.created_at) FROM messages o WHERE o.ticket_id = t.id AND o.direction = 'outbound'), '')
)`;

// 1, kun tehtävälle on pyydetty AI-ehdotus; vasta silloin näytetään ehdotettu dokumentti.
export const AI_SUGGESTED_SQL = `EXISTS(
  SELECT 1 FROM audit_log al WHERE al.ticket_id = t.id AND al.action = 'ai_suggested'
)`;

// Ehto asukkaalle, joka asuu yhtiössä tänään (ei ole muuttanut pois).
// Tehtävän tilat. open = Uusi (saapunut, ei vielä käsittelyssä; päätösjonossa), active = Avoin,
// waiting_manager = Käsittelyssä, answered = Vastattu (toimisto on vastannut), waiting_third_party =
// Kolmannella osapuolella, closed = Suljettu.
export const TICKET_STATUSES = ["open", "active", "waiting_manager", "answered", "waiting_third_party", "closed"] as const;

// Asukkaan vastaus tehtävään: suljettu tehtävä avautuu uudelleen uutena ja vastattu muuttuu avoimeksi,
// jotta se palaa käsittelijän päätösjonoon. Muut tilat säilyvät.
export function statusAfterResidentReply(status: string) {
  if (status === "closed") return "open";
  if (status === "answered") return "active";
  return status;
}

export const ACTIVE_RESIDENT = "(r.moved_out_at IS NULL OR r.moved_out_at > date('now', 'localtime'))";

export function today() {
  return new Date().toLocaleDateString("sv-SE");
}

// Tarkistaa vastaanotettavat tiedostot ennen tallennusta. Palauttaa käyttäjälle näytettävän virheen
// tai null, kun kaikki tiedostot voidaan ottaa vastaan.
export async function unsafeFileMessage(files: { filename: string; content: Buffer }[]): Promise<string | null> {
  try {
    for (const file of files) await assertSafeFile(file.content, file.filename);
    return null;
  } catch (error) {
    if (error instanceof UnsafeFileError) return error.message;
    throw error;
  }
}

export const VALID_EMAIL = /^[^\s<>,;@]+@[^\s<>,;@]+$/;
