import fs from "node:fs/promises";
import path from "node:path";
import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { chunkDocumentWithAi, formatKnowledgeEntry, type KnowledgeItem } from "../ai.js";
import { requireManager } from "../auth.js";
import { db, knowledgeFilesDir, nextDocNumber } from "../db.js";
import { extractFormatted, extractPages, isPdf, UnsupportedDocumentError } from "../extract.js";
import { applyVersion, compareVersions, likelyPreviousVersion, previousVersion } from "../knowledge-versions.js";
import {
  chunkSourceLabel, documentPages, findSimilarChunk, hasUnknownNumbers, insertChunk, listChunks, localChunks, pagesInNote,
  processDocument, saveChunks, selectKnowledgeChunks, setChunksStatus
} from "../knowledge-chunks.js";
import { markdownToPlain, plainToMarkdown } from "../rich-text.js";
import { id, now, today, unsafeFileMessage } from "../util.js";

export const knowledgeRouter: Router = express.Router();

export const KNOWLEDGE_AUDIENCES = ["ai", "internal"] as const;

// AI:n käytössä ovat vain yhtiön omat, voimassa olevat AI-dokumentaation tietueet, joiden teksti on
// saatu luettua. Sisäinen dokumentaatio on vain henkilökunnan luettavaksi, eikä AI näe sitä koskaan.
export function getKnowledge(companyId: string) {
  const date = today();
  return db.prepare(`
    SELECT id, title, content, kind, tags
    FROM knowledge
    WHERE company_id = ?
      AND status = 'active'
      AND audience = 'ai'
      AND extraction_ok = 1
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_until IS NULL OR valid_until >= ?)
  `).all(companyId, date, date) as KnowledgeItem[];
}

type KnowledgeRow = {
  id: string;
  company_id: string;
  title: string;
  content: string;
  kind: string;
  valid_from: string | null;
  valid_until: string | null;
  file_name: string | null;
  mime_type: string | null;
  version: number;
  group_id: string;
  status: string;
  extraction_ok: number;
  created_at: string;
  audience: string;
  processing_state: string;
};

function knowledgeState(row: KnowledgeRow) {
  const date = today();
  if (row.status !== "active") return row.status;
  if (!row.extraction_ok) return "unreadable";
  if (row.processing_state === "processing") return "processing";
  if (row.valid_until && row.valid_until < date) return "expired";
  if (row.valid_from && row.valid_from > date) return "upcoming";
  return row.audience === "internal" ? "internal" : "in_use";
}

type StoredKnowledgeRow = KnowledgeRow & { pages?: string | null; comparison?: string | null; formatted?: string | null };

function serializeKnowledge({ pages: _pages, comparison: _comparison, formatted: _formatted, ...row }: StoredKnowledgeRow) {
  return {
    ...row,
    content: row.kind === "document" ? row.content.slice(0, 600) : row.content,
    content_length: row.content.length,
    state: knowledgeState(row)
  };
}

function getAuthorizedKnowledge(knowledgeId: string) {
  const row = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(knowledgeId) as KnowledgeRow | undefined;
  return row && companyIdFromContext(row.company_id) ? row : null;
}

const validityDate = z.string().trim()
  .pipe(z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]))
  .default("");

// Tallentaa uuden tietueen. Jos se korvaa aiemman, vanha versio jää historiaan.
function saveKnowledge(input: {
  companyId: string;
  kind: "fact" | "document";
  title: string;
  content: string;
  validFrom: string;
  validUntil: string;
  replaces?: string;
  fileName?: string;
  mimeType?: string;
  extractionOk?: boolean;
  // PDF:n teksti sivuittain.
  pages?: string[] | null;
  // Muotoiltu teksti (dokumentit).
  formatted?: string | null;
  tags?: string[];
  // Puuttuessaan uusi versio perii korvattavan tietueen kohteen; uusi tietue on AI-dokumentaatiota.
  audience?: (typeof KNOWLEDGE_AUDIENCES)[number];
}) {
  const replaced = input.replaces
    ? db.prepare(
        "SELECT * FROM knowledge WHERE id = ? AND company_id = ? AND status = 'active'"
      ).get(input.replaces, input.companyId) as KnowledgeRow | undefined
    : undefined;
  if (input.replaces && !replaced) return null;

  // Dokumentin uusi versio odottaa isännöitsijän hyväksyntää; vakiotieto korvataan heti.
  const pending = Boolean(replaced) && input.kind === "document";
  const knowledgeId = id("knowledge");
  db.transaction(() => {
    if (replaced && pending) {
      // Aiempi odottava versio väistyy uuden tieltä.
      const stale = db.prepare("SELECT id FROM knowledge WHERE group_id = ? AND status = 'pending'").all(replaced.group_id) as { id: string }[];
      for (const row of stale) {
        db.prepare("UPDATE knowledge SET status = 'deleted' WHERE id = ?").run(row.id);
        setChunksStatus(row.id, "deleted");
      }
    } else if (replaced) {
      db.prepare("UPDATE knowledge SET status = 'replaced' WHERE id = ?").run(replaced.id);
    }
    db.prepare(`
      INSERT INTO knowledge
      (id, company_id, title, content, kind, valid_from, valid_until, file_name, mime_type,
       version, group_id, status, extraction_ok, created_at, audience, doc_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      knowledgeId,
      input.companyId,
      input.title,
      input.content,
      input.kind,
      input.validFrom || null,
      input.validUntil || null,
      input.fileName ?? null,
      input.mimeType ?? null,
      replaced ? replaced.version + 1 : 1,
      replaced ? replaced.group_id : knowledgeId,
      pending ? "pending" : "active",
      input.extractionOk === false ? 0 : 1,
      now(),
      input.audience ?? replaced?.audience ?? "ai",
      // Uusi versio pitää dokumenttinumeronsa; uusi tietue saa seuraavan numeron.
      (replaced as (KnowledgeRow & { doc_number?: number | null }) | undefined)?.doc_number ?? nextDocNumber()
    );
    // Uusi versio perii aiemman version avainsanat, ellei uusia anneta.
    const tags = input.tags ? input.tags.join(", ") : replaced ? (replaced as KnowledgeRow & { tags?: string }).tags ?? "" : "";
    if (tags) db.prepare("UPDATE knowledge SET tags = ? WHERE id = ?").run(tags, knowledgeId);
    if (replaced && !pending) setChunksStatus(replaced.id, "archived");
    saveChunks(
      { id: knowledgeId, company_id: input.companyId, status: "active" },
      localChunks({ title: input.title, content: input.content, kind: input.kind }, input.pages)
    );
    if (input.pages) db.prepare("UPDATE knowledge SET pages = ? WHERE id = ?").run(JSON.stringify(input.pages), knowledgeId);
    if (input.formatted) db.prepare("UPDATE knowledge SET formatted = ? WHERE id = ?").run(input.formatted, knowledgeId);
  })();

  return knowledgeId;
}

knowledgeRouter.get("/companies/:companyId/knowledge", (req, res) => {
  if (!companyIdFromContext(req.params.companyId)) {
    return res.status(403).json({ error: "Company not authorized" });
  }
  const rows = db.prepare(
    `SELECT k.*, (
       SELECT p.id FROM knowledge p WHERE p.group_id = k.group_id AND p.status = 'pending' ORDER BY p.created_at DESC LIMIT 1
     ) AS pending_version_id
     FROM knowledge k WHERE k.company_id = ? AND k.status = 'active' ORDER BY k.title`
  ).all(req.params.companyId) as KnowledgeRow[];
  res.json(rows.map(serializeKnowledge));
});

knowledgeRouter.post("/companies/:companyId/knowledge/facts", requireManager, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const schema = z.object({
    question: z.string().trim().min(1),
    answer: z.string().trim().min(1),
    // Muotoiltu vastaus (otsikot, lihavoinnit, luettelot); answer on sama ilman muotoilua.
    formatted: z.string().trim().max(200_000).optional(),
    validFrom: validityDate,
    validUntil: validityDate,
    replaces: z.string().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    audience: z.enum(KNOWLEDGE_AUDIENCES).optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Täytä kysymys ja vastaus ja tarkista päivämäärät." });
  }

  const knowledgeId = saveKnowledge({
    companyId,
    kind: "fact",
    title: parsed.data.question,
    content: parsed.data.formatted ? markdownToPlain(parsed.data.formatted) : parsed.data.answer,
    formatted: parsed.data.formatted || null,
    validFrom: parsed.data.validFrom,
    validUntil: parsed.data.validUntil,
    replaces: parsed.data.replaces,
    tags: parsed.data.tags,
    audience: parsed.data.audience
  });
  if (!knowledgeId) return res.status(404).json({ error: "Korvattavaa tietuetta ei löytynyt." });

  res.status(201).json({ ok: true, knowledgeId });
});

knowledgeRouter.post(
  "/companies/:companyId/knowledge/documents",
  requireManager,
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    const companyId = companyIdFromContext(req.params.companyId);
    if (!companyId) return res.status(403).json({ error: "Company not authorized" });

    const schema = z.object({
      fileName: z.string().trim().min(1),
      mimeType: z.string().default(""),
      title: z.string().trim().default(""),
      validFrom: validityDate,
      validUntil: validityDate,
      replaces: z.string().optional(),
      audience: z.enum(KNOWLEDGE_AUDIENCES).optional()
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "Valitse ladattava tiedosto ja tarkista päivämäärät." });
    }

    const fileName = path.basename(parsed.data.fileName);
    const unsafe = await unsafeFileMessage([{ filename: fileName, content: req.body }]);
    if (unsafe) return res.status(400).json({ error: unsafe });
    let text = "";
    let pages: string[] | null = null;
    let formatted: string | null = null;
    let extractionOk: boolean;
    try {
      const extracted = await extractPages(req.body, fileName, parsed.data.mimeType);
      if (isPdf(fileName, parsed.data.mimeType)) pages = extracted;
      text = extracted.filter(Boolean).join("\n\n");
      extractionOk = text.length > 0;
      if (extractionOk) formatted = await extractFormatted(req.body, fileName, text);
    } catch (error) {
      if (error instanceof UnsupportedDocumentError) {
        return res.status(400).json({ error: error.message });
      }
      console.error("Dokumentin tekstin lukeminen epäonnistui:", error instanceof Error ? error.message : error);
      extractionOk = false;
    }

    const knowledgeId = saveKnowledge({
      companyId,
      kind: "document",
      title: parsed.data.title || path.parse(fileName).name,
      content: text,
      validFrom: parsed.data.validFrom,
      validUntil: parsed.data.validUntil,
      replaces: parsed.data.replaces,
      fileName,
      mimeType: parsed.data.mimeType || "application/octet-stream",
      extractionOk,
      pages,
      formatted,
      audience: parsed.data.audience
    });
    if (!knowledgeId) return res.status(404).json({ error: "Korvattavaa tietuetta ei löytynyt." });

    await fs.writeFile(path.join(knowledgeFilesDir, knowledgeId), req.body);
    // Pilkonta jatkuu taustalla; dokumentin tila näkyy käyttöliittymässä.
    void processDocument(knowledgeId);

    // Ilman korvattavaa versiota tarkistetaan, onko tämä todennäköisesti uusi versio aiemmasta dokumentista.
    const likely = parsed.data.replaces ? null : likelyPreviousVersion({
      id: knowledgeId, company_id: companyId, title: parsed.data.title || path.parse(fileName).name, file_name: fileName
    });

    res.status(201).json({
      ok: true, knowledgeId, extractionOk, textLength: text.length,
      pending: Boolean(parsed.data.replaces),
      likelyVersionOf: likely ? { id: likely.id, title: likely.title } : null
    });
  }
);

knowledgeRouter.post("/companies/:companyId/knowledge/test", async (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = z.object({ question: z.string().trim().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita kysymys." });

  // Samat palat, jotka vastausehdotus saisi tähän kysymykseen.
  const selected = selectKnowledgeChunks(companyId, parsed.data.question);
  const chunks = selected.map(chunk => ({
    id: chunk.id, knowledgeId: chunk.knowledgeId, title: chunk.title, documentTitle: chunk.documentTitle,
    page: chunk.page, content: chunk.content, label: chunkSourceLabel(chunk)
  }));
  const [best] = selected;
  res.json(best
    ? { found: true, answer: best.content, source: { id: best.knowledgeId, title: best.documentTitle, chunkId: best.id, page: best.page }, chunks }
    : { found: false, chunks });
});

knowledgeRouter.put("/knowledge/:id/validity", requireManager, (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.status !== "active") return res.status(404).json({ error: "Knowledge not found" });

  const parsed = z.object({ validFrom: validityDate, validUntil: validityDate }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista päivämäärät." });
  if (parsed.data.validFrom && parsed.data.validUntil && parsed.data.validFrom > parsed.data.validUntil) {
    return res.status(400).json({ error: "Voimassaolon alku ei voi olla lopun jälkeen." });
  }

  db.prepare("UPDATE knowledge SET valid_from = ?, valid_until = ? WHERE id = ?").run(
    parsed.data.validFrom || null,
    parsed.data.validUntil || null,
    row.id
  );
  res.json({ ok: true });
});

// Siirtää tietueen AI-dokumentaation ja sisäisen dokumentaation välillä.
knowledgeRouter.put("/knowledge/:id/audience", requireManager, (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.status !== "active") return res.status(404).json({ error: "Knowledge not found" });

  const parsed = z.object({ audience: z.enum(KNOWLEDGE_AUDIENCES) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valitse, onko tietue AI:n vai vain henkilökunnan käytössä." });

  db.prepare("UPDATE knowledge SET audience = ? WHERE id = ?").run(parsed.data.audience, row.id);
  res.json({ ok: true });
});

// Siirtää tietueen toiselle taloyhtiölle. Mukana siirtyvät myös sen aiemmat versiot, jotta historia
// pysyy yhdessä. Käyttäjällä pitää olla oikeus molempiin taloyhtiöihin.
knowledgeRouter.put("/knowledge/:id/company", requireManager, (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.status !== "active") return res.status(404).json({ error: "Knowledge not found" });

  const parsed = z.object({ companyId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valitse taloyhtiö." });
  const companyId = companyIdFromContext(parsed.data.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  db.transaction(() => {
    db.prepare("UPDATE knowledge SET company_id = ? WHERE group_id = ?").run(companyId, row.group_id);
    db.prepare("UPDATE knowledge_chunks SET company_id = ? WHERE knowledge_id IN (SELECT id FROM knowledge WHERE group_id = ?)")
      .run(companyId, row.group_id);
  })();
  res.json({ ok: true });
});

knowledgeRouter.delete("/knowledge/:id", requireManager, (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  // Odottavan uuden version poisto = versio hylätään, ja edellinen jää voimaan.
  if (!row || (row.status !== "active" && row.status !== "pending")) return res.status(404).json({ error: "Knowledge not found" });

  // Tietue poistuu AI:n käytöstä, mutta jää historiaan.
  db.prepare("UPDATE knowledge SET status = 'deleted' WHERE id = ?").run(row.id);
  setChunksStatus(row.id, "deleted");
  res.json({ ok: true });
});

type PendingRow = KnowledgeRow & { comparison: string | null };

function pendingVersion(knowledgeId: string) {
  const row = getAuthorizedKnowledge(knowledgeId) as PendingRow | null;
  if (!row || row.status !== "pending") return null;
  const previous = previousVersion(row);
  return previous ? { row, previous } : null;
}

// Uuden version muutokset edelliseen: uudet, muuttuneet, poistuneet, ennallaan olevat ja ristiriidat.
knowledgeRouter.get("/knowledge/:id/comparison", async (req, res) => {
  const pending = pendingVersion(req.params.id);
  if (!pending) return res.status(404).json({ error: "Odottavaa versiota ei löytynyt." });
  const previous = { id: pending.previous.id, title: pending.previous.title, version: pending.previous.version };
  if (pending.row.processing_state === "processing") return res.json({ state: "processing", previous, items: [] });
  const { usedAi, items } = await compareVersions(pending.row, pending.previous);
  res.json({ state: "ready", previous, usedAi, items });
});

// Hyväksyy uuden version. decisions: muutoskohtaiset valinnat ("Käy läpi yksitellen"); ilman niitä
// muutokset hyväksytään, ja ristiriidoissa vanha tarkistettu tieto säilyy.
knowledgeRouter.post("/knowledge/:id/apply-version", requireManager, async (req, res) => {
  const pending = pendingVersion(req.params.id);
  if (!pending) return res.status(404).json({ error: "Odottavaa versiota ei löytynyt." });
  if (pending.row.processing_state === "processing") return res.status(409).json({ error: "Uutta versiota käsitellään vielä." });
  const parsed = z.object({ decisions: z.record(z.string(), z.enum(["accept", "reject"])).default({}) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Tarkista valinnat." });
  const { items } = await compareVersions(pending.row, pending.previous);
  applyVersion(pending.row, pending.previous, items, parsed.data.decisions);
  res.json({ ok: true, knowledgeId: pending.row.id });
});

// Merkitsee juuri ladatun dokumentin aiemman dokumentin uudeksi versioksi, joka odottaa hyväksyntää.
knowledgeRouter.post("/knowledge/:id/as-version-of", requireManager, (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.status !== "active" || row.kind !== "document" || row.group_id !== row.id) {
    return res.status(404).json({ error: "Knowledge not found" });
  }
  const parsed = z.object({ knowledgeId: z.string().min(1) }).safeParse(req.body);
  const target = parsed.success ? getAuthorizedKnowledge(parsed.data.knowledgeId) : null;
  if (!target || target.status !== "active" || target.kind !== "document" || target.company_id !== row.company_id || target.id === row.id) {
    return res.status(404).json({ error: "Aiempaa dokumenttia ei löytynyt." });
  }
  db.transaction(() => {
    const stale = db.prepare("SELECT id FROM knowledge WHERE group_id = ? AND status = 'pending'").all(target.group_id) as { id: string }[];
    for (const old of stale) {
      db.prepare("UPDATE knowledge SET status = 'deleted' WHERE id = ?").run(old.id);
      setChunksStatus(old.id, "deleted");
    }
    db.prepare("UPDATE knowledge SET status = 'pending', group_id = ?, version = ?, audience = ? WHERE id = ?")
      .run(target.group_id, target.version + 1, target.audience, row.id);
  })();
  res.json({ ok: true });
});

// Merkitse vanhentuneeksi: voimassaolo päättyy tänään.
knowledgeRouter.post("/knowledge/:id/expire", requireManager, (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.status !== "active") return res.status(404).json({ error: "Knowledge not found" });
  const date = today();
  db.prepare("UPDATE knowledge SET valid_until = ?, valid_from = CASE WHEN valid_from > ? THEN ? ELSE valid_from END WHERE id = ?")
    .run(date, date, date, row.id);
  res.json({ ok: true, validUntil: date });
});

knowledgeRouter.get("/knowledge/:id", (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row) return res.status(404).json({ error: "Knowledge not found" });

  const company = db.prepare("SELECT name FROM companies WHERE id = ?")
    .get(row.company_id) as { name: string } | undefined;
  const versions = db.prepare(
    "SELECT * FROM knowledge WHERE group_id = ? ORDER BY version DESC"
  ).all(row.group_id) as KnowledgeRow[];

  const { pages: _pages, comparison: _comparison, ...fields } = row as StoredKnowledgeRow;
  res.json({
    ...fields,
    // Ennen muotoilua tallennetuille dokumenteille muotoilu päätellään luetusta tekstistä.
    formatted: row.kind === "document" ? fields.formatted || plainToMarkdown(row.content) : fields.formatted || null,
    content_length: row.content.length,
    state: knowledgeState(row),
    company_name: company?.name ?? "",
    pending_version_id: row.status === "active" ? versions.find(version => version.status === "pending")?.id ?? null : null,
    versions: versions.map(serializeKnowledge)
  });
});

// Dokumentin tekstin muokkaus luo uuden version, joka odottaa hyväksyntää samoin kuin ladattu uusi versio:
// muutokset näytetään ennen kuin se korvaa nykyisen, ja isännöitsijän tarkistamat tiedot säilyvät.
knowledgeRouter.post("/knowledge/:id/text-version", requireManager, async (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id) as StoredKnowledgeRow | null;
  if (!row || row.status !== "active" || row.kind !== "document") return res.status(404).json({ error: "Knowledge not found" });
  const parsed = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    formatted: z.string().max(2_000_000)
  }).safeParse(req.body);
  const content = parsed.success ? markdownToPlain(parsed.data.formatted) : "";
  if (!parsed.success || !content) return res.status(400).json({ error: "Dokumentin teksti ei voi olla tyhjä." });
  const title = parsed.data.title ?? row.title;
  const previous = row.formatted || plainToMarkdown(row.content);
  if (parsed.data.formatted.trim() === previous.trim() && title === row.title) {
    return res.status(400).json({ error: "Tekstiin ei tehty muutoksia." });
  }

  const knowledgeId = saveKnowledge({
    companyId: row.company_id,
    kind: "document",
    title,
    content,
    validFrom: row.valid_from ?? "",
    validUntil: row.valid_until ?? "",
    replaces: row.id,
    fileName: row.file_name ?? undefined,
    mimeType: row.mime_type ?? undefined,
    // Muokatun tekstin sivujako ei enää vastaa alkuperäistä tiedostoa.
    pages: null,
    formatted: parsed.data.formatted.trim()
  });
  if (!knowledgeId) return res.status(404).json({ error: "Korvattavaa tietuetta ei löytynyt." });
  // Alkuperäinen tiedosto pysyy ladattavissa myös uudesta versiosta.
  await fs.copyFile(path.join(knowledgeFilesDir, row.id), path.join(knowledgeFilesDir, knowledgeId)).catch(() => undefined);
  void processDocument(knowledgeId);
  res.status(201).json({ ok: true, knowledgeId });
});

// Tietueen palat, eli mitä AI poimi dokumentista.
knowledgeRouter.get("/knowledge/:id/chunks", (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row) return res.status(404).json({ error: "Knowledge not found" });
  res.json(listChunks(row.id));
});

type ChunkRecord = { id: string; knowledge_id: string; company_id: string; status: string };

function getAuthorizedChunk(chunkId: string) {
  const row = db.prepare("SELECT id, knowledge_id, company_id, status FROM knowledge_chunks WHERE id = ?").get(chunkId) as ChunkRecord | undefined;
  return row && row.status === "active" && companyIdFromContext(row.company_id) ? row : null;
}

const chunkSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(5000),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([])
});

// Isännöitsijän muokkaama pala on hänen kirjoittamansa ja tarkistama: AI ei enää muuta sitä.
knowledgeRouter.put("/knowledge-chunks/:id", requireManager, (req, res) => {
  const chunk = getAuthorizedChunk(req.params.id);
  if (!chunk) return res.status(404).json({ error: "Tietoa ei löytynyt." });
  const parsed = chunkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita otsikko ja teksti." });
  db.prepare(`
    UPDATE knowledge_chunks SET title = ?, content = ?, tags = ?, origin = 'manual', verified = 1, needs_review = 0, updated_at = ?
    WHERE id = ?
  `).run(parsed.data.title, parsed.data.content, parsed.data.tags.join(", "), now(), chunk.id);
  res.json({ ok: true });
});

// Tarkistettu: isännöitsijä on lukenut AI:n poimiman tiedon ja todennut sen oikeaksi. Sisältö ei muutu.
knowledgeRouter.post("/knowledge-chunks/:id/verify", requireManager, (req, res) => {
  const chunk = getAuthorizedChunk(req.params.id);
  if (!chunk) return res.status(404).json({ error: "Tietoa ei löytynyt." });
  db.prepare("UPDATE knowledge_chunks SET verified = 1, needs_review = 0, updated_at = ? WHERE id = ?").run(now(), chunk.id);
  res.json({ ok: true });
});

knowledgeRouter.delete("/knowledge-chunks/:id", requireManager, (req, res) => {
  const chunk = getAuthorizedChunk(req.params.id);
  if (!chunk) return res.status(404).json({ error: "Tietoa ei löytynyt." });
  db.prepare("UPDATE knowledge_chunks SET status = 'deleted', updated_at = ? WHERE id = ?").run(now(), chunk.id);
  res.json({ ok: true });
});

// Lisää tieto -esikatselu: AI muotoilee isännöitsijän tekstin palaksi ja ehdottaa avainsanoja. Jos
// dokumentissa on jo samaa asiaa käsittelevä pala, ehdotetaan sen päivittämistä.
knowledgeRouter.post("/knowledge/:id/chunks/draft", requireManager, async (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.status !== "active") return res.status(404).json({ error: "Knowledge not found" });
  const parsed = z.object({ text: z.string().trim().min(1).max(5000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita lisättävä tieto." });

  let draft: { title: string; content: string; tags: string[] };
  let usedAi = true;
  try {
    draft = await formatKnowledgeEntry(parsed.data.text, row.title);
  } catch {
    usedAi = false;
    const firstLine = parsed.data.text.split(/[.!?\n]/)[0].trim();
    draft = { title: firstLine.slice(0, 80) || row.title, content: parsed.data.text, tags: [] };
  }
  const similar = findSimilarChunk(row.id, `${draft.title} ${draft.content} ${draft.tags.join(" ")}`);
  res.json({ ...draft, usedAi, similar: similar ? { id: similar.id, title: similar.title, content: similar.content } : null });
});

// Tallentaa esikatselussa hyväksytyn palan. replaceChunkId = päivitetään olemassa oleva pala.
knowledgeRouter.post("/knowledge/:id/chunks", requireManager, (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.status !== "active") return res.status(404).json({ error: "Knowledge not found" });
  const parsed = chunkSchema.extend({
    page: z.number().int().positive().nullable().optional(),
    // 'ai' = AI:n ehdotus, jonka isännöitsijä hyväksyi; 'manual' = isännöitsijän oma teksti.
    origin: z.enum(["ai", "manual"]).default("manual"),
    replaceChunkId: z.string().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita otsikko ja teksti." });

  if (parsed.data.replaceChunkId) {
    const chunk = getAuthorizedChunk(parsed.data.replaceChunkId);
    if (!chunk || chunk.knowledge_id !== row.id) return res.status(404).json({ error: "Tietoa ei löytynyt." });
    db.prepare(`
      UPDATE knowledge_chunks SET title = ?, content = ?, tags = ?, origin = 'manual', verified = 1, needs_review = 0, updated_at = ?
      WHERE id = ?
    `).run(parsed.data.title, parsed.data.content, parsed.data.tags.join(", "), now(), chunk.id);
    return res.json({ ok: true, chunkId: chunk.id });
  }

  const chunkId = insertChunk(row, {
    title: parsed.data.title,
    content: parsed.data.content,
    tags: parsed.data.tags.join(", "),
    page: parsed.data.page ?? null,
    origin: parsed.data.origin,
    verified: true,
    // AI:n ehdotuksessa keksitty luku jää näkyviin tarkistettavaksi, vaikka isännöitsijä hyväksyi sen.
    needsReview: parsed.data.origin === "ai" && hasUnknownNumbers(parsed.data.content, row.content)
  });
  res.status(201).json({ ok: true, chunkId });
});

// Jäikö jotain puuttumaan: AI lukee vain mainitut sivut uudelleen ja ehdottaa uusia paloja esikatseluun.
// Mitään ei tallenneta ennen kuin isännöitsijä hyväksyy ehdotukset.
knowledgeRouter.post("/knowledge/:id/chunks/missing", requireManager, async (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.status !== "active" || row.kind !== "document") return res.status(404).json({ error: "Knowledge not found" });
  const parsed = z.object({ note: z.string().trim().min(1).max(1000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kerro, mitä puuttuu." });

  const allPages = documentPages(row as KnowledgeRow & { pages: string | null }) ?? [row.content];
  const pageNumbers = allPages.length === 1 ? [1] : pagesInNote(parsed.data.note, allPages.length);
  if (!pageNumbers.length) {
    return res.status(400).json({ error: `Kerro, millä sivulla puuttuva tieto on (dokumentissa on ${allPages.length} sivua).` });
  }
  const selected = pageNumbers.slice(0, 5).map(page => ({ page, text: allPages[page - 1] ?? "" }));
  const existing = listChunks(row.id) as { title: string; content: string }[];
  const paged = allPages.length > 1;

  let usedAi = true;
  let proposals: { title: string; content: string; tags: string[]; page: number | null }[];
  try {
    proposals = (await chunkDocumentWithAi(row.title, selected, { note: parsed.data.note, existing: existing.map(chunk => chunk.title) }))
      .map(chunk => ({ title: chunk.title, content: chunk.content, tags: chunk.tags, page: paged ? chunk.page : null }));
  } catch {
    // Ilman AI:ta ehdotetaan mainittujen sivujen kappaleet, joita ei vielä ole tietoina.
    usedAi = false;
    const known = new Set(existing.map(chunk => chunk.content.replace(/\s+/g, " ").trim()));
    proposals = localChunks({ title: row.title, content: "", kind: "document" }, allPages)
      .filter(chunk => chunk.page && pageNumbers.includes(chunk.page) && !known.has(chunk.content))
      .map(chunk => ({ title: chunk.title, content: chunk.content, tags: [], page: paged ? chunk.page ?? null : null }));
  }
  res.json({
    usedAi,
    pages: pageNumbers.slice(0, 5),
    proposals: proposals.map(proposal => ({ ...proposal, needsReview: usedAi && hasUnknownNumbers(proposal.content, row.content) }))
  });
});

knowledgeRouter.get("/knowledge/:id/history", (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row) return res.status(404).json({ error: "Knowledge not found" });

  const versions = db.prepare(
    "SELECT * FROM knowledge WHERE group_id = ? ORDER BY version DESC"
  ).all(row.group_id) as KnowledgeRow[];
  res.json(versions.map(serializeKnowledge));
});

knowledgeRouter.get("/knowledge/:id/file", (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.kind !== "document" || !row.file_name) {
    return res.status(404).json({ error: "File not found" });
  }

  res.download(path.join(knowledgeFilesDir, row.id), row.file_name, {
    headers: { "Content-Type": "application/octet-stream" }
  });
});
