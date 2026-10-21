import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, localDate, login, MANAGER_EMAIL, SERVICE_EMAIL, startServer, type TestServer , inbound as postInbound } from "./helpers.js";

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
    const normal = await postInbound(server, admin, {
      companyId: "demo-company", senderName: "Liisa Mallikas", senderEmail: "liisa@example.com",
      subject: "Kysymys pyöräkellarista", body: "Mistä saan avaimen pyöräkellariin?"
    });
    assert.equal(normal.status, 201);
    assert.equal(normal.data.emergency, false);
    const detail = await ticket(normal.data.ticketId);
    assert.equal(detail.ticket.resident_name, "Liisa Mallikas");
    assert.equal(detail.ticket.status, "open");

    const emergency = await postInbound(server, admin, {
      companyId: "demo-company", senderName: "Tuntematon", subject: "Vesivuoto", body: "Keittiössä on vesivuoto."
    });
    assert.equal(emergency.data.emergency, true);
    assert.equal((await ticket(emergency.data.ticketId)).ticket.priority, "emergency");
  });

  it("päätös siirtää tehtävän käsittelijälle ja sulkeminen sulkee sen", async () => {
    const created = await postInbound(server, admin, {
      companyId: "demo-company", senderName: "Tuntematon", subject: "Roskakatos", body: "Roskakatos on täynnä."
    });
    const id = created.data.ticketId as string;
    assert.equal((await call(server, service, "POST", `/tickets/${id}/decision`, { decision: "human" })).data.status, "waiting_manager");
    const mine = (await call(server, service, "GET", "/my-tickets?companyId=demo-company")).data;
    assert.ok(mine.some((row: any) => row.id === id));

    assert.equal((await call(server, service, "POST", `/tickets/${id}/decision`, { decision: "skip", reason: "already_handled" })).data.status, "closed");
    assert.equal((await call(server, service, "POST", `/tickets/${id}/reopen`)).status, 200);
  });

  it("sulkemisen kommentti tallentuu sisäiseksi muistiinpanoksi ja lokiin", async () => {
    const id = await createTicket("normal");
    const closed = await call(server, service, "POST", `/tickets/${id}/decision`, {
      decision: "skip", reason: "already_handled", comment: "  Hoidettu puhelimitse.  "
    });
    assert.equal(closed.data.status, "closed");
    const detail = await ticket(id);
    assert.deepEqual(detail.notes.map((note: any) => note.body), ["Hoidettu puhelimitse."]);
    assert.equal(JSON.parse(detail.audit.find((row: any) => row.action === "decision_skip").details).comment, "Hoidettu puhelimitse.");

    // Ilman kommenttia muistiinpanoa ei synny.
    const other = await createTicket("normal");
    await call(server, service, "POST", `/tickets/${other}/decision`, { decision: "skip", reason: "spam" });
    assert.equal((await ticket(other)).notes.length, 0);
  });

  it("tehtävän poistaa vain isännöitsijä, ja poisto vie viestit ja muistiinpanot mukanaan", async () => {
    const created = await postInbound(server, admin, {
      companyId: "demo-company", senderName: "Tuntematon", subject: "Poistettava", body: "Tämä tehtävä poistetaan."
    });
    const id = created.data.ticketId as string;
    await call(server, service, "POST", `/tickets/${id}/notes`, { body: "Muistiinpano", author: "Testi" });

    assert.equal((await call(server, service, "DELETE", `/tickets/${id}`)).status, 403);
    assert.equal((await call(server, service, "GET", `/tickets/${id}`)).status, 200);

    const manager = await login(server, MANAGER_EMAIL);
    assert.equal((await call(server, manager, "DELETE", `/tickets/${id}`)).status, 200);
    assert.equal((await call(server, service, "GET", `/tickets/${id}`)).status, 404);
    assert.equal((await call(server, manager, "DELETE", `/tickets/${id}`)).status, 404);
    const tickets = (await call(server, service, "GET", "/tickets?companyId=demo-company")).data as any[];
    assert.ok(!tickets.some(row => row.id === id));

    const audit = (await call(server, admin, "GET", "/audit")).data as any[];
    assert.ok(audit.some(row => row.action === "ticket_deleted" && !row.ticket_id));
  });

  it("poistetun tehtävän sähköpostia ei tuoda uudelleen", async () => {
    const email = {
      companyId: "demo-company", senderName: "Roskaposti", senderEmail: "mainos@example.com",
      subject: "Tarjous", body: "Osta nyt!", sourceMessageId: "<poistettava-1@example.com>"
    };
    const created = await postInbound(server, admin, email);
    assert.equal(created.status, 201);
    const manager = await login(server, MANAGER_EMAIL);
    assert.equal((await call(server, manager, "DELETE", `/tickets/${created.data.ticketId}`)).status, 200);

    // Postin tarkistus yrittää tuoda saman viestin uudelleen: tehtävää ei synny.
    const again = await postInbound(server, admin, email);
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.deleted, true);
    const tickets = (await call(server, admin, "GET", "/tickets?companyId=demo-company")).data as { subject: string }[];
    assert.ok(!tickets.some(row => row.subject === "Tarjous"));

    // Uusi viesti samalta lähettäjältä tuodaan normaalisti.
    const fresh = await postInbound(server, admin, { ...email, sourceMessageId: "<uusi-1@example.com>" });
    assert.equal(fresh.status, 201);
  });

  it("toiselle annettu avoin tehtävä poistuu päätösjonosta tämän omiin tehtäviin ja näkyy kaikissa tehtävissä", async () => {
    const created = await postInbound(server, admin, {
      companyId: "demo-company", senderName: "Tuntematon", subject: "Annettava", body: "Tämä annetaan toiselle."
    });
    const id = created.data.ticketId as string;
    const queue = async () => ((await call(server, admin, "GET", "/decision-queue?companyId=demo-company")).data as any[]).map(row => row.id);
    assert.ok((await queue()).includes(id));

    const users = (await call(server, admin, "GET", "/users")).data as any[];
    const serviceUser = users.find(user => user.email === SERVICE_EMAIL);
    assert.equal((await call(server, admin, "PUT", `/tickets/${id}/fields`, { assigneeId: serviceUser.id })).status, 200);

    assert.ok(!(await queue()).includes(id));
    const mine = (await call(server, service, "GET", "/my-tickets?companyId=demo-company")).data as any[];
    assert.ok(mine.some(row => row.id === id));
    const all = (await call(server, admin, "GET", "/tickets?companyId=demo-company")).data as any[];
    const row = all.find(item => item.id === id);
    assert.equal(row.status, "waiting_manager");
    assert.equal(row.assignee_name, serviceUser.name);

    // Käsittelijän poistaminen ei palauta tehtävää jonoon.
    await call(server, admin, "PUT", `/tickets/${id}/fields`, { assigneeId: null });
    assert.equal((await ticket(id)).ticket.status, "waiting_manager");
  });

  it("uuden tehtävän ilmoittajaksi voi valita asukkaan tai kirjoittaa uuden (Muu)", async () => {
    const residents = (await call(server, service, "GET", "/companies/demo-company/residents")).data as any[];
    const picked = residents[0];
    const created = await call(server, service, "POST", "/tickets", {
      companyId: "demo-company", subject: "Ovikello", summary: "Ovikello ei soi", residentId: picked.id
    });
    assert.equal(created.status, 201);
    const detail = await ticket(created.data.ticketId);
    assert.equal(detail.ticket.resident_id, picked.id);
    assert.equal(detail.ticket.apartment_id, picked.apartment_id);
    assert.deepEqual(detail.reporters.map((r: any) => r.id), [picked.id]);
    assert.ok(detail.audit.some((row: any) => row.action === "reporter_linked"));

    // Muu: henkilö lisätään taloyhtiön asukkaaksi ja asunto luodaan tarvittaessa.
    const other = await call(server, service, "POST", "/tickets", {
      companyId: "demo-company", subject: "Vuoto", summary: "Vesi tippuu",
      newResident: { name: "Olli Ohikulkija", address: "Uusitie 5", apartmentNumber: "C 7" }
    });
    assert.equal(other.status, 201);
    const otherDetail = await ticket(other.data.ticketId);
    assert.equal(otherDetail.reporters[0].name, "Olli Ohikulkija");
    assert.equal(otherDetail.reporters[0].apartment_number, "C 7");
    const after = (await call(server, service, "GET", "/companies/demo-company/residents")).data as any[];
    assert.ok(after.some(r => r.name === "Olli Ohikulkija" && r.address === "Uusitie 5"));

    // Toisen yhtiön tai tuntematon asukas hylätään, eikä tehtävää luoda.
    assert.equal((await call(server, service, "POST", "/tickets", {
      companyId: "demo-company", subject: "X", summary: "Y", residentId: "ei-ole"
    })).status, 404);
    assert.equal((await call(server, service, "POST", "/tickets", {
      companyId: "demo-company", subject: "X", summary: "Y", newResident: { name: "Nimi", address: "", apartmentNumber: "A 1" }
    })).status, 400);
  });

  it("tuntemattoman yhtiön tehtäviä ei palauteta", async () => {
    assert.equal((await call(server, admin, "GET", "/tickets?companyId=ei-ole")).status, 403);
    assert.equal((await call(server, admin, "GET", "/tickets/ei-ole")).status, 404);
  });
});
