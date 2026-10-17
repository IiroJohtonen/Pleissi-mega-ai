import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ADMIN_EMAIL, call, login, MANAGER_EMAIL, OTHER_MANAGER_EMAIL, SERVICE_EMAIL, startServer, userByEmail, type TestServer
} from "./helpers.js";

describe("Taloyhtiö tunnistamatta -jono ja tehtävän siirto", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;
  let otherManager: string;
  let service: string;
  let otherCompany: string;
  let hannaId: string;
  let mikkoId: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
    otherManager = await login(server, OTHER_MANAGER_EMAIL);
    service = await login(server, SERVICE_EMAIL);
    hannaId = (await userByEmail(server, admin, MANAGER_EMAIL)).id;
    mikkoId = (await userByEmail(server, admin, OTHER_MANAGER_EMAIL)).id;
    await call(server, admin, "PUT", "/companies/demo-company", { name: "As Oy Koivikko", managerId: hannaId });
    otherCompany = (await call(server, admin, "POST", "/companies", { name: "As Oy Männikkö" })).data.companyId;
    await call(server, admin, "PUT", `/companies/${otherCompany}`, { name: "As Oy Männikkö", managerId: mikkoId, managerIds: [hannaId] });
  });

  after(() => server.stop());

  // Toimiston yhteiseen laatikkoon tullut viesti, jonka yhtiötä postin tuonti ei tunnistanut.
  const unknownMail = async (senderEmail: string, subject: string, body: string) => {
    const created = await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", companyUnknown: true, senderName: "Lähettäjä", senderEmail, subject, body, channel: "email"
    });
    assert.equal(created.status, 201);
    return created.data.ticketId as string;
  };
  const listed = async (token: string) => ((await call(server, token, "GET", "/tickets?companyId=all")).data as any[]).map(row => row.id);

  it("tunnistamaton viesti menee jonoon eikä oletusyhtiön isännöitsijälle", async () => {
    const ticketId = await unknownMail("tuntematon@example.com", "Vuotava hana", "Hana vuotaa Männikön A-rapussa.");
    const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.equal(detail.ticket.company_pending, 1);
    assert.equal(detail.ticket.assignee_id, null);
    assert.ok(detail.audit.some((row: any) => row.action === "company_unidentified"));

    // Asukasrekisterissä oleva lähettäjä tunnistetaan, vaikka vastaanottaja ei kertonut yhtiötä.
    const known = await unknownMail("liisa@example.com", "Sauna", "Saunan lauteet ovat rikki.");
    const knownDetail = (await call(server, admin, "GET", `/tickets/${known}`)).data;
    assert.equal(knownDetail.ticket.company_pending, 0);
    assert.equal(knownDetail.ticket.company_id, "demo-company");
  });

  it("jonon näkevät asetuksissa valitut roolit ja käyttäjät, pääkäyttäjä aina", async () => {
    const ticketId = await unknownMail("joku@example.com", "Kysymys", "Milloin pihat aurataan?");
    // Oletuksena pääkäyttäjä ja asiakaspalvelu; isännöitsijä ei näe tehtävää eikä pääse siihen.
    assert.ok((await listed(admin)).includes(ticketId));
    assert.ok((await listed(service)).includes(ticketId));
    assert.ok(!(await listed(manager)).includes(ticketId));
    assert.equal((await call(server, manager, "GET", `/tickets/${ticketId}`)).status, 404);
    assert.equal((await call(server, manager, "GET", "/office")).data.canHandleUnidentified, false);

    // Asetus: vain pääkäyttäjät ja Hanna.
    const saved = await call(server, admin, "PUT", "/office", { name: "Testitoimisto", unidentifiedQueueRoles: ["Pääkäyttäjä"], unidentifiedQueueUsers: [hannaId] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.unidentifiedQueueUsers, [hannaId]);
    assert.equal((await call(server, service, "PUT", "/office", { name: "x", unidentifiedQueueRoles: ["Asiakaspalvelu"] })).status, 403);
    assert.ok(!(await listed(service)).includes(ticketId));
    assert.ok((await listed(manager)).includes(ticketId));
    assert.ok((await listed(admin)).includes(ticketId));
  });

  it("käsittelijä saa ehdotuksen ja valitsee taloyhtiön", async () => {
    const ticketId = await unknownMail("uusi@example.com", "Valo rikki", "Männikön pihavalo ei syty.");
    const suggestion = (await call(server, manager, "GET", `/tickets/${ticketId}/company-suggestion`)).data.suggestion;
    assert.equal(suggestion.companyId, otherCompany);

    // Asiakaspalvelu ei ole enää jonon käsittelijä.
    assert.equal((await call(server, service, "PUT", `/tickets/${ticketId}/company`, { companyId: otherCompany })).status, 404);
    assert.equal((await call(server, manager, "PUT", `/tickets/${ticketId}/company`, { companyId: otherCompany })).status, 200);
    const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.equal(detail.ticket.company_pending, 0);
    assert.equal(detail.ticket.company_id, otherCompany);
    // Tehtävä menee uuden yhtiön vastuuisännöitsijälle ja saa sen yhtiön numeron.
    assert.equal(detail.ticket.assignee_id, mikkoId);
    assert.equal(detail.ticket.ticket_number, 1);
    assert.ok(detail.audit.some((row: any) => row.action === "company_assigned"));
  });

  it("väärään yhtiöön mennyt tehtävä siirretään oikeaan", async () => {
    const created = await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Asukas", subject: "Rappuvalo", body: "Rapun valo vilkkuu.", channel: "email"
    });
    const ticketId = created.data.ticketId as string;
    // Käsittelijä on Hanna (Koivikon vastuuisännöitsijä); asiakaspalvelu ei voi siirtää.
    assert.equal((await call(server, service, "PUT", `/tickets/${ticketId}/company`, { companyId: otherCompany })).status, 403);
    assert.equal((await call(server, manager, "PUT", `/tickets/${ticketId}/company`, { companyId: "demo-company" })).status, 400);
    assert.equal((await call(server, manager, "PUT", `/tickets/${ticketId}/company`, { companyId: otherCompany })).status, 200);
    const detail = (await call(server, otherManager, "GET", `/tickets/${ticketId}`)).data;
    assert.equal(detail.ticket.company_id, otherCompany);
    assert.equal(detail.ticket.assignee_id, mikkoId);
    const moved = detail.audit.find((row: any) => row.action === "company_changed");
    assert.equal(JSON.parse(moved.details).from, "As Oy Koivikko");
    assert.equal(JSON.parse(moved.details).to, "As Oy Männikkö");
  });
});
