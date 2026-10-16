import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, localDate, login, PASSWORD, startServer, type TestServer } from "./helpers.js";

// Jokainen reittitiedosto vastaa: varmistaa, että kaikki reitittimet on kytketty ja polut ovat oikein.
describe("reitit vastaavat", () => {
  let server: TestServer;
  let admin: string;
  let resident: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34", password: PASSWORD
    });
    resident = await login(server, "liisa@example.com");
  });

  after(() => server.stop());

  const from = encodeURIComponent(new Date().toISOString());
  const to = encodeURIComponent(new Date(Date.now() + 7 * 86_400_000).toISOString());

  it("henkilökunnan lukureitit", async () => {
    const month = localDate().slice(0, 7);
    const routes = [
      "/auth/me", "/users", "/office", "/audit", "/companies", "/gmail/status",
      "/tickets?companyId=demo-company", "/my-tickets?companyId=demo-company", "/decision-queue?companyId=demo-company",
      "/tickets/ticket-1",
      "/companies/demo-company/knowledge", "/knowledge/knowledge-1", "/knowledge/knowledge-1/history",
      "/companies/demo-company/residents",
      "/companies/demo-company/parking", "/companies/demo-company/parking-prices",
      `/companies/demo-company/parking-billing?month=${month}`,
      "/companies/demo-company/booking-settings", "/companies/demo-company/booking-queue",
      `/companies/demo-company/bookings?resource=sauna&from=${from}&to=${to}`,
      `/companies/demo-company/billing-periods?kind=sauna&month=${month}`,
      "/companies/demo-company/work-orders",
      "/companies/demo-company/announcements", "/companies/demo-company/announcement-audience",
      "/companies/demo-company/moves", "/companies/demo-company/waitlist",
      "/companies/demo-company/renovations", "/companies/demo-company/keys", "/companies/demo-company/keys/export", "/companies/demo-company/apartments",
      "/companies/demo-company/meter-readings",
      "/companies/demo-company/reports/topics?period=month"
    ];
    for (const route of routes) {
      assert.equal((await call(server, admin, "GET", route)).status, 200, route);
    }
  });

  it("asukasportaalin lukureitit", async () => {
    const routes = [
      "/portal/me", "/portal/tickets", "/portal/booking-settings", "/portal/announcements", "/portal/moves", "/portal/waitlist",
      "/portal/renovations", "/portal/meter-readings", "/portal/booking-queue",
      `/portal/bookings?resource=sauna&from=${from}&to=${to}`
    ];
    for (const route of routes) {
      assert.equal((await call(server, resident, "GET", route)).status, 200, route);
    }
  });

  it("tietopankki vastaa kysymykseen yhtiön tiedoista", async () => {
    const answer = await call(server, admin, "POST", "/companies/demo-company/knowledge/test", { question: "Miten saunavuoro varataan?" });
    assert.equal(answer.status, 200);
    assert.equal(answer.data.found, true);
    assert.equal(answer.data.source.title, "Saunavuorot");
  });

  it("salasanan palautus ei paljasta, onko osoitteella tunnusta", async () => {
    assert.deepEqual((await call(server, null, "POST", "/auth/forgot", { email: "ei-ole@example.com" })).data, { ok: true });
    assert.equal((await call(server, null, "POST", "/auth/reset", { token: "x".repeat(40), password: PASSWORD })).status, 400);
  });

  it("tuntematon reitti palauttaa 404", async () => {
    assert.equal((await call(server, admin, "GET", "/ei-ole")).status, 404);
  });
});
