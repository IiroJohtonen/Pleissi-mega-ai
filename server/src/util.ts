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

// Puhelinnumero E.164-muotoon: välit, viivat ja sulut pois, 00 → +, suomalainen 0-alkuinen → +358.
// Palauttaa null, jos numero ei kelpaa.
export function normalizePhone(value: string | null | undefined): string | null {
  let phone = (value ?? "").trim().replace(/[\s()./-]/g, "");
  if (!phone) return null;
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  else if (phone.startsWith("0")) phone = `+358${phone.slice(1)}`;
  else if (!phone.startsWith("+") && phone.startsWith("358")) phone = `+${phone}`;
  return /^\+[1-9]\d{6,14}$/.test(phone) ? phone : null;
}

export const ACTIVE_RESIDENT = "(r.moved_out_at IS NULL OR r.moved_out_at > date('now', 'localtime'))";

export function today() {
  return new Date().toLocaleDateString("sv-SE");
}

// Taloyhtiöiden varausvuorot ovat Suomen aikaa riippumatta palvelimen aikavyöhykkeestä.
const HELSINKI = "Europe/Helsinki";

// Suomen aikaa oleva kellonaika (päivä VVVV-KK-PP ja tunti) ISO-muodossa (UTC).
export function helsinkiIso(day: string, hour: number) {
  const guess = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: HELSINKI, timeZoneName: "shortOffset" })
    .formatToParts(guess).find(part => part.type === "timeZoneName")?.value ?? "GMT+2";
  const offset = Number(/GMT([+-]\d+)/.exec(zone)?.[1] ?? 2);
  return new Date(guess.getTime() - offset * 3600_000).toISOString();
}

// Aikaleiman päivä (VVVV-KK-PP), tunti ja minuutti Suomen aikaa.
export function helsinkiParts(iso: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HELSINKI, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")), minute: Number(part("minute")) };
}

// Päivä VVVV-KK-PP, johon lisätään päiviä.
export function addDays(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

// Asunnon rappu: asukkaan tietoihin kirjattu Rappu tai, jos sitä ei ole, asunnon numeron alkukirjaimet
// ("B 34" -> "B"). Ilman kumpaakaan rappua ei ole.
export function stairwellOf(apartmentNumber?: string | null, staircase?: string | null) {
  if (staircase?.trim()) return staircase.trim().toUpperCase();
  return (apartmentNumber ?? "").trim().match(/^[A-Za-zÅÄÖåäö]+/)?.[0].toUpperCase() ?? "";
}
