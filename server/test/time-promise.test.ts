import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, OTHER_MANAGER_EMAIL, PASSWORD, startServer, type TestServer } from "./helpers.js";

// Aikalupaus: AI-agentin siirtäessä tehtävän asukkaalle kerrotaan päivä (tehtävän määräajasta, ei kellonaikaa),
// vastuuisännöitsijää muistutetaan ennen lupauspäivää, ja Trendit näyttää, kuinka usein lupaukset pitävät.

const finnish = (day: string) => {
  const date = new Date(`${day}T12:00:00Z`);
  return `${["su", "ma", "ti", "ke", "to", "pe", "la"][date.getUTCDay()]} ${date.getUTCDate()}.${date.getUTCMonth() + 1}.`;
};

describe("aikalupaus asukkaalle", () => {
  let server: TestServer;
  let claude: http.Server;
  let env: Record<string, string>;
  let admin: string;
  let matti: string;

  before(async () => {
    // Aiheen tarkistus: korvausasia kuuluu henkilökunnalle, joten agentti siirtää tehtävän.
    claude = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_test", type: "message", role: "assistant", model: "claude-haiku-5-5",
          content: [{ type: "text", text: JSON.stringify({ category: "compensation", reason: "Asukas vaatii korvausta." }) }],
          stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
        }));
      });
    });
    await new Promise<void>(resolve => claude.listen(0, "127.0.0.1", resolve));
    env = { ANTHROPIC_API_KEY: "testiavain", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(claude.address() as AddressInfo).port}` };
    server = await startServer({ env });
    admin = await login(server, ADMIN_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-1", {
      name: "Matti Meikäläinen", email: "matti@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12", password: PASSWORD
    });
    matti = await login(server, "matti@example.com");
    await call(server, admin, "PUT", "/office", { name: "Testitoimisto", aiAgent: true });
    await call(server, admin, "PUT", "/agent/settings", { autoStart: true });
  });

  after(async () => {
    await server.stop();
    await new Promise(resolve => claude.close(resolve));
  });

  async function waitFor(ticketId: string, action: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
      if ((detail.audit as any[]).some(entry => entry.action === action)) return detail;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail(`Merkintää ${action} ei tullut`);
  }

  it("lupaus luonnokseksi vain asetuksella; uusi päivä määräajan siirrossa; muistutus myös varahenkilölle; mittari", async () => {
    // Asetus on oletuksena pois, ja sen voi kytkeä päälle vain automaattisen käynnistyksen ollessa päällä.
    assert.equal((await call(server, admin, "GET", "/agent/settings")).data.timePromise, false);
    await call(server, admin, "PUT", "/agent/settings", { autoStart: false });
    assert.equal((await call(server, admin, "PUT", "/agent/settings", { timePromise: true })).status, 409);
    await call(server, admin, "PUT", "/agent/settings", { autoStart: true });
    assert.equal((await call(server, admin, "PUT", "/agent/settings", { timePromise: true })).data.timePromise, true);

    const created = await call(server, matti, "POST", "/portal/tickets", {
      subject: "Pesukone", description: "Vaadin korvausta pesukoneen rikkoutumisesta.", type: "Pyyntö", attachments: []
    });
    assert.equal(created.status, 201);
    const ticketId = created.data.ticketId as string;
    const detail = await waitFor(ticketId, "time_promise_drafted");
    assert.ok(detail.ticket.due_date, "tehtävällä on määräaika");
    assert.equal(detail.ticket.promise_draft_date, detail.ticket.due_date);
    assert.equal(detail.ticket.promised_date, null, "lupaus kirjataan vasta lähetettäessä");
    const label = finnish(detail.ticket.due_date).replace(/\./g, "\\.");
    assert.match(detail.ticket.draft, new RegExp(`palaamme siihen viimeistään ${label}`));
    assert.doesNotMatch(detail.ticket.draft, /klo/, "ei kellonaikaa");
    assert.ok(!(detail.messages as any[]).some(message => message.direction === "outbound"), "asukkaalle ei lähtenyt mitään");

    // Käsittelijä lähetti lupauksen (sähköposti ei ole testissä käytössä, joten lähetys kirjataan kuten recordSentPromise).
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    const users = (await call(server, admin, "GET", "/users")).data as { id: string; email: string; name: string }[];
    const backup = users.find(user => user.email === OTHER_MANAGER_EMAIL)!;
    let db = new Database(path.join(server.dataDir, "kotilo.sqlite"));
    try {
      db.prepare("UPDATE tickets SET promised_date = due_date, promised_at = ?, promise_draft_date = NULL, draft = '' WHERE id = ?").run(sentAt, ticketId);
      db.prepare("INSERT OR REPLACE INTO company_managers (company_id, user_id, backup) VALUES ('demo-company', ?, 1)").run(backup.id);
    } finally {
      db.close();
    }
    assert.ok((await call(server, admin, "GET", "/companies")).data.find((company: any) => company.id === "demo-company").backup_ids.includes(backup.id));

    // Määräajan siirto: luonnokseen ilmoitus uudesta päivästä.
    const later = new Date(Date.now() + 20 * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });
    assert.equal((await call(server, admin, "PUT", `/tickets/${ticketId}/fields`, { dueDate: later })).status, 200);
    const moved = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.match(moved.ticket.draft, new RegExp(`käsittely on siirtynyt\\. Palaamme siihen viimeistään ${finnish(later).replace(/\./g, "\\.")}`));
    assert.equal(moved.ticket.promise_draft_date, later);

    // Avoin lupaus näkyy mittarissa.
    let promises = (await call(server, admin, "GET", "/reports/trends?companyId=demo-company&months=3")).data.promises;
    assert.deepEqual([promises.promises, promises.open, promises.kept], [1, 1, 0]);

    // Lupauspäivä on huomenna: palvelimen käynnistyessä ajettava muistutus menee vastuuisännöitsijälle ja varahenkilölle.
    await server.stop();
    db = new Database(path.join(server.dataDir, "kotilo.sqlite"));
    try {
      const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });
      db.prepare("UPDATE tickets SET promised_date = ? WHERE id = ?").run(tomorrow, ticketId);
    } finally {
      db.close();
    }
    server = await startServer({ dataDir: server.dataDir, env });
    admin = await login(server, ADMIN_EMAIL);
    const reminded = await waitFor(ticketId, "time_promise_reminder_failed").catch(() => waitFor(ticketId, "time_promise_reminder_sent"));
    assert.ok(reminded.ticket.promise_reminded_at);
    const targets = (reminded.audit as any[]).filter(entry => entry.action.startsWith("time_promise_reminder")).map(entry => JSON.parse(entry.details).to);
    assert.ok(targets.includes(backup.name), `varahenkilö: ${JSON.stringify(targets)}`);

    // Käsittelijä vastaa ennen lupauspäivää: lupaus piti.
    const replied = await call(server, admin, "POST", `/tickets/${ticketId}/message`, { sender: "Isännöitsijä", body: "Selvitämme asian.", channel: "portal" });
    assert.equal(replied.status, 200);
    promises = (await call(server, admin, "GET", "/reports/trends?companyId=demo-company&months=3")).data.promises;
    assert.deepEqual([promises.promises, promises.kept, promises.keptShare], [1, 1, 1]);
  });
});
