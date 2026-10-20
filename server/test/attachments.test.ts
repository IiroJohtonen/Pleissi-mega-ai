import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, PASSWORD, startServer, type TestServer , inbound as postInbound } from "./helpers.js";

const PDF = Buffer.from("%PDF-1.4 testi").toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
const EXE = Buffer.from("MZ\x90\x00 ajettava").toString("base64");

async function createTicket(server: TestServer, token: string) {
  return (await call(server, token, "POST", "/tickets", { companyId: "demo-company", subject: "Liitteet", summary: "Testi" })).data.ticketId as string;
}

describe("liitteet", () => {
  let server: TestServer;
  let admin: string;
  let resident: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34", password: PASSWORD
    });
    resident = await login(server, "liisa@example.com");
  });

  after(() => server.stop());

  it("liite tallentuu ja latautuu kirjautuneelle", async () => {
    const ticketId = await createTicket(server, admin);
    const saved = await call(server, admin, "POST", `/tickets/${ticketId}/attachments`, {
      attachments: [{ filename: "ohje.pdf", mimeType: "application/pdf", data: PDF }]
    });
    assert.equal(saved.status, 201);
    const attachmentId = saved.data.attachmentIds[0];

    const download = await fetch(`${server.url}/api/attachments/${attachmentId}`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "%PDF-1.4 testi");
    assert.equal((await fetch(`${server.url}/api/attachments/${attachmentId}`)).status, 401);
    assert.equal((await fetch(`${server.url}/api/attachments/${attachmentId}?token=${admin}`)).status, 401);
  });

  it("kuvan voi näyttää esikatseluna, muut liitteet vain ladataan", async () => {
    const ticketId = await createTicket(server, admin);
    const saved = await call(server, admin, "POST", `/tickets/${ticketId}/attachments`, {
      attachments: [
        { filename: "kuva.png", mimeType: "image/png", data: PNG },
        { filename: "ohje.pdf", mimeType: "application/pdf", data: PDF }
      ]
    });
    assert.equal(saved.status, 201);
    const [imageId, pdfId] = saved.data.attachmentIds;
    const headers = { Authorization: `Bearer ${admin}` };

    const image = await fetch(`${server.url}/api/attachments/${imageId}?inline=1`, { headers });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("content-disposition"), "inline");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");

    const pdf = await fetch(`${server.url}/api/attachments/${pdfId}?inline=1`, { headers });
    assert.equal(pdf.headers.get("content-type"), "application/octet-stream");
    assert.match(pdf.headers.get("content-disposition") ?? "", /^attachment/);
    assert.equal((await fetch(`${server.url}/api/attachments/${imageId}?inline=1`)).status, 401);
  });

  it("saapuneen sähköpostin liite liitetään viestiin aikajanalla", async () => {
    const created = await postInbound(server, admin, {
      companyId: "demo-company", senderName: "Matti", senderEmail: "matti@example.com",
      subject: "Kuva vuodosta", body: "Liitteenä kuva.", sourceMessageId: "<liite-1@example.com>"
    });
    assert.equal(created.status, 201);
    assert.ok(created.data.messageId);
    const detail = (await call(server, admin, "GET", `/tickets/${created.data.ticketId}`)).data;
    assert.equal(detail.messages[0].id, created.data.messageId);

    const reply = await postInbound(server, admin, {
      companyId: "demo-company", senderName: "Matti", senderEmail: "matti@example.com",
      subject: "Re: Kuva vuodosta", body: "Vielä toinen.", sourceMessageId: "<liite-2@example.com>",
      threadMessageIds: ["<liite-1@example.com>"]
    });
    assert.equal(reply.data.ticketId, created.data.ticketId);
    assert.ok(reply.data.messageId);
    assert.notEqual(reply.data.messageId, created.data.messageId);
  });

  it("ajettava tiedosto hylätään päätteen ja sisällön perusteella", async () => {
    const ticketId = await createTicket(server, admin);
    const byName = await call(server, admin, "POST", `/tickets/${ticketId}/attachments`, {
      attachments: [{ filename: "lasku.exe", mimeType: "application/pdf", data: PDF }]
    });
    assert.equal(byName.status, 400);
    assert.match(byName.data.error, /ajettavat tiedostot/);

    const byContent = await call(server, admin, "POST", `/tickets/${ticketId}/attachments`, {
      attachments: [{ filename: "lasku.pdf", mimeType: "application/pdf", data: EXE }]
    });
    assert.equal(byContent.status, 400);
    assert.equal((await call(server, admin, "GET", `/tickets/${ticketId}`)).data.attachments.length, 0);
  });

  it("asukkaan liitteen pitää olla oikeasti kuva tai PDF", async () => {
    const fake = await call(server, resident, "POST", "/portal/tickets", {
      subject: "Vuotava hana", description: "Keittiön hana tiputtaa.", type: "Vikailmoitus",
      attachments: [{ filename: "kuva.png", mimeType: "image/png", data: Buffer.from("ei ole kuva").toString("base64") }]
    });
    assert.equal(fake.status, 201);
    assert.equal(fake.data.attachmentError, "Liitteeksi kelpaa kuva tai PDF.");

    const real = await call(server, resident, "POST", "/portal/tickets", {
      subject: "Rikkinäinen ovi", description: "Varaston ovi ei mene kiinni.", type: "Vikailmoitus",
      attachments: [{ filename: "kuva.png", mimeType: "image/png", data: PNG }]
    });
    assert.equal(real.data.attachmentError, null);
    const detail = (await call(server, resident, "GET", `/portal/tickets/${real.data.ticketId}`)).data;
    assert.equal(detail.attachments.length, 1);
  });

  it("asukas ei pääse henkilökunnan rajapintaan eikä toisen asukkaan tehtävään", async () => {
    assert.equal((await call(server, resident, "GET", "/companies")).status, 403);
    assert.equal((await call(server, resident, "GET", "/portal/tickets/ticket-1")).status, 404);
    assert.equal((await call(server, admin, "GET", "/portal/me")).status, 403);
  });
  it("vastaukseen voi valita tehtävän omia liitteitä ja taloyhtiön dokumentteja, ei muiden tehtävien tai sisäisiä", async () => {
    const ticketId = await createTicket(server, admin);
    const otherTicketId = await createTicket(server, admin);
    const own = (await call(server, admin, "POST", `/tickets/${ticketId}/attachments`, {
      attachments: [{ filename: "kuva.png", mimeType: "image/png", data: PNG }]
    })).data.attachmentIds[0];
    const foreign = (await call(server, admin, "POST", `/tickets/${otherTicketId}/attachments`, {
      attachments: [{ filename: "muu.pdf", mimeType: "application/pdf", data: PDF }]
    })).data.attachmentIds[0];
    const upload = async (audience: string) => (await (await fetch(
      `${server.url}/api/companies/demo-company/knowledge/documents?${new URLSearchParams({ fileName: `ohje-${audience}.txt`, mimeType: "text/plain", audience })}`,
      { method: "POST", headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/octet-stream" }, body: "Järjestyssäännöt" }
    )).json()).knowledgeId as string;
    const publicDoc = await upload("ai");
    const internalDoc = await upload("internal");

    const reply = (body: Record<string, unknown>) => call(server, admin, "POST", `/tickets/${ticketId}/reply`, { body: "Liitteenä ohje.", ...body });
    // Kelvolliset liitteet hyväksytään; lähetys pysähtyy vasta siihen, ettei tehtävällä ole vastaanottajaa.
    const valid = await reply({ ticketAttachmentIds: [own], knowledgeIds: [publicDoc] });
    assert.equal(valid.status, 400);
    assert.match(valid.data.error, /sähköpostiosoitetta/);
    assert.equal((await reply({ ticketAttachmentIds: [foreign] })).status, 404);
    assert.equal((await reply({ knowledgeIds: [internalDoc] })).status, 404);
    const tooMany = await reply({ ticketAttachmentIds: Array(6).fill(own), knowledgeIds: Array(5).fill(publicDoc) });
    assert.equal(tooMany.status, 400);
  });
});

describe("virustarkistus (ClamAV)", () => {
  let scanner: net.Server;
  let server: TestServer;
  let admin: string;

  before(async () => {
    // Valepalvelu, joka noudattaa clamd:n INSTREAM-käytäntöä ja pitää EICAR-merkkijonoa viruksena.
    scanner = net.createServer(socket => {
      let received = Buffer.alloc(0);
      socket.on("data", chunk => {
        received = Buffer.concat([received, chunk]);
        if (received.subarray(-4).equals(Buffer.alloc(4))) {
          socket.end(received.includes("EICAR") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
        }
      });
    });
    await new Promise<void>(resolve => scanner.listen(0, "127.0.0.1", resolve));
    const port = (scanner.address() as net.AddressInfo).port;
    server = await startServer({ env: { CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: String(port) } });
    admin = await login(server, ADMIN_EMAIL);
  });

  after(async () => {
    await server.stop();
    scanner.close();
  });

  it("puhdas tiedosto hyväksytään ja saastunut hylätään", async () => {
    const ticketId = await createTicket(server, admin);
    const clean = await call(server, admin, "POST", `/tickets/${ticketId}/attachments`, {
      attachments: [{ filename: "ohje.pdf", mimeType: "application/pdf", data: PDF }]
    });
    assert.equal(clean.status, 201);

    const infected = await call(server, admin, "POST", `/tickets/${ticketId}/attachments`, {
      attachments: [{ filename: "virus.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF EICAR").toString("base64") }]
    });
    assert.equal(infected.status, 400);
    assert.match(infected.data.error, /haittaohjelman/);
  });

  it("tiedosto hylätään, jos tarkistus ei ole käytettävissä", async () => {
    await new Promise<void>(resolve => scanner.close(() => resolve()));
    const ticketId = await createTicket(server, admin);
    const result = await call(server, admin, "POST", `/tickets/${ticketId}/attachments`, {
      attachments: [{ filename: "ohje.pdf", mimeType: "application/pdf", data: PDF }]
    });
    assert.equal(result.status, 400);
    assert.match(result.data.error, /ei voitu tarkistaa/);
  });
});
