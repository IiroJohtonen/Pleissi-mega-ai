import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ADMIN_EMAIL, call, login, MANAGER_EMAIL, OTHER_MANAGER_EMAIL, SERVICE_EMAIL, startServer, userByEmail, type TestServer
} from "./helpers.js";

describe("arkaluonteisen tehtävän pääsynrajaus", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;
  let otherManager: string;
  let service: string;
  let ticketId: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
    otherManager = await login(server, OTHER_MANAGER_EMAIL);
    service = await login(server, SERVICE_EMAIL);
    // Hanna on vastuuisännöitsijä ja Mikko taloyhtiön muu isännöitsijä.
    const hanna = await userByEmail(server, admin, MANAGER_EMAIL);
    const mikko = await userByEmail(server, admin, OTHER_MANAGER_EMAIL);
    const saved = await call(server, admin, "PUT", "/companies/demo-company", { name: "As Oy Koivikko", managerId: hanna.id, managerIds: [mikko.id] });
    assert.equal(saved.status, 200);

    const created = await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Matti Meikäläinen", senderEmail: "matti@example.com",
      subject: "Home kylpyhuoneessa", body: "Lapsellani on astma ja epäilen hometta.", channel: "email"
    });
    ticketId = created.data.ticketId;
  });

  after(() => server.stop());

  it("vastuuisännöitsijä ja pääkäyttäjä näkevät tehtävän, ja avaus kirjataan kerran päivässä", async () => {
    for (const token of [manager, manager, admin]) {
      assert.equal((await call(server, token, "GET", `/tickets/${ticketId}`)).status, 200);
    }
    const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.equal(detail.ticket.subject, "Home kylpyhuoneessa");
    const views = detail.audit.filter((row: any) => row.action === "sensitive_viewed").map((row: any) => row.actor);
    assert.equal(views.length, 2);
    assert.equal(new Set(views).size, 2);
  });

  it("muu isännöitsijä ja asiakaspalvelu eivät näe sisältöä missään", async () => {
    for (const token of [otherManager, service]) {
      const opened = await call(server, token, "GET", `/tickets/${ticketId}`);
      assert.equal(opened.status, 403);
      assert.equal(opened.data.restricted, true);

      // Listassa tehtävä näkyy ilman sisältöä ja asukkaan nimeä.
      const row = ((await call(server, token, "GET", "/tickets?companyId=demo-company")).data as any[]).find(item => item.id === ticketId);
      assert.equal(row.restricted, true);
      assert.equal(row.subject, "Arkaluonteinen tehtävä");
      assert.equal(row.summary, "");
      assert.equal(row.resident_name, null);

      const search = (await call(server, token, "GET", "/search?q=astma")).data;
      assert.ok(!search.tickets.some((ticket: any) => ticket.id === ticketId));
      assert.equal((await call(server, token, "POST", `/tickets/${ticketId}/suggest`, {})).status, 404);
      assert.equal((await call(server, token, "PUT", `/tickets/${ticketId}/fields`, { priority: "low" })).status, 404);
    }
    const log = (await call(server, otherManager, "GET", "/audit")).data as any[];
    const rows = log.filter(row => row.ticket_id === ticketId);
    assert.ok(rows.length > 0);
    assert.ok(rows.every(row => row.ticket_subject === "Arkaluonteinen tehtävä" && row.details === "{}"));
  });

  it("käsittelijäksi annettu näkee tehtävän", async () => {
    const mikko = await userByEmail(server, admin, OTHER_MANAGER_EMAIL);
    assert.equal((await call(server, admin, "PUT", `/tickets/${ticketId}/fields`, { assigneeId: mikko.id })).status, 200);
    assert.equal((await call(server, otherManager, "GET", `/tickets/${ticketId}`)).status, 200);
    assert.equal((await call(server, service, "GET", `/tickets/${ticketId}`)).status, 403);
  });
});
