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
