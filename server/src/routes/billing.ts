import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { requireAdmin, requireManager } from "../auth.js";
import { db } from "../db.js";
import { now } from "../util.js";

export const billingRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Laskutetut kuukaudet. Merkintä tallentaa raportin rivit ja käytetyt hinnat sellaisinaan, joten
// myöhempi hinnanmuutos tai asukasmuutos ei muuta jo laskutettua kuukautta.
// ---------------------------------------------------------------------------------------------
const billingKey = z.object({ kind: z.enum(["sauna", "parking"]), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });

billingRouter.get("/companies/:companyId/billing-periods", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = billingKey.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista raportti ja kuukausi." });
  const row = db.prepare("SELECT * FROM billing_periods WHERE company_id = ? AND kind = ? AND month = ?")
    .get(companyId, parsed.data.kind, parsed.data.month) as
    | { billed_at: string; billed_by: string; total: number; prices: string; rows: string }
    | undefined;
  res.json(row ? { billedAt: row.billed_at, billedBy: row.billed_by, total: row.total, prices: JSON.parse(row.prices), rows: JSON.parse(row.rows) } : null);
});

billingRouter.post("/companies/:companyId/billing-periods", requireManager, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = billingKey.extend({
    total: z.number().min(0).max(10_000_000),
    prices: z.record(z.string(), z.number().min(0)),
    rows: z.array(z.object({
      name: z.string().max(200),
      apartment: z.string().max(60),
      detail: z.string().max(2000),
      total: z.number().min(0)
    })).min(1).max(2000)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Laskutettavia rivejä ei ole tai tiedot ovat virheelliset." });

  const existing = db.prepare("SELECT 1 FROM billing_periods WHERE company_id = ? AND kind = ? AND month = ?")
    .get(companyId, parsed.data.kind, parsed.data.month);
  if (existing) return res.status(409).json({ error: "Kuukausi on jo merkitty laskutetuksi." });
  db.prepare(`
    INSERT INTO billing_periods (company_id, kind, month, billed_at, billed_by, total, prices, rows)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(companyId, parsed.data.kind, parsed.data.month, now(), res.locals.user?.name ?? "Isännöitsijä",
    parsed.data.total, JSON.stringify(parsed.data.prices), JSON.stringify(parsed.data.rows));
  res.status(201).json({ ok: true });
});

// Laskutusmerkinnän saa poistaa vain pääkäyttäjä.
billingRouter.delete("/companies/:companyId/billing-periods", requireAdmin, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = billingKey.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista raportti ja kuukausi." });
  const changes = db.prepare("DELETE FROM billing_periods WHERE company_id = ? AND kind = ? AND month = ?")
    .run(companyId, parsed.data.kind, parsed.data.month).changes;
  if (!changes) return res.status(404).json({ error: "Laskutusmerkintää ei löytynyt." });
  res.json({ ok: true });
});
