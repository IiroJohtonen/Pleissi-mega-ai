import { db } from "../db.js";
import { id, now } from "../util.js";
import { SCHEMA_VERSION, type Comment, type Task } from "./canonical.js";
import { changedFields, type MessageRow, type TaskContext, type TaskRow, taskEligible, toComment, toTask, withOffset } from "./mapping.js";

// ---------------------------------------------------------------------------------------------
// Integraation lähtevä jono (docs/integraatiospec.md, Tapahtumaloki). Jokainen tehtävän muutos ja uusi
// kommentti kirjataan jonoon kanonisena sanomana samassa transaktiossa kuin itse muutos: triggeri
// kirjoittaa jonorivin, kun tehtävä tai viesti tallentuu, joten mikään tallennuskohta ei voi unohtaa
// kirjausta. Sisäisiä muistiinpanoja ei kirjata. audit_log on edelleen käyttäjille näkyvä
// toimintahistoria; tämä jono on integraation oma.
//
// Jonosta sanomat lähtevät kahdella tavalla:
//   adapteri (INTEGRATION_ADAPTER)  Pleissi lähettää ERP:hen (dispatcher.ts)
//   haku (INTEGRATION_PULL tai asetus)  ERP hakee GET /api/v1/events (pull.ts); käytössä, kun adapteria ei ole
//
// Triggerit ovat TEMP-triggereitä: ne ovat vain tämän palvelimen tietokantayhteydessä ja luodaan vain,
// kun integraatio on kytketty päälle. Muut yhteydet (esim. testit ja huoltoskriptit) eivät tarvitse
// triggerien käyttämiä funktioita.
// ---------------------------------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS integration_outbox (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  -- Olio, jota tapahtuma koskee ('task' tai 'comment'), ja tehtävä, johon se kuuluu.
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  -- Juokseva numero per olio.
  sequence INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  source TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  -- JSON-lista muuttuneista kentistä (task.updated); yhdistettäessä kaikkien ohitettujen kentät.
  changed_fields TEXT,
  -- Olion koko tila sanomamallin muodossa (sanoman data-kenttä).
  payload TEXT NOT NULL,
  -- pending = odottaa lähetystä, sent = ERP kuittasi, failed = ei lähetetä enää,
  -- superseded = uudempi saman tehtävän päivitys lähetettiin sen sijaan (superseded_by).
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_status_code INTEGER,
  last_error TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  -- Hakutila: juokseva paikka jonossa, annetaan julkaisuhetkellä (pull.ts). NULL = ei vielä haettavissa.
  cursor INTEGER,
  UNIQUE (entity_type, entity_id, sequence)
);
CREATE INDEX IF NOT EXISTS integration_outbox_pending ON integration_outbox (status, task_id);
CREATE INDEX IF NOT EXISTS integration_outbox_task ON integration_outbox (task_id);

-- ERP:n tunnisteet Pleissin olioille (sanomien externalRefs.erp). entity_type: task, comment, company,
-- apartment tai resident; task_id vain tehtäville ja kommenteille.
CREATE TABLE IF NOT EXISTS integration_refs (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  task_id TEXT,
  system TEXT NOT NULL DEFAULT 'erp',
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id, system)
);
`);

// Aiemmin task_id oli pakollinen; taulu rakennetaan uudelleen, jotta taloyhtiöt, asunnot ja asukkaat mahtuvat.
if ((db.prepare("PRAGMA table_info(integration_refs)").all() as { name: string; notnull: number }[])
  .some(column => column.name === "task_id" && column.notnull)) {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE integration_refs RENAME TO integration_refs_old;
      CREATE TABLE integration_refs (
        entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, task_id TEXT, system TEXT NOT NULL DEFAULT 'erp',
        external_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (entity_type, entity_id, system)
      );
      INSERT INTO integration_refs SELECT entity_type, entity_id, task_id, system, external_id, created_at FROM integration_refs_old;
      DROP TABLE integration_refs_old;
    `);
  })();
}
if (!(db.prepare("PRAGMA table_info(integration_outbox)").all() as { name: string }[]).some(column => column.name === "cursor")) {
  db.exec("ALTER TABLE integration_outbox ADD COLUMN cursor INTEGER");
}
// Hakutilan asetus käyttöliittymästä (Asetukset › Tietoturva › ERP-rajapinta).
if (!(db.prepare("PRAGMA table_info(office_settings)").all() as { name: string }[]).some(column => column.name === "integration_pull")) {
  db.exec("ALTER TABLE office_settings ADD COLUMN integration_pull INTEGER NOT NULL DEFAULT 0");
}
db.exec(`
  CREATE INDEX IF NOT EXISTS integration_refs_task ON integration_refs (task_id);
  -- ERP:n tunnisteella haku (ERP viittaa olioihin omilla tunnisteillaan).
  CREATE UNIQUE INDEX IF NOT EXISTS integration_refs_external ON integration_refs (entity_type, system, external_id);
  CREATE UNIQUE INDEX IF NOT EXISTS integration_outbox_cursor ON integration_outbox (cursor) WHERE cursor IS NOT NULL;
`);

export type OutboxStatus = "pending" | "sent" | "failed" | "superseded";

export type OutboxRow = {
  event_id: string; event_type: string; entity_type: "task" | "comment"; entity_id: string; task_id: string;
  sequence: number; schema_version: string; source: string; tenant_id: string; occurred_at: string;
  changed_fields: string | null; payload: string; status: OutboxStatus; attempts: number; next_attempt_at: string;
  last_status_code: number | null; last_error: string | null; superseded_by: string | null; created_at: string; sent_at: string | null;
  cursor: number | null;
};

export function integrationAdapterName() {
  return (process.env.INTEGRATION_ADAPTER ?? "").trim();
}

// Hakutila on pakotettu päälle ympäristömuuttujalla (INTEGRATION_PULL=true), jolloin asetusta ei voi kytkeä pois.
export function pullForcedByEnv() {
  return ["1", "true", "yes"].includes((process.env.INTEGRATION_PULL ?? "").trim().toLowerCase());
}

export function pullSetting() {
  return Boolean((db.prepare("SELECT integration_pull FROM office_settings WHERE id = 1").get() as { integration_pull: number } | undefined)?.integration_pull);
}

// ERP hakee muutokset jonosta. Adapterin kanssa Pleissi lähettää itse, joten hakutila on käytössä vain ilman adapteria.
export function pullEnabled() {
  return integrationAdapterName() === "" && (pullForcedByEnv() || pullSetting());
}

export function integrationEnabled() {
  return integrationAdapterName() !== "" || pullEnabled();
}

export function tenantId() {
  return (process.env.INTEGRATION_TENANT_ID ?? "").trim() || "default";
}

// Triggerin kutsuma muunnos. Palauttaa jonoon kirjattavan tapahtuman JSONina tai null, jos tehtävä ei
// kuulu ERP:hen tai sen ERP:lle näkyvä tila ei muuttunut edellisestä kirjauksesta.
function taskEvent(rowJson: string, contextJson: string, previousJson: string | null): string | null {
  const row = JSON.parse(rowJson) as TaskRow;
  if (!taskEligible(row)) return null;
  const task = toTask(row, JSON.parse(contextJson) as TaskContext);
  let changed: string[] | null = null;
  if (previousJson) {
    changed = changedFields(JSON.parse(previousJson) as Task, task);
    if (changed.length === 0) return null;
  }
  return event(previousJson ? "task.updated" : "task.created", task, changed);
}

function commentEvent(rowJson: string, sensitive: number | null): string | null {
  const comment = toComment(JSON.parse(rowJson) as MessageRow, Boolean(sensitive));
  return comment ? event("task.comment.added", comment, null) : null;
}

function event(eventType: string, data: Task | Comment, changed: string[] | null) {
  const timestamp = now();
  return JSON.stringify({
    eventId: id("evt"), eventType, data, changedFields: changed,
    occurredAt: withOffset(timestamp), createdAt: timestamp, tenantId: tenantId()
  });
}

// --- Triggerit ------------------------------------------------------------------------------------

const TASK_ROW = `json_object(
  'id', NEW.id, 'ticket_number', NEW.ticket_number, 'company_id', NEW.company_id, 'apartment_id', NEW.apartment_id, 'resident_id', NEW.resident_id,
  'type', NEW.type, 'priority', NEW.priority, 'status', NEW.status, 'subject', NEW.subject, 'summary', NEW.summary,
  'source_channel', NEW.source_channel, 'ai_action', NEW.ai_action, 'kind', NEW.kind, 'company_pending', NEW.company_pending,
  'sensitive', NEW.sensitive, 'topic', NEW.topic, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at)`;

// tickets-sarakkeet, joista sanoma muodostetaan (TASK_ROW ja TASK_CONTEXT).
const TASK_COLUMNS = `ticket_number, company_id, apartment_id, resident_id, type, priority, status, subject, summary,
  source_channel, ai_action, kind, company_pending, sensitive, topic, assignee_id, updated_at`;

const TASK_CONTEXT = `json_object(
  'erpRef', (SELECT external_id FROM integration_refs WHERE entity_type = 'task' AND entity_id = NEW.id AND system = 'erp'),
  'assigneeName', (SELECT name FROM users WHERE id = NEW.assignee_id),
  'managerName', (SELECT u.name FROM companies c JOIN users u ON u.id = c.manager_id WHERE c.id = NEW.company_id),
  'maintenanceName', (SELECT NULLIF(maintenance_name, '') FROM companies WHERE id = NEW.company_id),
  'hasWorkOrder', EXISTS (SELECT 1 FROM work_orders WHERE ticket_id = NEW.id),
  'commentCount', (SELECT COUNT(*) FROM messages WHERE ticket_id = NEW.id AND COALESCE(channel, '') != 'contractor'),
  'attachments', json((SELECT json_group_array(json_object('fileName', filename, 'contentType', mime_type))
    FROM (SELECT filename, mime_type FROM attachments WHERE ticket_id = NEW.id ORDER BY created_at))))`;

const LAST_TASK_PAYLOAD = `(SELECT payload FROM integration_outbox
  WHERE entity_type = 'task' AND entity_id = NEW.id ORDER BY sequence DESC LIMIT 1)`;

// Jonorivin sarakkeet tapahtuman JSONista (ev).
const OUTBOX_COLUMNS = `(event_id, event_type, entity_type, entity_id, task_id, sequence, schema_version, source, tenant_id,
  occurred_at, changed_fields, payload, status, attempts, next_attempt_at, created_at)`;
const outboxValues = (entityType: string, entityId: string, taskId: string) => `
  json_extract(ev, '$.eventId'), json_extract(ev, '$.eventType'), '${entityType}', ${entityId}, ${taskId},
  COALESCE((SELECT MAX(sequence) FROM integration_outbox WHERE entity_type = '${entityType}' AND entity_id = ${entityId}), 0) + 1,
  '${SCHEMA_VERSION}', 'pleissi', json_extract(ev, '$.tenantId'), json_extract(ev, '$.occurredAt'),
  json_extract(ev, '$.changedFields'), json_extract(ev, '$.data'), 'pending', 0, json_extract(ev, '$.createdAt'), json_extract(ev, '$.createdAt')`;

const messageRow = (alias: string) => `json_object('id', ${alias}.id, 'ticket_id', ${alias}.ticket_id, 'direction', ${alias}.direction,
  'sender', ${alias}.sender, 'body', ${alias}.body, 'created_at', ${alias}.created_at, 'channel', ${alias}.channel)`;
const TASK_QUEUED = (taskId: string) => `EXISTS (SELECT 1 FROM integration_outbox WHERE entity_type = 'task' AND entity_id = ${taskId})`;
const NOT_QUEUED = (alias: string) => `NOT EXISTS (SELECT 1 FROM integration_outbox o WHERE o.entity_type = 'comment' AND o.entity_id = ${alias}.id)`;

// Tehtävän kirjaus ja sen jälkeen kommentit, joita ei vielä ole jonossa (esim. kun tunnistamaton tehtävä
// saa taloyhtiön ja kirjautuu ensimmäistä kertaa, tai arkaluonteisuusmerkintä poistetaan).
const TASK_TRIGGER_BODY = `
  INSERT INTO integration_outbox ${OUTBOX_COLUMNS}
  SELECT ${outboxValues("task", "NEW.id", "NEW.id")}
  FROM (SELECT integration_task_event(${TASK_ROW}, ${TASK_CONTEXT}, ${LAST_TASK_PAYLOAD}) AS ev) WHERE ev IS NOT NULL;

  INSERT INTO integration_outbox ${OUTBOX_COLUMNS}
  SELECT ${outboxValues("comment", "cid", "NEW.id")}
  FROM (
    SELECT m.id AS cid, integration_comment_event(${messageRow("m")}, NEW.sensitive) AS ev
    FROM messages m WHERE m.ticket_id = NEW.id AND ${NOT_QUEUED("m")} ORDER BY m.created_at
  ) WHERE ev IS NOT NULL AND ${TASK_QUEUED("NEW.id")};`;

const MESSAGE_TRIGGER = `
CREATE TEMP TRIGGER IF NOT EXISTS integration_messages_insert AFTER INSERT ON main.messages
WHEN ${TASK_QUEUED("NEW.ticket_id")}
BEGIN
  INSERT INTO integration_outbox ${OUTBOX_COLUMNS}
  SELECT ${outboxValues("comment", "NEW.id", "NEW.ticket_id")}
  FROM (SELECT integration_comment_event(${messageRow("NEW")},
    (SELECT sensitive FROM tickets WHERE id = NEW.ticket_id)) AS ev) WHERE ev IS NOT NULL;
END;`;

const TRIGGERS = ["integration_tickets_insert", "integration_tickets_update", "integration_messages_insert"];
let installed = false;
let functionsRegistered = false;

// Rekisteröi muunnosfunktiot ja luo triggerit, jos integraatio on päällä. Kutsutaan käynnistyksessä ja
// kun hakutila kytketään asetuksista.
export function installOutbox() {
  if (installed || !integrationEnabled()) return;
  if (!functionsRegistered) {
    db.function("integration_task_event", { deterministic: false }, taskEvent);
    db.function("integration_comment_event", { deterministic: false }, commentEvent);
    functionsRegistered = true;
  }
  db.exec(`
    -- Tehtävänumero annetaan heti lisäyksen jälkeen omalla triggerillään (UPDATE), jolloin luonti kirjataan
    -- päivitystriggerissä. Ennen numeroa tehtävää ei kirjata, joten sanomassa on aina ticketNumber.
    CREATE TEMP TRIGGER IF NOT EXISTS integration_tickets_insert AFTER INSERT ON main.tickets
    WHEN NEW.ticket_number IS NOT NULL
    BEGIN ${TASK_TRIGGER_BODY} END;
    -- Vain sanomaan vaikuttavien sarakkeiden muutos (ja updated_at, jolla liitteiden muutos tulee mukaan);
    -- esim. luonnoksen tallennus ei käynnistä muunnosta lainkaan.
    CREATE TEMP TRIGGER IF NOT EXISTS integration_tickets_update AFTER UPDATE OF ${TASK_COLUMNS} ON main.tickets
    WHEN NEW.ticket_number IS NOT NULL
    BEGIN ${TASK_TRIGGER_BODY} END;
    ${MESSAGE_TRIGGER}
  `);
  installed = true;
}

// Integraatio kytketty pois: uusia muutoksia ei enää kirjata. Jonossa jo olevat sanomat säilyvät.
export function uninstallOutbox() {
  if (!installed || integrationEnabled()) return;
  for (const trigger of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS temp.${trigger}`);
  installed = false;
}

// Hakutilan kytkentä asetuksista. Palauttaa uuden tilan.
export function setPullSetting(enabled: boolean) {
  db.prepare("UPDATE office_settings SET integration_pull = ? WHERE id = 1").run(enabled ? 1 : 0);
  if (integrationEnabled()) installOutbox();
  else uninstallOutbox();
  return pullEnabled();
}

installOutbox();

// --- Tietosuoja ---------------------------------------------------------------------------------

// Asukastietojen poisto: jonon sanomat anonymisoidaan samoin kuin tehtävä ja sen viestit, myös jo
// lähetetyt. Kutsutaan samassa transaktiossa poiston jälkeen, jolloin tehtävän ja viestien nykyinen
// sisältö kertoo, mitä poistettiin.
export function anonymizeOutboxForTicket(ticketId: string, erased: { text: string; name: string }) {
  const rows = db.prepare("SELECT event_id, entity_type, entity_id, payload FROM integration_outbox WHERE task_id = ?")
    .all(ticketId) as Pick<OutboxRow, "event_id" | "entity_type" | "entity_id" | "payload">[];
  if (!rows.length) return;
  const ticket = db.prepare("SELECT subject FROM tickets WHERE id = ?").get(ticketId) as { subject: string } | undefined;
  const files = new Set((db.prepare("SELECT filename FROM attachments WHERE ticket_id = ?").all(ticketId) as { filename: string }[])
    .map(file => file.filename));
  const messages = new Map((db.prepare("SELECT id, sender, body FROM messages WHERE ticket_id = ?").all(ticketId) as
    { id: string; sender: string; body: string }[]).map(message => [message.id, message]));
  const update = db.prepare("UPDATE integration_outbox SET payload = ? WHERE event_id = ?");

  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    if (row.entity_type === "task") {
      if (ticket?.subject === erased.text) {
        payload.title = erased.text;
        if (!payload.sensitive) payload.description = null;
      }
      // Arkaluonteisen tehtävän sanomassa ei ole liitteitä.
      if (Array.isArray(payload.attachments)) {
        payload.attachments = payload.attachments.filter((file: { fileName: string }) => files.has(file.fileName));
      }
    } else {
      const message = messages.get(row.entity_id);
      if (!message) continue;
      if (message.body === erased.text) payload.text = erased.text;
      if (message.sender === erased.name && payload.author) payload.author.name = erased.name;
    }
    const next = JSON.stringify(payload);
    if (next !== row.payload) update.run(next, row.event_id);
  }
}

// Tehtävän poisto: jonon sanomat ja ERP-tunnisteet poistetaan tehtävän mukana, jotta henkilötietoja ei
// jää jonoon. ERP:hen ei lähetetä poistoa (specissä ei ole task.deleted-tapahtumaa).
export function deleteOutboxForTicket(ticketId: string) {
  db.prepare("DELETE FROM integration_outbox WHERE task_id = ?").run(ticketId);
  db.prepare("DELETE FROM integration_refs WHERE task_id = ?").run(ticketId);
}
