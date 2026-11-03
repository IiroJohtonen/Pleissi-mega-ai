import { Router } from "express";
import { z } from "zod";
import {
  agentAutoCompanies, agentAutoDefault, AutonomyError, setAgentAutoDefault, setAgentAutoOverride, setTopicAutonomy, topicAutonomy
} from "../agent-autonomy.js";
import { requireAdmin } from "../auth.js";
import { db } from "../db.js";
import { isTopic } from "../incidents.js";
import { id, now } from "../util.js";

// ---------------------------------------------------------------------------------------------
// AI-reseptionistin asetukset (Asetukset › AI): automaattinen käynnistys (toimiston oletus ja taloyhtiökohtaiset
// ohitukset) ja aiheiden autonomia. Vain pääkäyttäjälle.
// ---------------------------------------------------------------------------------------------

export const agentSettingsRouter = Router();

// topics = valitun taloyhtiön (companyId, oletuksena ensimmäinen) aiheet: luonnosmittari ja hyväksynnät.
agentSettingsRouter.get("/agent/settings", requireAdmin, (req, res) => {
  const companies = agentAutoCompanies();
  const requested = typeof req.query.companyId === "string" ? req.query.companyId : "";
  const companyId = companies.some(company => company.id === requested) ? requested : companies[0]?.id ?? "";
  res.json({ autoStart: agentAutoDefault(), companies, companyId, topics: companyId ? topicAutonomy(companyId) : [] });
});

agentSettingsRouter.put("/agent/settings", requireAdmin, (req, res) => {
  const parsed = z.object({ autoStart: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista asetus." });
  setAgentAutoDefault(parsed.data.autoStart);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), null, res.locals.user?.name ?? "Pääkäyttäjä", "agent_settings_updated", JSON.stringify(parsed.data), now()
  );
  res.json({ autoStart: agentAutoDefault() });
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

// Taloyhtiön aihe itsenäiseksi (vain kun taloyhtiön luonnosmittarin raja täyttyy) tai takaisin luonnostilaan.
agentSettingsRouter.put("/agent/topics/:topic", requireAdmin, (req, res) => {
  const topic = String(req.params.topic);
  if (!isTopic(topic) && topic !== "other") return res.status(404).json({ error: "Aihetta ei löytynyt." });
  const parsed = z.object({ companyId: z.string().min(1), autonomous: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista asetus." });
  if (!db.prepare("SELECT 1 FROM companies WHERE id = ?").get(parsed.data.companyId)) return res.status(404).json({ error: "Taloyhtiötä ei löytynyt." });
  try {
    setTopicAutonomy(parsed.data.companyId, topic, parsed.data.autonomous, res.locals.user?.name ?? "Pääkäyttäjä");
  } catch (error) {
    if (error instanceof AutonomyError) return res.status(409).json({ error: error.message });
    throw error;
  }
  res.json({ topics: topicAutonomy(parsed.data.companyId) });
});
