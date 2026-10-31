import { db } from "../db.js";
import type { Envelope } from "./canonical.js";
import { buildEnvelope, coalesce, SEND_DELAY_MS } from "./dispatcher.js";
import { type OutboxRow, pullEnabled } from "./outbox.js";

// ---------------------------------------------------------------------------------------------
// Hakutila (docs/integraatiospec.md, Haku jonosta): ERP hakee Pleissin muutokset kutsulla
// GET /api/v1/events?after=<kursori>. Jonoon kirjattu rivi julkaistaan haettavaksi samalla viiveellä kuin
// adapteri lähettäisi sen, ja ennen julkaisua saman tehtävän odottavat päivitykset yhdistetään uusimpaan
// (vanhemmat superseded). Julkaistu rivi saa juoksevan kursorin; tila sent tarkoittaa, että ERP on hakenut sen.
// ---------------------------------------------------------------------------------------------

export const formatCursor = (cursor: number) => `c_${String(cursor).padStart(6, "0")}`;

// "c_000042" → 42. Null = virheellinen kursori.
export function parseCursor(value: string): number | null {
  const match = /^c_(\d{1,15})$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

// Julkaisee haettavaksi ne tehtävät, joiden viimeisimmästä kirjauksesta on kulunut viive.
export function publishOutbox(at = Date.now()) {
  const unpublished = db.prepare("SELECT * FROM integration_outbox WHERE status = 'pending' AND cursor IS NULL ORDER BY rowid").all() as OutboxRow[];
  const byTask = new Map<string, OutboxRow[]>();
  for (const row of unpublished) byTask.set(row.task_id, [...(byTask.get(row.task_id) ?? []), row]);
  const delay = SEND_DELAY_MS();
  let published = 0;
  // Kursori jatkaa suurimmasta annetusta; palvelin on yksi prosessi, joten laskuri pysyy oikeana kierroksen ajan.
  let cursor = (db.prepare("SELECT MAX(cursor) AS cursor FROM integration_outbox WHERE cursor IS NOT NULL").get() as { cursor: number | null }).cursor ?? 0;
  const assign = db.prepare("UPDATE integration_outbox SET cursor = ? WHERE event_id = ?");
  for (const rows of byTask.values()) {
    if (Math.max(...rows.map(row => Date.parse(row.created_at))) + delay > at) continue;
    const updates = rows.filter(row => row.event_type === "task.updated");
    const newest = updates.length ? coalesce(updates) : null;
    const publish = rows.filter(row => row.event_type !== "task.updated" || row.event_id === newest?.event_id);
    db.transaction(() => {
      for (const row of publish) assign.run(++cursor, row.event_id);
    })();
    published += publish.length;
  }
  return published;
}

export type FetchResult = { events: (Envelope & { cursor: string })[]; nextCursor: string | null; hasMore: boolean };

// Tapahtumat kursorin jälkeen. Haetut merkitään lähetetyiksi ja API-avaimelle tallennetaan viimeisin kursori.
export function fetchEvents(after: number | null, limit: number, apiKeyId: string, at = Date.now()): FetchResult {
  publishOutbox(at);
  const rows = db.prepare(`
    SELECT * FROM integration_outbox WHERE cursor IS NOT NULL AND cursor > ? ORDER BY cursor LIMIT ?
  `).all(after ?? 0, limit + 1) as OutboxRow[];
  const page = rows.slice(0, limit);
  const timestamp = new Date(at).toISOString();
  const last = page.at(-1)?.cursor ?? after;
  const nextCursor = last === null || last === undefined ? null : formatCursor(last);
  db.transaction(() => {
    const sent = db.prepare("UPDATE integration_outbox SET status = 'sent', sent_at = ? WHERE event_id = ? AND status = 'pending'");
    for (const row of page) sent.run(timestamp, row.event_id);
    db.prepare("UPDATE integration_api_keys SET last_cursor = ?, last_fetched_at = ? WHERE id = ?").run(nextCursor, timestamp, apiKeyId);
  })();
  return {
    events: page.map(row => ({ ...buildEnvelope(row), cursor: formatCursor(row.cursor!) })),
    nextCursor,
    hasMore: rows.length > limit
  };
}

// Taustajulkaisu, jotta jonon tila (ja integraatioloki) pysyy ajan tasalla, vaikka ERP ei hakisi.
export function startPullJob(intervalMs: number) {
  setInterval(() => {
    if (!pullEnabled()) return;
    try {
      publishOutbox();
    } catch (error: any) {
      console.error("ERP-jonon julkaisu epäonnistui:", error?.message ?? error);
    }
  }, intervalMs);
}
