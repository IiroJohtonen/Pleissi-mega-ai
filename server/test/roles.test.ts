import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ADMIN_EMAIL, call, login, MANAGER_EMAIL, OTHER_MANAGER_EMAIL, SERVICE_EMAIL, startServer, userByEmail, type TestServer
, inbound as postInbound } from "./helpers.js";

describe("roolit ja yhtiönäkyvyys", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;
  let service: string;
  let otherCompany: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
    service = await login(server, SERVICE_EMAIL);

    // Toinen yhtiö, jonka vastuuisännöitsijä on joku muu kuin testin isännöitsijä.
    const created = await call(server, admin, "POST", "/companies", { name: "As Oy Testi" });
    assert.equal(created.status, 201);
    otherCompany = created.data.companyId;
    const otherManager = await userByEmail(server, admin, OTHER_MANAGER_EMAIL);
    await call(server, admin, "PUT", `/companies/${otherCompany}`, { name: "As Oy Testi", managerId: otherManager.id });
  });

  after(() => server.stop());

  it("kaikkien yhtiöiden tehtävät haetaan yhdellä haulla vain näkyvistä yhtiöistä", async () => {
    await postInbound(server, admin, {
      companyId: otherCompany, senderName: "Asukas", subject: "Testiyhtiön vika", body: "Ovi ei sulkeudu.", channel: "email"
    });
    const adminRows = (await call(server, admin, "GET", "/tickets?companyId=all")).data as any[];
    const companiesSeen = new Set(adminRows.map(row => row.company_id));
    assert.ok(companiesSeen.has("demo-company") && companiesSeen.has(otherCompany));
    assert.equal(adminRows.find(row => row.company_id === otherCompany).company_name, "As Oy Testi");

    // Isännöitsijä ei näe toisen vastuuisännöitsijän yhtiötä.
    const managerRows = (await call(server, manager, "GET", "/tickets?companyId=all")).data as any[];
    assert.ok(managerRows.length > 0);
    assert.ok(managerRows.every(row => row.company_id !== otherCompany));
  });

  it("kirjautumaton ei pääse rajapintaan", async () => {
    assert.equal((await call(server, null, "GET", "/companies")).status, 401);
  });

  it("isännöitsijä näkee vain omat ja vastuuisännöitsijättömät yhtiöt", async () => {
    const companies = (await call(server, manager, "GET", "/companies")).data;
    assert.deepEqual(companies.map((company: any) => company.id), ["demo-company"]);
  });

  it("isännöitsijä ei pääse toisen yhtiön tietoihin", async () => {
    assert.equal((await call(server, manager, "GET", `/tickets?companyId=${otherCompany}`)).status, 403);
    assert.equal((await call(server, manager, "GET", `/companies/${otherCompany}/residents`)).status, 403);
    assert.equal((await call(server, manager, "GET", `/companies/${otherCompany}/knowledge`)).status, 403);
  });

  it("muuksi isännöitsijäksi lisätty näkee yhtiön", async () => {
    const user = await userByEmail(server, admin, MANAGER_EMAIL);
    await call(server, admin, "PUT", `/companies/${otherCompany}`, { name: "As Oy Testi", managerIds: [user.id] });
    assert.equal((await call(server, manager, "GET", "/companies")).data.length, 2);
    await call(server, admin, "PUT", `/companies/${otherCompany}`, { name: "As Oy Testi", managerIds: [] });
    assert.equal((await call(server, manager, "GET", "/companies")).data.length, 1);
  });

  it("asiakaspalvelu näkee kaikki yhtiöt", async () => {
    assert.equal((await call(server, service, "GET", "/companies")).data.length, 2);
  });

  it("asiakaspalvelu ei voi tehdä isännöitsijän toimintoja", async () => {
    const denied: [string, string, unknown?][] = [
      ["POST", "/companies", { name: "Ei saa" }],
      ["PUT", "/companies/demo-company", { name: "Muutettu" }],
      ["GET", "/audit"],
      ["POST", "/companies/demo-company/knowledge/facts", { question: "a", answer: "b" }],
      ["POST", "/companies/demo-company/announcements", { title: "Testi", body: "Tiedote asukkaille" }],
      ["POST", "/companies/demo-company/billing-periods", { kind: "sauna", month: "2026-01", total: 1, prices: {}, rows: [{ name: "a", apartment: "A 1", detail: "", total: 1 }] }],
      ["GET", "/residents/resident-1/export"],
      ["DELETE", "/residents/resident-1"]
    ];
    for (const [method, route, body] of denied) {
      assert.equal((await call(server, service, method, route, body)).status, 403, `${method} ${route}`);
    }
  });

  it("asiakaspalvelu voi tehdä päivittäisen työn", async () => {
    assert.equal((await call(server, service, "GET", "/companies/demo-company/knowledge")).status, 200);
    const ticket = await call(server, service, "POST", "/tickets", { companyId: "demo-company", subject: "Lamppu", summary: "Rapun lamppu" });
    assert.equal(ticket.status, 201);
    assert.equal((await call(server, service, "POST", `/tickets/${ticket.data.ticketId}/notes`, { body: "Soitettu huoltoon" })).status, 201);
    const resident = await call(server, service, "POST", "/companies/demo-company/residents", { name: "Uusi Asukas", address: "Koivikkotie 10", apartmentNumber: "C 1" });
    assert.equal(resident.status, 201);
  });

  it("isännöitsijä voi muokata tietopankkia ja nähdä lokin", async () => {
    const fact = await call(server, manager, "POST", "/companies/demo-company/knowledge/facts", { question: "Missä pyykkitupa on?", answer: "Kellarissa." });
    assert.equal(fact.status, 201);
    const audit = await call(server, manager, "GET", "/audit");
    assert.equal(audit.status, 200);
    assert.ok(audit.data.every((row: any) => row.ticket_id !== null), "tehtävään liittymättömät rivit näkyvät vain pääkäyttäjälle");
  });

  it("vain pääkäyttäjä muuttaa toimiston asetuksia ja käyttäjiä", async () => {
    assert.equal((await call(server, manager, "PUT", "/office", { name: "X", retentionMonths: 1 })).status, 403);
    assert.equal((await call(server, manager, "POST", "/users", { name: "A", email: "a@example.com", role: "Isännöitsijä", password: "salasana123" })).status, 403);
    const office = await call(server, admin, "GET", "/office");
    assert.equal(office.data.reminderEmails, 0);
    assert.equal(office.data.retentionMonths, 0);
  });
});
