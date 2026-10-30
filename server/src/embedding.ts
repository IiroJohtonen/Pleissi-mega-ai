import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { dataDir, db } from "./db.js";
import { getMasterData } from "./master-data.js";
import { maskPersonalData } from "./privacy-filter.js";
import { id, now, today } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Merkityshaku (embedding). Teksti muutetaan paikallisella mallilla vektoriksi, jota verrataan kysymyksen
// vektoriin. Malli ajetaan tässä Node-prosessissa (Transformers.js, ONNX), ja vektorit ovat SQLitessä:
// hakuindeksi on sqlite-vec-laajennuksen vec0-taulu, ja jos laajennus ei lataudu, vektoreita verrataan
// muistissa. Teksti ei lähde palvelimelta.
//
// Vektoroitavat lähteet: dokumentaatiopalat (vain AI:n dokumentaatio), ratkaistut tehtävät ja hyväksytyt
// muistitiedot. Vektori on henkilötietoa, joten se poistetaan samoissa tilanteissa kuin lähdeteksti
// (pala arkistoidaan, tehtävä merkitään arkaluonteiseksi, asukkaan tiedot poistetaan) ja haku rajataan aina
// taloyhtiöön.
//
// Käyttö on pois päältä, kunnes pääkäyttäjä kytkee sen perustiedoista (taloyhtiökohtaisesti ohitettavissa).
// EMBEDDING_ENABLED=false on hätäkatkaisin: vektoreita ei lasketa eikä käytetä, asetuksista riippumatta.
// ---------------------------------------------------------------------------------------------

export type SourceType = "chunk" | "ticket" | "memory";
export type EmbeddingFeature = "similarTickets" | "hybridKnowledge";
export type Embedder = (texts: string[], kind: "query" | "passage") => Promise<number[][]>;

const DEFAULT_MODEL = "Xenova/multilingual-e5-small";
// Kevyt deterministinen sanatiivisteisiin perustuva vektori ilman mallia: testeihin ja kehitykseen, kun
// mallia ei voi ladata. Ei ymmärrä merkitystä.
export const HASH_MODEL = "hash";
const HASH_DIMENSIONS = 384;

export function embeddingModel() {
  return (process.env.EMBEDDING_MODEL ?? "").trim() || DEFAULT_MODEL;
}

// Mallin versio lukitaan Hugging Facen commit-tunnisteeseen, jotta sama nimi tuottaa aina samat vektorit.
// EMBEDDING_MODEL_REVISION ohittaa oletuksen; muun kuin oletusmallin versio on "main", ellei sitä anneta.
const DEFAULT_MODEL_REVISION = "3acb1fa45c83e69002b1641b37f3cccc132cdd63";
export function embeddingRevision() {
  return (process.env.EMBEDDING_MODEL_REVISION ?? "").trim() || (embeddingModel() === DEFAULT_MODEL ? DEFAULT_MODEL_REVISION : "main");
}

// Malli ja versio, joilla vektori on laskettu (embeddings.model). Versiomuutos laskee vektorit uudelleen.
export function embeddingModelKey() {
  return embeddingModel() === HASH_MODEL ? HASH_MODEL : `${embeddingModel()}@${embeddingRevision()}`;
}

function modelDir() {
  return (process.env.EMBEDDING_MODEL_DIR ?? "").trim() || path.join(dataDir, "models");
}

// Hätäkatkaisin ohittaa kaikki asetukset.
export function embeddingKilled() {
  return (process.env.EMBEDDING_ENABLED ?? "").trim().toLowerCase() === "false";
}

// Vektorin vähimmäissamankaltaisuus (kosini), jotta haku ei palauta mitään, kun mikään ei oikeasti vastaa.
// Oletus 0,8 sopii e5-malleille, joiden samankaltaisuudet ovat yleensä 0,7–0,9; säädetään evaluoinnin mukaan.
export function minSimilarity() {
  const raw = (process.env.EMBEDDING_MIN_SIMILARITY ?? "").trim();
  const value = Number(raw);
  if (raw && Number.isFinite(value) && value > -1 && value < 1) return value;
  return embeddingModel() === HASH_MODEL ? 0.2 : 0.8;
}

// --- Asetukset --------------------------------------------------------------------------------------

type CompanyOverride = { embedding_similar_tickets: number | null; embedding_hybrid_knowledge: number | null };
const COLUMN: Record<EmbeddingFeature, keyof CompanyOverride> = {
  similarTickets: "embedding_similar_tickets",
  hybridKnowledge: "embedding_hybrid_knowledge"
};

// Onko toiminto käytössä taloyhtiössä: hätäkatkaisin → taloyhtiön ohitus → perustiedot (oletus pois).
export function embeddingEnabled(companyId: string, feature: EmbeddingFeature): boolean {
  if (embeddingKilled()) return false;
  const row = db.prepare("SELECT embedding_similar_tickets, embedding_hybrid_knowledge FROM companies WHERE id = ?")
    .get(companyId) as CompanyOverride | undefined;
  const override = row?.[COLUMN[feature]];
  if (override === 0 || override === 1) return override === 1;
  return getMasterData().embedding[feature];
}

// Taloyhtiöt, joissa toiminto on käytössä.
function companiesWith(feature: EmbeddingFeature): string[] {
  if (embeddingKilled()) return [];
  const fallback = getMasterData().embedding[feature] ? 1 : 0;
  return (db.prepare(`SELECT id FROM companies WHERE COALESCE(${COLUMN[feature]}, ?) = 1`).all(fallback) as { id: string }[])
    .map(row => row.id);
}

export function setCompanyOverride(companyId: string, feature: EmbeddingFeature, value: boolean | null) {
  db.prepare(`UPDATE companies SET ${COLUMN[feature]} = ? WHERE id = ?`).run(value === null ? null : value ? 1 : 0, companyId);
}

// --- Malli ---------------------------------------------------------------------------------------------

let testEmbedder: Embedder | null = null;
// Testit korvaavat mallin deterministisellä toteutuksella, jotta mitään ei ladata.
export function setEmbedderForTests(embedder: Embedder | null) {
  testEmbedder = embedder;
}

function hashVector(text: string): number[] {
  const vector = new Array<number>(HASH_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-zåäö0-9]+/g) ?? []) {
    const token = word.slice(0, 6);
    const digest = crypto.createHash("sha256").update(token).digest();
    vector[digest.readUInt16BE(0) % HASH_DIMENSIONS] += digest[2] & 1 ? 1 : -1;
  }
  return normalize(vector);
}

function normalize(vector: number[]) {
  const length = Math.hypot(...vector) || 1;
  return vector.map(value => value / length);
}

// e5-mallit odottavat etuliitettä: "query: " kysymykselle ja "passage: " tallennettavalle tekstille.
function withPrefix(text: string, kind: "query" | "passage") {
  return /e5/i.test(embeddingModel()) ? `${kind}: ${text}` : text;
}

type Extractor = (texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let extractor: Promise<Extractor> | null = null;

export type ModelStatus = { model: string; loaded: boolean; loadMs: number | null; memoryMb: number | null; error: string | null };
const modelStatus: ModelStatus = { model: embeddingModelKey(), loaded: false, loadMs: null, memoryMb: null, error: null };

// Ladataan ensimmäisellä käytöllä tai käynnistyksessä (preloadModel). Malli luetaan kansiosta
// EMBEDDING_MODEL_DIR (oletus DATA_DIR/models), johon se tallentuu version mukaan (<malli>/<versio>/).
// EMBEDDING_ALLOW_DOWNLOAD=false estää latauksen Hugging Facesta: malli ladataan silloin ensin komennolla
// embeddings:download. allowDownload ohittaa asetuksen (latauskomento).
function loadExtractor(allowDownload?: boolean): Promise<Extractor> {
  extractor ??= (async () => {
    const started = Date.now();
    const rssBefore = process.memoryUsage().rss;
    try {
      const transformers = await import("@huggingface/transformers");
      transformers.env.cacheDir = modelDir();
      transformers.env.useFSCache = true;
      // Vain versioitu välimuisti: kansioon käsin kopioitu versioimaton malli ohittaisi lukitun version.
      transformers.env.allowLocalModels = false;
      transformers.env.allowRemoteModels = allowDownload ?? (process.env.EMBEDDING_ALLOW_DOWNLOAD ?? "").trim().toLowerCase() !== "false";
      const pipeline = await transformers.pipeline("feature-extraction", embeddingModel(), { dtype: "q8", revision: embeddingRevision() });
      Object.assign(modelStatus, {
        loaded: true, error: null, loadMs: Date.now() - started,
        memoryMb: Math.round((process.memoryUsage().rss - rssBefore) / 1024 / 1024)
      });
      console.log(`Merkityshaku: malli ${embeddingModelKey()} ladattu (${modelStatus.loadMs} ms, +${modelStatus.memoryMb} Mt muistia).`);
      return pipeline as unknown as Extractor;
    } catch (error: any) {
      extractor = null;
      modelStatus.error = String(error?.message ?? error);
      throw error;
    }
  })();
  return extractor;
}

export async function embed(texts: string[], kind: "query" | "passage"): Promise<number[][]> {
  if (!texts.length) return [];
  if (testEmbedder) return testEmbedder(texts, kind);
  if (embeddingModel() === HASH_MODEL) return texts.map(hashVector);
  const pipeline = await loadExtractor();
  const output = await pipeline(texts.map(text => withPrefix(text, kind)), { pooling: "mean", normalize: true });
  return output.tolist();
}

export function getModelStatus(): ModelStatus {
  return { ...modelStatus, model: embeddingModelKey() };
}

// Lataa mallin kansioon EMBEDDING_MODEL_DIR Hugging Facesta (komento embeddings:download) ja tarkistaa,
// että se tuottaa vektorin. Palauttaa kansion ja vektorin ulottuvuuden.
export async function downloadModel() {
  if (embeddingModel() === HASH_MODEL) throw new Error("Hash-mallia ei ladata.");
  const pipeline = await loadExtractor(true);
  const output = await pipeline([withPrefix("testi", "query")], { pooling: "mean", normalize: true });
  return { dir: modelDir(), dimensions: output.tolist()[0].length };
}

// Lataa mallin taustalla käynnistyksessä, kun merkityshaku on käytössä jossain taloyhtiössä, jotta
// ensimmäinen haku ei odota latausta. Virhe kirjataan; palvelin toimii sanahaulla.
export function preloadModel() {
  if (testEmbedder || embeddingModel() === HASH_MODEL) return;
  if (!companiesWith("similarTickets").length && !companiesWith("hybridKnowledge").length) return;
  loadExtractor().catch(error => console.error("Merkityshaun mallin lataus epäonnistui:", error?.message ?? error));
}

// --- Tallennus ja indeksi ------------------------------------------------------------------------------

// sqlite-vec ladataan tähän tietokantayhteyteen. EMBEDDING_SQLITE_VEC=false käyttää aina muistivertailua.
let vecAvailable = false;
if ((process.env.EMBEDDING_SQLITE_VEC ?? "").trim().toLowerCase() !== "false") {
  try {
    createRequire(import.meta.url)("sqlite-vec").load(db);
    vecAvailable = true;
  } catch (error: any) {
    console.error("Merkityshaku: sqlite-vec ei latautunut, vektoreita verrataan muistissa:", error?.message ?? error);
  }
}

export function vectorBackend() {
  return vecAvailable ? "sqlite-vec" : "memory";
}

// Hakuindeksin ulottuvuus luodaan ensimmäisestä vektorista. Jos malli vaihtuu toisen kokoiseen, indeksi
// luodaan uudelleen ja vanhan mallin vektorit poistetaan (ne lasketaan taustalla uudelleen).
function ensureVecTable(dimensions: number) {
  if (!vecAvailable) return;
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_embeddings'").get() as { sql: string } | undefined;
  if (existing?.sql.includes(`float[${dimensions}]`)) return;
  db.transaction(() => {
    if (existing) db.exec("DROP TABLE vec_embeddings");
    db.prepare("DELETE FROM embeddings WHERE dimensions != ?").run(dimensions);
    db.exec(`CREATE VIRTUAL TABLE vec_embeddings USING vec0(
      embedding float[${dimensions}] distance_metric=cosine, company_id text partition key, source_type text)`);
    const insert = db.prepare("INSERT INTO vec_embeddings (rowid, embedding, company_id, source_type) VALUES (?, ?, ?, ?)");
    for (const row of db.prepare("SELECT rowid, vector, company_id, source_type FROM embeddings").iterate() as Iterable<VectorRow>) {
      insert.run(BigInt(row.rowid), row.vector, row.company_id, row.source_type);
    }
  })();
}

type VectorRow = { rowid: number; vector: Buffer; company_id: string; source_type: string };

const toBlob = (vector: number[]) => Buffer.from(new Float32Array(vector).buffer);
const fromBlob = (blob: Buffer) => new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);

export function textHash(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// Poistaa lähteen vektorin. Synkroninen, jotta sen voi ajaa samassa transaktiossa kuin lähteen muutoksen.
export function deleteEmbedding(sourceType: SourceType, sourceId: string) {
  const row = db.prepare("SELECT rowid FROM embeddings WHERE source_type = ? AND source_id = ?").get(sourceType, sourceId) as { rowid: number } | undefined;
  if (!row) return;
  if (vecAvailable && hasVecTable()) db.prepare("DELETE FROM vec_embeddings WHERE rowid = ?").run(BigInt(row.rowid));
  db.prepare("DELETE FROM embeddings WHERE rowid = ?").run(row.rowid);
}

// Tietueen kaikkien palojen vektorit, joiden pala ei ole enää aktiivinen.
export function deleteInactiveChunkEmbeddings(knowledgeId: string) {
  const rows = db.prepare(`
    SELECT e.source_id FROM embeddings e JOIN knowledge_chunks c ON c.id = e.source_id
    WHERE e.source_type = 'chunk' AND c.knowledge_id = ? AND c.status != 'active'
  `).all(knowledgeId) as { source_id: string }[];
  for (const row of rows) deleteEmbedding("chunk", row.source_id);
}

const hasVecTable = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'vec_embeddings'").get());

function storeEmbedding(companyId: string, sourceType: SourceType, sourceId: string, hash: string, vector: number[]) {
  ensureVecTable(vector.length);
  db.transaction(() => {
    deleteEmbedding(sourceType, sourceId);
    const blob = toBlob(vector);
    const result = db.prepare(`
      INSERT INTO embeddings (id, company_id, source_type, source_id, model, text_hash, dimensions, vector, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id("emb"), companyId, sourceType, sourceId, embeddingModelKey(), hash, vector.length, blob, now());
    if (vecAvailable) {
      db.prepare("INSERT INTO vec_embeddings (rowid, embedding, company_id, source_type) VALUES (?, ?, ?, ?)")
        .run(BigInt(result.lastInsertRowid), blob, companyId, sourceType);
    }
  })();
}

function upToDate(sourceType: SourceType, sourceId: string, hash: string) {
  return Boolean(db.prepare("SELECT 1 FROM embeddings WHERE source_type = ? AND source_id = ? AND model = ? AND text_hash = ?")
    .get(sourceType, sourceId, embeddingModelKey(), hash));
}

// Laskee ja tallentaa lähteen vektorin, ellei sama teksti ole jo vektoroitu samalla mallilla.
// stillValid tarkistetaan laskennan jälkeen: lähde on voinut muuttua tai poistua laskennan aikana.
export async function upsertEmbedding(companyId: string, sourceType: SourceType, sourceId: string, text: string, stillValid: () => boolean = () => true) {
  const hash = textHash(text);
  if (upToDate(sourceType, sourceId, hash)) return false;
  const [vector] = await embed([text], "passage");
  if (!stillValid()) return false;
  storeEmbedding(companyId, sourceType, sourceId, hash, vector);
  return true;
}

export type SimilarSource = { sourceId: string; similarity: number };

// Kysymykseen lähimmät lähteet yhden taloyhtiön vektoreista, samankaltaisimmasta alkaen. Rajaus
// taloyhtiöön ja lähdetyyppiin tehdään ennen vertailua.
export async function searchSimilar(companyId: string, sourceType: SourceType, text: string, k: number, threshold = minSimilarity()): Promise<SimilarSource[]> {
  if (!text.trim() || k <= 0) return [];
  if (!db.prepare("SELECT 1 FROM embeddings WHERE company_id = ? AND source_type = ? LIMIT 1").get(companyId, sourceType)) return [];
  const [query] = await embed([text], "query");
  let rows: { rowid: number; similarity: number }[];
  if (vecAvailable && hasVecTable()) {
    rows = (db.prepare(`
      SELECT rowid, distance FROM vec_embeddings
      WHERE embedding MATCH ? AND k = ? AND company_id = ? AND source_type = ?
      ORDER BY distance
    `).all(toBlob(query), k, companyId, sourceType) as { rowid: number; distance: number }[])
      .map(row => ({ rowid: row.rowid, similarity: 1 - row.distance }));
  } else {
    rows = (db.prepare("SELECT rowid, vector FROM embeddings WHERE company_id = ? AND source_type = ?").all(companyId, sourceType) as
      { rowid: number; vector: Buffer }[])
      .map(row => {
        const vector = fromBlob(row.vector);
        let dot = 0;
        for (let index = 0; index < vector.length && index < query.length; index++) dot += vector[index] * query[index];
        return { rowid: row.rowid, similarity: dot };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }
  const lookup = db.prepare("SELECT source_id, company_id, model FROM embeddings WHERE rowid = ?");
  return rows.flatMap(row => {
    const source = lookup.get(row.rowid) as { source_id: string; company_id: string; model: string } | undefined;
    // Toisen taloyhtiön tai vanhan mallin vektori ei koskaan päädy tulokseen.
    if (!source || source.company_id !== companyId || source.model !== embeddingModelKey() || row.similarity < threshold) return [];
    return [{ sourceId: source.source_id, similarity: row.similarity }];
  });
}

// Reciprocal Rank Fusion: yhdistää järjestetyt listat. Kohde saa jokaisesta listasta 1 / (k + sija).
export function reciprocalRankFusion(lists: string[][], k = 60): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((itemId, index) => scores.set(itemId, (scores.get(itemId) ?? 0) + 1 / (k + index + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([itemId]) => itemId);
}

// --- Mitä vektoroidaan -----------------------------------------------------------------------------

// Sama merkintä kuin asukkaan tietojen poistossa (resident-erasure.ts ERASED_TEXT); testi varmistaa.
export const ERASED_MARK = "[Poistettu]";
const TEXT_LIMIT = 2000;

type Source = { companyId: string; sourceType: SourceType; sourceId: string; text: string };

const placeholders = (values: unknown[]) => values.map(() => "?").join(", ");
// Valinnainen rajaus yhteen lähteeseen (tarkistus ennen tallennusta).
const onlyId = (column: string, sourceId?: string) => (sourceId ? `AND ${column} = ?` : "");
const idParam = (sourceId?: string) => (sourceId ? [sourceId] : []);

// Dokumentaatiopala: otsikko, dokumentin nimi ja sisältö. Vain aktiiviset AI:n dokumentaation palat;
// voimassaolo rajataan haussa.
function chunkSources(companyIds: string[], sourceId?: string): Source[] {
  if (!companyIds.length) return [];
  return (db.prepare(`
    SELECT c.id, c.company_id, c.title, c.content, k.title AS document_title
    FROM knowledge_chunks c JOIN knowledge k ON k.id = c.knowledge_id
    WHERE c.company_id IN (${placeholders(companyIds)}) AND k.company_id = c.company_id
      AND c.status = 'active' AND k.status IN ('active', 'pending') AND k.audience = 'ai' AND k.extraction_ok = 1
      ${onlyId("c.id", sourceId)}
  `).all(...companyIds, ...idParam(sourceId)) as { id: string; company_id: string; title: string; content: string; document_title: string }[])
    .map(row => ({
      companyId: row.company_id, sourceType: "chunk", sourceId: row.id,
      text: `${row.title}\n${row.document_title}\n${row.content}`.slice(0, 1500)
    }));
}

// Ratkaistu tehtävä: otsikko ja asukkaan ensimmäinen viesti peitettynä. Mukana vain suljetut tehtävät,
// joihin toimisto on vastannut; ei arkaluonteisia, tunnistamattomia, suodatettuja eikä tehtäviä, joista
// asukkaan tietoja on poistettu tai joiden poisto odottaa sulkemista.
export function resolvedTicketSql(alias = "t") {
  const pendingErasure = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'erasure_pending'").get()
    ? `AND NOT EXISTS (SELECT 1 FROM erasure_pending p WHERE p.ticket_id = ${alias}.id)` : "";
  return `
  ${alias}.kind = 'ticket' AND ${alias}.status = 'closed' AND ${alias}.sensitive = 0 AND COALESCE(${alias}.company_pending, 0) = 0
  AND ${alias}.ai_action != 'filtered' AND ${alias}.subject != '${ERASED_MARK}'
  AND EXISTS (SELECT 1 FROM messages r WHERE r.ticket_id = ${alias}.id AND r.direction = 'outbound' AND COALESCE(r.channel, '') != 'contractor')
  AND NOT EXISTS (SELECT 1 FROM messages e WHERE e.ticket_id = ${alias}.id AND e.direction = 'inbound' AND e.body = '${ERASED_MARK}')
  ${pendingErasure}`;
}

export function firstResidentMessage(ticketId: string) {
  return (db.prepare(`
    SELECT body FROM messages WHERE ticket_id = ? AND direction = 'inbound' AND COALESCE(channel, '') != 'contractor'
    ORDER BY created_at LIMIT 1
  `).get(ticketId) as { body: string } | undefined)?.body ?? "";
}

function ticketSources(companyIds: string[], sourceId?: string): Source[] {
  if (!companyIds.length) return [];
  return (db.prepare(`
    SELECT t.id, t.company_id, t.subject, t.summary FROM tickets t
    WHERE t.company_id IN (${placeholders(companyIds)}) AND ${resolvedTicketSql()} ${onlyId("t.id", sourceId)}
  `).all(...companyIds, ...idParam(sourceId)) as { id: string; company_id: string; subject: string; summary: string }[])
    .map(row => ({
      companyId: row.company_id, sourceType: "ticket", sourceId: row.id,
      text: maskPersonalData(`${row.subject}\n${firstResidentMessage(row.id) || row.summary}`).slice(0, TEXT_LIMIT)
    }));
}

function memorySources(companyIds: string[], sourceId?: string): Source[] {
  if (!companyIds.length) return [];
  return (db.prepare(`
    SELECT id, company_id, text FROM company_memory
    WHERE company_id IN (${placeholders(companyIds)}) AND status = 'approved' AND (valid_until IS NULL OR valid_until >= ?)
      ${onlyId("id", sourceId)}
  `).all(...companyIds, today(), ...idParam(sourceId)) as { id: string; company_id: string; text: string }[])
    .map(row => ({ companyId: row.company_id, sourceType: "memory", sourceId: row.id, text: row.text.slice(0, TEXT_LIMIT) }));
}

// Kaikki lähteet, joilla pitää olla vektori: tehtävät, kun esimerkit ovat käytössä; palat ja muisti, kun
// hybridihaku on käytössä.
function wantedSources(): Source[] {
  const tickets = companiesWith("similarTickets");
  const knowledge = companiesWith("hybridKnowledge");
  return [...ticketSources(tickets), ...chunkSources(knowledge), ...memorySources(knowledge)];
}

// Onko lähde yhä vektoroitava samalla tekstillä (tarkistetaan laskennan jälkeen ennen tallennusta, koska
// lähde on voinut poistua, muuttua tai muuttua arkaluonteiseksi laskennan aikana).
function stillWanted(source: Source) {
  const loaders = { ticket: [ticketSources, "similarTickets"], chunk: [chunkSources, "hybridKnowledge"], memory: [memorySources, "hybridKnowledge"] } as const;
  const [load, feature] = loaders[source.sourceType];
  if (!embeddingEnabled(source.companyId, feature)) return false;
  return load([source.companyId], source.sourceId).some(item => item.text === source.text);
}

// --- Taustaindeksointi ----------------------------------------------------------------------------

const BATCH_SIZE = 16;
export type IndexResult = { embedded: number; removed: number; pending: number };

// Poistaa vektorit, joita ei enää pidä olla (lähde poistettu, arkistoitu, arkaluonteinen, asukkaan tiedot
// poistettu tai toiminto kytketty pois), ja laskee puuttuvat ja muuttuneet. maxBatches rajaa yhden ajon.
export async function indexEmbeddings(maxBatches = Infinity): Promise<IndexResult> {
  const wanted = wantedSources();
  const keys = new Set(wanted.map(source => `${source.sourceType}:${source.sourceId}`));
  let removed = 0;
  db.transaction(() => {
    for (const row of db.prepare("SELECT source_type, source_id FROM embeddings").all() as { source_type: SourceType; source_id: string }[]) {
      if (!keys.has(`${row.source_type}:${row.source_id}`)) {
        deleteEmbedding(row.source_type, row.source_id);
        removed++;
      }
    }
  })();

  const pending = wanted.filter(source => !upToDate(source.sourceType, source.sourceId, textHash(source.text)));
  let embedded = 0;
  for (let batch = 0; batch < maxBatches && embedded < pending.length; batch++) {
    const items = pending.slice(embedded, embedded + BATCH_SIZE);
    const vectors = await embed(items.map(item => item.text), "passage");
    items.forEach((item, index) => {
      if (stillWanted(item)) storeEmbedding(item.companyId, item.sourceType, item.sourceId, textHash(item.text), vectors[index]);
    });
    embedded += items.length;
  }
  return { embedded, removed, pending: pending.length - embedded };
}

let running: Promise<IndexResult> | null = null;
let again = false;
export type IndexStatus = { lastRunAt: string | null; lastError: string | null; lastResult: IndexResult | null };
const indexStatus: IndexStatus = { lastRunAt: null, lastError: null, lastResult: null };

// Käynnistää indeksoinnin taustalla. Samanaikainen pyyntö ajaa sen uudelleen nykyisen jälkeen.
export function scheduleEmbeddingIndex(): Promise<IndexResult> | null {
  if (embeddingKilled()) return null;
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let result: IndexResult = { embedded: 0, removed: 0, pending: 0 };
    try {
      do {
        again = false;
        result = await indexEmbeddings();
      } while (again);
      indexStatus.lastError = null;
    } catch (error: any) {
      indexStatus.lastError = String(error?.message ?? error);
      console.error("Merkityshaun indeksointi epäonnistui:", indexStatus.lastError);
    } finally {
      indexStatus.lastRunAt = now();
      indexStatus.lastResult = result;
      running = null;
    }
    return result;
  })();
  return running;
}

export function startEmbeddingJob() {
  if (embeddingKilled()) return;
  // Malli ladataan taustalla heti, kun merkityshaku on jossain käytössä; käynnistys ei odota sitä.
  preloadModel();
  // Käynnistyksessä puuttuvat vektorit täydennetään; sen jälkeen uudet ja muuttuneet lähteet minuutin välein.
  void scheduleEmbeddingIndex();
  setInterval(() => void scheduleEmbeddingIndex(), 60 * 1000);
}

// Tila asetusnäkymälle: montako vektoria taloyhtiöittäin ja lähteittäin, malli ja indeksi.
export function embeddingStatus() {
  const counts = db.prepare(`
    SELECT company_id, source_type, COUNT(*) AS count FROM embeddings GROUP BY company_id, source_type
  `).all() as { company_id: string; source_type: SourceType; count: number }[];
  return {
    killed: embeddingKilled(),
    backend: vectorBackend(),
    model: getModelStatus(),
    index: { ...indexStatus, running: Boolean(running) },
    counts
  };
}

// Täysi uudelleenlaskenta (komentoriviltä): kaikki vektorit poistetaan ja lasketaan alusta.
export async function rebuildEmbeddings(): Promise<IndexResult> {
  db.transaction(() => {
    if (vecAvailable && hasVecTable()) db.exec("DROP TABLE vec_embeddings");
    db.exec("DELETE FROM embeddings");
  })();
  return indexEmbeddings();
}
