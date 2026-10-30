import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------------------------
// Hakuevaluointi: vertaa nykyistä sanahakua ja hybridihakua (sanat + merkitys, RRF) testijoukolla
// test/fixtures/retrieval-questions.json esittelyaineiston dokumentaatiota vasten.
//
//   npm run eval:retrieval                          oletusmalli (EMBEDDING_MODEL tai multilingual-e5-small)
//   npm run eval:retrieval -- --model Xenova/bge-m3 toinen malli
//   npm run eval:retrieval -- --model hash          ajon tarkistus ilman mallia (ei kerro laadusta mitään)
//
// Mittarit: recall@k (oikea pala k parhaan joukossa), MRR (1 / oikean palan sija), väärät osumat kysymyksiin,
// joihin dokumentaatiossa ei ole vastausta, hakuaika (p95) ja mallin muisti. Jos mallia ei saada ladattua
// (esim. Hugging Face estetty eikä mallia ole kansiossa EMBEDDING_MODEL_DIR), skripti kertoo sen ja lopettaa.
// ---------------------------------------------------------------------------------------------

const { values: args } = parseArgs({ options: { model: { type: "string" }, k: { type: "string", default: "5" } } });
const k = Number(args.k) || 5;
if (args.model) process.env.EMBEDDING_MODEL = args.model;
const modelDir = (process.env.EMBEDDING_MODEL_DIR ?? "").trim() || path.join(import.meta.dirname, "..", "data", "models");
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "pleissi-retrieval-")),
  EMBEDDING_MODEL_DIR: modelDir,
  GMAIL_DISABLED: "1",
  INITIAL_PASSWORD: "eval-ei-kirjautumista",
  // Esittelyaineiston dokumentit pilkotaan kappaleittain, kuten ilman AI:ta.
  ANTHROPIC_API_KEY: ""
});
delete process.env.EMBEDDING_ENABLED;

type Expected = { document: string; contains: string };
type Case = { id: string; question: string; tags: string[]; expected: Expected[] };
const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "test", "fixtures", "retrieval-questions.json"), "utf8")) as
  { company: string; cases: Case[] };

const { db } = await import("../src/db.js");
const { resetDemoData } = await import("../src/demo-data.js");
const embedding = await import("../src/embedding.js");
const { searchKnowledgeChunks, selectKnowledgeChunks } = await import("../src/knowledge-chunks.js");

resetDemoData({ password: "eval-ei-kirjautumista" });
const model = embedding.embeddingModel();
console.log(`Hakuevaluointi: ${fixture.cases.length} kysymystä, malli ${model}, k = ${k}`);

try {
  await embedding.embed(["testi"], "query");
} catch (error: any) {
  console.log(`Mallia ${model} ei saatu ladattua (${String(error?.message ?? error).split("\n")[0]}).`);
  console.log(`Lataa malli kansioon ${modelDir} tai salli lataus Hugging Facesta, ja aja uudelleen. Vertailua ei tehty.`);
  process.exit(0);
}

embedding.setCompanyOverride(fixture.company, "hybridKnowledge", true);
const indexStarted = performance.now();
const indexed = await embedding.indexEmbeddings();
console.log(`Vektoroitu ${indexed.embedded} palaa ${Math.round(performance.now() - indexStarted)} ms.`);

const chunkInfo = db.prepare(`
  SELECT c.id, c.content, k.title FROM knowledge_chunks c JOIN knowledge k ON k.id = c.knowledge_id WHERE c.id = ?
`);
const matches = (chunkId: string, expected: Expected[]) => {
  const row = chunkInfo.get(chunkId) as { content: string; title: string } | undefined;
  return Boolean(row && expected.some(item => row.title === item.document && row.content.includes(item.contains)));
};

type Method = "sanahaku" | "hybridi";
type Outcome = { id: string; question: string; rank: Record<Method, number | null>; returned: Record<Method, number> };
const outcomes: Outcome[] = [];
const latencies: number[] = [];

for (const testCase of fixture.cases) {
  const byWords = selectKnowledgeChunks(fixture.company, testCase.question, k);
  const started = performance.now();
  const hybrid = await searchKnowledgeChunks(fixture.company, testCase.question, k);
  latencies.push(performance.now() - started);
  const rank = (ids: string[]) => {
    const index = ids.findIndex(chunkId => matches(chunkId, testCase.expected));
    return index < 0 ? null : index + 1;
  };
  outcomes.push({
    id: testCase.id, question: testCase.question,
    rank: { sanahaku: rank(byWords.map(chunk => chunk.id)), hybridi: rank(hybrid.map(chunk => chunk.id)) },
    returned: { sanahaku: byWords.length, hybridi: hybrid.length }
  });
}

const answerable = outcomes.filter((_, index) => fixture.cases[index].expected.length);
const unanswerable = outcomes.filter((_, index) => !fixture.cases[index].expected.length);
const percent = (value: number) => `${(Math.round(value * 1000) / 10).toString().replace(".", ",")} %`;
const metrics = (method: Method) => ({
  recall: answerable.filter(outcome => outcome.rank[method] !== null).length / answerable.length,
  mrr: answerable.reduce((sum, outcome) => sum + (outcome.rank[method] ? 1 / outcome.rank[method]! : 0), 0) / answerable.length,
  falseHits: unanswerable.filter(outcome => outcome.returned[method] > 0).length
});
const words = metrics("sanahaku");
const hybrid = metrics("hybridi");
const sorted = [...latencies].sort((a, b) => a - b);
const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
const status = embedding.getModelStatus();

console.log("");
console.log(`| Mittari | Sanahaku | Hybridi |`);
console.log(`| --- | --- | --- |`);
console.log(`| Recall@${k} (${answerable.length} kysymystä) | ${percent(words.recall)} | ${percent(hybrid.recall)} |`);
console.log(`| MRR | ${words.mrr.toFixed(3).replace(".", ",")} | ${hybrid.mrr.toFixed(3).replace(".", ",")} |`);
console.log(`| Väärät osumat (${unanswerable.length} ilman vastausta) | ${words.falseHits} | ${hybrid.falseHits} |`);
console.log(`| Hakuaika p95 | – | ${Math.round(p95)} ms |`);
console.log(`| Mallin muisti | – | ${status.memoryMb ?? "?"} Mt (lataus ${status.loadMs ?? "?"} ms) |`);
console.log("");
console.log("Kysymykset, joissa tulos erosi (sija tai –):");
for (const outcome of outcomes.filter(item => item.rank.sanahaku !== item.rank.hybridi)) {
  console.log(`  ${outcome.id} sanahaku ${outcome.rank.sanahaku ?? "–"} → hybridi ${outcome.rank.hybridi ?? "–"}  ${outcome.question}`);
}
db.close();
fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
