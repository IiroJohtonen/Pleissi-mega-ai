import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, startServer, tempDir, type TestServer } from "./helpers.js";

describe("allekirjoitus ja muistutukset", () => {
  let server: TestServer;
  let admin: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
  });

  after(() => server.stop());

  it("täyttää allekirjoituspohjan ja jättää tyhjät rivit pois", async () => {
    process.env.DATA_DIR = await tempDir();
    const { fillSignature, DEFAULT_SIGNATURE } = await import("../src/signature.js");
    const values = { nimi: "Hanna Lehtonen", titteli: "", puhelin: "040 123", "sähköposti": "hanna@toimisto.fi", toimisto: "Pohjantähti" };
    assert.equal(fillSignature(DEFAULT_SIGNATURE, values),
      "Ystävällisin terveisin\n\nHanna Lehtonen\nPohjantähti\n040 123\nhanna@toimisto.fi");
    assert.equal(fillSignature("Terveisin {Nimi}, {tuntematon}", values), "Terveisin Hanna Lehtonen, {tuntematon}");
    assert.equal(fillSignature("", values), "");
  });

  it("käyttäjä tallentaa oman allekirjoituksensa ja se näkyy tehtävällä", async () => {
    const initial = await call(server, admin, "GET", "/me/signature");
    assert.equal(initial.status, 200);
    assert.equal(initial.data.template, initial.data.defaultTemplate);

    const saved = await call(server, admin, "PUT", "/me/signature", {
      title: "Isännöitsijä", phone: "040 555 1234", template: "Terveisin\n{nimi}\n{titteli}\n{puhelin}"
    });
    assert.equal(saved.status, 200);
    assert.match(saved.data.preview, /^Terveisin\n.+\nIsännöitsijä\n040 555 1234$/);

    const ticketId = (await call(server, admin, "POST", "/tickets", { companyId: "demo-company", subject: "Allekirjoitus", summary: "Testi" })).data.ticketId;
    const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.equal(detail.signature, saved.data.preview);

    // Tyhjä pohja poistaa allekirjoituksen.
    await call(server, admin, "PUT", "/me/signature", { title: "", phone: "", template: "" });
    assert.equal((await call(server, admin, "GET", `/tickets/${ticketId}`)).data.signature, "");
  });

  it("hylkää virheellisen kopio-osoitteen ennen lähettämistä", async () => {
    const created = await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Matti", senderEmail: "matti@example.com",
      subject: "Kysymys", body: "Milloin on saunavuoro?", sourceMessageId: "<cc-1@example.com>"
    });
    const refused = await call(server, admin, "POST", `/tickets/${created.data.ticketId}/reply`, {
      body: "Vastaus", cc: "hallitus@yhtio.fi, ei-osoite"
    });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /ei-osoite/);
  });

  it("tehtävälistassa näkyy, milloin asukas alkoi odottaa vastausta", async () => {
    const created = await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Liisa", senderEmail: "liisa@example.com",
      subject: "Odottava", body: "Onko pyykkitupa auki?", sourceMessageId: "<odottaa-1@example.com>"
    });
    const tickets = (await call(server, admin, "GET", "/tickets?companyId=demo-company")).data as { id: string; waiting_since: string | null }[];
    const ticket = tickets.find(item => item.id === created.data.ticketId);
    assert.ok(ticket?.waiting_since);

    const office = await call(server, admin, "PUT", "/office", { name: "Pohjantähti Isännöinti Oy", replyReminderDays: 3, dueReminderDays: 2 });
    assert.equal(office.data.replyReminderDays, 3);
    assert.equal(office.data.dueReminderDays, 2);
  });
});
