import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  ADMIN_EMAIL, call, login, MANAGER_EMAIL, OTHER_MANAGER_EMAIL, PASSWORD, startServer, tempDir, userByEmail, type TestServer
} from "./helpers.js";

describe("asukkaan tietojen vienti ja poisto", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
    // Asukkaalle portaalitunnus, jotta poiston vaikutus kirjautumiseen nähdään.
    const saved = await call(server, admin, "PUT", "/residents/resident-1", {
      name: "Matti Meikäläinen", email: "matti@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12", password: PASSWORD
    });
    assert.equal(saved.status, 200);
  });

  after(() => server.stop());

  it("vienti sisältää asukkaan tiedot ja hänen viestinsä", async () => {
    const exported = await call(server, manager, "GET", "/residents/resident-1/export");
    assert.equal(exported.status, 200);
    assert.equal(exported.data.resident.name, "Matti Meikäläinen");
    assert.equal(exported.data.resident.has_portal_account, true);
    assert.equal(exported.data.tickets.length, 4);
    const sauna = exported.data.tickets.find((ticket: any) => ticket.subject === "Saunavuoro");
    assert.equal(sauna.messages[0].body, "Miten saan varattua saunavuoron?");
  });

  it("poisto anonymisoi asukkaan ja hänen tehtävänsä", async () => {
    assert.equal((await login(server, "matti@example.com")).length > 0, true);
    assert.equal((await call(server, manager, "DELETE", "/residents/resident-1")).status, 200);

    const detail = (await call(server, manager, "GET", "/tickets/ticket-1")).data;
    assert.equal(detail.ticket.resident_name, "Poistettu asukas");
    assert.ok(detail.messages.every((message: any) => message.body === "[Poistettu]" && !message.sender.includes("Matti")));

    const residents = (await call(server, manager, "GET", "/companies/demo-company/residents")).data;
    assert.ok(!residents.some((resident: any) => resident.id === "resident-1"));
    assert.equal((await call(server, null, "POST", "/auth/login", { email: "matti@example.com", password: PASSWORD })).status, 401);
    assert.equal((await call(server, manager, "DELETE", "/residents/resident-1")).status, 404);
  });

  it("poisto näkyy pääkäyttäjän lokissa ilman nimeä", async () => {
    const audit = (await call(server, admin, "GET", "/audit")).data;
    const entry = audit.find((row: any) => row.action === "resident_erased");
    assert.ok(entry);
    assert.ok(!entry.details.includes("Matti"));
  });
});

describe("käyttäjän poisto", () => {
  let server: TestServer;
  let admin: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
  });

  after(() => server.stop());

  it("omaa tunnusta ei voi poistaa eikä muu kuin pääkäyttäjä voi poistaa", async () => {
    const me = (await call(server, admin, "GET", "/auth/me")).data;
    assert.equal((await call(server, admin, "DELETE", `/users/${me.id}`)).status, 400);
    const manager = await login(server, MANAGER_EMAIL);
    const other = await userByEmail(server, admin, OTHER_MANAGER_EMAIL);
    assert.equal((await call(server, manager, "DELETE", `/users/${other.id}`)).status, 403);
  });

  it("poistetun käyttäjän tehtävät ja yhtiöt siirtyvät eikä hän voi kirjautua", async () => {
    const me = (await call(server, admin, "GET", "/auth/me")).data;
    const other = await userByEmail(server, admin, OTHER_MANAGER_EMAIL);
    await call(server, admin, "PUT", "/companies/demo-company", { name: "As Oy Koivikko", managerId: other.id });
    const ticket = await call(server, admin, "POST", "/tickets", { companyId: "demo-company", subject: "Siirtyvä", summary: "Testi" });
    await call(server, admin, "PUT", `/tickets/${ticket.data.ticketId}/fields`, { assigneeId: other.id });

    assert.equal((await call(server, admin, "DELETE", `/users/${other.id}`)).status, 200);

    const company = (await call(server, admin, "GET", "/companies")).data.find((item: any) => item.id === "demo-company");
    assert.equal(company.manager_id, null);
    assert.equal((await call(server, admin, "GET", `/tickets/${ticket.data.ticketId}`)).data.ticket.assignee_id, me.id);
    assert.equal((await call(server, null, "POST", "/auth/login", { email: OTHER_MANAGER_EMAIL, password: PASSWORD })).status, 401);
  });
});

describe("säilytysaika", () => {
  it("poistaa säilytysaikaa kauemmin suljettuna olleet tehtävät tiedostoineen", async () => {
    const dataDir = await tempDir();
    let server = await startServer({ dataDir });
    const admin = await login(server, ADMIN_EMAIL);
    const office = (await call(server, admin, "GET", "/office")).data;
    assert.equal((await call(server, admin, "PUT", "/office", { name: office.name, retentionMonths: 24 })).data.retentionMonths, 24);
    await server.stop();

    // Kolme vuotta sitten suljettu tehtävä viesteineen ja liitteineen.
    const old = new Date(Date.now() - 3 * 365 * 86_400_000).toISOString();
    const db = new Database(path.join(dataDir, "kotilo.sqlite"));
    db.prepare(`
      INSERT INTO tickets (id, company_id, type, priority, status, subject, summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at)
      VALUES ('ticket-old', 'demo-company', 'Muu', 'normal', 'closed', 'Vanha', 'Vanha', 'manual', 'human', '', '', ?, ?)
    `).run(old, old);
    db.prepare("INSERT INTO messages VALUES ('message-old', 'ticket-old', 'inbound', 'X', 'Vanha', 'Teksti', ?, 'email')").run(old);
    db.prepare("INSERT INTO attachments (id, ticket_id, filename, mime_type, size, created_at) VALUES ('attachment-old', 'ticket-old', 'a.pdf', 'application/pdf', 4, ?)").run(old);
    db.close();
    const attachmentFile = path.join(dataDir, "attachments", "attachment-old");
    fs.writeFileSync(attachmentFile, "%PDF");

    // Poisto ajetaan palvelimen käynnistyessä.
    server = await startServer({ dataDir });
    try {
      const token = await login(server, ADMIN_EMAIL);
      for (let attempt = 0; attempt < 50 && fs.existsSync(attachmentFile); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(fs.existsSync(attachmentFile), false);
      assert.equal((await call(server, token, "GET", "/tickets/ticket-old")).status, 404);
      assert.equal((await call(server, token, "GET", "/tickets/ticket-1")).status, 200, "avoin tehtävä säilyy");
      const audit = (await call(server, token, "GET", "/audit")).data;
      assert.ok(audit.some((row: any) => row.action === "retention_purge"));
    } finally {
      await server.stop();
    }
  });
});
