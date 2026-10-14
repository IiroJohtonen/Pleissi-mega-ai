import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, startServer, tempDir, type TestServer, userByEmail } from "./helpers.js";

// Moduulit avaavat tietokannan tuonnin yhteydessä, joten ne ladataan vasta väliaikaisen data-kansion jälkeen.
async function mailModules() {
  process.env.DATA_DIR = await tempDir();
  process.env.MAIL_SECRET_KEY = "11".repeat(32);
  // Demokanta ja toinen, sovelluksessa luotu yhtiö, jonka vastuuisännöitsijä on "isannoitsija-2".
  const { db, seed } = await import("../src/db.js");
  seed();
  db.prepare("INSERT INTO companies (id, name, email_address, managed, manager_id) VALUES ('toinen-yhtio', 'As Oy Toinen', '', 1, 'isannoitsija-2')").run();
  return {
    common: await import("../src/mail-common.js"),
    secrets: await import("../src/mail-secrets.js"),
    imap: await import("../src/mail-imap.js"),
    microsoft: await import("../src/mail-microsoft.js"),
    mail: await import("../src/mail.js")
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

  it("valitsee isännöitsijän omaan laatikkoon tulleelle viestille taloyhtiön", () => {
    const { companyForUserMailbox, mailboxOwnerId, userAccountId } = modules.common;
    assert.equal(userAccountId("abc"), "user:abc");
    assert.equal(mailboxOwnerId("user:abc"), "abc");
    assert.equal(mailboxOwnerId("office"), null);
    // Tunnettu asukas: hänen taloyhtiönsä, vaikka isännöitsijä hoitaa toista yhtiötä.
    assert.equal(companyForUserMailbox("isannoitsija-2", "MATTI@example.com"), "demo-company");
    // Tuntematon lähettäjä: isännöitsijän ainoa oma yhtiö.
    assert.equal(companyForUserMailbox("isannoitsija-2", "tuntematon@example.com"), "toinen-yhtio");
    // Ei omaa yhtiötä: oletusyhtiö.
    assert.equal(companyForUserMailbox("joku-muu", ""), "demo-company");
  });

  it("kertoo Microsoftin kirjautumisvirheen koodin ja korjauksen", () => {
    const message = modules.microsoft.microsoftErrorMessage(
      "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value."
    );
    assert.match(message, /AADSTS7000215/);
    assert.match(message, /Value-kenttä/);
    assert.match(modules.microsoft.microsoftErrorMessage("AADSTS999999: tuntematon"), /AADSTS999999.*Yhdistä tili uudelleen/);
    assert.equal(modules.microsoft.microsoftErrorMessage(""), "Microsoft-kirjautuminen epäonnistui. Yhdistä tili uudelleen asetuksista.");
  });

  it("tarjoaa vastaukselle lähettäjät ja valitsee oletukseksi saapumislaatikon", () => {
    const { mail, common, secrets } = modules;
    const save = (accountId: string, email: string) => common.saveMailAccount({
      accountId, email, provider: "imap", token: secrets.encryptSecret("salasana"), connectedBy: "testi"
    });
    const choices = (ticket: { id: string; company_id: string; mail_account_id?: string | null }, userId?: string) =>
      mail.replyAccountsFor(ticket, userId).map(account => `${account.kind}:${account.email}${account.arrived ? ":saapui" : ""}`);
    const manual = { id: "ei-sahkopostia", company_id: "demo-company" };

    // Ei yhtään tiliä: ei lähettäjiä.
    assert.deepEqual(choices(manual, "isannoitsija-2"), []);
    save("office", "toimisto@toimisto.fi");
    save("user:isannoitsija-2", "hanna@toimisto.fi");
    save("user:isannoitsija-3", "kalle@toimisto.fi");
    // Käsin luotu tehtävä: ensin oma laatikko, sitten toimisto.
    assert.deepEqual(choices(manual, "isannoitsija-2"), ["own:hanna@toimisto.fi", "office:toimisto@toimisto.fi"]);
    // Toimiston laatikkoon saapunut: toimisto on oletus.
    assert.deepEqual(choices({ ...manual, mail_account_id: "office" }, "isannoitsija-2"),
      ["office:toimisto@toimisto.fi:saapui", "own:hanna@toimisto.fi"]);
    // Kollegan laatikkoon saapunut: kollegan laatikosta ei voi lähettää.
    assert.deepEqual(choices({ ...manual, mail_account_id: "user:isannoitsija-3" }, "isannoitsija-2"),
      ["own:hanna@toimisto.fi", "office:toimisto@toimisto.fi"]);
    // Taloyhtiön oma tili näkyy omana vaihtoehtonaan.
    save("demo-company", "koivikko@toimisto.fi");
    assert.deepEqual(choices({ ...manual, mail_account_id: "demo-company" }, "isannoitsija-2"),
      ["company:koivikko@toimisto.fi:saapui", "own:hanna@toimisto.fi", "office:toimisto@toimisto.fi"]);
    for (const accountId of ["office", "user:isannoitsija-2", "user:isannoitsija-3", "demo-company"]) common.disconnectMailAccount(accountId);
  });

  it("lähettää vastauksen Microsoft 365 -tililtä alkuperäiseen viestiin", async () => {
    const { mail, common, secrets } = modules;
    common.saveMailAccount({
      accountId: "user:ms-testi",
      email: "hanna@outlook.com",
      provider: "microsoft",
      token: secrets.encryptSecret(JSON.stringify({ access_token: "tunnus", refresh_token: "r", expires_at: Date.now() + 3_600_000 })),
      connectedBy: "testi"
    });
    const calls: { method: string; url: string; body?: any }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer tunnus");
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "GET" && url.includes("$filter=")) return json({ value: [{ id: "alkuperainen" }] });
      if (url.endsWith("/createReply")) return json({ id: "luonnos" });
      if (method === "GET" && url.includes("/messages/luonnos")) return json({ internetMessageId: "<vastaus@outlook.com>" });
      if (url.endsWith("/attachments")) return json({ id: "liite" });
      if (method === "PATCH") return json({ id: "luonnos" });
      return new Response(null, { status: method === "POST" ? 202 : 200 });
    }) as typeof fetch;
    try {
      const sent = await mail.sendEmail({
        to: "matti@example.com",
        subject: "Re: Vuotava hana",
        body: "Huoltomies tulee huomenna.",
        sourceMessageId: "<ms-2@outlook.com>",
        attachments: [{ filename: "ohje.txt", mimeType: "text/plain", content: Buffer.from("ohje") }],
        companyId: "demo-company",
        accountId: "user:ms-testi"
      });
      assert.equal(sent.id, "<vastaus@outlook.com>");
    } finally {
      globalThis.fetch = originalFetch;
      common.disconnectMailAccount("user:ms-testi");
    }
    const steps = calls.map(call => `${call.method} ${call.url.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "").split("?")[0]}`);
    assert.deepEqual(steps, [
      "GET /me/messages",
      "POST /me/messages/alkuperainen/createReply",
      "PATCH /me/messages/luonnos",
      "POST /me/messages/luonnos/attachments",
      "GET /me/messages/luonnos",
      "POST /me/messages/luonnos/send"
    ]);
    assert.match(decodeURIComponent(calls[0].url), /internetMessageId eq '<ms-2@outlook\.com>'/);
    assert.equal(calls[2].body.body.content, "Huoltomies tulee huomenna.");
    assert.equal(calls[2].body.toRecipients[0].emailAddress.address, "matti@example.com");
    assert.equal(calls[3].body.name, "ohje.txt");
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

  it("jokainen käyttäjä voi yhdistää oman postilaatikkonsa", async () => {
    const own = await call(server, manager, "GET", "/mail/status?target=me");
    assert.equal(own.status, 200);
    assert.equal(own.data.own, true);
    assert.equal(own.data.connected, false);

    // Isännöitsijä saa yrittää omaa laatikkoaan, mutta ei toimiston tiliä.
    const refused = await call(server, manager, "POST", "/mail/imap", {
      target: "me", email: "hanna@toimisto.fi", imapHost: "127.0.0.1", imapPort: 1, smtpHost: "127.0.0.1", smtpPort: 1, password: "x"
    });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /IMAP-palvelimeen ei saatu yhteyttä/);
    assert.equal((await call(server, manager, "POST", "/mail/microsoft/connect", { target: "me" })).status, 200);
    assert.equal((await call(server, manager, "DELETE", "/mail/accounts/me")).status, 404);
  });

  it("omaan laatikkoon tullut tehtävä annetaan laatikon omistajalle", async () => {
    const owner = await userByEmail(server, admin, MANAGER_EMAIL);
    const created = await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Liisa Mallikas", senderEmail: "liisa@example.com",
      subject: "Kysymys pyörävarastosta", body: "Mistä saan avaimen pyörävarastoon?",
      sourceMessageId: "<oma-1@example.com>", assigneeId: owner.id, mailAccountId: `user:${owner.id}`
    });
    assert.equal(created.status, 201);
    const detail = (await call(server, admin, "GET", `/tickets/${created.data.ticketId}`)).data;
    const ticket = detail.ticket;
    // Yhtään postitiliä ei ole yhdistetty, joten lähettäjävaihtoehtoja ei ole.
    assert.deepEqual(detail.replyAccounts, []);
    assert.equal(ticket.assignee_id, owner.id);
    assert.equal(ticket.status, "open");
    assert.equal(ticket.mail_account_id, `user:${owner.id}`);

    // Lähettäjäksi ei voi valita tiliä, jota käyttäjälle ei tarjota.
    const refused = await call(server, manager, "POST", `/tickets/${created.data.ticketId}/reply`, {
      body: "Avain on huoltoyhtiöllä.", fromAccountId: "user:joku-muu"
    });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /Valitse toinen lähettäjä/);
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
