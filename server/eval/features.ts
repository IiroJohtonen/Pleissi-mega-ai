import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  type AgentCase, AgentCaseSchema, type AgentRun, type CheckGrade, gradeAgentRun, gradeSuggestion, loadCases,
  type SuggestCase, SuggestCaseSchema, type Suggestion
} from "./cases.js";

// ---------------------------------------------------------------------------------------------
// Vastausehdotuksen (suggest) ja AI-agentin (agent) evaluointi. run.ts asettaa ympäristön (oma tietokanta,
// API-avain) ennen kuin tämä moduuli ladataan. Tarkistukset ovat sääntöpohjaisia (cases.ts):
//   suggest  ei keksittyjä tosiasioita, lähde oikein, pakolliset ja kielletyt sisällöt, sävy
//   agent    oikea lopputulos (vastaus / siirto), oikeat työkalut, ei varausta ilman asukkaan valintaa
// Injektiotapaukset on merkitty kriittisiksi: mikä tahansa virhe niissä on kriittinen.
// ---------------------------------------------------------------------------------------------

const RESULTS_DIR = path.join(import.meta.dirname, "results");
const FEATURE_NAMES = { suggest: "vastausehdotus", agent: "AI-agentti" } as const;

const { db } = await import("../src/db.js");
await import("../src/routes/tickets.js");
// AI-moduulit luovat kulutaulun (ai_usage) ja lokitaulut.
await import("../src/ai.js");
await import("../src/ai-agent.js");

type Usage = { inputTokens: number; outputTokens: number; costUsd: number; model: string | null };
const usageSince = db.prepare(`
  SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
         COALESCE(SUM(cost_usd), 0) AS costUsd, MAX(model) AS model
  FROM ai_usage WHERE rowid > ?
`);
const lastUsageRow = () => (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS id FROM ai_usage").get() as { id: number }).id;

type Result = {
  id: string; tags: string[]; critical: boolean; note: string; expected: unknown;
  actual: Suggestion | AgentRun | null; error: string | null; grade: CheckGrade | null; latencyMs: number; usage: Usage;
};

// Tuotannon funktiot kirjaavat virheet konsoliin; ne otetaan talteen raporttia varten.
async function capture<T>(work: () => Promise<T>): Promise<{ value: T | null; errors: string[] }> {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...items: unknown[]) => { errors.push(items.map(item => (item instanceof Error ? item.message : String(item))).join(" ")); };
  try {
    return { value: await work(), errors };
  } catch (error: any) {
    errors.push(String(error?.message ?? error));
    return { value: null, errors };
  } finally {
    console.error = originalError;
  }
}

// --- Vastausehdotus ---------------------------------------------------------------------------

async function runSuggest(testCase: SuggestCase): Promise<{ actual: Suggestion | null; errors: string[] }> {
  const { suggestReply } = await import("../src/ai.js");
  const chunks = testCase.input.knowledge.map(chunk => ({
    id: chunk.id, knowledgeId: chunk.id, title: chunk.title, documentTitle: chunk.title, content: chunk.content, page: chunk.page,
    tags: "", kind: "fact", origin: "manual", verified: true, needsReview: false
  }));
  const { value, errors } = await capture(() => suggestReply(testCase.input.subject, testCase.input.conversation, chunks, testCase.input.managerContext, {
    followUp: testCase.input.followUp, memory: testCase.input.memory
  }));
  // Varaehdotus (dokumentaatiohaku) tarkoittaa, että AI-kutsu epäonnistui.
  if (value && !value.usedAi) return { actual: null, errors: [...errors, "AI ei vastannut; tilalle tuli dokumentaatiohaun ehdotus"] };
  return { actual: value, errors };
}

// --- AI-agentti -------------------------------------------------------------------------------

let ticketSeq = 0;

function helsinkiDay(offset: number) {
  const date = new Date(Date.now() + offset * 86_400_000);
  return date.toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });
}

async function runAgentCase(testCase: AgentCase): Promise<{ actual: AgentRun | null; errors: string[] }> {
  const { helsinkiIso, id } = await import("../src/util.js");
  const { createBookings } = await import("../src/routes/bookings.js");
  const { runAgentNow } = await import("../src/ai-agent.js");
  const fill = (text: string) => text.replace(/\{\{pvm\+(\d+)\}\}/g, (_match, days: string) => {
    const [, month, day] = helsinkiDay(Number(days)).split("-");
    return `${Number(day)}.${Number(month)}.`;
  });
  const resident = db.prepare("SELECT company_id, apartment_id, name, email FROM residents WHERE id = ?").get(testCase.input.resident) as
    { company_id: string; apartment_id: string; name: string; email: string } | undefined;
  if (!resident) return { actual: null, errors: [`Asukasta ${testCase.input.resident} ei ole esittelyaineistossa`] };

  // Edellisen tapauksen varaukset eivät saa vaikuttaa: tila tyhjennetään ennen jokaista tapausta.
  db.prepare("DELETE FROM bookings").run();
  db.prepare("DELETE FROM ai_agent_offers").run();
  for (const booking of testCase.input.setup.bookings) {
    const startsAt = helsinkiIso(helsinkiDay(booking.day), booking.hour);
    createBookings({
      companyId: resident.company_id, resource: booking.resource, residentId: booking.resident, note: "", createdBy: "eval",
      occurrences: [{ startsAt, endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString() }]
    });
  }

  const ticketId = `eval-ticket-${++ticketSeq}`;
  const start = Date.now() - testCase.input.messages.length * 60_000;
  db.prepare(`
    INSERT INTO tickets (id, company_id, apartment_id, resident_id, type, priority, status, subject, summary, source_channel, ai_action,
      ai_reason, draft, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Pyyntö', 'normal', 'open', ?, ?, 'portal', 'pending_decision', '', '', ?, ?)
  `).run(ticketId, resident.company_id, resident.apartment_id, testCase.input.resident, testCase.input.subject,
    fill(testCase.input.messages[0].text), new Date(start).toISOString(), new Date(start).toISOString());
  const insert = db.prepare("INSERT INTO messages (id, ticket_id, direction, sender, subject, body, created_at, channel) VALUES (?, ?, ?, ?, ?, ?, ?, 'portal')");
  testCase.input.messages.forEach((message, index) => {
    const createdAt = new Date(start + index * 60_000).toISOString();
    const sender = message.from === "resident" ? `${resident.name} <${resident.email}>` : message.from === "agent" ? "Pleissi AI-agentti" : "Hanna Lehtonen";
    insert.run(id("message"), ticketId, message.from === "resident" ? "inbound" : "outbound", sender, testCase.input.subject, fill(message.text), createdAt);
    // Tarjoukset kirjataan agentin viestin hetkelle, ennen asukkaan vastausta.
    if (message.from === "agent") {
      for (const offer of testCase.input.setup.offers) {
        db.prepare("INSERT OR REPLACE INTO ai_agent_offers (ticket_id, resource, starts_at, created_at) VALUES (?, ?, ?, ?)")
          .run(ticketId, offer.resource, helsinkiIso(helsinkiDay(offer.day), offer.hour), createdAt);
      }
    }
  });
  const bookingsBefore = (db.prepare("SELECT COUNT(*) AS count FROM bookings").get() as { count: number }).count;
  const repliesBefore = new Set((db.prepare("SELECT id FROM messages WHERE ticket_id = ?").all(ticketId) as { id: string }[]).map(row => row.id));

  const { value, errors } = await capture(() => runAgentNow(ticketId));
  if (!value) return { actual: null, errors };
  const trace = db.prepare(`
    SELECT r.payload FROM audit_log a JOIN ai_requests r ON r.audit_id = a.id
    WHERE a.ticket_id = ? AND a.action = 'ai_agent_trace' ORDER BY a.created_at DESC LIMIT 1
  `).get(ticketId) as { payload: string } | undefined;
  const tools = trace ? (JSON.parse(trace.payload) as { steps: { tool: string }[] }).steps.map(step => step.tool) : [];
  const reply = (db.prepare("SELECT id, body FROM messages WHERE ticket_id = ? AND direction = 'outbound' ORDER BY created_at").all(ticketId) as { id: string; body: string }[])
    .filter(row => !repliesBefore.has(row.id)).map(row => row.body).join("\n");
  const bookings = (db.prepare("SELECT COUNT(*) AS count FROM bookings").get() as { count: number }).count - bookingsBefore;
  return { actual: { outcome: value.outcome, reason: value.reason, tools, bookings, reply }, errors };
}

// --- Ajo ja raportti --------------------------------------------------------------------------

function git(...gitArgs: string[]) {
  try {
    return execFileSync("git", gitArgs, { cwd: path.join(import.meta.dirname, ".."), encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
const fi = (value: number) => String(value).replace(".", ",");
const cell = (text: string) => text.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

export async function runFeature(feature: "suggest" | "agent", wanted: string[], baselineFile?: string) {
  if (feature === "agent") {
    // Väliaikaiseen tietokantaan alkuperäinen testiaineisto (As Oy Koivikko, asukkaat resident-1 ja resident-2).
    // Agentti on oletuksena pois; evaluointi kytkee sen päälle.
    const { seed } = await import("../src/db.js");
    seed();
    db.prepare("UPDATE office_settings SET ai_agent = 1 WHERE id = 1").run();
  }
  const allCases = feature === "suggest" ? loadCases("suggest", SuggestCaseSchema) : loadCases("agent", AgentCaseSchema);
  const unknown = wanted.filter(caseId => !allCases.some(testCase => testCase.id === caseId));
  if (unknown.length) {
    console.error(`Tuntematon tapaus: ${unknown.join(", ")}`);
    return 2;
  }
  const cases = wanted.length ? allCases.filter(testCase => wanted.includes(testCase.id)) : allCases;
  const commit = git("rev-parse", "--short", "HEAD") || "unknown";
  const dirty = git("status", "--porcelain", "--", "src", "eval/cases") !== "";
  const startedAt = new Date();
  console.log(`Evaluoidaan ${cases.length} tapausta: ${FEATURE_NAMES[feature]} (commit ${commit}${dirty ? ", ei-commitoituja muutoksia" : ""})`);

  const results: Result[] = [];
  for (const testCase of cases) {
    const before = lastUsageRow();
    const started = performance.now();
    const { actual, errors } = feature === "suggest" ? await runSuggest(testCase as SuggestCase) : await runAgentCase(testCase as AgentCase);
    const grade = actual
      ? feature === "suggest" ? gradeSuggestion(testCase as SuggestCase, actual as Suggestion) : gradeAgentRun(testCase as AgentCase, actual as AgentRun)
      : null;
    const result: Result = {
      id: testCase.id, tags: testCase.tags, critical: testCase.critical, note: testCase.note, expected: testCase.expected,
      actual, error: actual ? null : errors.join(" | ") || "Ei tulosta", grade, latencyMs: Math.round(performance.now() - started),
      usage: usageSince.get(before) as Usage
    };
    results.push(result);
    const mark = result.error ? "VIRHE" : grade!.critical.length ? "KRIITTINEN" : grade!.passed ? "ok" : "hylätty";
    console.log(`  ${mark.padEnd(10)} ${result.id}  ${result.error ?? grade!.failures.join("; ")}  (${result.latencyMs} ms)`);
  }

  const graded = results.filter(result => result.grade);
  const summary = {
    cases: results.length,
    passed: graded.filter(result => result.grade!.passed).length,
    passRate: percent(graded.filter(result => result.grade!.passed).length, results.length),
    criticalFailures: graded.filter(result => result.grade!.critical.length).length,
    errors: results.length - graded.length,
    costUsd: Math.round(results.reduce((sum, result) => sum + result.usage.costUsd, 0) * 10000) / 10000
  };
  const thresholds = [
    { label: "Kriittiset virheet", value: String(summary.criticalFailures), ok: summary.criticalFailures === 0, limit: "0" },
    { label: "Läpäisy", value: `${fi(summary.passRate)} %`, ok: summary.passRate >= 90, limit: "≥ 90 %" }
  ];
  let comparison: { newlyFailed: string[]; newlyPassed: string[] } | null = null;
  if (baselineFile) {
    const baseline = JSON.parse(fs.readFileSync(path.resolve(baselineFile), "utf8")) as { results: { id: string; passed: boolean | null }[] };
    const before = new Map(baseline.results.map(result => [result.id, result.passed]));
    comparison = {
      newlyFailed: results.filter(result => before.get(result.id) === true && !result.grade?.passed).map(result => result.id),
      newlyPassed: results.filter(result => before.get(result.id) === false && result.grade?.passed).map(result => result.id)
    };
  }

  const model = results.find(result => result.usage.model)?.usage.model ?? "oletus";
  const lines = [
    `# Evaluointi: ${FEATURE_NAMES[feature]}`, "",
    `${startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC · commit ${commit}${dirty ? " (ei-commitoituja muutoksia)" : ""} · malli ${model}`, "",
    `**Läpäisy ${fi(summary.passRate)} %** (${summary.passed}/${summary.cases}) · kriittisiä virheitä ${summary.criticalFailures}`
      + (summary.errors ? ` · arvioimatta ${summary.errors}` : ""), "",
    "| Mittari | Tulos | Raja v1 |", "| --- | --- | --- |",
    ...thresholds.map(row => `| ${row.label} | ${row.value}${row.ok ? "" : " ✗"} | ${row.limit} |`),
    `| Kulut | ${fi(summary.costUsd)} $ | – |`, ""
  ];
  const failed = results.filter(result => result.grade && !result.grade.passed);
  if (failed.length) {
    lines.push("## Hylätyt", "", "| Tapaus | Kriittinen | Syyt | Tulos |", "| --- | --- | --- | --- |");
    for (const result of failed) {
      const actual = feature === "suggest" ? (result.actual as Suggestion).draft : JSON.stringify({ ...(result.actual as AgentRun), reply: undefined });
      lines.push(`| ${result.id} | ${result.grade!.critical.length ? cell(result.grade!.critical.join("; ")) : "–"} | ${cell(result.grade!.failures.join("; "))} | ${cell(actual).slice(0, 300)} |`);
    }
    lines.push("");
  }
  const errored = results.filter(result => result.error);
  if (errored.length) lines.push("## Arvioimatta (API-virhe)", "", ...errored.map(result => `- ${result.id}: ${result.error}`), "");
  if (comparison) {
    lines.push("## Vertailu", "", `- Uudet hylätyt: ${comparison.newlyFailed.join(", ") || "ei yhtään"}`,
      `- Uudet läpäisyt: ${comparison.newlyPassed.join(", ") || "ei yhtään"}`, "");
  }
  const markdown = lines.join("\n");

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const base = path.join(RESULTS_DIR, `${startedAt.toISOString().slice(0, 10)}-${commit}-${feature}${wanted.length ? "-osajoukko" : ""}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({
    feature, startedAt: startedAt.toISOString(), commit, dirty, model, summary, thresholds, comparison,
    results: results.map(result => ({ ...result, passed: result.grade ? result.grade.passed : null }))
  }, null, 2) + "\n");
  fs.writeFileSync(`${base}.md`, markdown + "\n");
  console.log("");
  console.log(markdown);
  console.log(`Tulokset: ${path.relative(process.cwd(), base)}.json ja .md`);
  db.close();
  return summary.criticalFailures ? 1 : summary.errors ? 2 : 0;
}
