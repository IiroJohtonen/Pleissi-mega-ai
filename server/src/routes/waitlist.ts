import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { db } from "../db.js";
import { notifyResident } from "../notify.js";
import { id, now } from "../util.js";
import { PARKING_TYPES, setParkingHolder, syncParkingHolders } from "./parking.js";
import { portalResident } from "./portal.js";

export const waitlistRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Jonotuslistat autopaikoille ja saunavuoroille. Järjestys on ilmoittautumisjärjestys.
// ---------------------------------------------------------------------------------------------
const WAITLIST_RESOURCES = ["parking", "sauna"] as const;

const WAITLIST_SELECT = `
  SELECT w.*, r.name AS resident_name, r.email AS resident_email, a.apartment_number, a.address,
         (SELECT COUNT(*) FROM waitlist earlier
          WHERE earlier.company_id = w.company_id AND earlier.resource = w.resource
            AND earlier.status IN ('waiting', 'offered') AND earlier.created_at < w.created_at) + 1 AS position
  FROM waitlist w
  LEFT JOIN residents r ON r.id = w.resident_id
  LEFT JOIN apartments a ON a.id = r.apartment_id
`;

waitlistRouter.post("/portal/waitlist", (req, res) => {
  const resident = portalResident(res);
  const parsed = z.object({
    resource: z.enum(WAITLIST_RESOURCES),
    parkingType: z.union([z.literal(""), z.enum(PARKING_TYPES)]).default(""),
    note: z.string().trim().max(300).default("")
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista jonon tiedot." });

  const existing = db.prepare(
    "SELECT 1 FROM waitlist WHERE resident_id = ? AND resource = ? AND status IN ('waiting', 'offered')"
  ).get(resident.id, parsed.data.resource);
  if (existing) return res.status(409).json({ error: "Olet jo tässä jonossa." });

  const waitlistId = id("wait");
  db.prepare("INSERT INTO waitlist (id, company_id, resource, parking_type, resident_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(waitlistId, resident.companyId, parsed.data.resource,
      parsed.data.resource === "parking" ? parsed.data.parkingType : "", resident.id, parsed.data.note, now());
  res.status(201).json({ ok: true, waitlistId });
});

// Asukas näkee vain omat jonopaikkansa ja sijansa, ei muiden jonottajien tietoja.
waitlistRouter.get("/portal/waitlist", (_req, res) => {
  const rows = db.prepare(`${WAITLIST_SELECT} WHERE w.resident_id = ? AND w.status IN ('waiting', 'offered') ORDER BY w.created_at`)
    .all(portalResident(res).id) as Record<string, unknown>[];
  res.json(rows.map(row => ({
    id: row.id, resource: row.resource, parking_type: row.parking_type, note: row.note,
    status: row.status, created_at: row.created_at, position: row.position
  })));
});

waitlistRouter.delete("/portal/waitlist/:id", (req, res) => {
  const changed = db.prepare(
    "UPDATE waitlist SET status = 'cancelled', closed_at = ? WHERE id = ? AND resident_id = ? AND status IN ('waiting', 'offered')"
  ).run(now(), req.params.id, portalResident(res).id).changes;
  if (!changed) return res.status(404).json({ error: "Jonopaikkaa ei löytynyt." });
  res.json({ ok: true });
});

waitlistRouter.get("/companies/:companyId/waitlist", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare(`${WAITLIST_SELECT} WHERE w.company_id = ? AND w.status IN ('waiting', 'offered') ORDER BY w.resource, w.created_at`).all(companyId));
});

function activeWaitlistEntry(waitlistId: string) {
  const entry = db.prepare("SELECT * FROM waitlist WHERE id = ?").get(waitlistId) as
    | { id: string; company_id: string; resource: string; resident_id: string; status: string }
    | undefined;
  if (!entry || !companyIdFromContext(entry.company_id) || !["waiting", "offered"].includes(entry.status)) return null;
  return entry;
}

// Merkitsee, että jonottajalle on tarjottu paikkaa tai vuoroa.
waitlistRouter.post("/waitlist/:id/offer", (req, res) => {
  const entry = activeWaitlistEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: "Jonopaikkaa ei löytynyt." });
  db.prepare("UPDATE waitlist SET status = 'offered', offered_at = ?, offered_by = ? WHERE id = ?")
    .run(now(), res.locals.user?.name ?? "Isännöitsijä", entry.id);
  void notifyResident(entry.resident_id, entry.resource === "parking" ? "Sinulle on tarjolla autopaikka" : "Sinulle on tarjolla saunavuoro", [
    entry.resource === "parking"
      ? "olet autopaikkajonossa vuorossa, ja sinulle on tarjolla vapautunut autopaikka."
      : "olet saunavuorojonossa vuorossa, ja sinulle on tarjolla vapautunut vuoro.",
    "Isännöitsijä sopii yksityiskohdista kanssasi. Jos et enää tarvitse paikkaa, voit poistua jonosta asukasportaalissa."
  ]);
  res.json({ ok: true });
});

// Poistaa jonosta: outcome 'done' = sai paikan tai vuoron, 'cancelled' = poistettu muusta syystä.
waitlistRouter.post("/waitlist/:id/close", (req, res) => {
  const entry = activeWaitlistEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: "Jonopaikkaa ei löytynyt." });
  const outcome = req.body?.outcome === "done" ? "done" : "cancelled";
  db.prepare("UPDATE waitlist SET status = ?, closed_at = ? WHERE id = ?").run(outcome, now(), entry.id);
  res.json({ ok: true });
});

// Antaa vapaan autopaikan jonottajalle ja poistaa hänet jonosta.
waitlistRouter.post("/waitlist/:id/assign-parking", (req, res) => {
  const entry = activeWaitlistEntry(req.params.id);
  if (!entry || entry.resource !== "parking") return res.status(404).json({ error: "Jonopaikkaa ei löytynyt." });
  syncParkingHolders();
  const space = db.prepare("SELECT id, resident_id FROM parking_spaces WHERE id = ? AND company_id = ?")
    .get(typeof req.body?.parkingId === "string" ? req.body.parkingId : "", entry.company_id) as
    | { id: string; resident_id: string | null }
    | undefined;
  if (!space) return res.status(404).json({ error: "Autopaikkaa ei löytynyt tästä taloyhtiöstä." });
  if (space.resident_id) return res.status(409).json({ error: "Autopaikka on jo varattu." });

  db.transaction(() => {
    setParkingHolder(space.id, entry.company_id, entry.resident_id);
    db.prepare("UPDATE waitlist SET status = 'done', closed_at = ? WHERE id = ?").run(now(), entry.id);
  })();
  const assigned = db.prepare("SELECT label, type FROM parking_spaces WHERE id = ?").get(space.id) as { label: string; type: string };
  void notifyResident(entry.resident_id, "Sinulle on annettu autopaikka", [
    `sinulle on annettu autopaikka ${assigned.label} (${assigned.type}) tästä päivästä alkaen.`
  ]);
  res.json({ ok: true });
});
