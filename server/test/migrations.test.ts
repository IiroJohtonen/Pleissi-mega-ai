import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { call, login, MANAGER_EMAIL, startServer, tempDir } from "./helpers.js";

describe("vanhojen remontti-ilmoitusten siirto tehtäviksi", () => {
  it("ilmoitus saa tehtävän, ja tila ja päätösteksti säilyvät", async () => {
    const dataDir = await tempDir();
    // Tietokannassa on remonttitaulu vanhassa muodossa, jossa asukas ja päivät ovat pakollisia.
    const db = new Database(path.join(dataDir, "kotilo.sqlite"));
    db.exec(`
      CREATE TABLE renovation_notices (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, apartment_id TEXT NOT NULL, resident_id TEXT NOT NULL,
        work_type TEXT NOT NULL, description TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        contractor TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', decision_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, completed_at TEXT
      )
    `);
    db.prepare(`
      INSERT INTO renovation_notices
        (id, company_id, apartment_id, resident_id, work_type, description, start_date, end_date, contractor,
         status, decision_note, created_at, decided_by, decided_at)
      VALUES ('renovation-old', 'demo-company', 'apt-34', 'resident-2', 'Sähkötyöt', 'Keittiön sähköt uusitaan.',
              '2026-01-10', '2026-01-20', 'Sähkö Oy', 'approved', 'Sähkösuunnitelma toimitettava.', '2026-01-01T10:00:00.000Z',
              'Hanna Lehtonen', '2026-01-02T10:00:00.000Z')
    `).run();
    db.close();

    const server = await startServer({ dataDir });
    try {
      const manager = await login(server, MANAGER_EMAIL);
      const [notice] = (await call(server, manager, "GET", "/companies/demo-company/renovations")).data as any[];
      assert.equal(notice.status, "approved");
      assert.equal(notice.decision_note, "Sähkösuunnitelma toimitettava.");
      assert.equal(notice.work_type, "Sähkö");
      assert.ok(notice.ticket_id);

      const detail = (await call(server, manager, "GET", `/tickets/${notice.ticket_id}`)).data;
      assert.equal(detail.ticket.kind, "renovation");
      assert.equal(detail.ticket.created_at, "2026-01-01T10:00:00.000Z");
      const approved = detail.audit.find((row: any) => row.action === "renovation_approved");
      assert.equal(approved.created_at, "2026-01-02T10:00:00.000Z");
      assert.match(approved.details, /Sähkösuunnitelma/);
    } finally {
      await server.stop();
    }

    // Uusi käynnistys ei luo tehtävää uudelleen.
    const again = await startServer({ dataDir });
    try {
      const manager = await login(again, MANAGER_EMAIL);
      const tickets = (await call(again, manager, "GET", "/tickets?companyId=demo-company")).data as any[];
      assert.equal(tickets.filter(ticket => ticket.kind === "renovation").length, 1);
    } finally {
      await again.stop();
    }
  });
});

describe("varaustoiveiden siirto jonopaikoiksi", () => {
  it("tulevan vuoron toive muuttuu jonopaikaksi ja mennyt suljetaan", async () => {
    const dataDir = await tempDir();
    const db = new Database(path.join(dataDir, "kotilo.sqlite"));
    db.exec(`
      CREATE TABLE booking_requests (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, resource TEXT NOT NULL, resident_id TEXT NOT NULL,
        starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        decision_note TEXT NOT NULL DEFAULT '', decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL
      )
    `);
    const future = new Date(Date.now() + 5 * 86_400_000);
    future.setUTCHours(15, 0, 0, 0);
    const insert = db.prepare(`
      INSERT INTO booking_requests (id, company_id, resource, resident_id, starts_at, ends_at, status, created_at)
      VALUES (?, 'demo-company', 'sauna', 'resident-2', ?, ?, 'pending', '2026-01-01T10:00:00.000Z')
    `);
    insert.run("request-future", future.toISOString(), new Date(future.getTime() + 3_600_000).toISOString());
    insert.run("request-past", "2026-01-05T15:00:00.000Z", "2026-01-05T16:00:00.000Z");
    db.close();

    const server = await startServer({ dataDir });
    try {
      const manager = await login(server, MANAGER_EMAIL);
      const queue = (await call(server, manager, "GET", "/companies/demo-company/booking-queue")).data as any[];
      assert.equal(queue.length, 1);
      assert.equal(queue[0].starts_at, future.toISOString());
      assert.equal(queue[0].resident_name, "Liisa Mallikas");
      assert.equal(queue[0].position, 1);
    } finally {
      await server.stop();
    }
    const after = new Database(path.join(dataDir, "kotilo.sqlite"));
    const statuses = after.prepare("SELECT id, status FROM booking_requests ORDER BY id").all();
    after.close();
    assert.deepEqual(statuses, [{ id: "request-future", status: "queued" }, { id: "request-past", status: "cancelled" }]);
  });
});
