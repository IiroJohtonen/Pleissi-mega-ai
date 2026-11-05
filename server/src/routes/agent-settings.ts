import { Router } from "express";
import { z } from "zod";
import {
  agentAutoCompanies, agentAutoDefault, agentName, agentSignatureLines, aiNote, setAgentAutoDefault, setAgentAutoOverride, setAgentName
} from "../agent-autonomy.js";
import { requireAdmin } from "../auth.js";
import { db } from "../db.js";
import { setTimePromiseEnabled, timePromiseEnabled } from "../time-promise.js";
import { id, now } from "../util.js";

// ---------------------------------------------------------------------------------------------
// AI-reseptionistin asetukset (Asetukset › AI): automaattinen käynnistys (toimiston oletus ja taloyhtiökohtaiset
// ohitukset) ja aiheiden autonomia. Vain pääkäyttäjälle.
// ---------------------------------------------------------------------------------------------

export const agentSettingsRouter = Router();

agentSettingsRouter.get("/agent/settings", requireAdmin, (_req, res) => {
  res.json({
    autoStart: agentAutoDefault(), timePromise: timePromiseEnabled(), agentName: agentName(), signature: agentSignatureLines(), note: aiNote(),
    companies: agentAutoCompanies()
  });
});

agentSettingsRouter.put("/agent/settings", requireAdmin, (req, res) => {
  const parsed = z.object({
    autoStart: z.boolean().optional(), timePromise: z.boolean().optional(), agentName: z.string().trim().min(1).max(40).optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista asetus." });
  if (parsed.data.autoStart !== undefined) setAgentAutoDefault(parsed.data.autoStart);
  // Aikalupauksen voi kytkeä päälle vain, kun AI-agentin automaattinen käynnistys on päällä (oletuksena tai jossain taloyhtiössä).
  if (parsed.data.timePromise) {
    const anyAuto = agentAutoDefault() || agentAutoCompanies().some(company => company.autoStart === true);
    if (!anyAuto) return res.status(409).json({ error: "Kytke ensin AI-agentin automaattinen käynnistys päälle." });
  }
  if (parsed.data.timePromise !== undefined) setTimePromiseEnabled(parsed.data.timePromise);
  if (parsed.data.agentName !== undefined) setAgentName(parsed.data.agentName);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), null, res.locals.user?.name ?? "Pääkäyttäjä", "agent_settings_updated", JSON.stringify(parsed.data), now()
  );
  res.json({ autoStart: agentAutoDefault(), timePromise: timePromiseEnabled(), agentName: agentName(), signature: agentSignatureLines(), note: aiNote() });
});

// Taloyhtiön ohitus: true = päällä, false = pois, null = toimiston oletus.
agentSettingsRouter.put("/agent/companies/:companyId", requireAdmin, (req, res) => {
  const company = db.prepare("SELECT id, name FROM companies WHERE id = ?").get(req.params.companyId) as { id: string; name: string } | undefined;
  if (!company) return res.status(404).json({ error: "Taloyhtiötä ei löytynyt." });
  const parsed = z.object({ autoStart: z.boolean().nullable() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista asetus." });
  setAgentAutoOverride(company.id, parsed.data.autoStart);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), null, res.locals.user?.name ?? "Pääkäyttäjä", "agent_settings_updated",
    JSON.stringify({ company: company.name, autoStart: parsed.data.autoStart }), now()
  );
  res.json({ ok: true });
});
