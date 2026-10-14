import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { db } from "../db.js";
import { notifyResident } from "../notify.js";
import { id, now } from "../util.js";
import { BOOKING_RESOURCES, bookingKindError } from "./bookings.js";
import { portalResident } from "./portal.js";

export const bookingRequestsRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Varaustoiveet: asukas voi toivoa jo varattua sauna- tai pyykkitupavuoroa. Toive menee
// isännöitsijälle, joka hyväksyy sen (vuoro siirtyy toivojalle ja aiempi varaus poistuu) tai hylkää.
// ---------------------------------------------------------------------------------------------

type BookingRequest = {
  id: string; company_id: string; resource: string; resident_id: string; starts_at: string; ends_at: string;
  note: string; status: string;
};

const RESOURCE_NAMES: Record<string, string> = { sauna: "saunavuoro", laundry: "pyykkitupavuoro" };

// Vuoron aika suomalaisittain, esim. "pe 17.10. klo 18.00–19.00".
function slotLabel(startsAt: string, endsAt: string) {
  const options = { timeZone: "Europe/Helsinki" } as const;
  const day = new Date(startsAt).toLocaleDateString("fi-FI", { ...options, weekday: "short", day: "numeric", month: "numeric" });
  const time = (value: string) => new Date(value).toLocaleTimeString("fi-FI", { ...options, hour: "2-digit", minute: "2-digit" });
  return `${day} klo ${time(startsAt)}–${time(endsAt)}`;
}

// Vuoron kanssa päällekkäiset varaukset.
function overlappingBookings(companyId: string, resource: string, startsAt: string, endsAt: string) {
  return db.prepare(`
    SELECT id, resident_id FROM bookings
    WHERE company_id = ? AND resource = ? AND starts_at < ? AND ends_at > ?
  `).all(companyId, resource, endsAt, startsAt) as { id: string; resident_id: string | null }[];
}

bookingRequestsRouter.post("/portal/booking-requests", (req, res) => {
  const resident = portalResident(res);
  const parsed = z.object({
    resource: z.enum(BOOKING_RESOURCES),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    note: z.string().trim().max(300).default("")
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista toiveen tiedot." });

  const { resource, startsAt, endsAt, note } = parsed.data;
  const valid = endsAt > startsAt
    && Date.parse(endsAt) > Date.now()
    && Date.parse(endsAt) - Date.parse(startsAt) <= 4 * 60 * 60 * 1000;
  if (!valid) return res.status(400).json({ error: "Vuoro on jo mennyt tai aika ei kelpaa." });

  const kindError = bookingKindError(resident.companyId, resource, 0);
  if (kindError) return res.status(403).json({ error: kindError });

  const holders = overlappingBookings(resident.companyId, resource, startsAt, endsAt);
  if (holders.length === 0) return res.status(409).json({ error: "Vuoro on vapaa. Varaa se suoraan kalenterista." });
  if (holders.some(holder => holder.resident_id === resident.id)) {
    return res.status(409).json({ error: "Vuoro on jo varattu sinulle." });
  }
  const duplicate = db.prepare(`
    SELECT 1 FROM booking_requests
    WHERE resident_id = ? AND resource = ? AND starts_at = ? AND status = 'pending'
  `).get(resident.id, resource, startsAt);
  if (duplicate) return res.status(409).json({ error: "Olet jo toivonut tätä vuoroa." });

  const requestId = id("bookreq");
  db.prepare(`
    INSERT INTO booking_requests (id, company_id, resource, resident_id, starts_at, ends_at, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(requestId, resident.companyId, resource, resident.id, startsAt, endsAt, note, now());
  res.status(201).json({ ok: true, requestId });
});

// Asukkaan omat toiveet: käsittelyä odottavat sekä viimeisen kuukauden aikana käsitellyt.
bookingRequestsRouter.get("/portal/booking-requests", (req, res) => {
  const resident = portalResident(res);
  const resource = z.enum(BOOKING_RESOURCES).safeParse(req.query.resource);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  res.json(db.prepare(`
    SELECT id, resource, starts_at, ends_at, note, status, decision_note, created_at
    FROM booking_requests
    WHERE resident_id = ? AND (? IS NULL OR resource = ?)
      AND status != 'cancelled'
      AND (status = 'pending' AND ends_at > ? OR status != 'pending' AND decided_at > ?)
    ORDER BY starts_at
  `).all(resident.id, resource.success ? resource.data : null, resource.success ? resource.data : null, now(), monthAgo));
});

bookingRequestsRouter.delete("/portal/booking-requests/:id", (req, res) => {
  const resident = portalResident(res);
  const changes = db.prepare(`
    UPDATE booking_requests SET status = 'cancelled', decided_at = ?
    WHERE id = ? AND resident_id = ? AND status = 'pending'
  `).run(now(), req.params.id, resident.id).changes;
  if (changes === 0) return res.status(404).json({ error: "Käsittelyä odottavaa toivetta ei löytynyt." });
  res.json({ ok: true });
});

// Käsittelyä odottavat toiveet henkilökunnalle: toivoja ja vuoron nykyinen varaaja.
bookingRequestsRouter.get("/companies/:companyId/booking-requests", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const resource = z.enum(BOOKING_RESOURCES).safeParse(req.query.resource);
  res.json(db.prepare(`
    SELECT q.id, q.resource, q.resident_id, q.starts_at, q.ends_at, q.note, q.created_at,
           r.name AS resident_name, a.apartment_number,
           (SELECT group_concat(COALESCE(hr.name || COALESCE(' · ' || ha.apartment_number, ''), NULLIF(b.note, ''), 'Varattu'), ', ')
              FROM bookings b
              LEFT JOIN residents hr ON hr.id = b.resident_id
              LEFT JOIN apartments ha ON ha.id = hr.apartment_id
              WHERE b.company_id = q.company_id AND b.resource = q.resource
                AND b.starts_at < q.ends_at AND b.ends_at > q.starts_at) AS current_holder
    FROM booking_requests q
    LEFT JOIN residents r ON r.id = q.resident_id
    LEFT JOIN apartments a ON a.id = r.apartment_id
    WHERE q.company_id = ? AND q.status = 'pending' AND q.ends_at > ? AND (? IS NULL OR q.resource = ?)
    ORDER BY q.starts_at, q.created_at
  `).all(companyId, now(), resource.success ? resource.data : null, resource.success ? resource.data : null));
});

// Käsittelyä odottava, tulevaisuudessa oleva toive, jonka yhtiöön käyttäjällä on oikeus.
function pendingRequest(requestId: string) {
  const request = db.prepare("SELECT * FROM booking_requests WHERE id = ?").get(requestId) as BookingRequest | undefined;
  if (!request || !companyIdFromContext(request.company_id)) return { status: 404, error: "Toivetta ei löytynyt." };
  if (request.status !== "pending") return { status: 409, error: "Toive on jo käsitelty." };
  if (Date.parse(request.ends_at) <= Date.now()) return { status: 409, error: "Vuoron aika on jo mennyt." };
  return { request };
}

// Hyväksyntä: vuoron aiemmat varaukset poistetaan ja vuoro varataan toivojalle. Sarjasta poistuu vain tämä vuoro.
bookingRequestsRouter.post("/booking-requests/:id/approve", (req, res) => {
  const found = pendingRequest(req.params.id);
  if (!found.request) return res.status(found.status).json({ error: found.error });
  const { request } = found;
  const decidedBy = res.locals.user?.name ?? "Isännöitsijä";
  const label = slotLabel(request.starts_at, request.ends_at);

  const displaced = overlappingBookings(request.company_id, request.resource, request.starts_at, request.ends_at);
  db.transaction(() => {
    for (const booking of displaced) db.prepare("DELETE FROM bookings WHERE id = ?").run(booking.id);
    db.prepare(`
      INSERT INTO bookings (id, company_id, resource, resident_id, note, starts_at, ends_at, created_by, created_at, series_id)
      VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, NULL)
    `).run(id("booking"), request.company_id, request.resource, request.resident_id,
      request.starts_at, request.ends_at, decidedBy, now());
    db.prepare("UPDATE booking_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?")
      .run(decidedBy, now(), request.id);
  })();

  const name = RESOURCE_NAMES[request.resource] ?? "vuoro";
  void notifyResident(request.resident_id, "Varaustoiveesi on hyväksytty", [
    `toivomasi ${name} ${label} on varattu sinulle.`
  ]);
  for (const holderId of new Set(displaced.map(booking => booking.resident_id).filter((value): value is string => Boolean(value)))) {
    if (holderId === request.resident_id) continue;
    void notifyResident(holderId, "Varauksesi on siirretty", [
      `isännöitsijä on siirtänyt varaamasi ${name}n ${label} toiselle asukkaalle.`,
      "Voit varata uuden vuoron asukasportaalista."
    ]);
  }
  res.json({ ok: true, removed: displaced.length });
});

bookingRequestsRouter.post("/booking-requests/:id/reject", (req, res) => {
  const parsed = z.object({ note: z.string().trim().max(500).default("") }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Perustelu on liian pitkä." });
  const found = pendingRequest(req.params.id);
  if (!found.request) return res.status(found.status).json({ error: found.error });
  const { request } = found;

  db.prepare("UPDATE booking_requests SET status = 'rejected', decision_note = ?, decided_by = ?, decided_at = ? WHERE id = ?")
    .run(parsed.data.note, res.locals.user?.name ?? "Isännöitsijä", now(), request.id);
  void notifyResident(request.resident_id, "Varaustoivettasi ei hyväksytty", [
    `toivomaasi ${RESOURCE_NAMES[request.resource] ?? "vuoro"}a ${slotLabel(request.starts_at, request.ends_at)} ei voitu antaa sinulle.`,
    ...(parsed.data.note ? ["", "Perustelu:", parsed.data.note] : [])
  ]);
  res.json({ ok: true });
});
