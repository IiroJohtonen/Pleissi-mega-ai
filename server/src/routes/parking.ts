import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { requireAdmin } from "../auth.js";
import { db } from "../db.js";
import { id, now, today } from "../util.js";

export const parkingRouter: Router = express.Router();

// Autopaikat: taloyhtiön paikat, niiden tyyppi ja haltija.
export const PARKING_TYPES = ["Autotalli", "Ulkopaikka", "Hallipaikka", "Lämmityspaikka"] as const;

const parkingSchema = z.object({
  label: z.string().trim().min(1).max(40),
  type: z.enum(PARKING_TYPES),
  residentId: z.string().nullable().default(null),
  note: z.string().trim().max(300).default("")
});

const PARKING_SELECT = `
  SELECT p.id, p.company_id, p.label, p.type, p.resident_id, p.note,
         r.name AS resident_name, a.apartment_number
  FROM parking_spaces p
  LEFT JOIN residents r ON r.id = p.resident_id
  LEFT JOIN apartments a ON a.id = r.apartment_id
`;

// Tarkistaa paikan tiedot: haltijan pitää olla saman yhtiön asukas ja tunnuksen yksilöllinen yhtiössä.
function parkingError(companyId: string, data: z.infer<typeof parkingSchema>, exceptId = "") {
  if (data.residentId) {
    const resident = db.prepare("SELECT 1 FROM residents WHERE id = ? AND company_id = ?").get(data.residentId, companyId);
    if (!resident) return { status: 404, error: "Asukasta ei löytynyt tästä yhtiöstä." };
  }
  const duplicate = db.prepare(
    "SELECT 1 FROM parking_spaces WHERE company_id = ? AND lower(label) = lower(?) AND id != ?"
  ).get(companyId, data.label, exceptId);
  if (duplicate) return { status: 409, error: "Tällä tunnuksella on jo autopaikka tässä taloyhtiössä." };
  return null;
}

parkingRouter.get("/companies/:companyId/parking", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  syncParkingHolders();
  res.json(db.prepare(`${PARKING_SELECT} WHERE p.company_id = ? ORDER BY p.label COLLATE NOCASE`).all(companyId));
});

parkingRouter.post("/companies/:companyId/parking", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = parkingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista paikan tunnus ja tyyppi." });
  const problem = parkingError(companyId, parsed.data);
  if (problem) return res.status(problem.status).json({ error: problem.error });

  const parkingId = id("parking");
  db.prepare("INSERT INTO parking_spaces (id, company_id, label, type, resident_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(parkingId, companyId, parsed.data.label, parsed.data.type, null, parsed.data.note, now());
  if (parsed.data.residentId) setParkingHolder(parkingId, companyId, parsed.data.residentId);
  res.status(201).json({ ok: true, parkingId });
});

parkingRouter.put("/parking/:id", (req, res) => {
  const space = db.prepare("SELECT id, company_id FROM parking_spaces WHERE id = ?").get(req.params.id) as
    | { id: string; company_id: string }
    | undefined;
  if (!space || !companyIdFromContext(space.company_id)) return res.status(404).json({ error: "Autopaikkaa ei löytynyt." });

  const parsed = parkingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista paikan tunnus ja tyyppi." });
  const problem = parkingError(space.company_id, parsed.data, space.id);
  if (problem) return res.status(problem.status).json({ error: problem.error });

  syncParkingHolders();
  const current = db.prepare("SELECT resident_id FROM parking_spaces WHERE id = ?").get(space.id) as { resident_id: string | null };
  db.prepare("UPDATE parking_spaces SET label = ?, type = ?, note = ? WHERE id = ?")
    .run(parsed.data.label, parsed.data.type, parsed.data.note, space.id);
  // Haltijan vaihtuessa vanha jakso päättyy ja uusi alkaa tästä päivästä.
  if (current.resident_id !== parsed.data.residentId) setParkingHolder(space.id, space.company_id, parsed.data.residentId);
  res.json({ ok: true });
});

parkingRouter.delete("/parking/:id", (req, res) => {
  const space = db.prepare("SELECT id, company_id FROM parking_spaces WHERE id = ?").get(req.params.id) as
    | { id: string; company_id: string }
    | undefined;
  if (!space || !companyIdFromContext(space.company_id)) return res.status(404).json({ error: "Autopaikkaa ei löytynyt." });
  db.prepare("DELETE FROM parking_assignments WHERE parking_id = ?").run(space.id);
  db.prepare("DELETE FROM parking_spaces WHERE id = ?").run(space.id);
  res.json({ ok: true });
});

// Vaihtaa autopaikan haltijan ja kirjaa muutoksen haltijahistoriaan tästä päivästä alkaen.
export function setParkingHolder(parkingId: string, companyId: string, residentId: string | null) {
  const date = today();
  db.prepare("UPDATE parking_assignments SET end_date = ? WHERE parking_id = ? AND (end_date IS NULL OR end_date > ?)")
    .run(date, parkingId, date);
  // Samana päivänä alkanut ja päättynyt jakso ei ole laskutettava.
  db.prepare("DELETE FROM parking_assignments WHERE parking_id = ? AND end_date <= start_date").run(parkingId);
  if (residentId) {
    db.prepare("INSERT INTO parking_assignments (id, parking_id, company_id, resident_id, start_date) VALUES (?, ?, ?, ?, ?)")
      .run(id("pa"), parkingId, companyId, residentId, date);
  }
  db.prepare("UPDATE parking_spaces SET resident_id = ? WHERE id = ?").run(residentId, parkingId);
}

// Paikan nykyinen haltija on se, jonka jakso on voimassa tänään. Ajetaan ennen lukemista, jotta
// tulevaisuuteen päivätty luopuminen (muutto) vapauttaa paikan oikeana päivänä.
export function syncParkingHolders() {
  const date = today();
  db.prepare(`
    UPDATE parking_spaces SET resident_id = (
      SELECT pa.resident_id FROM parking_assignments pa
      WHERE pa.parking_id = parking_spaces.id AND pa.start_date <= ? AND (pa.end_date IS NULL OR pa.end_date > ?)
      ORDER BY pa.start_date DESC LIMIT 1
    )
    WHERE EXISTS (SELECT 1 FROM parking_assignments pa WHERE pa.parking_id = parking_spaces.id)
  `).run(date, date);
}

// Laskutus: kuukauden aikana voimassa olleet haltijajaksot. month = VVVV-KK.
parkingRouter.get("/companies/:companyId/parking-billing", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const month = typeof req.query.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month) ? req.query.month : "";
  if (!month) return res.status(400).json({ error: "Anna kuukausi muodossa VVVV-KK." });

  const [year, monthNumber] = month.split("-").map(Number);
  const firstDay = `${month}-01`;
  const nextMonth = new Date(year, monthNumber, 1).toLocaleDateString("sv-SE");
  res.json(db.prepare(`
    SELECT pa.id, p.label, p.type, pa.resident_id, r.name AS resident_name, a.apartment_number,
           pa.start_date, pa.end_date
    FROM parking_assignments pa
    JOIN parking_spaces p ON p.id = pa.parking_id
    LEFT JOIN residents r ON r.id = pa.resident_id
    LEFT JOIN apartments a ON a.id = r.apartment_id
    WHERE pa.company_id = ? AND pa.start_date < ? AND (pa.end_date IS NULL OR pa.end_date > ?)
    ORDER BY p.label COLLATE NOCASE
  `).all(companyId, nextMonth, firstDay));
});

// Autopaikkojen kuukausihinnat (euroa) paikkatyypeittäin.
function parkingPrices(companyId: string) {
  const prices = Object.fromEntries(PARKING_TYPES.map(type => [type, 0])) as Record<(typeof PARKING_TYPES)[number], number>;
  const rows = db.prepare("SELECT type, monthly_price FROM parking_prices WHERE company_id = ?").all(companyId) as
    { type: string; monthly_price: number }[];
  for (const row of rows) {
    if ((PARKING_TYPES as readonly string[]).includes(row.type)) prices[row.type as (typeof PARKING_TYPES)[number]] = row.monthly_price;
  }
  return prices;
}

parkingRouter.get("/companies/:companyId/parking-prices", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(parkingPrices(companyId));
});

parkingRouter.put("/companies/:companyId/parking-prices", requireAdmin, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const price = z.number().min(0).max(10000);
  const parsed = z.object({ Autotalli: price, Ulkopaikka: price, Hallipaikka: price, Lämmityspaikka: price.default(0) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista hinnat." });

  const save = db.prepare(`
    INSERT INTO parking_prices (company_id, type, monthly_price) VALUES (?, ?, ?)
    ON CONFLICT(company_id, type) DO UPDATE SET monthly_price = excluded.monthly_price
  `);
  for (const type of PARKING_TYPES) save.run(companyId, type, parsed.data[type]);
  res.json(parkingPrices(companyId));
});
