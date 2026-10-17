import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { db } from "../db.js";
import { id, now } from "../util.js";

export const reportersRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Ilmoittajan vaihto muissa tietueissa kuin tehtävissä: muutto- ja remontti-ilmoitukset, jonot ja
// kulutuslukemat. Uusi ilmoittaja valitaan saman taloyhtiön asukkaista. Muutto- ja
// remontti-ilmoituksella asunto vaihtuu ilmoittajan asunnoksi, kuten tehtävällä; remontin tehtävä
// päivittyy samalla. Jonossa ja lukemalla asunto ei muutu.
// ---------------------------------------------------------------------------------------------
const RECORDS = {
  moves: { table: "move_notices", label: "muuttoilmoitus", apartment: true },
  renovations: { table: "renovation_notices", label: "remontti-ilmoitus", apartment: true },
  waitlist: { table: "waitlist", label: "jonopaikka", apartment: false },
  "meter-readings": { table: "meter_readings", label: "lukema", apartment: false }
} as const;

reportersRouter.put("/:kind/:id/reporter", (req, res, next) => {
  const record = RECORDS[req.params.kind as keyof typeof RECORDS];
  if (!record) return next();
  const parsed = z.object({ residentId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valitse ilmoittaja asukkaista." });

  const row = db.prepare(`SELECT * FROM ${record.table} WHERE id = ?`).get(req.params.id) as
    | { id: string; company_id: string; resident_id: string | null; ticket_id?: string | null }
    | undefined;
  if (!row || !companyIdFromContext(row.company_id)) return res.status(404).json({ error: "Tietuetta ei löytynyt." });
  const resident = db.prepare("SELECT id, name, apartment_id FROM residents WHERE id = ? AND company_id = ? AND erased_at IS NULL")
    .get(parsed.data.residentId, row.company_id) as { id: string; name: string; apartment_id: string } | undefined;
  if (!resident) return res.status(404).json({ error: "Asukasta ei löytynyt tästä taloyhtiöstä." });
  if (row.resident_id === resident.id) return res.json({ ok: true });

  const previous = row.resident_id
    ? (db.prepare("SELECT name FROM residents WHERE id = ?").get(row.resident_id) as { name: string } | undefined)?.name ?? ""
    : "";
  const timestamp = now();
  const actor = res.locals.user?.name ?? "Isännöitsijä";
  db.transaction(() => {
    if (record.apartment) {
      db.prepare(`UPDATE ${record.table} SET resident_id = ?, apartment_id = ? WHERE id = ?`).run(resident.id, resident.apartment_id, row.id);
    } else {
      db.prepare(`UPDATE ${record.table} SET resident_id = ? WHERE id = ?`).run(resident.id, row.id);
    }
    if (row.ticket_id) {
      db.prepare("UPDATE tickets SET resident_id = ?, apartment_id = ?, updated_at = ? WHERE id = ?")
        .run(resident.id, resident.apartment_id, timestamp, row.ticket_id);
      db.prepare("DELETE FROM ticket_reporters WHERE ticket_id = ?").run(row.ticket_id);
      db.prepare("INSERT INTO ticket_reporters (ticket_id, resident_id) VALUES (?, ?)").run(row.ticket_id, resident.id);
    }
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), row.ticket_id ?? null, actor, "reporter_changed",
      JSON.stringify({ record: record.label, from: previous, to: resident.name }), timestamp
    );
  })();
  res.json({ ok: true });
});
