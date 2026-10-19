import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, localDate, login, MANAGER_EMAIL, startServer, type TestServer , inbound as postInbound } from "./helpers.js";

describe("perustiedot", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
  });

  after(() => server.stop());

  const inbound = async (subject: string, body: string) => {
    const created = await postInbound(server, admin, { companyId: "demo-company", senderName: "Asukas", subject, body, channel: "email" });
    assert.equal(created.status, 201);
    return (await call(server, admin, "GET", `/tickets/${created.data.ticketId}`)).data.ticket;
  };

  it("vain pääkäyttäjä näkee ja muuttaa perustiedot", async () => {
    assert.equal((await call(server, manager, "GET", "/master-data")).status, 403);
    assert.equal((await call(server, manager, "PUT", "/master-data", { emergencyKeywords: ["savu"] })).status, 403);
    const data = (await call(server, admin, "GET", "/master-data")).data;
    assert.deepEqual(data.values.priorityDays, { emergency: 0, urgent: 1, normal: 5, low: 14 });
    assert.ok(data.values.emergencyKeywords.includes("vesivuoto"));
    assert.ok(!data.values.emergencyKeywords.includes("lukko"));
    assert.equal((await call(server, admin, "PUT", "/master-data", { priorityDays: { emergency: 0, urgent: 1, normal: -1, low: 14 } })).status, 400);
  });

  it("hätäsanat ja määräajat tulevat perustiedoista", async () => {
    assert.equal((await inbound("Hissi", "Hissi on jumissa kerrosten välissä.")).priority, "normal");
    const saved = await call(server, admin, "PUT", "/master-data", {
      emergencyKeywords: ["hissi on jumissa", "vesivuoto"],
      priorityDays: { emergency: 0, urgent: 2, normal: 7, low: 30 }
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.emergencyKeywords, ["hissi on jumissa", "vesivuoto"]);

    const stuck = await inbound("Hissi", "Hissi on jumissa kerrosten välissä.");
    assert.equal(stuck.priority, "emergency");
    assert.equal(stuck.due_date, localDate(0));
    assert.equal((await inbound("Ovikello", "Ovikello ei soi.")).due_date, localDate(7));

    const log = (await call(server, admin, "GET", "/audit")).data as any[];
    assert.ok(log.some(row => row.action === "master_data_updated"));
  });
});
