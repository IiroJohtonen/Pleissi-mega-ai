import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, startServer, type TestServer , inbound as postInbound } from "./helpers.js";

describe("tilapäivitykset asukkaalle", () => {
  let server: TestServer;
  let admin: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    // Asukkaalla pitää olla sähköposti, jotta päivitys lähtee.
    await call(server, admin, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34"
    });
  });

  after(() => server.stop());

  async function newTicket(id: string) {
    const ticketId = (await postInbound(server, admin, {
      companyId: "demo-company", senderName: "Liisa Mallikas", senderEmail: "liisa@example.com",
      subject: `Ilmoitus ${id}`, body: "Rappukäytävän ovi ei sulkeudu.", sourceMessageId: `<${id}@example.com>`
    })).data.ticketId as string;
    await call(server, admin, "POST", `/tickets/${ticketId}/reporters`, { residentId: "resident-2" });
    return ticketId;
  }

  async function notifications(ticketId: string) {
    const audit = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data.audit as { action: string; details: string }[];
    return audit.filter(row => row.action === "resident_notified").map(row => JSON.parse(row.details).event as string);
  }

  it("tilan vaihto käsin lähettää päivityksen, mutta samaa ei toisteta heti", async () => {
    const ticketId = await newTicket("tila-a");
    await call(server, admin, "PUT", `/tickets/${ticketId}/fields`, { status: "waiting_manager" });
    await call(server, admin, "PUT", `/tickets/${ticketId}/fields`, { status: "answered" });
    await call(server, admin, "PUT", `/tickets/${ticketId}/fields`, { status: "waiting_manager" });
    await call(server, admin, "PUT", `/tickets/${ticketId}/fields`, { status: "closed" });
    assert.deepEqual((await notifications(ticketId)).sort(), ["closed", "in_progress"]);
  });

  it("sulkeminen päätösjonosta ilmoittaa asukkaalle, roskaposti ei", async () => {
    const closed = await newTicket("tila-b");
    await call(server, admin, "POST", `/tickets/${closed}/decision`, { decision: "skip", reason: "already_handled" });
    assert.deepEqual(await notifications(closed), ["closed"]);

    const spam = await newTicket("tila-c");
    await call(server, admin, "POST", `/tickets/${spam}/decision`, { decision: "skip", reason: "spam" });
    assert.deepEqual(await notifications(spam), []);
  });

  it("päivitykset voi kytkeä pois asetuksista", async () => {
    const office = (await call(server, admin, "GET", "/office")).data;
    assert.equal(office.residentStatusUpdates, 1);
    await call(server, admin, "PUT", "/office", { name: office.name, residentStatusUpdates: false });
    const ticketId = await newTicket("tila-d");
    await call(server, admin, "PUT", `/tickets/${ticketId}/fields`, { status: "closed" });
    assert.deepEqual(await notifications(ticketId), []);
    await call(server, admin, "PUT", "/office", { name: office.name, residentStatusUpdates: true });
  });
});
