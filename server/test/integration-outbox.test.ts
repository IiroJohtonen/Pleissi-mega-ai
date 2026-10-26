import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
import { after, before, describe, it } from "node:test";
import { call, login, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

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

  it("tehtävän luonti, muutokset ja muistiinpano lähtevät ERP:hen; nopeista muutoksista vain uusin", async () => {
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
    const comment = rows.find(row => row.event_type === "task.comment.added")!;
    assert.equal(comment.status, "sent");
    assert.equal(JSON.parse(comment.payload).visibility, "internal");
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
