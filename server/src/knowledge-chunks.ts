import { aiAvailable, chunkDocumentWithAi, chunks, overlap, stems } from "./ai.js";
import { db } from "./db.js";
import { id, now, today } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Tietopalat. Jokainen tietopankin tietue pilkotaan aiheittaisiksi paloiksi, ja vastausehdotukseen
// valitaan vain kysymykseen osuvat palat. Haku on paikallinen sanavartalohaku (ei vektorikantaa).
// ---------------------------------------------------------------------------------------------

// Yhden palan enimmäispituus AI:lle lähetettäessä.
export const CHUNK_PROMPT_LIMIT = 1500;

export type KnowledgeChunk = {
  id: string;
  knowledgeId: string;
  title: string;
  // Dokumentin tai vakiotiedon otsikko, josta pala on.
  documentTitle: string;
  content: string;
  page: number | null;
  tags: string;
  kind: string;
  origin: string;
  verified: boolean;
  needsReview: boolean;
};

export type ChunkInput = {
  title: string;
  content: string;
  page?: number | null;
  tags?: string;
  origin: "ai" | "local" | "manual";
  verified?: boolean;
  needsReview?: boolean;
  suggestedValidUntil?: string | null;
};

type KnowledgeSource = { id: string; company_id: string; title: string; content: string; kind: string; status: string };

// Kappaleen otsikoksi sen ensimmäinen virke lyhennettynä, jotta palat erottuvat toisistaan listassa.
export function previewTitle(content: string) {
  const sentence = content.split(/(?<=[.!?])\s/)[0].trim();
  return sentence.length <= 70 ? sentence.replace(/[.!?]$/, "") : `${sentence.slice(0, 67).replace(/\s+\S*$/, "")}…`;
}

// Paikallinen pilkonta: dokumentti kappaleittain, vakiotieto yhtenä palana. Vakiotiedon on kirjoittanut
// isännöitsijä, joten se on valmiiksi tarkistettu. PDF:n sivut (pages) pilkotaan sivu kerrallaan, jotta
// jokainen pala saa sivunumeronsa.
export function localChunks(row: Pick<KnowledgeSource, "title" | "content" | "kind">, pages?: string[] | null): ChunkInput[] {
  if (row.kind !== "document") {
    return row.content.trim() ? [{ title: row.title, content: row.content.trim(), origin: "manual", verified: true }] : [];
  }
  if (pages?.length) {
    return pages.flatMap((page, index) =>
      chunks(page).map(content => ({ title: previewTitle(content), content, page: index + 1, origin: "local" as const })));
  }
  return chunks(row.content).map(content => ({ title: previewTitle(content), content, origin: "local" }));
}

// Numerot (hinnat, päivämäärät, kellonajat, puhelinnumerot) palan tekstistä.
function numbersIn(text: string) {
  return text.match(/\d+/g) ?? [];
}

// AI:n palassa jokaisen numeron pitää löytyä alkuperäisestä tekstistä. Muuten pala merkitään
// tarkistettavaksi, koska AI on voinut muuttaa tai keksiä luvun.
export function hasUnknownNumbers(content: string, source: string) {
  const known = new Set(numbersIn(source));
  return numbersIn(content).some(number => !known.has(number));
}

type DocumentRow = KnowledgeSource & { pages: string | null; extraction_ok: number };

export function documentPages(row: Pick<DocumentRow, "pages">): string[] | null {
  if (!row.pages) return null;
  try {
    const pages = JSON.parse(row.pages);
    return Array.isArray(pages) ? pages.map(String) : null;
  } catch {
    return null;
  }
}

const runningDocuments = new Set<string>();

// Pilkkoo dokumentin taustalla. Paikalliset palat ovat käytössä heti; kun AI on käytössä, ne korvataan
// AI:n pilkkomilla paloilla. Jos AI ei ole käytössä tai kutsu epäonnistuu, paikalliset palat jäävät.
export async function processDocument(knowledgeId: string) {
  if (runningDocuments.has(knowledgeId)) return;
  const row = db.prepare("SELECT id, company_id, title, content, kind, status, pages, extraction_ok FROM knowledge WHERE id = ?")
    .get(knowledgeId) as DocumentRow | undefined;
  if (!row || row.kind !== "document") return;
  const setState = (state: "processing" | "ready" | "failed") =>
    db.prepare("UPDATE knowledge SET processing_state = ? WHERE id = ?").run(state, knowledgeId);
  if (!row.extraction_ok || !row.content.trim()) {
    setState("failed");
    return;
  }
  if (!aiAvailable()) {
    setState("ready");
    return;
  }

  runningDocuments.add(knowledgeId);
  setState("processing");
  try {
    const pages = documentPages(row);
    const aiChunks = await chunkDocumentWithAi(row.title, (pages ?? [row.content]).map((text, index) => ({ page: index + 1, text })));
    // Tietue on voinut muuttua käsittelyn aikana (korvattu tai poistettu); palat saavat sen tilan.
    const current = db.prepare("SELECT status FROM knowledge WHERE id = ?").get(knowledgeId) as { status: string } | undefined;
    if (!current) return;
    saveChunks({ id: row.id, company_id: row.company_id, status: current.status }, aiChunks.map(chunk => ({
      title: chunk.title,
      content: chunk.content,
      // Muiden kuin PDF-dokumenttien sivunumero ei kerro mitään.
      page: pages ? chunk.page : null,
      tags: chunk.tags.join(", "),
      origin: "ai" as const,
      needsReview: hasUnknownNumbers(chunk.content, row.content),
      suggestedValidUntil: chunk.validUntil
    })));
  } catch (error) {
    console.error("Dokumentin pilkonta AI:lla epäonnistui, käytetään kappalejakoa:", error instanceof Error ? error.message : error);
  } finally {
    runningDocuments.delete(knowledgeId);
    setState("ready");
  }
}

// Käynnistyksessä kesken jääneet pilkonnat aloitetaan uudelleen.
export function resumeDocumentProcessing() {
  const rows = db.prepare("SELECT id FROM knowledge WHERE processing_state = 'processing' AND status = 'active'").all() as { id: string }[];
  for (const row of rows) void processDocument(row.id);
}

// Tallentaa tietueen palat. Aiemmat aktiiviset palat arkistoidaan, paitsi isännöitsijän tarkistamat ja
// kirjoittamat: niitä AI tai uusi pilkonta ei koskaan korvaa.
export function saveChunks(knowledge: Pick<KnowledgeSource, "id" | "company_id" | "status">, items: ChunkInput[]) {
  const timestamp = now();
  const insert = db.prepare(`
    INSERT INTO knowledge_chunks
      (id, knowledge_id, company_id, title, content, page, tags, origin, verified, needs_review, status, position,
       created_at, updated_at, suggested_valid_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Vanhan version palat jäävät historiaan arkistoituina.
  const status = knowledge.status === "active" ? "active" : knowledge.status === "deleted" ? "deleted" : "archived";
  db.transaction(() => {
    db.prepare(`
      UPDATE knowledge_chunks SET status = 'archived', updated_at = ?
      WHERE knowledge_id = ? AND status = 'active' AND verified = 0 AND origin != 'manual'
    `)
      .run(timestamp, knowledge.id);
    items.forEach((item, position) => insert.run(
      id("chunk"), knowledge.id, knowledge.company_id, item.title.trim() || "Nimetön", item.content.trim(),
      item.page ?? null, item.tags ?? "", item.origin, item.verified ? 1 : 0, item.needsReview ? 1 : 0,
      status, position, timestamp, timestamp, item.suggestedValidUntil ?? null
    ));
  })();
}

// Merkitsee tietueen palat tietueen tilan mukaisiksi (korvattu → arkistoitu, poistettu → poistettu).
export function setChunksStatus(knowledgeId: string, status: "active" | "archived" | "deleted") {
  db.prepare("UPDATE knowledge_chunks SET status = ?, updated_at = ? WHERE knowledge_id = ? AND status != 'deleted'")
    .run(status, now(), knowledgeId);
}

// Kertaluonteinen siirto: tietueet, joilla ei vielä ole paloja, pilkotaan paikallisesti.
export function migrateKnowledgeChunks() {
  const rows = db.prepare(`
    SELECT k.id, k.company_id, k.title, k.content, k.kind, k.status FROM knowledge k
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.knowledge_id = k.id)
  `).all() as KnowledgeSource[];
  for (const row of rows) saveChunks(row, localChunks(row));
}

type ChunkRow = {
  id: string; knowledge_id: string; title: string; content: string; page: number | null; tags: string;
  origin: string; verified: number; needs_review: number; document_title: string; document_tags: string; kind: string;
};

function toChunk(row: ChunkRow): KnowledgeChunk {
  return {
    id: row.id,
    knowledgeId: row.knowledge_id,
    title: row.title,
    documentTitle: row.document_title,
    content: row.content.slice(0, CHUNK_PROMPT_LIMIT),
    page: row.page,
    tags: [row.tags, row.document_tags].filter(Boolean).join(", "),
    kind: row.kind,
    origin: row.origin,
    verified: row.verified === 1,
    needsReview: row.needs_review === 1
  };
}

// Pisteyttää palan kysymystä vasten samoin säännöin kuin aiempi tietuehaku: avainsana tai pitkä
// otsikkosana riittää yksinään, muuten tarvitaan vähintään kaksi eri osumaa.
function scoreChunk(query: Set<string>, chunk: KnowledgeChunk): number | null {
  const tagStems = [...stems(chunk.tags)];
  const tagHits = [...query].filter(word => tagStems.some(tag => word.startsWith(tag) || tag.startsWith(word)));
  // Kappalejaon palan otsikko on sen oma ensimmäinen virke, joten se ei ole otsikko-osuma.
  const titleText = chunk.origin === "local" ? chunk.documentTitle : `${chunk.title} ${chunk.documentTitle}`;
  const titleHits = [...new Set([...overlap(query, titleText), ...tagHits])];
  const contentHits = overlap(query, chunk.content);
  const distinct = new Set([...titleHits, ...contentHits]);
  const strongTitleHit = tagHits.length > 0 || titleHits.some(word => word.length >= 7);

  if (distinct.size < 2 && !strongTitleHit) return null;
  // Dokumentin palassa itse tekstin tai avainsanan pitää osua; pelkkä dokumentin nimi ei riitä.
  if (chunk.kind === "document" && contentHits.length === 0 && tagHits.length === 0) return null;
  return titleHits.length * 2 + contentHits.length;
}

// Valitsee kysymykseen parhaiten osuvat palat yhtiön AI:n käytössä olevasta dokumentaatiosta.
// Mukana ovat vain aktiiviset, voimassa olevat, luettavat AI-dokumentaation palat. Tyhjä lista = ei osumia;
// koko tietopankkia ei koskaan palauteta.
export function selectKnowledgeChunks(companyId: string, question: string, limit = 5): KnowledgeChunk[] {
  const query = stems(question);
  if (query.size === 0 || limit <= 0) return [];
  const date = today();
  const rows = db.prepare(`
    SELECT c.id, c.knowledge_id, c.title, c.content, c.page, c.tags, c.origin, c.verified, c.needs_review,
           k.title AS document_title, k.tags AS document_tags, k.kind
    FROM knowledge_chunks c
    JOIN knowledge k ON k.id = c.knowledge_id
    WHERE c.company_id = ? AND k.company_id = ?
      AND c.status = 'active'
      AND k.status = 'active'
      AND k.audience = 'ai'
      AND k.extraction_ok = 1
      AND (k.valid_from IS NULL OR k.valid_from <= ?)
      AND (k.valid_until IS NULL OR k.valid_until >= ?)
    ORDER BY k.title, c.position
  `).all(companyId, companyId, date, date) as ChunkRow[];

  return rows
    .map(toChunk)
    .map(chunk => ({ chunk, score: scoreChunk(query, chunk) }))
    .filter((entry): entry is { chunk: KnowledgeChunk; score: number } => entry.score !== null)
    // Vakaa järjestys: tasapisteissä tietopankin järjestys.
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.chunk);
}

// Palan lähde käyttäjälle ja AI:lle: "Järjestyssäännöt, s. 3".
export function chunkSourceLabel(chunk: Pick<KnowledgeChunk, "documentTitle" | "page">) {
  return chunk.page ? `${chunk.documentTitle}, s. ${chunk.page}` : chunk.documentTitle;
}

// Tietueen aktiiviset palat käyttöliittymälle järjestyksessä.
export function listChunks(knowledgeId: string) {
  return db.prepare(`
    SELECT id, knowledge_id, title, content, page, tags, origin, verified, needs_review, suggested_valid_until,
           position, created_at, updated_at
    FROM knowledge_chunks WHERE knowledge_id = ? AND status = 'active'
    ORDER BY COALESCE(page, 0), position
  `).all(knowledgeId);
}

// Lisää tietueelle yhden palan listan loppuun (isännöitsijän lisäämä tai hyväksymä).
export function insertChunk(knowledge: { id: string; company_id: string }, item: ChunkInput) {
  const chunkId = id("chunk");
  const timestamp = now();
  const { position } = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM knowledge_chunks WHERE knowledge_id = ?")
    .get(knowledge.id) as { position: number };
  db.prepare(`
    INSERT INTO knowledge_chunks
      (id, knowledge_id, company_id, title, content, page, tags, origin, verified, needs_review, status, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    chunkId, knowledge.id, knowledge.company_id, item.title.trim() || "Nimetön", item.content.trim(), item.page ?? null,
    item.tags ?? "", item.origin, item.verified ? 1 : 0, item.needsReview ? 1 : 0, position, timestamp, timestamp
  );
  return chunkId;
}

// Tietueen pala, joka käsittelee samaa asiaa kuin annettu teksti, tai null.
export function findSimilarChunk(knowledgeId: string, text: string) {
  const query = stems(text);
  if (query.size === 0) return null;
  const rows = db.prepare(`
    SELECT c.id, c.knowledge_id, c.title, c.content, c.page, c.tags, c.origin, c.verified, c.needs_review,
           k.title AS document_title, '' AS document_tags, k.kind
    FROM knowledge_chunks c JOIN knowledge k ON k.id = c.knowledge_id
    WHERE c.knowledge_id = ? AND c.status = 'active'
  `).all(knowledgeId) as ChunkRow[];
  let best: { chunk: KnowledgeChunk; score: number } | null = null;
  for (const row of rows) {
    const chunk = toChunk(row);
    // Dokumentin nimi ei tee palasta samankaltaista, koska kaikki palat ovat samasta dokumentista.
    const score = scoreChunk(query, { ...chunk, documentTitle: "" });
    if (score !== null && score >= 3 && (!best || score > best.score)) best = { chunk, score };
  }
  return best?.chunk ?? null;
}

// Sivunumerot isännöitsijän huomiosta: "sivulta 7", "s. 3–4", "sivut 2 ja 5".
export function pagesInNote(note: string, pageCount: number) {
  const pages = new Set<number>();
  for (const match of note.matchAll(/(?:\bs\.|\bsivu\w*)\s*(\d+)(?:\s*(?:[–-]|ja|,)\s*(\d+))?/gi)) {
    const first = Number(match[1]);
    const last = match[2] ? Number(match[2]) : first;
    for (let page = Math.min(first, last); page <= Math.max(first, last) && page - Math.min(first, last) < 10; page++) {
      if (page >= 1 && page <= pageCount) pages.add(page);
    }
  }
  return [...pages].sort((a, b) => a - b);
}
