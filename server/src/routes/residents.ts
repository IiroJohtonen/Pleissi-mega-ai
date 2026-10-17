import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { isAdmin, requireManager, setResidentPassword } from "../auth.js";
import { deleteBookingsAndRelease } from "../booking-queue.js";
import { db } from "../db.js";
import { ACTIVE_RESIDENT, id, now, today } from "../util.js";
import {
  deferTicketErasure, ERASED_NAME, eraseResidentFromTicket, openResidentTickets, removeAttachmentFiles, residentTicketIds,
  sentByResident
} from "../resident-erasure.js";

export const residentsRouter: Router = express.Router();

export function findResident(companyId: string, senderEmail?: string, senderName?: string) {
  if (senderEmail) {
    const r = db.prepare(`
      SELECT r.*, a.apartment_number
      FROM residents r
      JOIN apartments a ON a.id = r.apartment_id
      WHERE r.company_id = ? AND lower(r.email) = lower(?)
    `).get(companyId, senderEmail);
    if (r) return r as any;
  }

  if (senderName) {
    const r = db.prepare(`
      SELECT r.*, a.apartment_number
      FROM residents r
      JOIN apartments a ON a.id = r.apartment_id
      WHERE r.company_id = ? AND lower(r.name) = lower(?)
    `).get(companyId, senderName);
    if (r) return r as any;
  }

  return null;
}

residentsRouter.get("/companies/:companyId/residents", (req, res) => {
  if (!companyIdFromContext(req.params.companyId)) {
    return res.status(403).json({ error: "Company not authorized" });
  }
  res.json(
    db.prepare(`
      SELECT r.id, r.name, r.email, a.apartment_number, a.address,
             EXISTS(SELECT 1 FROM resident_credentials rc WHERE rc.resident_id = r.id) AS has_password
      FROM residents r
      JOIN apartments a ON a.id = r.apartment_id
      WHERE r.company_id = ? AND ${ACTIVE_RESIDENT}
      ORDER BY r.name
    `).all(req.params.companyId)
  );
});

const residentSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().pipe(z.union([z.literal(""), z.email()])).default(""),
  address: z.string().trim().min(1),
  apartmentNumber: z.string().trim().min(1)
});

// Lisää asukkaan yhtiöön ja luo asunnon, jos sitä ei vielä ole. Palauttaa virheen tekstinä.
function addResident(companyId: string, input: unknown): { residentId: string } | { error: string; status: number } {
  const parsed = residentSchema.safeParse(input);
  if (!parsed.success) return { error: "Tarkista nimi, sähköposti, osoite ja asunto.", status: 400 };

  const { name, email, address, apartmentNumber } = parsed.data;

  if (email) {
    const existing = db.prepare(
      `SELECT r.id FROM residents r WHERE r.company_id = ? AND lower(r.email) = lower(?) AND ${ACTIVE_RESIDENT}`
    ).get(companyId, email);
    if (existing) return { error: "Tällä sähköpostiosoitteella on jo asukas.", status: 409 };
  }

  let apartment = db.prepare(`
    SELECT id FROM apartments
    WHERE company_id = ? AND lower(apartment_number) = lower(?) AND lower(address) = lower(?)
  `).get(companyId, apartmentNumber, address) as { id: string } | undefined;

  if (!apartment) {
    apartment = { id: id("apt") };
    db.prepare("INSERT INTO apartments VALUES (?, ?, ?, ?)").run(
      apartment.id, companyId, apartmentNumber, address
    );
  }

  const residentId = id("resident");
  db.prepare("INSERT INTO residents (id, company_id, apartment_id, name, email) VALUES (?, ?, ?, ?, ?)").run(
    residentId, companyId, apartment.id, name, email || null
  );

  return { residentId };
}

residentsRouter.post("/companies/:companyId/residents", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password && !isAdmin(res)) {
    return res.status(403).json({ error: "Vain pääkäyttäjä voi asettaa asukkaan salasanan." });
  }
  if (password && password.length < 8) {
    return res.status(400).json({ error: "Salasanassa pitää olla vähintään 8 merkkiä." });
  }
  if (password && !String(req.body?.email ?? "").trim()) {
    return res.status(400).json({ error: "Kirjautumiseen tarvitaan sähköposti." });
  }

  const result = addResident(companyId, req.body);
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  if (password) setResidentPassword(result.residentId, password);

  res.status(201).json({ ok: true, residentId: result.residentId });
});

// Tuo asukkaat CSV-tiedostosta luetuista riveistä. Kelvolliset rivit lisätään, ja ohitetut
// palautetaan rivinumeron ja syyn kanssa.
residentsRouter.post("/companies/:companyId/residents/import", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = z.object({
    rows: z.array(z.object({
      line: z.number().int(),
      name: z.string().default(""),
      email: z.string().default(""),
      address: z.string().default(""),
      apartmentNumber: z.string().default("")
    })).min(1).max(2000)
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Tiedostossa ei ole tuotavia rivejä tai rivejä on yli 2000." });
  }

  let added = 0;
  const skipped: { line: number; name: string; reason: string }[] = [];

  db.transaction(() => {
    for (const row of parsed.data.rows) {
      const result = addResident(companyId, row);
      if ("error" in result) skipped.push({ line: row.line, name: row.name.trim(), reason: result.error });
      else added++;
    }
  })();

  res.json({ added, skipped });
});

residentsRouter.put("/residents/:residentId", (req, res) => {
  const resident = db.prepare(
    "SELECT id, company_id, apartment_id FROM residents WHERE id = ?"
  ).get(req.params.residentId) as { id: string; company_id: string; apartment_id: string } | undefined;
  const companyId = resident && companyIdFromContext(resident.company_id);
  if (!resident || !companyId) return res.status(404).json({ error: "Asukasta ei löytynyt." });

  const schema = z.object({
    name: z.string().trim().min(1),
    email: z.string().trim().pipe(z.union([z.literal(""), z.email()])).default(""),
    address: z.string().trim().min(1),
    apartmentNumber: z.string().trim().min(1)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Tarkista nimi, sähköposti, osoite ja asunto." });
  }

  const { name, email, address, apartmentNumber } = parsed.data;

  if (email) {
    const existing = db.prepare(
      `SELECT r.id FROM residents r WHERE r.company_id = ? AND lower(r.email) = lower(?) AND r.id != ? AND ${ACTIVE_RESIDENT}`
    ).get(companyId, email, resident.id);
    if (existing) {
      return res.status(409).json({ error: "Tällä sähköpostiosoitteella on jo asukas." });
    }
  }

  let apartment = db.prepare(`
    SELECT id FROM apartments
    WHERE company_id = ? AND lower(apartment_number) = lower(?) AND lower(address) = lower(?)
  `).get(companyId, apartmentNumber, address) as { id: string } | undefined;

  if (!apartment) {
    apartment = { id: id("apt") };
    db.prepare("INSERT INTO apartments VALUES (?, ?, ?, ?)").run(
      apartment.id, companyId, apartmentNumber, address
    );
  }

  // Salasana on valinnainen: tyhjä jättää nykyisen ennalleen.
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password) {
    if (!isAdmin(res)) return res.status(403).json({ error: "Vain pääkäyttäjä voi vaihtaa asukkaan salasanan." });
    if (!email) return res.status(400).json({ error: "Kirjautumiseen tarvitaan sähköposti." });
    const passwordError = setResidentPassword(resident.id, password);
    if (passwordError) return res.status(400).json({ error: passwordError });
  }

  db.prepare("UPDATE residents SET name = ?, email = ?, apartment_id = ? WHERE id = ?").run(
    name, email || null, apartment.id, resident.id
  );

  // Asukkaan tehtävät seuraavat asukasta uuteen asuntoon.
  db.prepare("UPDATE tickets SET apartment_id = ? WHERE resident_id = ? AND apartment_id = ?").run(
    apartment.id, resident.id, resident.apartment_id
  );

  res.json({ ok: true });
});

type ResidentRow = {
  id: string; company_id: string; apartment_id: string; name: string; email: string | null;
  moved_out_at: string | null; erased_at: string | null;
};

// Asukas, jonka tietoihin pyynnön tekijällä on oikeus ja jota ei ole jo poistettu.
function getAuthorizedResident(residentId: string) {
  const resident = db.prepare(
    "SELECT id, company_id, apartment_id, name, email, moved_out_at, erased_at FROM residents WHERE id = ?"
  ).get(residentId) as ResidentRow | undefined;
  return resident && !resident.erased_at && companyIdFromContext(resident.company_id) ? resident : null;
}

// Tehtävät, joissa asukas on yhteyshenkilö tai ilmoittaja.
// Asukkaasta tallennetut tiedot yhtenä tiedostona (tietosuoja-asetuksen mukainen tietopyyntö).
// Mukana ovat asukkaan omat viestit ja hänelle lähetetyt vastaukset, ei sisäisiä muistiinpanoja.
residentsRouter.get("/residents/:residentId/export", requireManager, (req, res) => {
  const resident = getAuthorizedResident(req.params.residentId);
  if (!resident) return res.status(404).json({ error: "Asukasta ei löytynyt." });

  const ticketIds = residentTicketIds(resident.id);
  const tickets = ticketIds.map(ticketId => ({
    ...(db.prepare(`
      SELECT ticket_number AS number, subject, type, status, source_channel AS channel, created_at, updated_at
      FROM tickets WHERE id = ?
    `).get(ticketId) as Record<string, unknown>),
    messages: (db.prepare(`
      SELECT direction, sender, subject, body, channel, created_at FROM messages
      WHERE ticket_id = ? AND channel != 'contractor' ORDER BY created_at
    `).all(ticketId) as { direction: string; sender: string }[])
      .filter(message => message.direction === "outbound" || sentByResident(message.sender, resident)),
    attachments: db.prepare(`
      SELECT filename, size, direction, created_at FROM attachments WHERE ticket_id = ? ORDER BY created_at
    `).all(ticketId)
  }));

  res.json({
    exported_at: now(),
    resident: {
      ...(db.prepare(`
        SELECT r.name, r.email, r.moved_out_at, c.name AS company, a.apartment_number, a.address
        FROM residents r
        JOIN companies c ON c.id = r.company_id
        JOIN apartments a ON a.id = r.apartment_id
        WHERE r.id = ?
      `).get(resident.id) as Record<string, unknown>),
      has_portal_account: Boolean(db.prepare("SELECT 1 FROM resident_credentials WHERE resident_id = ?").get(resident.id))
    },
    tickets,
    bookings: db.prepare("SELECT resource, starts_at, ends_at, note, created_at FROM bookings WHERE resident_id = ? ORDER BY starts_at").all(resident.id),
    parking: db.prepare(`
      SELECT p.label, p.type, pa.start_date, pa.end_date
      FROM parking_assignments pa JOIN parking_spaces p ON p.id = pa.parking_id
      WHERE pa.resident_id = ? ORDER BY pa.start_date
    `).all(resident.id),
    booking_requests: db.prepare(`
      SELECT resource, starts_at, ends_at, note, status, decision_note, created_at
      FROM booking_requests WHERE resident_id = ? ORDER BY created_at
    `).all(resident.id),
    waitlist: db.prepare("SELECT resource, parking_type, note, status, created_at FROM waitlist WHERE resident_id = ? ORDER BY created_at").all(resident.id),
    booking_queue: db.prepare(`
      SELECT resource, starts_at, ends_at, status, created_at, closed_at FROM booking_queue WHERE resident_id = ? ORDER BY created_at
    `).all(resident.id),
    move_notices: db.prepare(`
      SELECT move_date, moves_out, new_residents, door_name, note, status, created_at
      FROM move_notices WHERE resident_id = ? ORDER BY created_at
    `).all(resident.id),
    renovation_notices: db.prepare(`
      SELECT work_type, description, start_date, end_date, contractor, status, decision_note, created_at
      FROM renovation_notices WHERE resident_id = ? ORDER BY created_at
    `).all(resident.id),
    meter_readings: db.prepare(`
      SELECT meter_type, reading_date, value, note, created_at FROM meter_readings WHERE resident_id = ? ORDER BY reading_date
    `).all(resident.id),
    key_loans: db.prepare(`
      SELECT k.code, k.type, l.handed_at, l.due_date, l.returned_at
      FROM key_loans l JOIN building_keys k ON k.id = l.key_id WHERE l.resident_id = ? ORDER BY l.handed_at
    `).all(resident.id)
  });
});

// Asukkaan avoimet tehtävät ennen poistoa: isännöitsijä päättää, säilytetäänkö kesken olevat asiat.
residentsRouter.get("/residents/:residentId/erasure-preview", requireManager, (req, res) => {
  const resident = getAuthorizedResident(req.params.residentId);
  if (!resident) return res.status(404).json({ error: "Asukasta ei löytynyt." });
  res.json({ openTickets: openResidentTickets(resident.id) });
});

// Poistaa asukkaan henkilötiedot (tietosuoja-asetuksen mukainen poistopyyntö). Asukkaan rivi ja
// tehtävät jäävät tilastoihin ilman nimeä: viestit, liitteet, tunnukset, tulevat vuorot, varaustoiveet, jonot sekä
// muutto- ja remontti-ilmoitukset poistetaan. Jo laskutetuksi merkityt kuukaudet ovat kirjanpitoaineistoa ja säilyvät.
// keepTicketIds: avoimet tehtävät, joiden tietoja tarvitaan asian hoitamiseen (peruste keepReason). Ne
// anonymisoidaan, kun tehtävä suljetaan.
residentsRouter.delete("/residents/:residentId", requireManager, async (req, res) => {
  const resident = getAuthorizedResident(req.params.residentId);
  if (!resident) return res.status(404).json({ error: "Asukasta ei löytynyt." });
  const options = z.object({
    keepTicketIds: z.array(z.string()).max(200).default([]),
    keepReason: z.string().trim().max(300).default("")
  }).safeParse(req.body ?? {});
  if (!options.success) return res.status(400).json({ error: "Tarkista säilytettävät tehtävät." });
  const openIds = new Set(openResidentTickets(resident.id).map(ticket => ticket.id));
  const keep = new Set(options.data.keepTicketIds.filter(ticketId => openIds.has(ticketId)));
  if (keep.size > 0 && !options.data.keepReason) {
    return res.status(400).json({ error: "Kirjoita peruste, miksi tehtävät säilytetään." });
  }
  const actor = res.locals.user?.name ?? "Isännöitsijä";

  const date = today();
  const removedFiles: string[] = [];

  db.transaction(() => {
    for (const ticketId of residentTicketIds(resident.id)) {
      if (keep.has(ticketId)) {
        deferTicketErasure(ticketId, resident, options.data.keepReason, actor);
        continue;
      }
      removedFiles.push(...eraseResidentFromTicket(ticketId, resident));
    }

    db.prepare("DELETE FROM resident_credentials WHERE resident_id = ?").run(resident.id);
    db.prepare("DELETE FROM resident_sessions WHERE resident_id = ?").run(resident.id);
    db.prepare("DELETE FROM password_resets WHERE kind = 'resident' AND subject_id = ?").run(resident.id);
    db.prepare("DELETE FROM booking_queue WHERE resident_id = ?").run(resident.id);
    deleteBookingsAndRelease("resident_id = ? AND starts_at >= ?", [resident.id, now()]);
    db.prepare("UPDATE bookings SET note = '' WHERE resident_id = ?").run(resident.id);
    db.prepare("DELETE FROM waitlist WHERE resident_id = ?").run(resident.id);
    db.prepare("DELETE FROM booking_requests WHERE resident_id = ?").run(resident.id);
    db.prepare("DELETE FROM move_notices WHERE resident_id = ?").run(resident.id);
    // Remontti-ilmoitus on taloyhtiön asiakirja, joten se jää historiaan ilman asukkaan tietoja.
    db.prepare("UPDATE renovation_notices SET resident_id = NULL, reporter_name = '' WHERE resident_id = ?").run(resident.id);
    // Lukemat ovat asunnon tietoja ja avaimen luovutus jää rekisteriin; niistä poistetaan vain yhteys asukkaaseen.
    db.prepare("UPDATE meter_readings SET resident_id = NULL, recorded_by = ?, note = '' WHERE resident_id = ?").run(ERASED_NAME, resident.id);
    db.prepare("UPDATE key_loans SET resident_id = NULL, holder_name = ?, note = '' WHERE resident_id = ?").run(ERASED_NAME, resident.id);

    // Autopaikka vapautuu tänään; mennyt haltijajakso jää laskutusta varten ilman nimeä.
    db.prepare("UPDATE parking_assignments SET end_date = ? WHERE resident_id = ? AND (end_date IS NULL OR end_date > ?)")
      .run(date, resident.id, date);
    db.prepare("DELETE FROM parking_assignments WHERE resident_id = ? AND end_date <= start_date").run(resident.id);
    db.prepare("UPDATE parking_spaces SET resident_id = NULL WHERE resident_id = ?").run(resident.id);

    db.prepare("UPDATE residents SET name = ?, email = NULL, moved_out_at = ?, erased_at = ? WHERE id = ?").run(
      ERASED_NAME,
      resident.moved_out_at && resident.moved_out_at < date ? resident.moved_out_at : date,
      now(),
      resident.id
    );

    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), null, res.locals.user?.name ?? "Isännöitsijä", "resident_erased",
      JSON.stringify({ resident_id: resident.id, company_id: resident.company_id, kept_tickets: keep.size, reason: keep.size ? options.data.keepReason : undefined }), now()
    );
  })();

  await removeAttachmentFiles(removedFiles);

  res.json({ ok: true });
});
