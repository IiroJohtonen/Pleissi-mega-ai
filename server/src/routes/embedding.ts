import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth.js";
import { db } from "../db.js";
import { embeddingStatus, scheduleEmbeddingIndex, setCompanyOverride } from "../embedding.js";
import { id, now } from "../util.js";

// ---------------------------------------------------------------------------------------------
// Merkityshaun tila ja taloyhtiökohtaiset ohitukset (Asetukset › AI › Merkityshaku). Toimiston yhteiset
// asetukset tallennetaan perustietoihin (embedding). Vain pääkäyttäjälle.
// ---------------------------------------------------------------------------------------------

export const embeddingRouter = Router();

embeddingRouter.get("/embedding/status", requireAdmin, (_req, res) => {
  const status = embeddingStatus();
  const companies = (db.prepare(`
    SELECT id, name, embedding_similar_tickets, embedding_hybrid_knowledge FROM companies ORDER BY name COLLATE NOCASE
  `).all() as { id: string; name: string; embedding_similar_tickets: number | null; embedding_hybrid_knowledge: number | null }[])
    .map(row => {
      const count = (type: string) => status.counts.find(item => item.company_id === row.id && item.source_type === type)?.count ?? 0;
      const override = (value: number | null) => (value === null ? null : value === 1);
      return {
        id: row.id, name: row.name,
        similarTickets: override(row.embedding_similar_tickets), hybridKnowledge: override(row.embedding_hybrid_knowledge),
        vectors: { ticket: count("ticket"), chunk: count("chunk"), memory: count("memory") }
      };
    });
  res.json({ killed: status.killed, backend: status.backend, model: status.model, index: status.index, companies });
});

// Taloyhtiön ohitus: true = päällä, false = pois, null = perustietojen arvo.
embeddingRouter.put("/embedding/companies/:companyId", requireAdmin, (req, res) => {
  const company = db.prepare("SELECT id, name FROM companies WHERE id = ?").get(req.params.companyId) as { id: string; name: string } | undefined;
  if (!company) return res.status(404).json({ error: "Taloyhtiötä ei löytynyt." });
  const parsed = z.object({
    similarTickets: z.boolean().nullable().optional(),
    hybridKnowledge: z.boolean().nullable().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista asetukset." });
  db.transaction(() => {
    if (parsed.data.similarTickets !== undefined) setCompanyOverride(company.id, "similarTickets", parsed.data.similarTickets);
    if (parsed.data.hybridKnowledge !== undefined) setCompanyOverride(company.id, "hybridKnowledge", parsed.data.hybridKnowledge);
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), null, res.locals.user?.name ?? "Pääkäyttäjä", "embedding_settings_updated",
      JSON.stringify({ company: company.name, ...parsed.data }), now()
    );
  })();
  // Puuttuvat vektorit lasketaan (tai pois kytketyn taloyhtiön vektorit poistetaan) taustalla.
  void scheduleEmbeddingIndex();
  res.json({ ok: true });
});
