import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, localDate, login, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

describe("tehtävät ja määräajat", () => {
  let server: TestServer;
  let admin: string;
  let service: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    service = await login(server, SERVICE_EMAIL);
  });

  after(() => server.stop());

  async function createTicket(priority: string) {
    const created = await call(server, service, "POST", "/tickets", {
      companyId: "demo-company", subject: `Tehtävä ${priority}`, summary: "Testi", priority
    });
    assert.equal(created.status, 201);
    return created.data.ticketId as string;
  }

  async function ticket(id: string) {
    return (await call(server, service, "GET", `/tickets/${id}`)).data;
  }

  it("uusi tehtävä saa määräajan prioriteetin mukaan", async () => {
    const expected = { emergency: 0, urgent: 1, normal: 5, low: 14 };
    for (const [priority, days] of Object.entries(expected)) {
      assert.equal((await ticket(await createTicket(priority))).ticket.due_date, localDate(days), priority);
    }
  });

  it("määräajan voi vaihtaa ja poistaa, ja muutos kirjataan lokiin", async () => {
    const id = await createTicket("normal");
    assert.equal((await call(server, service, "PUT", `/tickets/${id}/fields`, { dueDate: "2026-01-01" })).status, 200);
    const changed = await ticket(id);
    assert.equal(changed.ticket.due_date, "2026-01-01");
    assert.ok(changed.audit.some((row: any) => row.action === "ticket_updated" && row.details.includes("due_date")));

    await call(server, service, "PUT", `/tickets/${id}/fields`, { dueDate: null });
    assert.equal((await ticket(id)).ticket.due_date, null);
  });

  it("virheellinen määräaika hylätään", async () => {
    const id = await createTicket("normal");
    assert.equal((await call(server, service, "PUT", `/tickets/${id}/fields`, { dueDate: "huomenna" })).status, 400);
  });

  it("saapuva viesti luo tehtävän ja hätätapaus tunnistetaan", async () => {
    const normal = await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Liisa Mallikas", senderEmail: "liisa@example.com",
      subject: "Kysymys pyöräkellarista", body: "Mistä saan avaimen pyöräkellariin?"
    });
    assert.equal(normal.status, 201);
    assert.equal(normal.data.emergency, false);
    const detail = await ticket(normal.data.ticketId);
    assert.equal(detail.ticket.resident_name, "Liisa Mallikas");
    assert.equal(detail.ticket.status, "open");

    const emergency = await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Tuntematon", subject: "Vesivuoto", body: "Keittiössä on vesivuoto."
    });
    assert.equal(emergency.data.emergency, true);
    assert.equal((await ticket(emergency.data.ticketId)).ticket.priority, "emergency");
  });

  it("päätös siirtää tehtävän käsittelijälle ja sulkeminen sulkee sen", async () => {
    const created = await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Tuntematon", subject: "Roskakatos", body: "Roskakatos on täynnä."
    });
    const id = created.data.ticketId as string;
    assert.equal((await call(server, service, "POST", `/tickets/${id}/decision`, { decision: "human" })).data.status, "waiting_manager");
    const mine = (await call(server, service, "GET", "/my-tickets?companyId=demo-company")).data;
    assert.ok(mine.some((row: any) => row.id === id));

    assert.equal((await call(server, service, "POST", `/tickets/${id}/decision`, { decision: "skip", reason: "already_handled" })).data.status, "closed");
    assert.equal((await call(server, service, "POST", `/tickets/${id}/reopen`)).status, 200);
  });

  it("tuntemattoman yhtiön tehtäviä ei palauteta", async () => {
    assert.equal((await call(server, admin, "GET", "/tickets?companyId=ei-ole")).status, 403);
    assert.equal((await call(server, admin, "GET", "/tickets/ei-ole")).status, 404);
  });
});
