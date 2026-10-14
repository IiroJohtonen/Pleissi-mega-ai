import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, startServer, tempDir, type TestServer } from "./helpers.js";

// Moduulit avaavat tietokannan tuonnin yhteydessä, joten ne ladataan vasta väliaikaisen data-kansion jälkeen.
async function mailModules() {
  process.env.DATA_DIR = await tempDir();
  process.env.MAIL_SECRET_KEY = "11".repeat(32);
  return {
    secrets: await import("../src/mail-secrets.js"),
    imap: await import("../src/mail-imap.js"),
    microsoft: await import("../src/mail-microsoft.js")
  };
}

describe("sähköpostipalvelujen yhteiset osat", () => {
  let modules: Awaited<ReturnType<typeof mailModules>>;
  before(async () => {
    modules = await mailModules();
  });

  it("salaa ja purkaa tallennetun salasanan", () => {
    const stored = modules.secrets.encryptSecret("sälä-sana 123");
    assert.match(stored, /^enc:v1:/);
    assert.ok(!stored.includes("sälä"));
    assert.equal(modules.secrets.decryptSecret(stored), "sälä-sana 123");
  });

  it("muuntaa IMAP-viestin tuotavaksi ketjutietoineen ja liitteineen", async () => {
    const raw = await new MailComposer({
      from: "Liisa Mallikas <liisa@example.com>",
      to: "Kotilo <posti@toimisto.fi>",
      cc: "koivikko@toimisto.fi",
      subject: "Re: Saunavuoro",
      text: "Kiitos vastauksesta!",
      messageId: "<vastaus-1@example.com>",
      inReplyTo: "<kotilo-1@toimisto.fi>",
      references: "<alku-1@example.com> <kotilo-1@toimisto.fi>",
      attachments: [{ filename: "kuva.png", content: Buffer.from("png"), contentType: "image/png" }]
    }).compile().build();
    const parsed = await simpleParser(raw);
    const inbound = modules.imap.parsedToInbound(parsed, "varatunniste");
    assert.equal(inbound.id, "<vastaus-1@example.com>");
    assert.equal(inbound.subject, "Re: Saunavuoro");
    assert.equal(inbound.body, "Kiitos vastauksesta!");
    assert.match(inbound.from, /liisa@example\.com/);
    assert.deepEqual(inbound.threadMessageIds.sort(), ["<alku-1@example.com>", "<kotilo-1@toimisto.fi>"]);
    assert.deepEqual(inbound.recipients.sort(), ["koivikko@toimisto.fi", "posti@toimisto.fi"]);
    const attachments = await inbound.attachments();
    assert.equal(attachments[0].filename, "kuva.png");
    assert.equal(attachments[0].content.toString(), "png");
    assert.equal(modules.imap.isKotiloNotification(parsed), false);

    const notification = await simpleParser(await new MailComposer({
      from: "posti@toimisto.fi", to: "hanna@toimisto.fi", subject: "Hätä", text: "x", headers: { "X-Kotilo-Notification": "1" }
    }).compile().build());
    assert.equal(modules.imap.isKotiloNotification(notification), true);
  });

  it("muuntaa Microsoft 365 -viestin tuotavaksi", async () => {
    const message = {
      id: "AAMk1",
      internetMessageId: "<ms-2@outlook.com>",
      subject: "Vuotava hana",
      from: { emailAddress: { name: "Matti Meikäläinen", address: "matti@example.com" } },
      toRecipients: [{ emailAddress: { address: "posti@toimisto.fi" } }],
      ccRecipients: [],
      body: { contentType: "text", content: "  Keittiön hana vuotaa.  " },
      internetMessageHeaders: [{ name: "In-Reply-To", value: "<kotilo-2@toimisto.fi>" }]
    };
    const inbound = modules.microsoft.graphToInbound(message, ["<ms-2@outlook.com>", "<alku-2@outlook.com>"], async () => []);
    assert.equal(inbound.id, "<ms-2@outlook.com>");
    assert.equal(inbound.from, "Matti Meikäläinen <matti@example.com>");
    assert.equal(inbound.body, "Keittiön hana vuotaa.");
    assert.deepEqual(inbound.threadMessageIds.sort(), ["<alku-2@outlook.com>", "<kotilo-2@toimisto.fi>"]);
    assert.deepEqual(inbound.recipients, ["posti@toimisto.fi"]);
    assert.equal(modules.microsoft.isGraphNotification(message), false);
    assert.equal(modules.microsoft.isGraphNotification({ ...message, internetMessageHeaders: [{ name: "x-kotilo-notification", value: "1" }] }), true);
  });
});

describe("sähköpostitilien yhdistäminen", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;

  before(async () => {
    server = await startServer({ env: { MS_CLIENT_ID: "testi-client", MS_CLIENT_SECRET: "testi-salaisuus", MS_REDIRECT_URI: "https://app.kotilo.io/api/mail/microsoft/callback" } });
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
  });

  after(() => server.stop());

  it("kertoo käytössä olevat palvelut ja aloittaa Microsoft-kirjautumisen", async () => {
    const providers = await call(server, admin, "GET", "/mail/providers");
    assert.equal(providers.data.microsoft, true);
    assert.equal(providers.data.imap, true);

    assert.equal((await call(server, manager, "POST", "/mail/microsoft/connect", { target: "office" })).status, 403);
    const started = await call(server, admin, "POST", "/mail/microsoft/connect", { target: "office" });
    assert.equal(started.status, 200);
    const url = new URL(started.data.url);
    assert.equal(url.hostname, "login.microsoftonline.com");
    assert.equal(url.searchParams.get("client_id"), "testi-client");
    assert.equal(url.searchParams.get("redirect_uri"), "https://app.kotilo.io/api/mail/microsoft/callback");
    assert.match(url.searchParams.get("scope") ?? "", /Mail\.Send/);

    // Paluuosoite toimii ilman istuntoa, mutta tuntematon state ei yhdistä mitään.
    const callback = await call(server, null, "GET", "/mail/microsoft/callback?state=tuntematon&code=x");
    assert.equal(callback.status, 200);
    assert.match(String(callback.data), /vanhentunut tai virheellinen/);
  });

  it("tarkistaa IMAP-tiedot ja kertoo, jos palvelimeen ei saada yhteyttä", async () => {
    const account = {
      target: "demo-company", email: "posti@koivikko.fi", imapHost: "127.0.0.1", imapPort: 1,
      smtpHost: "127.0.0.1", smtpPort: 1, password: "salasana"
    };
    assert.equal((await call(server, manager, "POST", "/mail/imap", account)).status, 403);
    assert.equal((await call(server, admin, "POST", "/mail/imap", { ...account, email: "ei-osoite" })).status, 400);
    assert.equal((await call(server, admin, "POST", "/mail/imap", { ...account, imapHost: "huono osoite" })).status, 400);

    const refused = await call(server, admin, "POST", "/mail/imap", account);
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /IMAP-palvelimeen ei saatu yhteyttä/);

    // Epäonnistunut yhteys ei tallenna tiliä.
    const status = await call(server, admin, "GET", "/mail/status?companyId=demo-company");
    assert.equal(status.data.own, false);
  });
});
