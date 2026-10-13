import fs from "node:fs/promises";
import path from "node:path";
import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { answerFromKnowledge, type KnowledgeItem } from "../ai.js";
import { requireManager } from "../auth.js";
import { db, knowledgeFilesDir } from "../db.js";
import { extractText, UnsupportedDocumentError } from "../extract.js";
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
};

function knowledgeState(row: KnowledgeRow) {
  const date = today();
  if (row.status !== "active") return row.status;
  if (!row.extraction_ok) return "unreadable";
  if (row.valid_until && row.valid_until < date) return "expired";
  if (row.valid_from && row.valid_from > date) return "upcoming";
  return row.audience === "internal" ? "internal" : "in_use";
}

function serializeKnowledge(row: KnowledgeRow) {
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

  const knowledgeId = id("knowledge");
  db.transaction(() => {
    if (replaced) {
      db.prepare("UPDATE knowledge SET status = 'replaced' WHERE id = ?").run(replaced.id);
    }
    db.prepare(`
      INSERT INTO knowledge
      (id, company_id, title, content, kind, valid_from, valid_until, file_name, mime_type,
       version, group_id, status, extraction_ok, created_at, audience)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
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
      input.extractionOk === false ? 0 : 1,
      now(),
      input.audience ?? replaced?.audience ?? "ai"
    );
    // Uusi versio perii aiemman version avainsanat, ellei uusia anneta.
    const tags = input.tags ? input.tags.join(", ") : replaced ? (replaced as KnowledgeRow & { tags?: string }).tags ?? "" : "";
    if (tags) db.prepare("UPDATE knowledge SET tags = ? WHERE id = ?").run(tags, knowledgeId);
  })();

  return knowledgeId;
}

knowledgeRouter.get("/companies/:companyId/knowledge", (req, res) => {
  if (!companyIdFromContext(req.params.companyId)) {
    return res.status(403).json({ error: "Company not authorized" });
  }
  const rows = db.prepare(
    "SELECT * FROM knowledge WHERE company_id = ? AND status = 'active' ORDER BY title"
  ).all(req.params.companyId) as KnowledgeRow[];
  res.json(rows.map(serializeKnowledge));
});

knowledgeRouter.post("/companies/:companyId/knowledge/facts", requireManager, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const schema = z.object({
    question: z.string().trim().min(1),
    answer: z.string().trim().min(1),
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
    content: parsed.data.answer,
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
    let extractionOk: boolean;
    try {
      text = await extractText(req.body, fileName, parsed.data.mimeType);
      extractionOk = text.length > 0;
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
      audience: parsed.data.audience
    });
    if (!knowledgeId) return res.status(404).json({ error: "Korvattavaa tietuetta ei löytynyt." });

    await fs.writeFile(path.join(knowledgeFilesDir, knowledgeId), req.body);

    res.status(201).json({ ok: true, knowledgeId, extractionOk, textLength: text.length });
  }
);

knowledgeRouter.post("/companies/:companyId/knowledge/test", async (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = z.object({ question: z.string().trim().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita kysymys." });

  const answer = await answerFromKnowledge(parsed.data.question, getKnowledge(companyId));
  res.json(answer
    ? { found: true, answer: answer.answer, source: { id: answer.sourceId, title: answer.sourceTitle } }
    : { found: false });
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

knowledgeRouter.delete("/knowledge/:id", requireManager, (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row || row.status !== "active") return res.status(404).json({ error: "Knowledge not found" });

  // Tietue poistuu AI:n käytöstä, mutta jää historiaan.
  db.prepare("UPDATE knowledge SET status = 'deleted' WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

knowledgeRouter.get("/knowledge/:id", (req, res) => {
  const row = getAuthorizedKnowledge(req.params.id);
  if (!row) return res.status(404).json({ error: "Knowledge not found" });

  const company = db.prepare("SELECT name FROM companies WHERE id = ?")
    .get(row.company_id) as { name: string } | undefined;
  const versions = db.prepare(
    "SELECT * FROM knowledge WHERE group_id = ? ORDER BY version DESC"
  ).all(row.group_id) as KnowledgeRow[];

  res.json({
    ...row,
    content_length: row.content.length,
    state: knowledgeState(row),
    company_name: company?.name ?? "",
    versions: versions.map(serializeKnowledge)
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
