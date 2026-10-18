import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { QUEUE_JOIN_CUTOFF_MS, QUEUE_POSITION_SQL, waitingCount } from "../booking-queue.js";
import { db } from "../db.js";
import { ACTIVE_RESIDENT, id, now } from "../util.js";
import { BOOKING_RESOURCES, bookingRules } from "./bookings.js";
import { portalResident } from "./portal.js";

export const bookingQueueRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Jonopaikat varatuille vuoroille (logiikka tiedostossa booking-queue.ts). Asukas liittyy jonoon
// kalenterista varatun vuoron päältä ja näkee omat jonopaikkansa sijoineen. Vuoro siirtyy jonolle,
// kun varaus perutaan.
// ---------------------------------------------------------------------------------------------

bookingQueueRouter.post("/portal/booking-queue", (req, res) => {
  const resident = portalResident(res);
  const parsed = z.object({ resource: z.enum(BOOKING_RESOURCES), startsAt: z.iso.datetime(), endsAt: z.iso.datetime() }).safeParse(req.body);
  if (!parsed.success || parsed.data.endsAt <= parsed.data.startsAt) return res.status(400).json({ error: "Tarkista vuoron tiedot." });
  const { resource, startsAt, endsAt } = parsed.data;

  const rule = bookingRules(resident.companyId)[resource];
  if (!rule.queueEnabled) return res.status(403).json({ error: "Jono ei ole käytössä tässä taloyhtiössä." });
  // Raja tarkistetaan palvelimella: jonoon ei voi liittyä alle kolme tuntia ennen vuoron alkua.
  if (Date.parse(startsAt) - Date.now() < QUEUE_JOIN_CUTOFF_MS) {
    return res.status(409).json({ error: "Jonoon voi liittyä viimeistään kolme tuntia ennen vuoron alkua." });
  }

  const holders = db.prepare(`
    SELECT resident_id FROM bookings WHERE company_id = ? AND resource = ? AND starts_at < ? AND ends_at > ?
  `).all(resident.companyId, resource, endsAt, startsAt) as { resident_id: string | null }[];
  if (holders.length === 0) return res.status(409).json({ error: "Vuoro on vapaa. Varaa se suoraan kalenterista." });
  if (holders.some(holder => holder.resident_id === resident.id)) return res.status(409).json({ error: "Vuoro on jo varattu sinulle." });
  const already = db.prepare(`
    SELECT 1 FROM booking_queue WHERE resident_id = ? AND company_id = ? AND resource = ? AND starts_at = ? AND ends_at = ? AND status = 'waiting'
  `).get(resident.id, resident.companyId, resource, startsAt, endsAt);
  if (already) return res.status(409).json({ error: "Olet jo tämän vuoron jonossa." });
  if (waitingCount(resident.companyId, resource, startsAt, endsAt) >= rule.queueSize) {
    return res.status(409).json({ error: "Jono on täynnä." });
  }

  const entryId = id("queue");
  db.prepare(`
    INSERT INTO booking_queue (id, company_id, resource, starts_at, ends_at, resident_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)
  `).run(entryId, resident.companyId, resource, startsAt, endsAt, resident.id, now());
  const position = waitingCount(resident.companyId, resource, startsAt, endsAt);
  res.status(201).json({ ok: true, entryId, position });
});

// Asukkaan omat jonopaikat: odottavat tulevat vuorot sijoineen sekä viimeisen kuukauden aikana saadut vuorot.
bookingQueueRouter.get("/portal/booking-queue", (req, res) => {
  const resident = portalResident(res);
  const resource = z.enum(BOOKING_RESOURCES).safeParse(req.query.resource);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  res.json(db.prepare(`
    SELECT q.id, q.resource, q.starts_at, q.ends_at, q.status, q.created_at, q.closed_at,
           CASE WHEN q.status = 'waiting' THEN ${QUEUE_POSITION_SQL} END AS position
    FROM booking_queue q
    WHERE q.resident_id = ? AND (? IS NULL OR q.resource = ?)
      AND (q.status = 'waiting' AND q.ends_at > ? OR q.status = 'granted' AND q.closed_at > ?)
    ORDER BY q.starts_at
  `).all(resident.id, resource.success ? resource.data : null, resource.success ? resource.data : null, now(), monthAgo));
});

// Asukas poistuu jonosta itse.
bookingQueueRouter.delete("/portal/booking-queue/:id", (req, res) => {
  const changed = db.prepare(`
    UPDATE booking_queue SET status = 'left', closed_at = ? WHERE id = ? AND resident_id = ? AND status = 'waiting'
  `).run(now(), req.params.id, portalResident(res).id).changes;
  if (!changed) return res.status(404).json({ error: "Jonopaikkaa ei löytynyt." });
  res.json({ ok: true });
});

// Toimiston näkymä: tulevien vuorojen jonot, jonottajat sijoineen ja vuoron nykyinen varaaja.
bookingQueueRouter.get("/companies/:companyId/booking-queue", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const resource = z.enum(BOOKING_RESOURCES).safeParse(req.query.resource);
  res.json(db.prepare(`
    SELECT q.id, q.company_id, q.resource, q.resident_id, q.starts_at, q.ends_at, q.created_at,
           r.name AS resident_name, r.email AS resident_email, a.apartment_number, ${QUEUE_POSITION_SQL} AS position,
           (SELECT group_concat(COALESCE(hr.name || COALESCE(' · ' || ha.apartment_number, ''), NULLIF(b.note, ''), 'Varattu'), ', ')
              FROM bookings b
              LEFT JOIN residents hr ON hr.id = b.resident_id
              LEFT JOIN apartments ha ON ha.id = hr.apartment_id
              WHERE b.company_id = q.company_id AND b.resource = q.resource
                AND b.starts_at < q.ends_at AND b.ends_at > q.starts_at) AS current_holder
    FROM booking_queue q
    LEFT JOIN residents r ON r.id = q.resident_id
    LEFT JOIN apartments a ON a.id = r.apartment_id
    WHERE q.company_id = ? AND q.status = 'waiting' AND q.ends_at > ? AND (? IS NULL OR q.resource = ?)
    ORDER BY q.starts_at, position
  `).all(companyId, now(), resource.success ? resource.data : null, resource.success ? resource.data : null));
});

// Toimisto lisää asukkaan varatun vuoron jonoon (esim. puhelimitse pyydettäessä). Jono täyttyy kuten asukkaan
// itse liittyessä, mutta toimisto voi lisätä jonoon myös silloin, kun asukkaiden jonoon liittyminen ei ole käytössä
// tai vuoron alkuun on alle kolme tuntia.
bookingQueueRouter.post("/companies/:companyId/booking-queue", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = z.object({
    resource: z.enum(BOOKING_RESOURCES), startsAt: z.iso.datetime(), endsAt: z.iso.datetime(), residentId: z.string().min(1)
  }).safeParse(req.body);
  if (!parsed.success || parsed.data.endsAt <= parsed.data.startsAt) return res.status(400).json({ error: "Valitse asukas." });
  const { resource, startsAt, endsAt, residentId } = parsed.data;
  if (Date.parse(endsAt) <= Date.now()) return res.status(409).json({ error: "Vuoro on jo mennyt." });
  if (!db.prepare(`SELECT 1 FROM residents r WHERE r.id = ? AND r.company_id = ? AND ${ACTIVE_RESIDENT}`).get(residentId, companyId)) {
    return res.status(404).json({ error: "Asukasta ei löytynyt tästä taloyhtiöstä." });
  }

  const holders = db.prepare(`
    SELECT resident_id FROM bookings WHERE company_id = ? AND resource = ? AND starts_at < ? AND ends_at > ?
  `).all(companyId, resource, endsAt, startsAt) as { resident_id: string | null }[];
  if (holders.length === 0) return res.status(409).json({ error: "Vuoro on vapaa. Varaa se asukkaalle suoraan." });
  if (holders.some(holder => holder.resident_id === residentId)) return res.status(409).json({ error: "Vuoro on jo varattu tälle asukkaalle." });
  const already = db.prepare(`
    SELECT 1 FROM booking_queue WHERE resident_id = ? AND company_id = ? AND resource = ? AND starts_at = ? AND ends_at = ? AND status = 'waiting'
  `).get(residentId, companyId, resource, startsAt, endsAt);
  if (already) return res.status(409).json({ error: "Asukas on jo tämän vuoron jonossa." });
  if (waitingCount(companyId, resource, startsAt, endsAt) >= bookingRules(companyId)[resource].queueSize) {
    return res.status(409).json({ error: "Jono on täynnä." });
  }

  const entryId = id("queue");
  db.prepare(`
    INSERT INTO booking_queue (id, company_id, resource, starts_at, ends_at, resident_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)
  `).run(entryId, companyId, resource, startsAt, endsAt, residentId, now());
  res.status(201).json({ ok: true, entryId, position: waitingCount(companyId, resource, startsAt, endsAt) });
});

// Toimisto voi poistaa jonottajan jonosta.
bookingQueueRouter.delete("/booking-queue/:id", (req, res) => {
  const entry = db.prepare("SELECT id, company_id FROM booking_queue WHERE id = ? AND status = 'waiting'").get(req.params.id) as
    { id: string; company_id: string } | undefined;
  if (!entry || !companyIdFromContext(entry.company_id)) return res.status(404).json({ error: "Jonopaikkaa ei löytynyt." });
  db.prepare("UPDATE booking_queue SET status = 'cancelled', closed_at = ? WHERE id = ?").run(now(), entry.id);
  res.json({ ok: true });
});
