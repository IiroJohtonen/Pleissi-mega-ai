import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { requireManager } from "../auth.js";
import { deleteBookingsAndRelease } from "../booking-queue.js";
import { db } from "../db.js";
import { notifyResident } from "../notify.js";
import { ACTIVE_RESIDENT, id, now } from "../util.js";
import { syncParkingHolders } from "./parking.js";
import { portalResident } from "./portal.js";

export const movesRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Muuttoilmoitukset: asukas ilmoittaa portaalissa, toimisto hyväksyy tai hylkää.
// ---------------------------------------------------------------------------------------------
const moveSchema = z.object({
  moveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // true = asunnon nykyiset asukkaat muuttavat pois muuttopäivänä.
  movesOut: z.boolean().default(false),
  newResidents: z.array(z.object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().pipe(z.union([z.literal(""), z.email()])).default("")
  })).max(8).default([]),
  doorName: z.string().trim().max(60).default(""),
  note: z.string().trim().max(1000).default("")
});

const MOVE_SELECT = `
  SELECT m.*, r.name AS resident_name, r.email AS resident_email, a.apartment_number, a.address
  FROM move_notices m
  LEFT JOIN residents r ON r.id = m.resident_id
  LEFT JOIN apartments a ON a.id = m.apartment_id
`;

movesRouter.post("/portal/moves", (req, res) => {
  const resident = portalResident(res);
  const parsed = moveSchema.safeParse(req.body);
  if (!parsed.success || Number.isNaN(Date.parse(parsed.success ? parsed.data.moveDate : ""))) {
    return res.status(400).json({ error: "Tarkista muuttopäivä ja uusien asukkaiden tiedot." });
  }
  if (!parsed.data.movesOut && parsed.data.newResidents.length === 0 && !parsed.data.doorName) {
    return res.status(400).json({ error: "Ilmoita poismuutto, uudet asukkaat tai oveen tuleva nimi." });
  }
  const pending = db.prepare("SELECT 1 FROM move_notices WHERE resident_id = ? AND status = 'pending'").get(resident.id);
  if (pending) return res.status(409).json({ error: "Sinulla on jo käsittelyä odottava muuttoilmoitus." });

  const moveId = id("move");
  db.prepare(`
    INSERT INTO move_notices (id, company_id, apartment_id, resident_id, move_date, moves_out, new_residents, door_name, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(moveId, resident.companyId, resident.apartmentId, resident.id, parsed.data.moveDate, parsed.data.movesOut ? 1 : 0,
    JSON.stringify(parsed.data.newResidents), parsed.data.doorName, parsed.data.note, now());
  res.status(201).json({ ok: true, moveId });
});

movesRouter.get("/portal/moves", (_req, res) => {
  res.json(db.prepare(`
    SELECT id, move_date, moves_out, new_residents, door_name, note, status, created_at
    FROM move_notices WHERE resident_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(portalResident(res).id));
});

movesRouter.get("/companies/:companyId/moves", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare(`${MOVE_SELECT} WHERE m.company_id = ? ORDER BY m.status = 'pending' DESC, m.created_at DESC`).all(companyId));
});

type MoveNotice = {
  id: string; company_id: string; apartment_id: string; resident_id: string; move_date: string;
  moves_out: number; new_residents: string; door_name: string; status: string;
};

function pendingMove(moveId: string) {
  const notice = db.prepare("SELECT * FROM move_notices WHERE id = ?").get(moveId) as MoveNotice | undefined;
  if (!notice || !companyIdFromContext(notice.company_id)) return { notice: null, error: "Muuttoilmoitusta ei löytynyt.", status: 404 };
  if (notice.status !== "pending") return { notice: null, error: "Muuttoilmoitus on jo käsitelty.", status: 409 };
  return { notice, error: "", status: 200 };
}

// Hyväksyntä päivittää asukastietokannan: lähtijät merkitään muuttaneiksi muuttopäivästä, heidän
// autopaikkansa päättyvät ja vuoronsa poistuvat muuttopäivästä alkaen, ja uudet asukkaat lisätään.
movesRouter.post("/moves/:id/approve", requireManager, (req, res) => {
  const found = pendingMove(req.params.id);
  if (!found.notice) return res.status(found.status).json({ error: found.error });
  const { notice } = found;
  const actor = res.locals.user?.name ?? "Isännöitsijä";
  const result = { movedOut: 0, parkingReleased: [] as string[], bookingsRemoved: 0, added: [] as string[], skipped: [] as string[] };

  db.transaction(() => {
    if (notice.moves_out) {
      const leaving = db.prepare(`SELECT r.id FROM residents r WHERE r.apartment_id = ? AND ${ACTIVE_RESIDENT}`)
        .all(notice.apartment_id) as { id: string }[];
      const moveStart = new Date(`${notice.move_date}T00:00:00`).toISOString();
      for (const { id: residentId } of leaving) {
        db.prepare("UPDATE residents SET moved_out_at = ? WHERE id = ?").run(notice.move_date, residentId);
        const spaces = db.prepare(`
          SELECT p.label FROM parking_assignments pa JOIN parking_spaces p ON p.id = pa.parking_id
          WHERE pa.resident_id = ? AND (pa.end_date IS NULL OR pa.end_date > ?)
        `).all(residentId, notice.move_date) as { label: string }[];
        result.parkingReleased.push(...spaces.map(space => space.label));
        db.prepare("UPDATE parking_assignments SET end_date = ? WHERE resident_id = ? AND (end_date IS NULL OR end_date > ?)")
          .run(notice.move_date, residentId, notice.move_date);
        db.prepare("DELETE FROM parking_assignments WHERE resident_id = ? AND end_date <= start_date").run(residentId);
        result.bookingsRemoved += deleteBookingsAndRelease("resident_id = ? AND starts_at >= ?", [residentId, moveStart]);
        db.prepare("UPDATE booking_queue SET status = 'cancelled', closed_at = ? WHERE resident_id = ? AND status = 'waiting'")
          .run(now(), residentId);
        db.prepare("UPDATE waitlist SET status = 'cancelled', closed_at = ? WHERE resident_id = ? AND status IN ('waiting', 'offered')")
          .run(now(), residentId);
        result.movedOut++;
      }
      syncParkingHolders();
    }

    const apartment = db.prepare("SELECT apartment_number, address FROM apartments WHERE id = ?").get(notice.apartment_id) as
      { apartment_number: string; address: string | null };
    for (const person of JSON.parse(notice.new_residents) as { name: string; email: string }[]) {
      const duplicate = person.email && db.prepare(
        `SELECT 1 FROM residents r WHERE r.company_id = ? AND lower(r.email) = lower(?) AND ${ACTIVE_RESIDENT}`
      ).get(notice.company_id, person.email);
      if (duplicate) {
        result.skipped.push(`${person.name} (sähköposti on jo toisella asukkaalla)`);
        continue;
      }
      db.prepare("INSERT INTO residents (id, company_id, apartment_id, name, email) VALUES (?, ?, ?, ?, ?)")
        .run(id("resident"), notice.company_id, notice.apartment_id, person.name, person.email || null);
      result.added.push(person.name);
    }
    void apartment;

    db.prepare("UPDATE move_notices SET status = 'approved', decided_by = ?, decided_at = ?, result = ? WHERE id = ?")
      .run(actor, now(), JSON.stringify(result), notice.id);
  })();

  void notifyResident(notice.resident_id, "Muuttoilmoitus on hyväksytty", [
    `muuttoilmoituksesi (muuttopäivä ${notice.move_date.split("-").reverse().join(".")}) on hyväksytty ja asukastiedot on päivitetty.`,
    ...(result.added.length > 0 ? [`Asuntoon lisätyt asukkaat: ${result.added.join(", ")}.`] : []),
    ...(result.parkingReleased.length > 0 ? [`Autopaikka päättyy muuttopäivänä: ${result.parkingReleased.join(", ")}.`] : [])
  ]);
  res.json({ ok: true, result });
});

movesRouter.post("/moves/:id/reject", requireManager, (req, res) => {
  const found = pendingMove(req.params.id);
  if (!found.notice) return res.status(found.status).json({ error: found.error });
  db.prepare("UPDATE move_notices SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?")
    .run(res.locals.user?.name ?? "Isännöitsijä", now(), found.notice.id);
  void notifyResident(found.notice.resident_id, "Muuttoilmoitusta ei hyväksytty", [
    "muuttoilmoitustasi ei voitu hyväksyä sellaisenaan. Isännöitsijä on tarvittaessa yhteydessä; voit myös tehdä uuden ilmoituksen asukasportaalissa."
  ]);
  res.json({ ok: true });
});
