import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { statusAfterResidentReply } from "../src/util.js";
import { ADMIN_EMAIL, call, login, startServer, type TestServer } from "./helpers.js";

describe("tehtävän tilat", () => {
  let server: TestServer;
  let admin: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
  });

  after(async () => {
    await server.stop();
  });

  async function ticket(ticketId: string) {
    return (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
  }

  it("asukkaan vastaus muuttaa vastatun avoimeksi ja suljetun uudeksi", () => {
    assert.equal(statusAfterResidentReply("answered"), "active");
    assert.equal(statusAfterResidentReply("closed"), "open");
    assert.equal(statusAfterResidentReply("waiting_manager"), "waiting_manager");
    assert.equal(statusAfterResidentReply("waiting_third_party"), "waiting_third_party");
  });

  it("uusi tehtävä on Uusi-tilassa, tilaa voi vaihtaa käsin ja muutos kirjataan", async () => {
    const created = await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Matti", senderEmail: "matti@example.com",
      subject: "Ovikello", body: "Ovikello ei soi.", sourceMessageId: "<tila-1@example.com>"
    });
    const ticketId = created.data.ticketId;
    assert.equal((await ticket(ticketId)).ticket.status, "open");

    assert.equal((await call(server, admin, "PUT", `/tickets/${ticketId}/fields`, { status: "keksitty" })).status, 400);
    for (const status of ["active", "waiting_manager", "answered", "waiting_third_party", "closed"]) {
      assert.equal((await call(server, admin, "PUT", `/tickets/${ticketId}/fields`, { status })).status, 200);
      assert.equal((await ticket(ticketId)).ticket.status, status);
    }
    const changes = (await ticket(ticketId)).audit.filter((row: any) => row.action === "status_changed");
    assert.equal(changes.length, 5);
    assert.ok(changes.some((row: any) => row.details === JSON.stringify({ from: "waiting_third_party", to: "closed" })));
  });

  it("asukkaan sähköpostivastaus palauttaa vastatun tehtävän avoimeksi", async () => {
    const created = await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Liisa", senderEmail: "liisa@example.com",
      subject: "Pihavalot", body: "Pihavalot palavat päivällä.", sourceMessageId: "<tila-2@example.com>"
    });
    const ticketId = created.data.ticketId;
    await call(server, admin, "PUT", `/tickets/${ticketId}/fields`, { status: "answered" });
    await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Liisa", senderEmail: "liisa@example.com",
      subject: "Re: Pihavalot", body: "Edelleen palavat.", sourceMessageId: "<tila-3@example.com>",
      threadMessageIds: ["<tila-2@example.com>"]
    });
    assert.equal((await ticket(ticketId)).ticket.status, "active");
  });
});
