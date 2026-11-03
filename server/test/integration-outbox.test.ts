import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

// ERP-integraatio käynnissä olevassa palvelimessa: sovelluksen omat toiminnot kirjaavat jonoon, ja
// taustatyö lähettää mock-ERP:hen. Ilman INTEGRATION_ADAPTER-asetusta jonoon ei kirjata mitään.

type Row = { event_type: string; status: string; payload: string; changed_fields: string | null };

function outbox(server: TestServer, taskId: string) {
  const db = new Database(path.join(server.dataDir, "kotilo.sqlite"), { readonly: true });
  try {
    return db.prepare("SELECT event_type, status, payload, changed_fields FROM integration_outbox WHERE task_id = ? ORDER BY rowid").all(taskId) as Row[];
  } finally {
    db.close();
  }
}

async function until<T>(read: () => T, ready: (value: T) => boolean, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Ei valmistunut ajoissa: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

describe("ERP-integraatio palvelimessa", () => {
  let server: TestServer;
  let service: string;

  before(async () => {
    server = await startServer({
      env: { INTEGRATION_ADAPTER: "mock", INTEGRATION_TENANT_ID: "asiakas-001", INTEGRATION_SEND_DELAY_MS: "600", INTEGRATION_POLL_MS: "100" }
    });
    service = await login(server, SERVICE_EMAIL);
  });

  after(async () => {
    await server.stop();
  });

  it("tehtävän luonti ja muutokset lähtevät ERP:hen, muistiinpano ei; nopeista muutoksista vain uusin", async () => {
    const created = await call(server, service, "POST", "/tickets", {
      companyId: "demo-company", subject: "Porraskäytävän valo ei pala", summary: "B-portaan valo on rikki.", type: "Vikailmoitus"
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const taskId = created.data.ticketId;
    await until(() => outbox(server, taskId), rows => rows[0]?.status === "sent");

    await call(server, service, "POST", `/tickets/${taskId}/decision`, { decision: "human" });
    await call(server, service, "PUT", `/tickets/${taskId}/fields`, { priority: "urgent" });
    await call(server, service, "POST", `/tickets/${taskId}/notes`, { body: "Huoltoyhtiö käy huomenna." });

    const rows = await until(() => outbox(server, taskId), all => all.length > 1 && all.every(row => row.status !== "pending"));
    const updates = rows.filter(row => row.event_type === "task.updated");
    assert.equal(updates.filter(row => row.status === "sent").length, 1, JSON.stringify(rows.map(row => [row.event_type, row.status])));
    const sent = updates.find(row => row.status === "sent")!;
    assert.equal(JSON.parse(sent.payload).priority, "high");
    assert.ok(JSON.parse(sent.changed_fields!).includes("priority"));
    assert.ok(!rows.some(row => row.event_type === "task.comment.added"), "sisäinen muistiinpano ei mene jonoon");
  });

  it("integraatioloki näyttää sanomat tiloineen pääkäyttäjälle, ja sanoman avaus kirjautuu lokiin", async () => {
    const admin = await login(server, ADMIN_EMAIL);
    for (const email of [SERVICE_EMAIL, MANAGER_EMAIL]) {
      assert.equal((await call(server, await login(server, email), "GET", "/integration/messages")).status, 403);
    }
    const list = await call(server, admin, "GET", "/integration/messages");
    assert.equal(list.status, 200);
    assert.equal(list.data.adapter, "mock");
    assert.ok(list.data.counts.sent > 0);
    const message = list.data.messages.find((row: any) => row.event_type === "task.created");
    assert.ok(message.ticket_number);
    assert.equal(message.payload, undefined, "lista ei sisällä sanomien sisältöä");

    const sent = await call(server, admin, "GET", "/integration/messages?status=sent");
    assert.ok(sent.data.messages.every((row: any) => row.status === "sent"));
    assert.equal((await call(server, admin, "GET", "/integration/messages?status=foo")).status, 400);

    const opened = await call(server, admin, "GET", `/integration/messages/${encodeURIComponent(message.event_id)}`);
    assert.equal(opened.status, 200);
    const envelope = opened.data.envelope;
    assert.equal(envelope.eventId, message.event_id);
    assert.equal(envelope.eventType, "task.created");
    assert.equal(envelope.tenantId, "asiakas-001");
    assert.match(envelope.data.externalRefs.erp, /^ERP-T-/);
    assert.equal(envelope.data.id, message.task_id);

    const audit = (await call(server, admin, "GET", "/audit")).data as { action: string; ticket_id: string }[];
    assert.ok(audit.some(entry => entry.action === "integration_message_viewed" && entry.ticket_id === message.task_id));
    assert.equal((await call(server, admin, "GET", "/integration/messages/evt-tuntematon")).status, 404);
  });
});

describe("ERP-integraatio pois päältä", () => {
  let server: TestServer;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.stop();
  });

  it("jonoon ei kirjata mitään", async () => {
    const service = await login(server, SERVICE_EMAIL);
    const created = await call(server, service, "POST", "/tickets", { companyId: "demo-company", subject: "Testi", summary: "Testi" });
    assert.equal(outbox(server, created.data.ticketId).length, 0);
  });
});
