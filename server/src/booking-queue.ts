import { db } from "./db.js";
import { notifyResident } from "./notify.js";
import { id, now } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Vuorokohtainen jono sauna- ja pyykkitupavuoroille. Asukas liittyy jonoon varatun vuoron päältä.
// Kun varaus perutaan tai poistetaan, vuoro siirtyy aina jonon ensimmäiselle, myös vähän ennen
// vuoron alkua. Jonoon liittyminen sen sijaan päättyy kolme tuntia ennen vuoron alkua.
// ---------------------------------------------------------------------------------------------
export const QUEUE_JOIN_CUTOFF_MS = 3 * 60 * 60 * 1000;

const RESOURCE_NAMES: Record<string, string> = { sauna: "saunavuoro", laundry: "pyykkitupavuoro" };

export type QueueEntry = {
  id: string; company_id: string; resource: string; starts_at: string; ends_at: string;
  resident_id: string | null; status: string; created_at: string;
};

// Vuoron aika suomalaisittain, esim. "pe 17.10. klo 18.00–19.00".
export function slotLabel(startsAt: string, endsAt: string) {
  const options = { timeZone: "Europe/Helsinki" } as const;
  const day = new Date(startsAt).toLocaleDateString("fi-FI", { ...options, weekday: "short", day: "numeric", month: "numeric" });
  const time = (value: string) => new Date(value).toLocaleTimeString("fi-FI", { ...options, hour: "2-digit", minute: "2-digit" });
  return `${day} klo ${time(startsAt)}–${time(endsAt)}`;
}

// Jonosija: odottavien joukossa liittymisjärjestyksessä, 1 = seuraava.
export const QUEUE_POSITION_SQL = `(
  SELECT COUNT(*) FROM booking_queue earlier
  WHERE earlier.company_id = q.company_id AND earlier.resource = q.resource
    AND earlier.starts_at = q.starts_at AND earlier.ends_at = q.ends_at AND earlier.status = 'waiting'
    AND (earlier.created_at < q.created_at OR (earlier.created_at = q.created_at AND earlier.id < q.id))
) + 1`;

export function waitingCount(companyId: string, resource: string, startsAt: string, endsAt: string) {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM booking_queue
    WHERE company_id = ? AND resource = ? AND starts_at = ? AND ends_at = ? AND status = 'waiting'
  `).get(companyId, resource, startsAt, endsAt) as { count: number }).count;
}

// Antaa vapautuneen vuoron jonon ensimmäiselle. Palauttaa jonottajan tunnisteen tai null, jos jono
// on tyhjä tai vuoro on jo päättynyt, jolloin vuoro jää vapaaksi.
export function giveSlotToQueue(slot: { company_id: string; resource: string; starts_at: string; ends_at: string }) {
  if (Date.parse(slot.ends_at) <= Date.now()) return null;
  const next = db.prepare(`
    SELECT * FROM booking_queue
    WHERE company_id = ? AND resource = ? AND starts_at = ? AND ends_at = ? AND status = 'waiting' AND resident_id IS NOT NULL
    ORDER BY created_at, id LIMIT 1
  `).get(slot.company_id, slot.resource, slot.starts_at, slot.ends_at) as QueueEntry | undefined;
  if (!next || !next.resident_id) return null;
  // Vuoro voi olla jo varattu uudelleen (esim. toimisto varasi sen samalla); silloin jono odottaa.
  const taken = db.prepare(`
    SELECT 1 FROM bookings WHERE company_id = ? AND resource = ? AND starts_at < ? AND ends_at > ? LIMIT 1
  `).get(slot.company_id, slot.resource, slot.ends_at, slot.starts_at);
  if (taken) return null;

  const bookingId = id("booking");
  const timestamp = now();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO bookings (id, company_id, resource, resident_id, note, starts_at, ends_at, created_by, created_at, series_id)
      VALUES (?, ?, ?, ?, '', ?, ?, 'Jono', ?, NULL)
    `).run(bookingId, slot.company_id, slot.resource, next.resident_id, slot.starts_at, slot.ends_at, timestamp);
    db.prepare("UPDATE booking_queue SET status = 'granted', closed_at = ?, booking_id = ? WHERE id = ?").run(timestamp, bookingId, next.id);
  })();

  const name = RESOURCE_NAMES[slot.resource] ?? "vuoro";
  void notifyResident(next.resident_id, `Sait ${name}n ${slotLabel(slot.starts_at, slot.ends_at)}`, [
    `olit jonossa, ja ${name} ${slotLabel(slot.starts_at, slot.ends_at)} vapautui. Vuoro on nyt varattu sinulle.`,
    "Jos et tarvitse vuoroa, peru se asukasportaalissa, niin se siirtyy seuraavalle jonottajalle."
  ]);
  return next.resident_id;
}

// Kutsutaan varausten poiston jälkeen: jokainen vapautunut vuoro siirtyy jonon ensimmäiselle.
export function releaseSlots(removed: { company_id: string; resource: string; starts_at: string; ends_at: string }[]) {
  for (const slot of removed) giveSlotToQueue(slot);
}

// Poistaa varaukset ja siirtää vapautuneet vuorot jonolle. where = SQL-ehto bookings-taululle.
export function deleteBookingsAndRelease(where: string, params: unknown[]) {
  const removed = db.prepare(`SELECT id, company_id, resource, starts_at, ends_at FROM bookings WHERE ${where}`).all(...params) as
    { id: string; company_id: string; resource: string; starts_at: string; ends_at: string }[];
  const remove = db.prepare("DELETE FROM bookings WHERE id = ?");
  db.transaction(() => {
    for (const booking of removed) remove.run(booking.id);
  })();
  releaseSlots(removed);
  return removed.length;
}

// Ennen jonoa asukas saattoi toivoa varattua vuoroa, ja isännöitsijä hyväksyi toiveen. Jono korvaa
// toiveet: avoin toive tulevasta vuorosta muuttuu jonopaikaksi (alkuperäinen toiveen aika säilyy
// jonon järjestyksenä), ja mennyttä vuoroa koskeva toive suljetaan. Toiveet säilyvät historiana.
export function migrateBookingRequests() {
  const pending = db.prepare("SELECT * FROM booking_requests WHERE status = 'pending' ORDER BY created_at").all() as
    { id: string; company_id: string; resource: string; resident_id: string; starts_at: string; ends_at: string; created_at: string }[];
  const timestamp = now();
  db.transaction(() => {
    for (const request of pending) {
      if (Date.parse(request.ends_at) > Date.now()) {
        db.prepare(`
          INSERT INTO booking_queue (id, company_id, resource, starts_at, ends_at, resident_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)
        `).run(id("queue"), request.company_id, request.resource, request.starts_at, request.ends_at, request.resident_id, request.created_at);
        db.prepare("UPDATE booking_requests SET status = 'queued', decided_at = ?, decided_by = 'Jono' WHERE id = ?").run(timestamp, request.id);
      } else {
        db.prepare("UPDATE booking_requests SET status = 'cancelled', decided_at = ? WHERE id = ?").run(timestamp, request.id);
      }
    }
  })();
}
