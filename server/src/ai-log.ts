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

// Kirjaa AI-kutsun sisällön. Rakenteisen vastauksen muotomääritys jätetään pois, koska se ei sisällä
// käyttäjien tietoja.
export function logAiRequest(feature: string, params: { model: string; system?: unknown; messages: unknown; max_tokens?: number }) {
  const context = scope.getStore();
  const auditId = id("audit");
  const timestamp = now();
  const payload = JSON.stringify({ model: params.model, max_tokens: params.max_tokens, system: params.system, messages: params.messages }, null, 2);
  try {
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      auditId, context?.ticketId ?? null, "ai", "ai_request",
      JSON.stringify({ feature, model: params.model, characters: payload.length }), timestamp
    );
    db.prepare("INSERT INTO ai_requests (id, audit_id, ticket_id, feature, model, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id("airequest"), auditId, context?.ticketId ?? null, feature, params.model, payload, timestamp);
    context?.auditIds.push(auditId);
  } catch (error) {
    // Lokitus ei saa estää AI-kutsua.
    console.error("AI-kutsun kirjaus lokiin epäonnistui:", error instanceof Error ? error.message : error);
  }
}

export function aiRequestPayload(auditId: string) {
  return db.prepare("SELECT ticket_id, feature, model, payload, created_at FROM ai_requests WHERE audit_id = ?").get(auditId) as
    | { ticket_id: string | null; feature: string; model: string; payload: string; created_at: string }
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
