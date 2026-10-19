import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, SERVICE_EMAIL, startServer, userByEmail, type TestServer , inbound as postInbound } from "./helpers.js";

// Gmail on testeissä pois päältä, joten hälytys kirjautuu lokiin epäonnistuneena. Merkintä kertoo
// silti, kenelle hälytys oli lähdössä.
describe("hätätapauksen hälytys", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;
  let service: string;
  let managerName: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
    service = await login(server, SERVICE_EMAIL);
    const user = await userByEmail(server, admin, MANAGER_EMAIL);
    managerName = user.name;
    await setManager(user.id);
  });

  after(() => server.stop());

  async function setManager(managerId: string | null) {
    const saved = await call(server, admin, "PUT", "/companies/demo-company", { name: "As Oy Koivikko", managerId });
    assert.equal(saved.status, 200);
  }

  async function inbound(subject: string, body: string) {
    const created = await postInbound(server, admin, {
      companyId: "demo-company", senderName: "Liisa Mallikas", senderEmail: "liisa@example.com", subject, body
    });
    assert.equal(created.status, 201);
    return created.data.ticketId as string;
  }

  // Hälytys lähtee taustalla, joten lokimerkintää odotetaan hetki.
  async function alerts(ticketId: string, expected: number) {
    let rows: { action: string; details: string }[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
      rows = detail.audit.filter((row: any) => row.action.startsWith("emergency_alert_"));
      if (rows.length >= expected) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return rows.map(row => ({ action: row.action, ...JSON.parse(row.details) }));
  }

  it("saapuva hätätapaus hälyttää vastuuisännöitsijän, tavallinen viesti ei", async () => {
    const [alert] = await alerts(await inbound("Vesivuoto", "Keittiössä on vesivuoto."), 1);
    assert.equal(alert.to, managerName);
    assert.equal(alert.action, "emergency_alert_failed");
    assert.match(alert.error, /GMAIL_DISABLED/);

    assert.deepEqual(await alerts(await inbound("Kysymys pyöräkellarista", "Mistä saan avaimen pyöräkellariin?"), 0), []);
  });

  it("käsin luotu hätätapaus hälyttää, ellei luoja ole itse vastuuisännöitsijä", async () => {
    const body = { companyId: "demo-company", subject: "Putkirikko kellarissa", summary: "Soitettu toimistolle", priority: "emergency" };
    const byService = await call(server, service, "POST", "/tickets", body);
    assert.equal((await alerts(byService.data.ticketId, 1))[0].to, managerName);

    const byManager = await call(server, manager, "POST", "/tickets", body);
    assert.deepEqual(await alerts(byManager.data.ticketId, 0), []);
  });

  it("tehtävän nostaminen hätätapaukseksi hälyttää kerran", async () => {
    const id = await inbound("Roskakatos", "Roskakatos on täynnä.");
    assert.equal((await call(server, service, "PUT", `/tickets/${id}/fields`, { priority: "emergency" })).status, 200);
    assert.equal((await alerts(id, 1)).length, 1);

    await call(server, service, "PUT", `/tickets/${id}/fields`, { priority: "emergency", dueDate: "2026-01-01" });
    assert.equal((await alerts(id, 2)).length, 1);
  });

  it("puuttuva vastuuisännöitsijä kirjataan lokiin", async () => {
    await setManager(null);
    const [alert] = await alerts(await inbound("Sähkökatko", "Koko rapussa on sähkökatko."), 1);
    assert.equal(alert.action, "emergency_alert_failed");
    assert.equal(alert.error, "Taloyhtiöllä ei ole vastuuisännöitsijää.");
  });
});
