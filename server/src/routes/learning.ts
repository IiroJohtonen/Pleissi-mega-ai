import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext, getAuthorizedTicket, visibleCompanyIds } from "../access.js";
import { isAdmin, requireManager } from "../auth.js";
import { aiAvailable, findContradictions, replyToGuide } from "../ai.js";
import { withAiLog } from "../ai-log.js";
import { db } from "../db.js";
import { searchKnowledgeChunks } from "../knowledge-chunks.js";
import { maskPersonalData } from "../privacy-filter.js";
import { detectSensitivity } from "../ticket-sensitivity.js";
import { id, now } from "../util.js";
import { saveKnowledge } from "./knowledge.js";
import { loadNote } from "./memory.js";

// ---------------------------------------------------------------------------------------------
// Oppiminen isännöitsijän vastauksista (laajentaa taloyhtiön muistin ehdotusvirtaa, memory.ts):
// vastaus dokumentaatioksi, ristiriitatarkistus, tarkistuspäivä, osaamisaukot, Tietopohja-haku ja
// opitun tiedon vienti evaluoinnin testitapaukseksi. Muisti ja dokumentaatio pysyvät erillään
// tallennuksessa; Tietopohja näyttää ne yhdessä.
// ---------------------------------------------------------------------------------------------

export const learningRouter: Router = express.Router();

// Lähetetystä vastauksesta yleinen ohje (AI, ilman henkilötietoja). Isännöitsijä tarkistaa ja tallentaa.
learningRouter.post("/tickets/:id/messages/:messageId/guide", requireManager, async (req, res) => {
  const ticket = getAuthorizedTicket(req.params.id) as { id: string; subject: string; company_id: string; sensitive: number } | null;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  const message = db.prepare("SELECT body, direction, channel FROM messages WHERE id = ? AND ticket_id = ?").get(req.params.messageId, ticket.id) as
    { body: string; direction: string; channel: string | null } | undefined;
  if (!message || message.direction !== "outbound" || message.channel === "contractor") return res.status(404).json({ error: "Vastausta ei löytynyt." });
  // Arkaluonteinen tehtävä ei mene AI:lle.
  if (ticket.sensitive || detectSensitivity(ticket.id, `${ticket.subject}\n${message.body}`)) {
    return res.status(400).json({ error: "Arkaluonteisesta tehtävästä ei tehdä ohjetta AI:lla." });
  }
  if (!aiAvailable()) return res.status(503).json({ error: "AI ei ole juuri nyt käytettävissä." });
  try {
    const { result } = await withAiLog(ticket.id, () => replyToGuide(ticket.subject, message.body));
    res.json(result);
  } catch (error: any) {
    console.error("Ohjeen luonnos epäonnistui:", error?.message ?? error);
    res.status(502).json({ error: "Ohjeen luonnos epäonnistui. Yritä uudelleen." });
  }
});

const guideSchema = z.object({ title: z.string().trim().min(1).max(120), content: z.string().trim().min(5).max(4000) });

// Ristiriitatarkistus ennen tallennusta: uutta ohjetta verrataan lähimpiin olemassa oleviin (AI).
learningRouter.post("/companies/:companyId/knowledge-base/conflicts", requireManager, async (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = guideSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Anna ohjeelle otsikko ja teksti." });
  const nearest = await searchKnowledgeChunks(companyId, `${parsed.data.title}\n${parsed.data.content}`, 5);
  if (!nearest.length) return res.json({ checked: true, conflicts: [] });
  if (!aiAvailable()) return res.json({ checked: false, conflicts: [] });
  const conflicts = await withAiLog(undefined, () => findContradictions(parsed.data,
    nearest.map(chunk => ({ id: chunk.id, title: chunk.title, content: chunk.content }))))
    .then(({ result }) => ({ checked: true, result }))
    .catch(error => {
      console.error("Ristiriitatarkistus epäonnistui:", error?.message ?? error);
      return { checked: false, result: [] as { id: string; reason: string }[] };
    });
  res.json({
    checked: conflicts.checked,
    conflicts: conflicts.result.map(conflict => {
      const chunk = nearest.find(item => item.id === conflict.id)!;
      return { chunkId: chunk.id, knowledgeId: chunk.knowledgeId, title: chunk.title, documentTitle: chunk.documentTitle, reason: conflict.reason };
    })
  });
});

// Tarkistettu ohje AI-dokumentaatioon: tämä taloyhtiö tai (pääkäyttäjä) kaikki toimiston taloyhtiöt.
learningRouter.post("/companies/:companyId/knowledge-base/guides", requireManager, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = guideSchema.extend({ scope: z.enum(["company", "office"]).default("company"), ticketId: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Anna ohjeelle otsikko ja teksti." });
  if (parsed.data.scope === "office" && !isAdmin(res)) return res.status(403).json({ error: "Kaikkien taloyhtiöiden ohjeen voi tallentaa vain pääkäyttäjä." });
  const knowledgeId = saveKnowledge({
    companyId, kind: "fact", title: parsed.data.title, content: parsed.data.content, validFrom: "", validUntil: "", audience: "ai", scope: parsed.data.scope
  });
  const ticketId = parsed.data.ticketId && getAuthorizedTicket(parsed.data.ticketId) ? parsed.data.ticketId : null;
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), ticketId, res.locals.user?.name ?? "Isännöitsijä", "guide_saved", JSON.stringify({ knowledge: knowledgeId, company: companyId, scope: parsed.data.scope }), now()
  );
  res.status(201).json({ knowledgeId });
});

// Ohjeen tarkistuspäivä: uusi päivä tai "tarkistettu" (seuraava tarkistus vuoden päästä).
learningRouter.put("/knowledge/:id/review", requireManager, (req, res) => {
  const row = db.prepare("SELECT id, company_id FROM knowledge WHERE id = ?").get(req.params.id) as { id: string; company_id: string } | undefined;
  if (!row || !companyIdFromContext(row.company_id)) return res.status(404).json({ error: "Tietoa ei löytynyt." });
  const parsed = z.object({ reviewAt: z.iso.date().optional(), reviewed: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success || (!parsed.data.reviewAt && !parsed.data.reviewed)) return res.status(400).json({ error: "Valitse tarkistuspäivä." });
  if (parsed.data.reviewed) db.prepare("UPDATE knowledge SET review_at = date('now', '+12 months') WHERE id = ?").run(row.id);
  else db.prepare("UPDATE knowledge SET review_at = ? WHERE id = ?").run(parsed.data.reviewAt, row.id);
  res.json({ reviewAt: (db.prepare("SELECT review_at FROM knowledge WHERE id = ?").get(row.id) as { review_at: string }).review_at });
});

// Aukkoraportti (12 viikkoa): useimmin ilman vastausta jääneet kysymykset aiheittain ja AI-agentin siirtojen
// osuus aiheittain viikoittain.
export function knowledgeGapReport(companyIds: string[], days = 84) {
  if (!companyIds.length) return { topics: [], weeks: [] };
  const placeholders = companyIds.map(() => "?").join(", ");
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const gaps = db.prepare(`
    SELECT COALESCE(topic, 'other') AS topic, question, COUNT(*) AS count, MAX(created_at) AS last_at
    FROM knowledge_gaps WHERE company_id IN (${placeholders}) AND created_at >= ?
    GROUP BY COALESCE(topic, 'other'), lower(question) ORDER BY count DESC, last_at DESC
  `).all(...companyIds, since) as { topic: string; question: string; count: number; last_at: string }[];
  const topics = new Map<string, { topic: string; total: number; questions: { question: string; count: number; lastAt: string }[] }>();
  for (const gap of gaps) {
    const item = topics.get(gap.topic) ?? { topic: gap.topic, total: 0, questions: [] };
    item.total += gap.count;
    if (item.questions.length < 10) item.questions.push({ question: gap.question, count: gap.count, lastAt: gap.last_at });
    topics.set(gap.topic, item);
  }
  const runs = db.prepare(`
    SELECT COALESCE(t.topic, 'other') AS topic, strftime('%Y-%W', a.created_at) AS week, a.action
    FROM audit_log a JOIN tickets t ON t.id = a.ticket_id
    WHERE t.company_id IN (${placeholders}) AND a.action IN ('ai_agent_replied', 'ai_agent_handover') AND a.created_at >= ?
  `).all(...companyIds, since) as { topic: string; week: string; action: string }[];
  const weeks = new Map<string, { week: string; topic: string; runs: number; handovers: number }>();
  for (const run of runs) {
    const key = `${run.week}|${run.topic}`;
    const item = weeks.get(key) ?? { week: run.week, topic: run.topic, runs: 0, handovers: 0 };
    item.runs++;
    if (run.action === "ai_agent_handover") item.handovers++;
    weeks.set(key, item);
  }
  return {
    topics: [...topics.values()].sort((a, b) => b.total - a.total),
    weeks: [...weeks.values()].sort((a, b) => b.week.localeCompare(a.week) || b.runs - a.runs)
  };
}

learningRouter.get("/reports/knowledge-gaps", (req, res) => {
  const requested = typeof req.query.companyId === "string" && req.query.companyId !== "all" ? req.query.companyId : null;
  const companyIds = requested ? [companyIdFromContext(requested)].filter((value): value is string => Boolean(value)) : visibleCompanyIds();
  if (requested && !companyIds.length) return res.status(403).json({ error: "Company not authorized" });
  res.json(knowledgeGapReport(companyIds));
});

type BaseItem = {
  type: "memory" | "documentation"; id: string; title: string; text: string; scope: string; reviewAt: string | null;
  validUntil: string | null; knowledgeId: string | null; page: number | null;
};

// Tietopohja: taloyhtiön muisti ja AI-dokumentaatio yhdessä. Yksi haku palauttaa molemmat tyyppimerkinnällä;
// dokumentaatiossa sama haku kuin AI:lla (sanahaku tai hybridi), muistissa sanahaku.
learningRouter.get("/companies/:companyId/knowledge-base", async (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
  const type = req.query.type === "memory" || req.query.type === "documentation" ? req.query.type : "all";
  const items: BaseItem[] = [];
  if (type !== "documentation") {
    const words = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
    const notes = db.prepare(`
      SELECT id, text, stairwell, valid_until FROM company_memory WHERE company_id = ? AND status = 'approved' AND target = 'memory'
      ORDER BY updated_at DESC
    `).all(companyId) as { id: string; text: string; stairwell: string; valid_until: string | null }[];
    for (const note of notes) {
      if (words.length && !words.some(word => note.text.toLowerCase().includes(word))) continue;
      items.push({ type: "memory", id: note.id, title: note.stairwell ? `${note.stairwell}-porras` : "Koko taloyhtiö", text: note.text, scope: "company",
        reviewAt: null, validUntil: note.valid_until, knowledgeId: null, page: null });
    }
  }
  if (type !== "memory") {
    if (query) {
      for (const chunk of await searchKnowledgeChunks(companyId, query, 20)) {
        const knowledge = db.prepare("SELECT scope, review_at, valid_until FROM knowledge WHERE id = ?").get(chunk.knowledgeId) as
          { scope: string; review_at: string | null; valid_until: string | null };
        items.push({
          type: "documentation", id: chunk.id, title: chunk.title && chunk.title !== chunk.documentTitle ? `${chunk.documentTitle} · ${chunk.title}` : chunk.documentTitle,
          text: chunk.content, scope: knowledge.scope, reviewAt: knowledge.review_at, validUntil: knowledge.valid_until, knowledgeId: chunk.knowledgeId, page: chunk.page
        });
      }
    } else {
      const rows = db.prepare(`
        SELECT id, title, content, scope, review_at, valid_until FROM knowledge
        WHERE (company_id = ? OR scope = 'office') AND status = 'active' AND audience = 'ai' ORDER BY title
      `).all(companyId) as { id: string; title: string; content: string; scope: string; review_at: string | null; valid_until: string | null }[];
      for (const row of rows) {
        items.push({ type: "documentation", id: row.id, title: row.title, text: row.content.slice(0, 600), scope: row.scope, reviewAt: row.review_at,
          validUntil: row.valid_until, knowledgeId: row.id, page: null });
      }
    }
  }
  res.json({ items });
});

// Hyväksytystä opitusta tiedosta testitapaus evaluointiin (server/eval/cases/suggest, ks. eval/README.md).
// Isännöitsijä täydentää tunnisteen ja odotukset ennen kuin tiedosto lisätään repoon.
learningRouter.get("/memory/:id/eval-case", requireManager, (req, res) => {
  const note = loadNote(req.params.id);
  if (!note || note.status !== "approved" || note.target === "none") return res.status(404).json({ error: "Tietoa ei löytynyt." });
  const sources = JSON.parse(note.sources || "[]") as string[];
  const gap = sources.length
    ? db.prepare(`SELECT question FROM knowledge_gaps WHERE ticket_id IN (${sources.map(() => "?").join(", ")}) LIMIT 1`).get(...sources) as { question: string } | undefined
    : undefined;
  const subject = sources.map(ticketId => db.prepare("SELECT subject, sensitive FROM tickets WHERE id = ?").get(ticketId) as { subject: string; sensitive: number } | undefined)
    .find(ticket => ticket && !ticket.sensitive)?.subject;
  const question = maskPersonalData(gap?.question ?? subject ?? note.doc_title ?? note.text.slice(0, 80));
  const chunkId = `chunk-${note.id}`;
  const documentation = note.target === "documentation";
  res.setHeader("Content-Disposition", `attachment; filename="opittu-${note.id}.json"`);
  res.json({
    id: "suggest-000",
    feature: "suggest",
    source: "real",
    tags: ["opittu", documentation ? "dokumentaatio" : "muisti"],
    input: {
      subject: question.slice(0, 120),
      conversation: `Asukas: ${question}`,
      knowledge: documentation ? [{ id: chunkId, title: note.doc_title ?? "Ohje", content: maskPersonalData(note.text), page: null }] : [],
      managerContext: "",
      followUp: false,
      memory: documentation ? [] : [maskPersonalData(note.text)]
    },
    expected: { source: documentation ? [chunkId] : [], sourceOrNone: !documentation, mustInclude: [], mustNotInclude: [], maxWords: 180 },
    critical: false,
    note: `Opittu tieto (${documentation ? "dokumentaatio" : "muisti"}), hyväksytty ${note.decided_at?.slice(0, 10) ?? ""}. Vaihda id, lisää mustInclude ja tarkista anonymisointi ennen tallennusta.`
  });
});
