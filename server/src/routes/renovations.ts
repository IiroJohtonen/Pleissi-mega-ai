import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { requireManager } from "../auth.js";
import { db } from "../db.js";
import { notifyResident } from "../notify.js";
import { id, now } from "../util.js";
import { portalResident } from "./portal.js";

export const renovationsRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Remontti-ilmoitukset: asukas ilmoittaa portaalissa, isännöitsijä hyväksyy tai hylkää ja voi
// kirjata hyväksynnälle ehdot. Hyväksytty remontti merkitään lopuksi valmistuneeksi.
// ---------------------------------------------------------------------------------------------
export const RENOVATION_WORK_TYPES = [
  "Märkätila", "Keittiö", "Vesi- ja viemärityöt", "Sähkötyöt", "Lattiat ja pinnat", "Rakenteet", "Muu"
] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const fiDay = (day: string) => day.split("-").reverse().join(".");

const renovationSchema = z.object({
  workType: z.enum(RENOVATION_WORK_TYPES),
  description: z.string().trim().min(10).max(5000),
  startDate: z.string().regex(DAY),
  endDate: z.string().regex(DAY),
  contractor: z.string().trim().max(300).default("")
});

renovationsRouter.post("/portal/renovations", (req, res) => {
  const resident = portalResident(res);
  const parsed = renovationSchema.safeParse(req.body);
  if (!parsed.success || Number.isNaN(Date.parse(parsed.data.startDate)) || Number.isNaN(Date.parse(parsed.data.endDate))) {
    return res.status(400).json({ error: "Tarkista työn tyyppi, kuvaus ja päivämäärät." });
  }
  if (parsed.data.endDate < parsed.data.startDate) {
    return res.status(400).json({ error: "Päättymispäivä ei voi olla ennen alkamispäivää." });
  }

  const renovationId = id("renovation");
  db.prepare(`
    INSERT INTO renovation_notices
      (id, company_id, apartment_id, resident_id, work_type, description, start_date, end_date, contractor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(renovationId, resident.companyId, resident.apartmentId, resident.id, parsed.data.workType, parsed.data.description,
    parsed.data.startDate, parsed.data.endDate, parsed.data.contractor, now());
  res.status(201).json({ ok: true, renovationId });
});

renovationsRouter.get("/portal/renovations", (_req, res) => {
  res.json(db.prepare(`
    SELECT id, work_type, description, start_date, end_date, contractor, status, decision_note, created_at, decided_at, completed_at
    FROM renovation_notices WHERE resident_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(portalResident(res).id));
});

renovationsRouter.get("/companies/:companyId/renovations", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare(`
    SELECT n.*, r.name AS resident_name, r.email AS resident_email, a.apartment_number, a.address
    FROM renovation_notices n
    LEFT JOIN residents r ON r.id = n.resident_id
    LEFT JOIN apartments a ON a.id = n.apartment_id
    WHERE n.company_id = ?
    ORDER BY n.status = 'pending' DESC, n.created_at DESC
  `).all(companyId));
});

type RenovationNotice = {
  id: string; company_id: string; resident_id: string; work_type: string; start_date: string; end_date: string; status: string;
};

function renovationWithStatus(renovationId: string, status: string, handledError: string) {
  const notice = db.prepare("SELECT * FROM renovation_notices WHERE id = ?").get(renovationId) as RenovationNotice | undefined;
  if (!notice || !companyIdFromContext(notice.company_id)) return { notice: null, error: "Remontti-ilmoitusta ei löytynyt.", status: 404 };
  if (notice.status !== status) return { notice: null, error: handledError, status: 409 };
  return { notice, error: "", status: 200 };
}

const decisionSchema = z.object({ note: z.string().trim().max(3000).default("") });

renovationsRouter.post("/renovations/:id/approve", requireManager, (req, res) => {
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Ehdot ovat liian pitkät." });
  const found = renovationWithStatus(req.params.id, "pending", "Remontti-ilmoitus on jo käsitelty.");
  if (!found.notice) return res.status(found.status).json({ error: found.error });
  const { notice } = found;

  db.prepare("UPDATE renovation_notices SET status = 'approved', decision_note = ?, decided_by = ?, decided_at = ? WHERE id = ?")
    .run(parsed.data.note, res.locals.user?.name ?? "Isännöitsijä", now(), notice.id);
  void notifyResident(notice.resident_id, "Remontti-ilmoitus on hyväksytty", [
    `remontti-ilmoituksesi (${notice.work_type}, ${fiDay(notice.start_date)}–${fiDay(notice.end_date)}) on hyväksytty.`,
    ...(parsed.data.note ? ["", "Hyväksynnän ehdot:", parsed.data.note] : [])
  ]);
  res.json({ ok: true });
});

renovationsRouter.post("/renovations/:id/reject", requireManager, (req, res) => {
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success || !parsed.data.note) return res.status(400).json({ error: "Kirjoita hylkäämisen perustelu." });
  const found = renovationWithStatus(req.params.id, "pending", "Remontti-ilmoitus on jo käsitelty.");
  if (!found.notice) return res.status(found.status).json({ error: found.error });
  const { notice } = found;

  db.prepare("UPDATE renovation_notices SET status = 'rejected', decision_note = ?, decided_by = ?, decided_at = ? WHERE id = ?")
    .run(parsed.data.note, res.locals.user?.name ?? "Isännöitsijä", now(), notice.id);
  void notifyResident(notice.resident_id, "Remontti-ilmoitusta ei hyväksytty", [
    `remontti-ilmoitustasi (${notice.work_type}, ${fiDay(notice.start_date)}–${fiDay(notice.end_date)}) ei hyväksytty. Työtä ei saa aloittaa.`,
    "",
    "Perustelu:",
    parsed.data.note
  ]);
  res.json({ ok: true });
});

renovationsRouter.post("/renovations/:id/complete", requireManager, (req, res) => {
  const found = renovationWithStatus(req.params.id, "approved", "Vain hyväksytyn remontin voi merkitä valmistuneeksi.");
  if (!found.notice) return res.status(found.status).json({ error: found.error });
  db.prepare("UPDATE renovation_notices SET status = 'completed', completed_at = ? WHERE id = ?").run(now(), found.notice.id);
  res.json({ ok: true });
});
