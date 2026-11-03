import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "./db.js";
import { id, now } from "./util.js";

// ---------------------------------------------------------------------------------------------
// AI:lle lähtevän tiedon loki. Jokaisesta kutsusta tallennetaan malli, järjestelmäohje ja viestit
// täsmälleen siinä muodossa kuin ne lähetetään (henkilötiedot jo maskattuina). Lokiin tulee
// merkintä "ai_request", ja itse sisältö on omassa taulussaan, koska dokumentit voivat olla pitkiä.
// Tehtävään liittyvä kutsu kirjataan tehtävälle; saapuvan viestin arviointi tehdään ennen kuin
// tehtävä on olemassa, joten sen merkintä liitetään tehtävään luonnin jälkeen.
// ---------------------------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_requests (
    id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL,
    ticket_id TEXT,
    feature TEXT NOT NULL,
    model TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);
// AI:n vastaus pyynnön rinnalla (sisältö, lopetuksen syy ja tokenit), jotta lokista näkee, mitä AI vastasi.
if (!(db.prepare("PRAGMA table_info(ai_requests)").all() as { name: string }[]).some(column => column.name === "response")) {
  db.exec("ALTER TABLE ai_requests ADD COLUMN response TEXT");
}

type Scope = { ticketId?: string; auditIds: string[] };
const scope = new AsyncLocalStorage<Scope>();

// Suorittaa AI-kutsut niin, että niiden lokimerkinnät liitetään tehtävään (tai kerätään myöhemmin liitettäviksi).
export async function withAiLog<T>(ticketId: string | undefined, run: () => Promise<T>): Promise<{ result: T; auditIds: string[] }> {
  const context: Scope = { ticketId, auditIds: [] };
  const result = await scope.run(context, run);
  return { result, auditIds: context.auditIds };
}

// Liittää ennen tehtävän luontia kirjatut AI-merkinnät tehtävään.
export function attachAiLog(auditIds: string[], ticketId: string) {
  for (const auditId of auditIds) {
    db.prepare("UPDATE audit_log SET ticket_id = ? WHERE id = ?").run(ticketId, auditId);
    db.prepare("UPDATE ai_requests SET ticket_id = ? WHERE audit_id = ?").run(ticketId, auditId);
  }
}

// Kirjaa lokiin merkinnän (action) ja sen sisällön ai_requests-tauluun. Palauttaa sisällön tunnisteen tai null,
// jos kirjaus epäonnistui (lokitus ei saa estää AI-kutsua).
function logEntry(action: string, feature: string, model: string, payload: string, details: Record<string, unknown>) {
  const context = scope.getStore();
  const auditId = id("audit");
  const requestId = id("airequest");
  const timestamp = now();
  try {
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      auditId, context?.ticketId ?? null, "ai", action, JSON.stringify({ feature, model, characters: payload.length, ...details }), timestamp
    );
    db.prepare("INSERT INTO ai_requests (id, audit_id, ticket_id, feature, model, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(requestId, auditId, context?.ticketId ?? null, feature, model, payload, timestamp);
    context?.auditIds.push(auditId);
    return requestId;
  } catch (error) {
    console.error("AI-kutsun kirjaus lokiin epäonnistui:", error instanceof Error ? error.message : error);
    return null;
  }
}

// Kirjaa AI-kutsun sisällön. Rakenteisen vastauksen muotomääritys jätetään pois, koska se ei sisällä
// käyttäjien tietoja. Palautettu tunniste annetaan logAiResponse:lle, kun vastaus on tullut.
export function logAiRequest(feature: string, params: { model: string; system?: unknown; messages: unknown; max_tokens?: number }) {
  const payload = JSON.stringify({ model: params.model, max_tokens: params.max_tokens, system: params.system, messages: params.messages }, null, 2);
  return logEntry("ai_request", feature, params.model, payload, {});
}

type AiResponseLike = { stop_reason?: string | null; content?: unknown; usage?: unknown; parsed_output?: unknown };

// Tallentaa AI:n vastauksen pyynnön rinnalle: rakenteinen tulos (jos on), muuten sisältölohkot.
export function logAiResponse(requestId: string | null, response: AiResponseLike | AiResponseLike[]) {
  if (!requestId) return;
  const shape = (item: AiResponseLike) => ({
    stop_reason: item.stop_reason ?? null,
    ...(item.parsed_output !== undefined && item.parsed_output !== null ? { output: item.parsed_output } : { content: item.content }),
    usage: item.usage ?? null
  });
  try {
    db.prepare("UPDATE ai_requests SET response = ? WHERE id = ?")
      .run(JSON.stringify(Array.isArray(response) ? response.map(shape) : shape(response), null, 2), requestId);
  } catch (error) {
    console.error("AI:n vastauksen kirjaus lokiin epäonnistui:", error instanceof Error ? error.message : error);
  }
}

// AI-agentin ajon jäljitys: jokainen työkalukutsu syötteineen ja tuloksineen. Näkyy tehtävän lokissa
// avattavana merkintänä (ai_agent_trace), samassa paikassa kuin AI:lle lähetetty sisältö.
export type AgentTraceStep = { tool: string; input: unknown; output: unknown; error?: string; at: string; ms: number };
export function logAgentTrace(model: string, steps: AgentTraceStep[], outcome: string) {
  return logEntry("ai_agent_trace", "agent", model, JSON.stringify({ outcome, steps }, null, 2), { steps: steps.length, outcome });
}

export function aiRequestPayload(auditId: string) {
  return db.prepare("SELECT ticket_id, feature, model, payload, response, created_at FROM ai_requests WHERE audit_id = ?").get(auditId) as
    | { ticket_id: string | null; feature: string; model: string; payload: string; response: string | null; created_at: string }
    | undefined;
}

// Poistaa tehtävän AI-lokin sisällöt (tehtävän poisto ja asukkaan tietojen poisto).
export function deleteAiRequests(ticketId: string) {
  db.prepare("DELETE FROM ai_requests WHERE ticket_id = ?").run(ticketId);
}

// Säilytysajan poisto: sisällöt, joiden lokimerkintää ei enää ole.
export function purgeOrphanAiRequests() {
  return db.prepare("DELETE FROM ai_requests WHERE audit_id NOT IN (SELECT id FROM audit_log)").run().changes;
}
