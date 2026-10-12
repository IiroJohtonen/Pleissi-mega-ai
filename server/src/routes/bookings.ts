import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { requireAdmin } from "../auth.js";
import { db } from "../db.js";
import { id, now } from "../util.js";

export const bookingsRouter: Router = express.Router();

// Yhteistilojen vuorovaraukset (sauna ja pyykkitupa). Sama rakenne molemmille tiloille.
export const BOOKING_RESOURCES = ["sauna", "laundry"] as const;
export const MAX_BOOKING_OCCURRENCES = 26;
const DEFAULT_WEEKLY_WEEKS = 12;

export const bookingTimes = z.object({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() });

// weeklyWeeks = kuinka monelle viikolle viikoittainen vuoro varataan kerralla.
// singlePrice = yhden vuoron hinta, monthlyPrice = viikoittaisen vuoron hinta kuukaudessa (euroa).
type BookingRule = { single: boolean; weekly: boolean; weeklyWeeks: number; singlePrice: number; monthlyPrice: number };
type BookingRules = Record<(typeof BOOKING_RESOURCES)[number], BookingRule>;

// Taloyhtiön asetukset: saako tilaan varata yksittäisiä ja viikoittaisia vuoroja.
export function bookingRules(companyId: string): BookingRules {
  const rules: BookingRules = {
    sauna: { single: true, weekly: true, weeklyWeeks: DEFAULT_WEEKLY_WEEKS, singlePrice: 0, monthlyPrice: 0 },
    laundry: { single: true, weekly: true, weeklyWeeks: DEFAULT_WEEKLY_WEEKS, singlePrice: 0, monthlyPrice: 0 }
  };
  const rows = db.prepare(`
    SELECT resource, allow_single, allow_weekly, weekly_weeks, single_price, monthly_price
    FROM booking_settings WHERE company_id = ?
  `).all(companyId) as {
    resource: string; allow_single: number; allow_weekly: number; weekly_weeks: number;
    single_price: number; monthly_price: number;
  }[];
  for (const row of rows) {
    if (row.resource === "sauna" || row.resource === "laundry") {
      rules[row.resource] = {
        single: Boolean(row.allow_single),
        weekly: Boolean(row.allow_weekly),
        weeklyWeeks: row.weekly_weeks,
        singlePrice: row.single_price,
        monthlyPrice: row.monthly_price
      };
    }
  }
  return rules;
}

// Palauttaa virhetekstin, jos pyydetty vuorotyyppi on kytketty pois taloyhtiön asetuksista tai
// viikoittaista vuoroa yritetään varata pidemmäksi ajaksi kuin asetus sallii.
export function bookingKindError(companyId: string, resource: (typeof BOOKING_RESOURCES)[number], repeats: number) {
  const rule = bookingRules(companyId)[resource];
  const weekly = repeats > 0;
  if (weekly && rule.weekly && repeats + 1 > rule.weeklyWeeks) {
    return `Viikoittaisen vuoron voi varata enintään ${rule.weeklyWeeks} viikoksi.`;
  }
  if (weekly ? rule.weekly : rule.single) return null;
  return weekly
    ? "Viikoittaisten vuorojen varaaminen ei ole käytössä tässä taloyhtiössä."
    : "Yksittäisten vuorojen varaaminen ei ole käytössä tässä taloyhtiössä.";
}

bookingsRouter.get("/companies/:companyId/booking-settings", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(bookingRules(companyId));
});

bookingsRouter.put("/companies/:companyId/booking-settings", requireAdmin, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const rule = z.object({
    single: z.boolean(),
    weekly: z.boolean(),
    weeklyWeeks: z.number().int().min(2).max(MAX_BOOKING_OCCURRENCES).default(DEFAULT_WEEKLY_WEEKS),
    singlePrice: z.number().min(0).max(10000).default(0),
    monthlyPrice: z.number().min(0).max(10000).default(0)
  });
  const parsed = z.object({ sauna: rule, laundry: rule }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista asetukset." });

  const save = db.prepare(`
    INSERT INTO booking_settings
      (company_id, resource, allow_single, allow_weekly, weekly_weeks, single_price, monthly_price)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, resource) DO UPDATE SET
      allow_single = excluded.allow_single, allow_weekly = excluded.allow_weekly,
      weekly_weeks = excluded.weekly_weeks, single_price = excluded.single_price,
      monthly_price = excluded.monthly_price
  `);
  for (const resource of BOOKING_RESOURCES) {
    const value = parsed.data[resource];
    save.run(companyId, resource, value.single ? 1 : 0, value.weekly ? 1 : 0, value.weeklyWeeks,
      value.singlePrice, value.monthlyPrice);
  }
  res.json(bookingRules(companyId));
});

// Tallentaa yhden tai useamman vuoron. Viikoittaisessa varauksessa selain lähettää jokaisen
// viikon ajat (paikallinen kellonaika säilyy kesä- ja talviajan vaihtuessa), ja ne saavat yhteisen
// sarjatunnisteen. Jo varatut tai menneet vuorot ohitetaan ja palautetaan kutsujalle.
export function createBookings(input: {
  companyId: string;
  resource: string;
  occurrences: { startsAt: string; endsAt: string }[];
  residentId: string | null;
  note: string;
  createdBy: string;
}): { created: number; skipped: string[] } {
  const seriesId = input.occurrences.length > 1 ? id("series") : null;
  const overlap = db.prepare(`
    SELECT 1 FROM bookings
    WHERE company_id = ? AND resource = ? AND starts_at < ? AND ends_at > ?
    LIMIT 1
  `);
  const insert = db.prepare(`
    INSERT INTO bookings (id, company_id, resource, resident_id, note, starts_at, ends_at, created_by, created_at, series_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let created = 0;
  const skipped: string[] = [];
  db.transaction(() => {
    for (const { startsAt, endsAt } of input.occurrences) {
      const valid = endsAt > startsAt
        && Date.parse(endsAt) > Date.now()
        && Date.parse(endsAt) - Date.parse(startsAt) <= 4 * 60 * 60 * 1000;
      if (!valid || overlap.get(input.companyId, input.resource, endsAt, startsAt)) {
        skipped.push(startsAt);
        continue;
      }
      insert.run(id("booking"), input.companyId, input.resource, input.residentId, input.note,
        startsAt, endsAt, input.createdBy, now(), seriesId);
      created++;
    }
  })();
  return { created, skipped };
}

// Poistaa varauksen. series=1 poistaa myös saman sarjan myöhemmät vuorot.
export function deleteBooking(booking: { id: string; series_id: string | null; starts_at: string }, wholeSeries: boolean) {
  if (wholeSeries && booking.series_id) {
    return db.prepare("DELETE FROM bookings WHERE series_id = ? AND starts_at >= ?")
      .run(booking.series_id, booking.starts_at).changes;
  }
  return db.prepare("DELETE FROM bookings WHERE id = ?").run(booking.id).changes;
}

bookingsRouter.get("/companies/:companyId/bookings", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = z.object({
    resource: z.enum(BOOKING_RESOURCES),
    from: z.iso.datetime(),
    to: z.iso.datetime()
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista tila ja aikaväli." });

  res.json(db.prepare(`
    SELECT b.id, b.resource, b.resident_id, b.note, b.starts_at, b.ends_at, b.created_by, b.series_id,
           r.name AS resident_name, a.apartment_number
    FROM bookings b
    LEFT JOIN residents r ON r.id = b.resident_id
    LEFT JOIN apartments a ON a.id = r.apartment_id
    WHERE b.company_id = ? AND b.resource = ? AND b.starts_at < ? AND b.ends_at > ?
    ORDER BY b.starts_at
  `).all(companyId, parsed.data.resource, parsed.data.to, parsed.data.from));
});

bookingsRouter.post("/companies/:companyId/bookings", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = z.object({
    resource: z.enum(BOOKING_RESOURCES),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    residentId: z.string().optional(),
    note: z.string().trim().max(200).default(""),
    // Viikoittaisen varauksen myöhemmät viikot; ensimmäinen vuoro on startsAt–endsAt.
    repeats: z.array(bookingTimes).max(MAX_BOOKING_OCCURRENCES - 1).default([])
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista varauksen tiedot." });

  const { resource, startsAt, endsAt, residentId, note } = parsed.data;
  if (endsAt <= startsAt) return res.status(400).json({ error: "Varauksen pitää päättyä alkamisen jälkeen." });
  if (!residentId && !note) return res.status(400).json({ error: "Valitse asukas tai kirjoita varauksen tieto." });

  if (residentId) {
    const resident = db.prepare("SELECT id FROM residents WHERE id = ? AND company_id = ?").get(residentId, companyId);
    if (!resident) return res.status(404).json({ error: "Asukasta ei löytynyt tästä yhtiöstä." });
  }

  const kindError = bookingKindError(companyId, resource, parsed.data.repeats.length);
  if (kindError) return res.status(403).json({ error: kindError });

  // Samaan tilaan ei voi tehdä päällekkäisiä varauksia; varatut viikot ohitetaan.
  const result = createBookings({
    companyId,
    resource,
    occurrences: [{ startsAt, endsAt }, ...parsed.data.repeats],
    residentId: residentId ?? null,
    note,
    createdBy: res.locals.user?.name ?? "Tuntematon"
  });
  if (result.created === 0) return res.status(409).json({ error: "Vuoro on jo varattu tai aika on mennyt." });

  res.status(201).json({ ok: true, ...result });
});

bookingsRouter.delete("/bookings/:id", (req, res) => {
  const booking = db.prepare("SELECT id, company_id, series_id, starts_at FROM bookings WHERE id = ?").get(req.params.id) as
    | { id: string; company_id: string; series_id: string | null; starts_at: string }
    | undefined;
  if (!booking || !companyIdFromContext(booking.company_id)) {
    return res.status(404).json({ error: "Varausta ei löytynyt." });
  }
  res.json({ ok: true, deleted: deleteBooking(booking, req.query.series === "1") });
});
