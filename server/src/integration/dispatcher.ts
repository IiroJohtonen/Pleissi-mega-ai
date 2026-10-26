import { raiseAlert, resolveAlert } from "../alerts.js";
import { db } from "../db.js";
import { sendEmail } from "../mail.js";
import { formatTicketNumber } from "../numbers.js";
import { id, now, VALID_EMAIL } from "../util.js";
import type { AdapterResult, ErpAdapter } from "./adapter.js";
import type { Comment, Envelope, EventType, Task } from "./canonical.js";
import { MockErpAdapter } from "./mock-adapter.js";
import { integrationAdapterName, type OutboxRow } from "./outbox.js";

// ---------------------------------------------------------------------------------------------
// Jonon lähetys ERP:hen. Muutos on kirjattu jonoon heti; lähetys tehdään taustalla, kun saman tehtävän
// viimeisimmästä kirjauksesta on kulunut SEND_DELAY. Saman tehtävän odottavista päivityksistä lähetetään
// vain uusin (sanoma sisältää koko tilan), ja vanhemmat merkitään ohitetuiksi (superseded).
//
// Järjestys tehtävää kohden: task.created ensin, koska ERP:n tunniste saadaan siitä; päivitykset ja
// kommentit odottavat sen kuittausta. Kommentteja ei yhdistetä: jokainen lähtee erikseen järjestyksessä.
//
// Virheet (docs/integraatiospec.md, Virheenkäsittely):
//   429, 5xx ja yhteysvirhe → uusi yritys kasvavin välein (1 min, 5 min, 30 min), sitten failed ja
//                             ilmoitus vastuuisännöitsijälle
//   401, 403                → hälytys pääkäyttäjille; rivi odottaa ja lähtee, kun avain on korjattu
//   400, 404, 409 ja muut   → failed heti ja ilmoitus vastuuisännöitsijälle
// Sovelluslokiin kirjataan vain tapahtuman tunniste ja vastauskoodi, ei sanoman henkilötietoja.
// ---------------------------------------------------------------------------------------------

const numberEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const SEND_DELAY_MS = () => numberEnv("INTEGRATION_SEND_DELAY_MS", 5_000);
const POLL_MS = () => numberEnv("INTEGRATION_POLL_MS", 2_000);
export const RETRY_DELAYS_MS = () => {
  const custom = (process.env.INTEGRATION_RETRY_DELAYS_MS ?? "").split(",").map(value => value.trim()).filter(Boolean)
    .map(Number).filter(value => Number.isFinite(value) && value >= 0);
  return custom.length ? custom : [60_000, 5 * 60_000, 30 * 60_000];
};
const AUTH_RETRY_MS = () => numberEnv("INTEGRATION_AUTH_RETRY_MS", 5 * 60_000);
const CALL_TIMEOUT_MS = 30_000;
const AUTH_ALERT = "integration:auth";

let adapter: ErpAdapter | null = null;

// Käytössä oleva adapteri INTEGRATION_ADAPTER-muuttujan mukaan. Oikeat ERP-adapterit lisätään tähän.
export function currentAdapter(): ErpAdapter | null {
  if (adapter) return adapter;
  const name = integrationAdapterName();
  if (name === "mock") adapter = MockErpAdapter.fromEnv();
  else if (name) console.error(`Tuntematon INTEGRATION_ADAPTER: ${name}`);
  return adapter;
}

const later = (ms: number, from: number) => new Date(from + ms).toISOString();
const due = (iso: string, at: number) => Date.parse(iso) <= at;

function erpRef(entityType: string, entityId: string): string | null {
  return (db.prepare("SELECT external_id FROM integration_refs WHERE entity_type = ? AND entity_id = ? AND system = 'erp'")
    .get(entityType, entityId) as { external_id: string } | undefined)?.external_id ?? null;
}

function envelope<T extends Task | Comment>(row: OutboxRow): Envelope<T> {
  const data = JSON.parse(row.payload) as T;
  data.externalRefs = { erp: erpRef(row.entity_type, row.entity_id) };
  return {
    eventId: row.event_id,
    eventType: row.event_type as EventType,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    source: row.source as "pleissi",
    tenantId: row.tenant_id,
    sequence: row.sequence,
    ...(row.changed_fields ? { changedFields: JSON.parse(row.changed_fields) as string[] } : {}),
    data
  };
}

async function call(work: () => Promise<AdapterResult>): Promise<AdapterResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<AdapterResult>(resolve => {
    timer = setTimeout(() => resolve({ ok: false, status: null, error: "ERP ei vastannut ajoissa" }), CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work(), timeout]);
  } catch (error: any) {
    return { ok: false, status: null, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

function send(target: ErpAdapter, row: OutboxRow, erpTaskId: string | null): Promise<AdapterResult> {
  if (row.event_type === "task.created") return call(() => target.createTask(envelope<Task>(row)));
  if (!erpTaskId) return Promise.resolve({ ok: false, status: null, error: "Tehtävällä ei ole vielä ERP-tunnistetta" });
  if (row.event_type === "task.updated") return call(() => target.updateTask(erpTaskId, envelope<Task>(row)));
  return call(() => target.addComment(erpTaskId, envelope<Comment>(row)));
}

// Tallentaa kutsun tuloksen. Palauttaa true, jos rivi lähti.
function record(row: OutboxRow, result: AdapterResult, at: number): boolean {
  const timestamp = new Date(at).toISOString();
  if (result.ok) {
    db.transaction(() => {
      db.prepare("UPDATE integration_outbox SET status = 'sent', sent_at = ?, last_status_code = ?, last_error = NULL WHERE event_id = ?")
        .run(timestamp, result.status, row.event_id);
      if (result.externalId) {
        db.prepare(`
          INSERT OR REPLACE INTO integration_refs (entity_type, entity_id, task_id, system, external_id, created_at)
          VALUES (?, ?, ?, 'erp', ?, ?)
        `).run(row.entity_type, row.entity_id, row.task_id, result.externalId, timestamp);
      }
    })();
    resolveAlert(AUTH_ALERT);
    console.log(`ERP-integraatio: ${row.event_type} ${row.event_id} lähetetty (${result.status})`);
    return true;
  }

  const { status, error } = result;
  console.error(`ERP-integraatio: ${row.event_type} ${row.event_id} epäonnistui (${status ?? "ei yhteyttä"})`);
  if (status === 401 || status === 403) {
    // Avain tai oikeus puuttuu: mitään ei hylätä, vaan rivi odottaa, kunnes avain on korjattu.
    db.prepare("UPDATE integration_outbox SET next_attempt_at = ?, last_status_code = ?, last_error = ? WHERE event_id = ?")
      .run(later(AUTH_RETRY_MS(), at), status, error, row.event_id);
    raiseAlert(AUTH_ALERT, "ERP-integraation tunnistautuminen epäonnistui",
      `ERP vastasi ${status}. Rajapinta-avain on vanhentunut tai siltä puuttuu oikeus. Muutokset odottavat jonossa ja lähtevät, kun avain on korjattu.`);
    return false;
  }

  const retryable = status === null || status === 429 || status >= 500;
  const attempts = row.attempts + 1;
  const delays = RETRY_DELAYS_MS();
  if (retryable && attempts <= delays.length) {
    db.prepare("UPDATE integration_outbox SET attempts = ?, next_attempt_at = ?, last_status_code = ?, last_error = ? WHERE event_id = ?")
      .run(attempts, later(delays[attempts - 1], at), status, error, row.event_id);
    return false;
  }
  db.prepare("UPDATE integration_outbox SET status = 'failed', attempts = ?, last_status_code = ?, last_error = ? WHERE event_id = ?")
    .run(attempts, status, error, row.event_id);
  void notifyFailure(row, status, error);
  return false;
}

// Epäonnistunut kirjaus näkyy tehtävän historiassa, ja vastuuisännöitsijä saa sähköpostin.
async function notifyFailure(row: OutboxRow, status: number | null, error: string) {
  const ticket = db.prepare(`
    SELECT t.ticket_number, t.sensitive, t.subject, c.name AS company, u.name AS manager_name, u.email AS manager_email
    FROM tickets t JOIN companies c ON c.id = t.company_id LEFT JOIN users u ON u.id = c.manager_id WHERE t.id = ?
  `).get(row.task_id) as { ticket_number: number | null; sensitive: number; subject: string; company: string;
    manager_name: string | null; manager_email: string | null } | undefined;
  if (!ticket) return;
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), row.task_id, "system", "integration_failed",
    JSON.stringify({ eventType: row.event_type, eventId: row.event_id, status, error }), now()
  );
  const email = (ticket.manager_email ?? "").trim();
  if (!VALID_EMAIL.test(email)) return;
  const what = row.event_type === "task.comment.added" ? "Viestin kirjaus" : row.event_type === "task.created" ? "Tehtävän kirjaus" : "Tehtävän muutoksen kirjaus";
  try {
    await sendEmail({
      to: email,
      notification: true,
      subject: `${what} ERP:hen epäonnistui: #${formatTicketNumber(ticket.ticket_number)}`,
      body: [
        `Hei ${ticket.manager_name ?? ""},`,
        "",
        `${what} toiminnanohjausjärjestelmään ei onnistunut, eikä sitä yritetä enää automaattisesti.`,
        "Tarkista tehtävä ja tee kirjaus tarvittaessa käsin.",
        "",
        `Tehtävä: #${formatTicketNumber(ticket.ticket_number)} ${ticket.sensitive ? "Arkaluonteinen tehtävä" : ticket.subject} (${ticket.company})`,
        `Syy: ${status ? `ERP vastasi ${status}. ` : ""}${error}`,
        "",
        `Avaa Pleissi: ${process.env.APP_URL || "http://localhost:5173"}`
      ].join("\n")
    });
  } catch (mailError: any) {
    console.error("ERP-integraation virheilmoitus ei lähtenyt:", mailError?.message ?? mailError);
  }
}

// Yhdistää saman tehtävän odottavat päivitykset uusimpaan: vanhemmat merkitään ohitetuiksi, ja uusin saa
// kaikkien muuttuneet kentät sekä suurimman yrityskerran, jotta uudelleenyritysten porrastus ei ala alusta.
function coalesce(updates: OutboxRow[]): OutboxRow {
  const newest = updates[updates.length - 1];
  if (updates.length === 1) return newest;
  const fields = [...new Set(updates.flatMap(row => (row.changed_fields ? JSON.parse(row.changed_fields) as string[] : [])))];
  const attempts = Math.max(...updates.map(row => row.attempts));
  db.transaction(() => {
    const supersede = db.prepare("UPDATE integration_outbox SET status = 'superseded', superseded_by = ? WHERE event_id = ? AND status = 'pending'");
    for (const row of updates.slice(0, -1)) supersede.run(newest.event_id, row.event_id);
    db.prepare("UPDATE integration_outbox SET changed_fields = ?, attempts = ? WHERE event_id = ?").run(JSON.stringify(fields), attempts, newest.event_id);
  })();
  return { ...newest, changed_fields: JSON.stringify(fields), attempts };
}

// Lähettää yhden tehtävän lähtövalmiit rivit järjestyksessä.
async function processTask(target: ErpAdapter, rows: OutboxRow[], at: number) {
  const delay = SEND_DELAY_MS();
  const latest = Math.max(...rows.map(row => Date.parse(row.created_at)));
  // Lähetys odottaa, kunnes tehtävän viimeisimmästä kirjauksesta on kulunut viive.
  if (latest + delay > at) return;

  const created = rows.find(row => row.event_type === "task.created");
  if (created) {
    if (!due(created.next_attempt_at, at)) return;
    if (!record(created, await send(target, created, null), at)) return;
  }
  const erpTaskId = erpRef("task", rows[0].task_id);
  // Luonti ei ole vielä mennyt läpi (esim. epäonnistui): päivitykset ja kommentit odottavat.
  if (!erpTaskId) return;

  const updates = rows.filter(row => row.event_type === "task.updated");
  if (updates.length && updates.every(row => due(row.next_attempt_at, at))) {
    const newest = coalesce(updates);
    record(newest, await send(target, newest, erpTaskId), at);
  }

  for (const comment of rows.filter(row => row.event_type === "task.comment.added")) {
    if (!due(comment.next_attempt_at, at)) break;
    // Kommentit lähtevät järjestyksessä: epäonnistunut pysäyttää seuraavat seuraavaan yritykseen asti.
    if (!record(comment, await send(target, comment, erpTaskId), at)) break;
  }
}

let running = false;

// Yksi lähetyskierros. at ja target voidaan antaa testeissä.
export async function processOutbox(target: ErpAdapter | null = currentAdapter(), at = Date.now()) {
  if (!target || running) return;
  running = true;
  try {
    const pending = db.prepare("SELECT * FROM integration_outbox WHERE status = 'pending' ORDER BY rowid").all() as OutboxRow[];
    const byTask = new Map<string, OutboxRow[]>();
    for (const row of pending) byTask.set(row.task_id, [...(byTask.get(row.task_id) ?? []), row]);
    for (const rows of byTask.values()) await processTask(target, rows, at);
  } finally {
    running = false;
  }
}

export function startIntegrationJob() {
  if (!currentAdapter()) return;
  setInterval(() => {
    processOutbox().catch(error => console.error("ERP-integraation lähetys epäonnistui:", error?.message ?? error));
  }, POLL_MS());
}
