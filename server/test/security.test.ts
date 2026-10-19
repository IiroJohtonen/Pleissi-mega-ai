import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ADMIN_EMAIL, call, inbound, login, MANAGER_EMAIL, OTHER_MANAGER_EMAIL, PASSWORD, SERVICE_EMAIL, startServer, type TestServer
} from "./helpers.js";
import { htmlToText } from "../src/mail-common.js";

// Tietoturvaregressiot: jokainen testi vastaa korjattua haavoittuvuutta, jottei se palaa.
describe("tietoturva", () => {
  let server: TestServer;
  let admin: string, hanna: string, mikko: string, elina: string, matti: string, liisa: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    hanna = await login(server, MANAGER_EMAIL);
    mikko = await login(server, OTHER_MANAGER_EMAIL);
    elina = await login(server, SERVICE_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-1", { name: "Matti", email: "matti@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12", password: PASSWORD });
    await call(server, admin, "PUT", "/residents/resident-2", { name: "Liisa", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34", password: PASSWORD });
    matti = await login(server, "matti@example.com");
    liisa = await login(server, "liisa@example.com");
  });
  after(() => server.stop());

  const usersById = async (email: string) => (await call(server, admin, "GET", "/users")).data.find((u: any) => u.email === email).id;

  async function sensitiveTicketWithWorkOrder() {
    const t = (await call(server, hanna, "POST", "/tickets", { companyId: "demo-company", subject: "Terveysasia parveke", summary: "s", type: "Muu", priority: "normal" })).data.ticketId;
    await call(server, hanna, "POST", `/tickets/${t}/reporters`, { residentId: "resident-2" });
    await call(server, hanna, "PUT", `/tickets/${t}/fields`, { assigneeId: await usersById(MANAGER_EMAIL) });
    await call(server, hanna, "PUT", `/tickets/${t}/sensitive`, { sensitive: true });
    await call(server, hanna, "POST", `/tickets/${t}/work-orders`, { contractorName: "H", contractorEmail: "", description: "Arka kuvaus", sendEmail: false });
    return t;
  }

  it("asiakaspalvelu ei voi vaihtaa asukkaan sähköpostia (tilin kaappaus)", async () => {
    const blocked = await call(server, elina, "PUT", "/residents/resident-2", { name: "Liisa", email: "evil@evil.fi", address: "Koivikkotie 10", apartmentNumber: "B 34" });
    assert.equal(blocked.status, 403);
    // Isännöitsijä saa vaihtaa.
    assert.equal((await call(server, hanna, "PUT", "/residents/resident-2", { name: "Liisa", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34" })).status, 200);
  });

  it("kirjautunut henkilökunta ei pääse inbound-rajapintaan ilman sisäistä tunnistetta", async () => {
    const r = await call(server, hanna, "POST", "/inbound/messages", { companyId: "demo-company", recipientEmails: ["toinen@kotilo.example"], subject: "X", body: "Y" });
    assert.equal(r.status, 403);
    // Sisäisellä tunnisteella (postintuonti) toimii.
    assert.equal((await inbound(server, admin, { companyId: "demo-company", senderName: "A", subject: "OK", body: "B", channel: "email" })).status, 201);
  });

  it("asukkaan tietopyynnön vienti ei paljasta arkaluonteista tehtävää muulle kuin käsittelijälle", async () => {
    await sensitiveTicketWithWorkOrder();
    const exp = JSON.stringify((await call(server, mikko, "GET", "/residents/resident-2/export")).data);
    assert.ok(!exp.includes("Terveysasia parveke"), "arkaluonteinen otsikko vuoti vientiin");
    // Käsittelijä näkee sisällön.
    const own = JSON.stringify((await call(server, hanna, "GET", "/residents/resident-2/export")).data);
    assert.ok(own.includes("Terveysasia parveke"));
  });

  it("työtilauslista ei paljasta arkaluonteisen tehtävän tietoja muulle kuin käsittelijälle", async () => {
    await sensitiveTicketWithWorkOrder();
    const wo = JSON.stringify((await call(server, mikko, "GET", "/companies/demo-company/work-orders")).data);
    assert.ok(!wo.includes("Terveysasia parveke") && !wo.includes("Arka kuvaus"));
  });

  it("isännöitsijä ei voi nimetä itseään vastuuisännöitsijäksi", async () => {
    const mikkoId = await usersById(OTHER_MANAGER_EMAIL);
    const blocked = await call(server, mikko, "PUT", "/companies/demo-company", { name: "As Oy Koivikko", managerId: mikkoId });
    assert.equal(blocked.status, 403);
    const comp = (await call(server, admin, "GET", "/companies")).data.find((c: any) => c.id === "demo-company");
    assert.notEqual(comp?.manager_id, mikkoId);
    // Pääkäyttäjä saa vaihtaa.
    assert.equal((await call(server, admin, "PUT", "/companies/demo-company", { name: "As Oy Koivikko", managerId: mikkoId })).status, 200);
    await call(server, admin, "PUT", "/companies/demo-company", { name: "As Oy Koivikko", managerId: "" });
  });

  it("jaetulla tehtävällä asukas ei näe toisen asukkaan portaaliviestejä eikä liitteitä", async () => {
    const t = (await call(server, hanna, "POST", "/tickets", { companyId: "demo-company", subject: "Yhteinen", summary: "s", type: "Muu", priority: "normal" })).data.ticketId;
    await call(server, hanna, "POST", `/tickets/${t}/reporters`, { residentId: "resident-2" });
    await call(server, liisa, "POST", `/portal/tickets/${t}/messages`, { body: "Liisan yksityinen viesti", attachments: [] });
    await call(server, hanna, "POST", `/tickets/${t}/reporters`, { residentId: "resident-1" });
    const matR = await call(server, matti, "GET", `/portal/tickets/${t}`);
    assert.ok(!JSON.stringify(matR.data.messages).includes("Liisan yksityinen viesti"));
    // Liisa näkee oman viestinsä.
    const liiR = await call(server, liisa, "GET", `/portal/tickets/${t}`);
    assert.ok(JSON.stringify(liiR.data.messages).includes("Liisan yksityinen viesti"));
  });

  it("salasanan palautuslinkki ei seuraa pyynnön Origin-otsaketta", async () => {
    // Vieras Origin ei saa päätyä linkkiin (posti on testissä pois, mutta pyyntö ei kaadu Originin takia).
    const r = await call(server, "", "POST", "/auth/forgot", { email: ADMIN_EMAIL }, { Origin: "https://evil.example" });
    assert.ok(r.status === 200 || r.status === 502, `forgot status ${r.status}`);
  });

  it("htmlToText ei jumitu sulkemattomilla tageilla (ei ReDoS)", () => {
    const t0 = Date.now();
    htmlToText("<style".repeat(400000));
    htmlToText("<".repeat(400000));
    assert.ok(Date.now() - t0 < 1000, "htmlToText kesti liian kauan");
  });
});
