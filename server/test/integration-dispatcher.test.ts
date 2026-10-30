import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { tempDir } from "./helpers.js";

// ERP-integraation jono ja lähetys ilman palvelinta: tietokanta omaan kansioon, mock-ERP ja lähetyskierrokset
// annetulla kellonajalla, jotta viiveet ja uudelleenyritykset voidaan testata odottamatta.

let db: typeof import("../src/db.js").db;
let processOutbox: typeof import("../src/integration/dispatcher.js").processOutbox;
let MockErpAdapter: typeof import("../src/integration/mock-adapter.js").MockErpAdapter;
let eraseResidentFromTicket: typeof import("../src/resident-erasure.js").eraseResidentFromTicket;
let deleteTicket: typeof import("../src/routes/tickets.js").deleteTicket;

const DELAY = 5_000;
const MINUTE = 60_000;
let seq = 0;

type Row = { event_id: string; event_type: string; entity_id: string; sequence: number; status: string; attempts: number;
  changed_fields: string | null; payload: string; superseded_by: string | null; last_status_code: number | null; next_attempt_at: string };

const rows = (taskId: string) => db.prepare("SELECT * FROM integration_outbox WHERE task_id = ? ORDER BY rowid").all(taskId) as Row[];
const erpId = (taskId: string) => (db.prepare("SELECT external_id FROM integration_refs WHERE entity_type = 'task' AND entity_id = ?")
  .get(taskId) as { external_id: string } | undefined)?.external_id;
// Lähetyskierros hetkellä, jolloin kaikista kirjauksista on kulunut viive (+ lisäaika).
const later = (extra = 0) => Date.now() + DELAY + 100 + extra;

function createTicket(fields: Record<string, unknown> = {}) {
  const ticketId = `ticket-int-${++seq}`;
  const timestamp = new Date().toISOString();
  const values = {
    id: ticketId, company_id: "company-int", apartment_id: "apartment-int", resident_id: "resident-int", type: "Vikailmoitus",
    priority: "normal", status: "open", subject: "Keittiön hana vuotaa", summary: "Hanasta tippuu vettä.", source_channel: "email",
    ai_action: "pending_decision", ai_reason: "", draft: "", created_at: timestamp, updated_at: timestamp, ...fields
  };
  db.prepare(`INSERT INTO tickets (${Object.keys(values).join(", ")}) VALUES (${Object.keys(values).map(() => "?").join(", ")})`)
    .run(...Object.values(values));
  return ticketId;
}

const update = (ticketId: string, set: string, ...params: unknown[]) =>
  db.prepare(`UPDATE tickets SET ${set}, updated_at = ? WHERE id = ?`).run(...params, new Date().toISOString(), ticketId);

function addMessage(ticketId: string, direction: string, sender: string, body: string, channel = "email") {
  const messageId = `message-int-${++seq}`;
  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(messageId, ticketId, direction, sender, "Aihe", body, new Date().toISOString(), channel);
  return messageId;
}

describe("ERP-integraation jono", () => {
  before(async () => {
    process.env.DATA_DIR = await tempDir("kotilo-integration-");
    process.env.GMAIL_DISABLED = "1";
    process.env.INTEGRATION_ADAPTER = "mock";
    process.env.INTEGRATION_TENANT_ID = "asiakas-001";
    process.env.INTEGRATION_SEND_DELAY_MS = String(DELAY);
    delete process.env.INTEGRATION_RETRY_DELAYS_MS;
    ({ db } = await import("../src/db.js"));
    await import("../src/integration/outbox.js");
    ({ processOutbox } = await import("../src/integration/dispatcher.js"));
    ({ MockErpAdapter } = await import("../src/integration/mock-adapter.js"));
    ({ eraseResidentFromTicket } = await import("../src/resident-erasure.js"));
    ({ deleteTicket } = await import("../src/routes/tickets.js"));

    db.prepare("INSERT INTO users (id, name, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("user-int", "Hanna Isännöitsijä", "hanna@example.com", "Isännöitsijä", "x", new Date().toISOString());
    db.prepare("INSERT INTO companies (id, name, email_address, manager_id) VALUES (?, ?, ?, ?)").run("company-int", "As Oy Koivikko", "koivikko@example.com", "user-int");
    db.prepare("INSERT INTO apartments (id, company_id, apartment_number, address, staircase) VALUES (?, ?, ?, ?, ?)")
      .run("apartment-int", "company-int", "B 8", "Koivukuja 4", "B");
    db.prepare("INSERT INTO residents (id, company_id, apartment_id, name, email) VALUES (?, ?, ?, ?, ?)")
      .run("resident-int", "company-int", "apartment-int", "Liisa Mattila", "liisa@example.com");
  });

  it("tehtävän luonti kirjautuu kanonisena sanomana samaan tietokantaan", () => {
    const ticketId = createTicket({ priority: "emergency", type: "Häiriöilmoitus" });
    const [created] = rows(ticketId);
    assert.equal(created.event_type, "task.created");
    assert.equal(created.sequence, 1);
    assert.equal(created.status, "pending");
    const task = JSON.parse(created.payload);
    assert.equal(task.id, ticketId);
    assert.deepEqual(task.externalRefs, { erp: null });
    assert.equal(task.title, "Keittiön hana vuotaa");
    assert.equal(task.priority, "critical");
    assert.equal(task.category, "complaint");
    assert.equal(task.status, "open");
    assert.equal(task.channel, "email");
    assert.equal(task.housingCompanyId, "company-int");
    assert.equal(task.residentId, "resident-int");
    assert.deepEqual(task.assignee, { type: "propertyManager", name: "Hanna Isännöitsijä" });
    assert.match(task.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[23]:00$/);
    const row = db.prepare("SELECT tenant_id, schema_version, source FROM integration_outbox WHERE event_id = ?").get(created.event_id) as any;
    assert.deepEqual({ ...row }, { tenant_id: "asiakas-001", schema_version: "1.0", source: "pleissi" });
  });

  it("tilat, kiireellisyydet ja kategoriat käännetään sovitusti", () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ status: "active" }, { status: "open" }],
      [{ status: "waiting_manager" }, { status: "in_progress" }],
      [{ status: "answered" }, { status: "waiting_resident" }],
      [{ status: "waiting_third_party" }, { status: "waiting_contractor" }],
      [{ status: "closed" }, { status: "closed" }],
      [{ priority: "urgent" }, { priority: "high" }],
      [{ priority: "low" }, { priority: "low" }],
      [{ type: "Kysymys" }, { category: "question" }],
      [{ type: "Vikailmoitus" }, { category: "maintenance" }],
      [{ type: "Asiakirjatilaus" }, { category: "other" }],
      [{ source_channel: "portal" }, { channel: "web_form" }],
      [{ source_channel: "manual" }, { channel: "manual" }],
      [{ ai_action: "ai" }, { assignee: { type: "ai", name: "Pleissi" } }]
    ];
    for (const [fields, expected] of cases) {
      const task = JSON.parse(rows(createTicket(fields))[0].payload);
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(task[key], value, JSON.stringify(fields));
    }
  });

  it("vain ERP:lle näkyvän tilan muutos kirjataan, ja muuttuneet kentät merkitään", () => {
    const ticketId = createTicket();
    update(ticketId, "draft = ?, ai_reason = ?", "Luonnos", "AI:n perustelu");
    assert.equal(rows(ticketId).length, 1, "AI-luonnos ei ole ERP:n tietoa");
    update(ticketId, "status = ?", "waiting_manager");
    const [, updated] = rows(ticketId);
    assert.equal(updated.event_type, "task.updated");
    assert.equal(updated.sequence, 2);
    assert.deepEqual(JSON.parse(updated.changed_fields!), ["status"]);
  });

  it("tunnistamaton, suodatettu ja remontti-ilmoitus eivät mene ERP:hen; tunnistettu kirjautuu luontina", () => {
    assert.equal(rows(createTicket({ ai_action: "filtered" })).length, 0);
    assert.equal(rows(createTicket({ kind: "renovation" })).length, 0);
    const pending = createTicket({ company_pending: 1 });
    addMessage(pending, "inbound", "Liisa Mattila <liisa@example.com>", "Hana vuotaa");
    assert.equal(rows(pending).length, 0);
    update(pending, "company_pending = 0");
    const queued = rows(pending);
    assert.deepEqual(queued.map(row => row.event_type), ["task.created", "task.comment.added"]);
  });

  it("viestit kirjautuvat kommentteina; työtilaukset ja sisäiset muistiinpanot eivät mene jonoon", () => {
    const ticketId = createTicket();
    addMessage(ticketId, "inbound", "Liisa Mattila <liisa@example.com>", "Hanasta tippuu vettä.");
    addMessage(ticketId, "outbound", "Hanna Isännöitsijä", "Tilasimme huollon.");
    addMessage(ticketId, "outbound", "Pleissi AI-agentti", "Varasin vuoron.", "portal");
    addMessage(ticketId, "outbound", "Hanna Isännöitsijä", "Työtilaus huoltoyhtiölle", "contractor");
    db.prepare("INSERT INTO ticket_notes VALUES (?, ?, ?, ?, ?)").run("note-int-1", ticketId, "Hanna Isännöitsijä", "Soitin asukkaalle.", new Date().toISOString());
    db.prepare("INSERT INTO ticket_notes VALUES (?, ?, ?, ?, ?)").run("note-int-2", ticketId, "Pleissi AI-agentti", "Siirsin henkilökunnalle.", new Date().toISOString());
    const comments = rows(ticketId).filter(row => row.event_type === "task.comment.added").map(row => JSON.parse(row.payload));
    assert.deepEqual(comments.map(comment => [comment.author.type, comment.author.name, comment.visibility, comment.text]), [
      ["resident", "Liisa Mattila", "public", "Hanasta tippuu vettä."],
      ["propertyManager", "Hanna Isännöitsijä", "public", "Tilasimme huollon."],
      ["ai", "Pleissi AI-agentti", "public", "Varasin vuoron."]
    ]);
    assert.ok(comments.every(comment => comment.taskId === ticketId));
    assert.ok(!rows(ticketId).some(row => row.entity_id.startsWith("note-int")), "muistiinpanot eivät ole jonossa");
    // Muistiinpano ei myöskään kasvata kommenttien määrää eikä synnytä päivitystä.
    update(ticketId, "status = ?", "waiting_manager");
    assert.equal(JSON.parse(rows(ticketId).at(-1)!.payload).commentCount, 3);
  });

  it("arkaluonteisesta tehtävästä lähtee vain tunnisteet, otsikko, tila ja sensitive: true", () => {
    const ticketId = createTicket({ sensitive: 1, subject: "Avainasia", summary: "Asukkaan sairaus", ticket_number: 9001 });
    addMessage(ticketId, "inbound", "Liisa Mattila", "Arkaluonteinen viesti");
    update(ticketId, "priority = ?, summary = ?", "urgent", "Lisää terveystietoa");
    const queued = rows(ticketId);
    assert.deepEqual(queued.map(row => row.event_type), ["task.created"], "kommentit ja piilotettujen kenttien muutokset eivät mene jonoon");
    assert.deepEqual(JSON.parse(queued[0].payload), {
      id: ticketId, externalRefs: { erp: null }, ticketNumber: 9001, title: "Avainasia", status: "open", sensitive: true
    });
    // Merkinnän poisto julkaisee koko tilan ja aiemmat viestit.
    update(ticketId, "sensitive = 0");
    const after = rows(ticketId);
    assert.deepEqual(after.map(row => row.event_type), ["task.created", "task.updated", "task.comment.added"]);
    const full = JSON.parse(after[1].payload);
    assert.equal(full.sensitive, false);
    assert.equal(full.description, "Lisää terveystietoa");
    assert.ok(JSON.parse(after[1].changed_fields!).includes("sensitive"));
  });

  it("tavallisessa tehtävässä on tehtävänumero ja sensitive: false", () => {
    const ticketId = createTicket();
    const task = JSON.parse(rows(ticketId)[0].payload);
    assert.equal(typeof task.ticketNumber, "number");
    assert.equal(task.sensitive, false);
  });

  it("lähetys odottaa viiveen, tallentaa ERP:n tunnisteen ja lähettää odottavista päivityksistä vain uusimman", async () => {
    const erp = new MockErpAdapter();
    const ticketId = createTicket();
    await processOutbox(erp, Date.now());
    assert.equal(erp.calls.length, 0, "viive ei ole vielä kulunut");
    await processOutbox(erp, later());
    assert.equal(rows(ticketId)[0].status, "sent");
    assert.match(erpId(ticketId)!, /^ERP-T-/);

    update(ticketId, "priority = ?", "urgent");
    update(ticketId, "type = ?", "Kysymys");
    update(ticketId, "status = ?", "waiting_manager");
    addMessage(ticketId, "outbound", "Hanna Isännöitsijä", "Selvitämme asiaa.");
    erp.calls.length = 0;
    await processOutbox(erp, later());

    const updates = rows(ticketId).filter(row => row.event_type === "task.updated");
    assert.deepEqual(updates.map(row => row.status), ["superseded", "superseded", "sent"]);
    const newest = updates[2];
    assert.ok(updates.slice(0, 2).every(row => row.superseded_by === newest.event_id));
    assert.deepEqual(JSON.parse(newest.changed_fields!).sort(), ["category", "priority", "status"]);
    assert.deepEqual(erp.calls.map(c => c.method), ["updateTask", "addComment"]);
    assert.equal(erp.calls[0].eventId, newest.event_id);
    assert.equal(erp.tasks.get(erpId(ticketId)!)!.status, "Kesken");
  });

  it("päivitykset ja kommentit odottavat, kunnes ERP on kuitannut luonnin", async () => {
    const erp = new MockErpAdapter([503]);
    const ticketId = createTicket();
    update(ticketId, "status = ?", "waiting_manager");
    addMessage(ticketId, "inbound", "Liisa Mattila", "Lisätietoa");
    await processOutbox(erp, later());
    assert.deepEqual(erp.calls.map(c => c.method), ["createTask"]);
    assert.deepEqual(rows(ticketId).map(row => row.status), ["pending", "pending", "pending"]);
    await processOutbox(erp, later(MINUTE));
    assert.deepEqual(erp.calls.map(c => c.method), ["createTask", "createTask", "updateTask", "addComment"]);
    assert.deepEqual(rows(ticketId).map(row => row.status), ["sent", "sent", "sent"]);
  });

  it("429, 5xx ja yhteysvirhe uusitaan 1, 5 ja 30 minuutin päästä, sitten failed ja merkintä tehtävälle", async () => {
    const erp = new MockErpAdapter();
    const ticketId = createTicket();
    await processOutbox(erp, later());
    update(ticketId, "status = ?", "answered");
    erp.fail(503, 429, 0, 500);
    const start = later();
    await processOutbox(erp, start);
    let [, row] = rows(ticketId);
    assert.equal(row.attempts, 1);
    assert.equal(Date.parse(row.next_attempt_at), start + MINUTE);

    await processOutbox(erp, start + MINUTE - 1);
    assert.equal(rows(ticketId)[1].attempts, 1, "ei yritetä ennen aikaa");
    await processOutbox(erp, start + MINUTE);
    await processOutbox(erp, start + 6 * MINUTE);
    [, row] = rows(ticketId);
    assert.equal(row.attempts, 3);
    assert.equal(row.status, "pending");
    assert.equal(Date.parse(row.next_attempt_at), start + 36 * MINUTE);
    await processOutbox(erp, start + 36 * MINUTE);
    [, row] = rows(ticketId);
    assert.equal(row.status, "failed");
    assert.equal(row.last_status_code, 500);
    const audit = db.prepare("SELECT details FROM audit_log WHERE ticket_id = ? AND action = 'integration_failed'").get(ticketId) as { details: string };
    assert.equal(JSON.parse(audit.details).status, 500);
  });

  it("uudempi päivitys korvaa uudelleenyritystä odottavan ja lähtee seuraavalla yrityksellä", async () => {
    const erp = new MockErpAdapter();
    const ticketId = createTicket();
    await processOutbox(erp, later());
    update(ticketId, "status = ?", "waiting_manager");
    erp.fail(503);
    const start = later();
    await processOutbox(erp, start);
    update(ticketId, "priority = ?", "low");
    await processOutbox(erp, later());
    assert.equal(rows(ticketId).filter(row => row.status === "sent").length, 1, "odottaa ensimmäisen uudelleenyrityksen aikaa");
    await processOutbox(erp, Math.max(start + MINUTE, later()));
    const updates = rows(ticketId).filter(row => row.event_type === "task.updated");
    assert.deepEqual(updates.map(row => row.status), ["superseded", "sent"]);
    assert.deepEqual(JSON.parse(updates[1].changed_fields!).sort(), ["priority", "status"]);
    assert.equal(updates[1].attempts, 1, "yrityskerrat eivät ala alusta");
  });

  it("400 ja 409 merkitään heti epäonnistuneiksi ilman uudelleenyritystä", async () => {
    for (const status of [400, 409]) {
      const erp = new MockErpAdapter();
      const ticketId = createTicket();
      await processOutbox(erp, later());
      update(ticketId, "status = ?", "closed");
      erp.fail(status);
      await processOutbox(erp, later());
      const [, row] = rows(ticketId);
      assert.equal(row.status, "failed");
      assert.equal(row.attempts, 1);
      assert.equal(row.last_status_code, status);
    }
  });

  it("401 ja 403 nostavat hälytyksen, eikä riviä hylätä vaan se lähtee, kun avain toimii", async () => {
    const erp = new MockErpAdapter([401, 401]);
    const ticketId = createTicket();
    const start = later();
    await processOutbox(erp, start);
    await processOutbox(erp, start + 5 * MINUTE);
    assert.equal(rows(ticketId)[0].status, "pending");
    assert.equal(rows(ticketId)[0].attempts, 0);
    const alert = db.prepare("SELECT resolved_at FROM system_alerts WHERE kind = 'integration:auth'").get() as { resolved_at: string | null };
    assert.equal(alert.resolved_at, null);
    await processOutbox(erp, start + 10 * MINUTE);
    assert.equal(rows(ticketId)[0].status, "sent");
    assert.equal((db.prepare("SELECT COUNT(*) AS open FROM system_alerts WHERE kind = 'integration:auth' AND resolved_at IS NULL").get() as { open: number }).open, 0);
  });

  it("kommentit lähtevät yksitellen järjestyksessä, eikä epäonnistunut ohita aiempaa", async () => {
    const erp = new MockErpAdapter();
    const ticketId = createTicket();
    await processOutbox(erp, later());
    const first = addMessage(ticketId, "inbound", "Liisa Mattila", "Ensimmäinen");
    addMessage(ticketId, "inbound", "Liisa Mattila", "Toinen");
    erp.fail(503);
    erp.calls.length = 0;
    const start = later();
    await processOutbox(erp, start);
    assert.equal(erp.calls.length, 1, "toinen odottaa ensimmäistä");
    await processOutbox(erp, start + MINUTE);
    assert.deepEqual(erp.comments.filter(c => c.erpTaskId === erpId(ticketId)).map(c => c.text), ["Ensimmäinen", "Toinen"]);
    assert.ok(db.prepare("SELECT 1 FROM integration_refs WHERE entity_type = 'comment' AND entity_id = ?").get(first));
  });

  it("asukastietojen poisto anonymisoi jonon sanomat, myös jo lähetetyt", async () => {
    const erp = new MockErpAdapter();
    const ticketId = createTicket();
    addMessage(ticketId, "inbound", "Liisa Mattila <liisa@example.com>", "Asuntoni B 8 hana vuotaa.");
    addMessage(ticketId, "outbound", "Hanna Isännöitsijä", "Hei Liisa, huolto tulee.");
    db.prepare("INSERT INTO attachments (id, ticket_id, filename, mime_type, size, created_at, direction) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("attachment-int", ticketId, "liisan-hana.jpg", "image/jpeg", 10, new Date().toISOString(), "inbound");
    update(ticketId, "status = ?", "answered");
    await processOutbox(erp, later());

    db.transaction(() => eraseResidentFromTicket(ticketId, { id: "resident-int", name: "Liisa Mattila", email: "liisa@example.com" }))();
    const all = JSON.stringify(rows(ticketId).map(row => row.payload));
    for (const text of ["Liisa", "Keittiön hana", "Hanasta tippuu", "liisan-hana.jpg", "B 8 hana"]) assert.ok(!all.includes(text), text);
    const last = rows(ticketId).at(-1)!;
    assert.equal(last.event_type, "task.updated", "anonymisoitu tila lähtee myös ERP:hen");
    assert.equal(last.status, "pending");
    assert.equal(JSON.parse(last.payload).title, "[Poistettu]");
  });

  it("tehtävän poisto poistaa sen sanomat ja ERP-tunnisteet jonosta", async () => {
    const erp = new MockErpAdapter();
    const ticketId = createTicket();
    addMessage(ticketId, "inbound", "Liisa Mattila", "Viesti");
    await processOutbox(erp, later());
    assert.ok(erpId(ticketId));
    await deleteTicket(ticketId);
    assert.equal(rows(ticketId).length, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM integration_refs WHERE task_id = ?").get(ticketId) as { count: number }).count, 0);
  });

  it("AI-kommenttien tekijä vastaa AI-agentin nimeä", async () => {
    const { AGENT_ACTOR } = await import("../src/ai-agent.js");
    const { AI_AUTHOR } = await import("../src/integration/mapping.js");
    assert.equal(AI_AUTHOR, AGENT_ACTOR);
  });
});
