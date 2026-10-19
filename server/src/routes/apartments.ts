import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { requireManager } from "../auth.js";
import { db } from "../db.js";
import { syncParkingHolders } from "./parking.js";
import { ACTIVE_RESIDENT, id } from "../util.js";

export const apartmentsRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Asunnot: taloyhtiön huoneistot. Asuntoon kuuluvat sen henkilöt (asukkaat ja osakkaat), avaimet ja
// asukkaiden autopaikat, vuorot ja remontit. Asukas kuuluu aina yhteen asuntoon; henkilön lisäys
// asuntoon siirtää hänet siihen.
// ---------------------------------------------------------------------------------------------

type ApartmentRow = { id: string; company_id: string; apartment_number: string; address: string; staircase: string };

function getAuthorizedApartment(apartmentId: string) {
  const row = db.prepare("SELECT id, company_id, apartment_number, address, staircase FROM apartments WHERE id = ?")
    .get(apartmentId) as ApartmentRow | undefined;
  return row && companyIdFromContext(row.company_id) ? row : null;
}

// Asunnot listaan ja valintoihin (myös lukemat, avaimet ja muutot): rappu ja voimassa olevien henkilöiden määrä.
apartmentsRouter.get("/companies/:companyId/apartments", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare(`
    SELECT a.id, a.apartment_number, a.address, a.staircase,
           (SELECT COUNT(*) FROM residents r WHERE r.apartment_id = a.id AND ${ACTIVE_RESIDENT} AND r.erased_at IS NULL) AS resident_count
    FROM apartments a
    WHERE a.company_id = ?
    ORDER BY a.staircase COLLATE NOCASE, a.apartment_number COLLATE NOCASE
  `).all(companyId));
});

const apartmentSchema = z.object({
  apartmentNumber: z.string().trim().min(1).max(40),
  address: z.string().trim().min(1).max(200),
  staircase: z.string().trim().max(20).default("")
});

// Sama asunto (numero ja osoite) on taloyhtiössä vain kerran.
function duplicateApartment(companyId: string, input: z.infer<typeof apartmentSchema>, exceptId = "") {
  return db.prepare(`
    SELECT id FROM apartments
    WHERE company_id = ? AND lower(apartment_number) = lower(?) AND lower(address) = lower(?) AND id != ?
  `).get(companyId, input.apartmentNumber, input.address, exceptId);
}

apartmentsRouter.post("/companies/:companyId/apartments", requireManager, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = apartmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita asunnon numero ja osoite." });
  if (duplicateApartment(companyId, parsed.data)) return res.status(409).json({ error: "Asunto on jo taloyhtiössä." });
  const apartmentId = id("apt");
  db.prepare("INSERT INTO apartments (id, company_id, apartment_number, address, staircase) VALUES (?, ?, ?, ?, ?)")
    .run(apartmentId, companyId, parsed.data.apartmentNumber, parsed.data.address, parsed.data.staircase);
  res.status(201).json({ ok: true, apartmentId });
});

// Asunnon tietue: tiedot, henkilöt, avaimet sekä asukkaiden autopaikat, tulevat vuorot ja remontit.
apartmentsRouter.get("/apartments/:id", (req, res) => {
  const apartment = getAuthorizedApartment(req.params.id);
  if (!apartment) return res.status(404).json({ error: "Asuntoa ei löytynyt." });
  syncParkingHolders();
  const company = db.prepare("SELECT name FROM companies WHERE id = ?").get(apartment.company_id) as { name: string } | undefined;
  const residents = db.prepare(`
    SELECT r.id, r.name, r.email, r.roles FROM residents r
    WHERE r.apartment_id = ? AND ${ACTIVE_RESIDENT} AND r.erased_at IS NULL
    ORDER BY r.name COLLATE NOCASE
  `).all(apartment.id);
  const keys = db.prepare(`
    SELECT k.id, k.code, k.type, k.status, l.holder_name
    FROM building_keys k
    LEFT JOIN key_loans l ON l.key_id = k.id AND l.returned_at IS NULL
    WHERE k.apartment_id = ? ORDER BY k.code COLLATE NOCASE
  `).all(apartment.id);
  const parking = db.prepare(`
    SELECT p.id, p.label, p.type, r.name AS resident_name
    FROM parking_spaces p JOIN residents r ON r.id = p.resident_id
    WHERE r.apartment_id = ? ORDER BY p.label COLLATE NOCASE
  `).all(apartment.id);
  const bookings = db.prepare(`
    SELECT b.id, b.resource, b.starts_at, b.ends_at, r.name AS resident_name
    FROM bookings b JOIN residents r ON r.id = b.resident_id
    WHERE r.apartment_id = ? AND b.ends_at >= datetime('now', 'localtime')
    ORDER BY b.starts_at LIMIT 50
  `).all(apartment.id);
  const renovations = db.prepare(`
    SELECT n.id, n.work_type, n.start_date, n.end_date, n.status, r.name AS resident_name
    FROM renovation_notices n LEFT JOIN residents r ON r.id = n.resident_id
    WHERE n.apartment_id = ? ORDER BY n.start_date DESC
  `).all(apartment.id);
  res.json({ ...apartment, company_name: company?.name ?? "", residents, keys, parking, bookings, renovations });
});

apartmentsRouter.put("/apartments/:id", requireManager, (req, res) => {
  const apartment = getAuthorizedApartment(req.params.id);
  if (!apartment) return res.status(404).json({ error: "Asuntoa ei löytynyt." });
  const parsed = apartmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita asunnon numero ja osoite." });
  if (duplicateApartment(apartment.company_id, parsed.data, apartment.id)) return res.status(409).json({ error: "Asunto on jo taloyhtiössä." });
  db.prepare("UPDATE apartments SET apartment_number = ?, address = ?, staircase = ? WHERE id = ?")
    .run(parsed.data.apartmentNumber, parsed.data.address, parsed.data.staircase, apartment.id);
  res.json({ ok: true });
});

// Henkilön lisäys asuntoon: saman taloyhtiön asukas siirtyy tähän asuntoon. Hänen tehtävänsä seuraavat mukana.
apartmentsRouter.post("/apartments/:id/residents", requireManager, (req, res) => {
  const apartment = getAuthorizedApartment(req.params.id);
  if (!apartment) return res.status(404).json({ error: "Asuntoa ei löytynyt." });
  const parsed = z.object({ residentId: z.string().min(1) }).safeParse(req.body);
  const resident = parsed.success
    ? db.prepare(`SELECT r.id, r.apartment_id FROM residents r WHERE r.id = ? AND r.company_id = ? AND r.erased_at IS NULL`)
        .get(parsed.data.residentId, apartment.company_id) as { id: string; apartment_id: string } | undefined
    : undefined;
  if (!resident) return res.status(404).json({ error: "Asukasta ei löytynyt." });
  db.transaction(() => {
    db.prepare("UPDATE residents SET apartment_id = ? WHERE id = ?").run(apartment.id, resident.id);
    db.prepare("UPDATE tickets SET apartment_id = ? WHERE resident_id = ? AND apartment_id = ?")
      .run(apartment.id, resident.id, resident.apartment_id);
  })();
  res.json({ ok: true });
});

// Avaimen liitos asuntoon ja sen poisto. Avain on aina saman taloyhtiön avain.
apartmentsRouter.put("/apartments/:id/keys/:keyId", requireManager, (req, res) => {
  const apartment = getAuthorizedApartment(req.params.id);
  if (!apartment) return res.status(404).json({ error: "Asuntoa ei löytynyt." });
  const linked = req.body?.linked !== false;
  const result = db.prepare(`
    UPDATE building_keys SET apartment_id = ?
    WHERE id = ? AND company_id = ? AND (? = 1 OR apartment_id = ?)
  `).run(linked ? apartment.id : null, req.params.keyId, apartment.company_id, linked ? 1 : 0, apartment.id);
  if (!result.changes) return res.status(404).json({ error: "Avainta ei löytynyt." });
  res.json({ ok: true });
});
