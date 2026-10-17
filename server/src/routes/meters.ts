import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { db } from "../db.js";
import { id, now, today } from "../util.js";
import { portalResident } from "./portal.js";
import { detailList, detailsSchema, parseDetails } from "../site-forms.js";

export const metersRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Kulutuslukemat: asukas ilmoittaa asuntonsa mittarilukeman portaalissa tai toimisto kirjaa sen.
// Kulutus on lukeman ja saman mittarin edellisen lukeman erotus.
// ---------------------------------------------------------------------------------------------
export const METER_TYPES = ["cold_water", "hot_water", "electricity"] as const;

const readingSchema = z.object({
  meterType: z.enum(METER_TYPES),
  value: z.number().min(0).max(9_999_999),
  readingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().trim().max(300).default("")
});

// Asunnon mittarin viimeisin lukema annettuun päivään mennessä.
function previousReading(apartmentId: string, meterType: string, readingDate: string) {
  return db.prepare(`
    SELECT value, reading_date FROM meter_readings
    WHERE apartment_id = ? AND meter_type = ? AND reading_date <= ?
    ORDER BY reading_date DESC, created_at DESC LIMIT 1
  `).get(apartmentId, meterType, readingDate) as { value: number; reading_date: string } | undefined;
}

function readingDateError(readingDate: string): string | null {
  if (Number.isNaN(Date.parse(readingDate))) return "Tarkista lukupäivä.";
  return readingDate > today() ? "Lukupäivä ei voi olla tulevaisuudessa." : null;
}

function insertReading(input: {
  companyId: string; apartmentId: string; residentId: string | null; meterType: string; readingDate: string;
  value: number; source: "portal" | "office"; recordedBy: string; note: string;
}) {
  const readingId = id("reading");
  db.prepare(`
    INSERT INTO meter_readings
      (id, company_id, apartment_id, resident_id, meter_type, reading_date, value, source, recorded_by, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(readingId, input.companyId, input.apartmentId, input.residentId, input.meterType, input.readingDate, input.value,
    input.source, input.recordedBy, input.note, now());
  return readingId;
}

// Asukkaan lukema ei voi olla edellistä pienempi: mittari ei kulje taaksepäin. Mittarin vaihdon
// jälkeisen pienemmän lukeman kirjaa toimisto.
metersRouter.post("/portal/meter-readings", (req, res) => {
  const resident = portalResident(res);
  const parsed = readingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista mittari ja lukema." });
  const readingDate = parsed.data.readingDate ?? today();
  const dateError = readingDateError(readingDate);
  if (dateError) return res.status(400).json({ error: dateError });

  const previous = previousReading(resident.apartmentId, parsed.data.meterType, readingDate);
  if (previous && parsed.data.value < previous.value) {
    return res.status(409).json({
      error: `Lukema on pienempi kuin edellinen lukema (${String(previous.value).replace(".", ",")}). Tarkista lukema tai ota yhteyttä isännöitsijään.`
    });
  }

  const readingId = insertReading({
    companyId: resident.companyId, apartmentId: resident.apartmentId, residentId: resident.id,
    meterType: parsed.data.meterType, readingDate, value: parsed.data.value, source: "portal",
    recordedBy: resident.name, note: parsed.data.note
  });
  res.status(201).json({ ok: true, readingId });
});

// Asukas näkee vain itse ilmoittamansa lukemat, ei asunnon aiempien asukkaiden kulutusta.
metersRouter.get("/portal/meter-readings", (_req, res) => {
  res.json(db.prepare(`
    SELECT id, meter_type, reading_date, value, note, created_at
    FROM meter_readings WHERE resident_id = ? ORDER BY reading_date DESC, created_at DESC LIMIT 60
  `).all(portalResident(res).id));
});

// Asunnot lukeman ja avaimen kohdistamista varten.
metersRouter.get("/companies/:companyId/apartments", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare("SELECT id, apartment_number, address FROM apartments WHERE company_id = ? ORDER BY apartment_number").all(companyId));
});

// previous_value on saman asunnon ja mittarin edellinen lukema; kulutus lasketaan niiden erotuksena.
metersRouter.get("/companies/:companyId/meter-readings", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const rows = db.prepare(`
    SELECT m.id, m.company_id, m.apartment_id, m.resident_id, m.meter_type, m.reading_date, m.value, m.source, m.recorded_by, m.note, m.created_at,
           m.details,
           a.apartment_number, a.address, r.name AS resident_name, r.email AS resident_email,
           LAG(m.value) OVER same_meter AS previous_value,
           LAG(m.reading_date) OVER same_meter AS previous_date
    FROM meter_readings m
    LEFT JOIN apartments a ON a.id = m.apartment_id
    LEFT JOIN residents r ON r.id = m.resident_id
    WHERE m.company_id = ?
    WINDOW same_meter AS (PARTITION BY m.apartment_id, m.meter_type ORDER BY m.reading_date, m.created_at)
    ORDER BY m.reading_date DESC, m.created_at DESC
  `).all(companyId) as (Record<string, unknown> & { details: string })[];
  // details: verkkosivun lomakkeen ilmoittajan tiedot (nimi, puhelin, sähköposti, osoite, huoneisto).
  res.json(rows.map(row => ({ ...row, details: detailList("meter", row.details) })));
});

// Lukeman muokkaus: asunto, mittari, lukema, päivä, huomio ja lomakkeen ilmoittajan tiedot.
metersRouter.put("/meter-readings/:id", (req, res) => {
  const reading = db.prepare("SELECT id, company_id, details FROM meter_readings WHERE id = ?").get(req.params.id) as
    { id: string; company_id: string; details: string } | undefined;
  if (!reading || !companyIdFromContext(reading.company_id)) return res.status(404).json({ error: "Lukemaa ei löytynyt." });
  const parsed = readingSchema.extend({
    apartmentId: z.string().min(1).nullable().default(null),
    details: detailsSchema("meter").optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista asunto, mittari ja lukema." });
  const readingDate = parsed.data.readingDate ?? today();
  const dateError = readingDateError(readingDate);
  if (dateError) return res.status(400).json({ error: dateError });
  if (parsed.data.apartmentId && !db.prepare("SELECT 1 FROM apartments WHERE id = ? AND company_id = ?").get(parsed.data.apartmentId, reading.company_id)) {
    return res.status(404).json({ error: "Asuntoa ei löytynyt tästä taloyhtiöstä." });
  }
  const details = parsed.data.details ?? parseDetails(reading.details);
  db.prepare(`
    UPDATE meter_readings SET apartment_id = ?, meter_type = ?, value = ?, reading_date = ?, note = ?, details = ? WHERE id = ?
  `).run(parsed.data.apartmentId, parsed.data.meterType, parsed.data.value, readingDate, parsed.data.note, JSON.stringify(details), reading.id);
  res.json({ ok: true });
});

metersRouter.post("/companies/:companyId/meter-readings", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = readingSchema.extend({ apartmentId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista asunto, mittari ja lukema." });
  const readingDate = parsed.data.readingDate ?? today();
  const dateError = readingDateError(readingDate);
  if (dateError) return res.status(400).json({ error: dateError });
  if (!db.prepare("SELECT 1 FROM apartments WHERE id = ? AND company_id = ?").get(parsed.data.apartmentId, companyId)) {
    return res.status(404).json({ error: "Asuntoa ei löytynyt tästä taloyhtiöstä." });
  }

  const readingId = insertReading({
    companyId, apartmentId: parsed.data.apartmentId, residentId: null, meterType: parsed.data.meterType, readingDate,
    value: parsed.data.value, source: "office", recordedBy: res.locals.user?.name ?? "Isännöitsijä", note: parsed.data.note
  });
  res.status(201).json({ ok: true, readingId });
});

metersRouter.delete("/meter-readings/:id", (req, res) => {
  const reading = db.prepare("SELECT id, company_id FROM meter_readings WHERE id = ?").get(req.params.id) as
    { id: string; company_id: string } | undefined;
  if (!reading || !companyIdFromContext(reading.company_id)) return res.status(404).json({ error: "Lukemaa ei löytynyt." });
  db.prepare("DELETE FROM meter_readings WHERE id = ?").run(reading.id);
  res.json({ ok: true });
});
