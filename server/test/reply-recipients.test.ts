import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, inbound, login, PASSWORD, startServer, type TestServer } from "./helpers.js";

// Vastauksen vastaanottajat: oletuksena alkuperäinen lähettäjä; käsittelijä voi lisätä ja poistaa osoitteita, ja lista
// pysyy tehtävällä. Asukkaan vaihto ei muuta listaa itsestään.
describe("vastauksen vastaanottajat", () => {
  let server: TestServer;
  let admin: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34", password: PASSWORD
    });
  });

  after(async () => {
    await server.stop();
  });

  it("oletus on lähettäjä; lisäys, poisto ja palautus oletukseen", async () => {
    const created = await inbound(server, admin, {
      companyId: "demo-company", senderName: "Vuokralainen", senderEmail: "vuokralainen@example.com", subject: "Ovi", body: "Ovi ei lukitu.", channel: "email"
    });
    const ticketId = created.data.ticketId as string;
    let detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.deepEqual([detail.replyRecipients, detail.replyRecipientsCustom], [["vuokralainen@example.com"], false]);

    // Asukkaan vaihto ei vaihda vastaanottajaa itsestään.
    assert.equal((await call(server, admin, "POST", `/tickets/${ticketId}/reporters`, { residentId: "resident-2" })).status, 201);
    detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.deepEqual(detail.replyRecipients, ["vuokralainen@example.com"]);

    // Käsittelijä lisää uuden asukkaan: molemmat saavat vastaukset jatkossa.
    assert.equal((await call(server, admin, "PUT", `/tickets/${ticketId}/recipients`, { recipients: ["vuokralainen@example.com", "ei osoite"] })).status, 400);
    const saved = await call(server, admin, "PUT", `/tickets/${ticketId}/recipients`, {
      recipients: ["vuokralainen@example.com", "liisa@example.com", "LIISA@example.com"]
    });
    assert.deepEqual(saved.data.recipients, ["vuokralainen@example.com", "liisa@example.com"]);
    detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.deepEqual([detail.replyRecipients, detail.replyRecipientsCustom], [["vuokralainen@example.com", "liisa@example.com"], true]);
    assert.ok((detail.audit as any[]).some(entry => entry.action === "reply_recipients_changed"));

    // Vanhan osoitteen poisto: vain uusi asukas.
    await call(server, admin, "PUT", `/tickets/${ticketId}/recipients`, { recipients: ["liisa@example.com"] });
    assert.deepEqual((await call(server, admin, "GET", `/tickets/${ticketId}`)).data.replyRecipients, ["liisa@example.com"]);

    // Tyhjä lista palauttaa oletuksen.
    const reset = await call(server, admin, "PUT", `/tickets/${ticketId}/recipients`, { recipients: [] });
    assert.deepEqual([reset.data.recipients, reset.data.custom], [["vuokralainen@example.com"], false]);
  });
});
