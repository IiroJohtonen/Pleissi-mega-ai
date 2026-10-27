import "dotenv/config";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { type Assessment, type AssessCase, type Grade, gradeAssessment, loadAssessCases } from "./cases.js";

// ---------------------------------------------------------------------------------------------
// Pleissin AI:n evaluointi (Evaluation suite spec). Ensimmäinen versio kattaa saapuvan viestin
// arvioinnin (assessIncoming). Ajo kutsuu tuotannon funktiota oikealla Claude-API:lla, joten se maksaa
// ja kestää minuutteja eikä kuulu npm testiin.
//
//   npm run eval                                   koko joukko
//   npm run eval -- --case assess-001              yksi tapaus (toistettavissa tai pilkuilla)
//   npm run eval -- --model claude-sonnet-5-5      toinen malli
//   npm run eval -- --baseline eval/results/2026-10-27-abc1234.json   uudet hylätyt ja läpäisyt
//
// API-avain: EVAL_ANTHROPIC_API_KEY (oma avain ja kuukausiraja Anthropicin konsolissa), muuten
// ANTHROPIC_API_KEY. Ajo käyttää omaa väliaikaista tietokantaa, joten kulut eivät kirjaudu Pleissin
// kulurajaan eikä mitään tallennu sovelluksen dataan.
// Tulokset: eval/results/<päivä>-<commit>.json ja .md. Exit code 1, jos kriittisiä virheitä on.
// ---------------------------------------------------------------------------------------------

const RESULTS_DIR = path.join(import.meta.dirname, "results");

const { values: args } = parseArgs({
  options: {
    feature: { type: "string", default: "assess" },
    case: { type: "string", multiple: true },
    model: { type: "string" },
    baseline: { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});

if (args.help) {
  console.log("npm run eval -- [--case <id>[,<id>]] [--model <malli>] [--baseline <tulostiedosto.json>]");
  process.exit(0);
}
if (args.feature !== "assess") {
  console.error(`Toimintoa "${args.feature}" ei vielä evaluoida. Käytössä: assess.`);
  process.exit(2);
}

const apiKey = process.env.EVAL_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("API-avain puuttuu: aseta EVAL_ANTHROPIC_API_KEY (tai ANTHROPIC_API_KEY) server/.env-tiedostoon.");
  process.exit(2);
}
if (!process.env.EVAL_ANTHROPIC_API_KEY) console.warn("Huom: EVAL_ANTHROPIC_API_KEY puuttuu, käytetään ANTHROPIC_API_KEY-avainta.");

// Ympäristö asetetaan ennen sovelluksen moduulien latausta: oma tietokanta, ei postia, valittu malli.
process.env.ANTHROPIC_API_KEY = apiKey;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pleissi-eval-"));
process.env.GMAIL_DISABLED = "1";
// Väliaikaisen tietokannan käyttäjät luodaan tällä salasanalla, jotta sovellus ei arvo ja tulosta omaansa.
process.env.INITIAL_PASSWORD = "eval-ei-kirjautumista";
if (args.model) process.env.ANTHROPIC_MODEL = args.model;

const { db } = await import("../src/db.js");
const { assessIncoming } = await import("../src/ai.js");
// Arvioinnin malli valitaan samoin kuin tuotannossa (perustiedot → ANTHROPIC_MODEL → oletus). Tyhjässä
// tietokannassa perustietojen valinta on tyhjä, joten --model ohittaa sen.
const { getMasterData } = await import("../src/master-data.js");

type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; model: string | null };

type CaseResult = {
  id: string;
  tags: string[];
  critical: boolean;
  input: AssessCase["input"];
  expected: AssessCase["expected"];
  note: string;
  actual: Assessment | null;
  // Kutsu epäonnistui (API-virhe, aikakatkaisu): tapausta ei voitu arvioida.
  error: string | null;
  grade: Grade | null;
  latencyMs: number;
  usage: Usage;
};

const usageRows = db.prepare(`
  SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens, COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
         COALESCE(SUM(cost_usd), 0) AS costUsd, MAX(model) AS model
  FROM ai_usage WHERE rowid > ?
`);
const lastUsageRow = () => (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS id FROM ai_usage").get() as { id: number }).id;

// Tuotannon funktio palauttaa virheessä null ja kirjaa syyn konsoliin; syy otetaan talteen raporttia varten.
async function runCase(testCase: AssessCase): Promise<CaseResult> {
  const before = lastUsageRow();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...items: unknown[]) => {
    errors.push(items.map(item => (item instanceof Error ? item.message : String(item))).join(" "));
  };
  const started = performance.now();
  let actual: Assessment | null = null;
  try {
    actual = await assessIncoming(testCase.input.subject, testCase.input.body, testCase.input.sender);
  } catch (error: any) {
    errors.push(String(error?.message ?? error));
  } finally {
    console.error = originalError;
  }
  const latencyMs = Math.round(performance.now() - started);
  const usage = usageRows.get(before) as Usage;
  return {
    id: testCase.id, tags: testCase.tags, critical: testCase.critical, input: testCase.input, expected: testCase.expected, note: testCase.note,
    actual, error: actual ? null : errors.join(" | ") || "Ei arviota", grade: actual ? gradeAssessment(testCase, actual) : null,
    latencyMs, usage
  };
}

function git(...gitArgs: string[]) {
  try {
    return execFileSync("git", gitArgs, { cwd: path.join(import.meta.dirname, ".."), encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
const fi = (value: number) => String(value).replace(".", ",");
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

// --- Ajo -------------------------------------------------------------------------------------------

const allCases = loadAssessCases();
const wanted = (args.case ?? []).flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean);
const unknown = wanted.filter(caseId => !allCases.some(testCase => testCase.id === caseId));
if (unknown.length) {
  console.error(`Tuntematon tapaus: ${unknown.join(", ")}`);
  process.exit(2);
}
const cases = wanted.length ? allCases.filter(testCase => wanted.includes(testCase.id)) : allCases;

const commit = git("rev-parse", "--short", "HEAD") || "unknown";
const dirty = git("status", "--porcelain", "--", "src", "eval/cases") !== "";
const startedAt = new Date();
console.log(`Evaluoidaan ${cases.length} tapausta: saapuvan viestin arviointi (commit ${commit}${dirty ? ", ei-commitoituja muutoksia" : ""})`);

const results: CaseResult[] = [];
for (const testCase of cases) {
  const result = await runCase(testCase);
  results.push(result);
  const mark = result.error ? "VIRHE" : result.grade!.critical.length ? "KRIITTINEN" : result.grade!.passed ? "ok" : "hylätty";
  const got = result.actual ? `relevant=${result.actual.relevant} priority=${result.actual.priority}` : result.error;
  console.log(`  ${mark.padEnd(10)} ${result.id}  ${got}  (${result.latencyMs} ms)`);
}

// --- Yhteenveto ------------------------------------------------------------------------------------

const graded = results.filter(result => result.grade);
const summary = {
  cases: results.length,
  graded: graded.length,
  errors: results.length - graded.length,
  passed: graded.filter(result => result.grade!.passed).length,
  passRate: percent(graded.filter(result => result.grade!.passed).length, results.length),
  relevantRate: percent(graded.filter(result => result.grade!.relevantOk).length, results.length),
  priorityRate: percent(graded.filter(result => result.grade!.priorityOk).length, results.length),
  criticalFailures: graded.filter(result => result.grade!.critical.length).length,
  costUsd: Math.round(results.reduce((sum, result) => sum + result.usage.costUsd, 0) * 10000) / 10000,
  inputTokens: results.reduce((sum, result) => sum + result.usage.inputTokens, 0),
  outputTokens: results.reduce((sum, result) => sum + result.usage.outputTokens, 0),
  latencyMedianMs: median(results.map(result => result.latencyMs)),
  latencyMaxMs: Math.max(0, ...results.map(result => result.latencyMs))
};
// Hyväksymisrajat v1 (spec, Raportti ja hyväksymisrajat).
const thresholds = [
  { label: "Kriittiset virheet", value: summary.criticalFailures, ok: summary.criticalFailures === 0, limit: "0" },
  { label: "Relevanssi oikein", value: `${fi(summary.relevantRate)} %`, ok: summary.relevantRate >= 95, limit: "≥ 95 %" },
  { label: "Prioriteetti hyväksyttävä", value: `${fi(summary.priorityRate)} %`, ok: summary.priorityRate >= 90, limit: "≥ 90 %" }
];

type BaselineFile = { commit: string; results: { id: string; passed: boolean | null }[] };
let comparison: { file: string; commit: string; newlyFailed: string[]; newlyPassed: string[] } | null = null;
if (args.baseline) {
  const baseline = JSON.parse(fs.readFileSync(path.resolve(args.baseline), "utf8")) as BaselineFile;
  const before = new Map(baseline.results.map(result => [result.id, result.passed]));
  const passedNow = (result: CaseResult) => Boolean(result.grade?.passed);
  comparison = {
    file: path.basename(args.baseline),
    commit: baseline.commit,
    newlyFailed: results.filter(result => before.get(result.id) === true && !passedNow(result)).map(result => result.id),
    newlyPassed: results.filter(result => before.get(result.id) === false && passedNow(result)).map(result => result.id)
  };
}

const model = results.find(result => result.usage.model)?.usage.model
  ?? (getMasterData().aiModels.assess || process.env.ANTHROPIC_MODEL || "oletus");
const critical = results.filter(result => result.grade?.critical.length);
const failed = results.filter(result => result.grade && !result.grade.passed && !result.grade.critical.length);
const errored = results.filter(result => result.error);

const describe = (result: CaseResult) => result.actual
  ? `relevant=${result.actual.relevant}, priority=${result.actual.priority}` : `virhe: ${result.error}`;
const expectedText = (result: CaseResult) =>
  `relevant=${result.expected.relevant}, priority ∈ {${result.expected.priorityAcceptable.join(", ")}}`;

const lines: string[] = [];
lines.push(`# Evaluointi: saapuvan viestin arviointi`, "");
lines.push(`${startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC · commit ${commit}${dirty ? " (ei-commitoituja muutoksia)" : ""} · malli ${model}`, "");
lines.push(`**Läpäisy ${fi(summary.passRate)} %** (${summary.passed}/${summary.cases}) · kriittisiä virheitä ${summary.criticalFailures}` +
  (summary.errors ? ` · arvioimatta ${summary.errors}` : ""), "");
lines.push("| Mittari | Tulos | Raja v1 |", "| --- | --- | --- |");
for (const row of thresholds) lines.push(`| ${row.label} | ${row.value}${row.ok ? "" : " ✗"} | ${row.limit} |`);
lines.push(`| Kulut | ${fi(Number(summary.costUsd.toFixed(4)))} $ (${summary.inputTokens} + ${summary.outputTokens} tokenia) | – |`);
lines.push(`| Viive | mediaani ${summary.latencyMedianMs} ms, hitain ${summary.latencyMaxMs} ms | – |`, "");
if (critical.length) {
  lines.push("## Kriittiset virheet", "", "| Tapaus | Syy | Odotettu | Saatu | AI:n perustelu |", "| --- | --- | --- | --- | --- |");
  for (const result of critical) {
    const reason = `${result.actual!.relevanceReason} ${result.actual!.reason}`.replace(/\|/g, "/").trim();
    lines.push(`| ${result.id} | ${result.grade!.critical.join("; ")} | ${expectedText(result)} | ${describe(result)} | ${reason} |`);
  }
  lines.push("");
}
if (failed.length) {
  lines.push("## Muut hylätyt", "", "| Tapaus | Odotettu | Saatu | AI:n perustelu |", "| --- | --- | --- | --- |");
  for (const result of failed) {
    lines.push(`| ${result.id} | ${expectedText(result)} | ${describe(result)} | ${`${result.actual!.relevanceReason} ${result.actual!.reason}`.replace(/\|/g, "/").trim()} |`);
  }
  lines.push("");
}
if (errored.length) {
  lines.push("## Arvioimatta (API-virhe)", "");
  for (const result of errored) lines.push(`- ${result.id}: ${result.error}`);
  lines.push("");
}
if (comparison) {
  lines.push(`## Vertailu: ${comparison.file} (commit ${comparison.commit})`, "");
  lines.push(`- Uudet hylätyt: ${comparison.newlyFailed.join(", ") || "ei yhtään"}`);
  lines.push(`- Uudet läpäisyt: ${comparison.newlyPassed.join(", ") || "ei yhtään"}`, "");
}
const markdown = lines.join("\n");

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const partial = wanted.length ? "-osajoukko" : "";
const base = path.join(RESULTS_DIR, `${startedAt.toISOString().slice(0, 10)}-${commit}${partial}`);
fs.writeFileSync(`${base}.json`, JSON.stringify({
  feature: "assess", startedAt: startedAt.toISOString(), commit, dirty, model, summary, thresholds, comparison,
  results: results.map(result => ({ ...result, passed: result.grade ? result.grade.passed : null }))
}, null, 2) + "\n");
fs.writeFileSync(`${base}.md`, markdown + "\n");

console.log("");
console.log(markdown);
console.log(`Tulokset: ${path.relative(process.cwd(), base)}.json ja .md`);

db.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
// 1 = kriittisiä virheitä (julkaisu pysähtyy), 2 = tapauksia jäi arvioimatta, 0 = kunnossa.
process.exit(critical.length ? 1 : errored.length ? 2 : 0);
