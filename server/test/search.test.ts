import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, startServer, type TestServer , inbound as postInbound } from "./helpers.js";

describe("haku", () => {
  let server: TestServer;
  let admin: string;
  let ticketId: string;
  let ticketNumber: number;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    const created = await postInbound(server, admin, {
      companyId: "demo-company", senderName: "Testi Asukas", subject: "Pyörävaraston ovi", body: "Ovi narisee ja jää raolleen.", channel: "email"
    });
    ticketId = created.data.ticketId;
    ticketNumber = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data.ticket.ticket_number;
    await call(server, admin, "POST", `/tickets/${ticketId}/notes`, { body: "Huoltomies tilattu saranoiden rasvaukseen." });
    await call(server, admin, "POST", "/companies/demo-company/knowledge/facts", {
      question: "Miten pyörävarastoon pääsee?", answer: "Pyörävaraston avaa oman asunnon avain."
    });
  });

  after(async () => {
    await server.stop();
  });

  it("löytää tehtävän ja dokumentaation sanasta isoista kirjaimista ja ääkkösistä huolimatta", async () => {
    const result = await call(server, admin, "GET", `/search?q=${encodeURIComponent("PYÖRÄVARAST")}`);
    assert.equal(result.status, 200);
    assert.ok(result.data.tickets.some((ticket: any) => ticket.id === ticketId));
    assert.ok(result.data.knowledge.some((item: any) => /pyörävarast/i.test(item.title)));
  });

  it("hakee myös viesteistä ja muistiinpanoista, ja kaikkien sanojen pitää löytyä", async () => {
    const note = await call(server, admin, "GET", `/search?q=${encodeURIComponent("saranoiden rasvaukseen")}`);
    const found = note.data.tickets.find((ticket: any) => ticket.id === ticketId);
    assert.ok(found);
    assert.match(found.snippet, /saranoiden/);
    assert.ok((await call(server, admin, "GET", `/search?q=${encodeURIComponent("narisee")}`)).data.tickets.some((ticket: any) => ticket.id === ticketId));
    assert.equal((await call(server, admin, "GET", `/search?q=${encodeURIComponent("narisee kuuhullu")}`)).data.tickets.length, 0);
  });

  it("#numero löytää tehtävän numerolla", async () => {
    const result = await call(server, admin, "GET", `/search?q=${encodeURIComponent(`#${ticketNumber}`)}`);
    assert.equal(result.data.tickets[0].id, ticketId);
  });

  it("#T-numero löytää tehtävän ja #K-numero dokumentin", async () => {
    const padded = `#T${String(ticketNumber).padStart(6, "0")}`;
    const byTicket = (await call(server, admin, "GET", `/search?q=${encodeURIComponent(padded)}`)).data;
    assert.equal(byTicket.tickets[0].id, ticketId);
    assert.equal(byTicket.knowledge.length, 0);

    const knowledge = (await call(server, admin, "GET", "/companies/demo-company/knowledge")).data as { id: string; doc_number: number }[];
    const entry = knowledge[0];
    assert.ok(entry.doc_number > 0);
    const byDocument = (await call(server, admin, "GET", `/search?q=${encodeURIComponent(`#K${String(entry.doc_number).padStart(6, "0")}`)}`)).data;
    assert.deepEqual(byDocument.knowledge.map((item: any) => item.id), [entry.id]);
    assert.equal(byDocument.tickets.length, 0);
  });

  it("vakiotiedon uusi versio pitää dokumenttinumeronsa", async () => {
    const created = await call(server, admin, "POST", "/companies/demo-company/knowledge/facts", {
      question: "Pihagrilli", answer: "Grillaus on sallittu", formatted: "Grillaus on **sallittu**"
    });
    assert.equal(created.status, 201);
    const first = (await call(server, admin, "GET", `/knowledge/${created.data.knowledgeId}`)).data;
    assert.equal(first.content, "Grillaus on sallittu");
    assert.equal(first.formatted, "Grillaus on **sallittu**");
    const next = await call(server, admin, "POST", "/companies/demo-company/knowledge/facts", {
      question: "Pihagrilli", answer: "Grillaus kielletty", replaces: created.data.knowledgeId
    });
    const second = (await call(server, admin, "GET", `/knowledge/${next.data.knowledgeId}`)).data;
    assert.equal(second.doc_number, first.doc_number);
  });

  it("tyhjä haku hylätään", async () => {
    assert.equal((await call(server, admin, "GET", "/search?q=")).status, 400);
  });
});
