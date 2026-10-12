
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { INTERNAL_TOKEN } from "./auth.js";
import { assertSafeFile } from "./scan.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const credentialsPath = path.resolve(__dirname, "../credentials.json");
const tokenPath = path.resolve(__dirname, "../token.json");

// KIITO_COMPANY_ID on muuttujan vanha nimi; se toimii edelleen.
const COMPANY_ID = process.env.DEFAULT_COMPANY_ID || process.env.KIITO_COMPANY_ID || "demo-company";
const POLL_INTERVAL_MS = 20_000;

type GmailHeader = {
  name?: string;
  value?: string;
};

type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

type GmailMessage = {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: {
    headers?: GmailHeader[];
    mimeType?: string;
    body?: { data?: string };
    parts?: GmailPart[];
  };
};

let isRunning = false;

function decodeBase64Url(data: string): string {
  return Buffer.from(
    data.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
}

function findBody(part?: GmailPart): { text?: string; html?: string } {
  if (!part) return {};

  if (part.mimeType === "text/plain" && part.body?.data) {
    return { text: decodeBase64Url(part.body.data) };
  }

  if (part.mimeType === "text/html" && part.body?.data) {
    return { html: decodeBase64Url(part.body.data) };
  }

  for (const child of part.parts || []) {
    const found = findBody(child);
    if (found.text || found.html) return found;
  }

  return {};
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getHeader(message: GmailMessage, name: string): string {
  const header = message.payload?.headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase()
  );
  return header?.value || "";
}

export function parseSender(from: string): { name: string; email: string } {
  const match = from.match(/^(.*?)\s*<([^<>]+)>$/);

  if (match) {
    return {
      name: match[1].replace(/^"|"$/g, "").trim() || match[2],
      email: match[2].trim()
    };
  }

  const emailMatch = from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const email = emailMatch?.[0] || "";

  return {
    name: from.trim() || email || "Tuntematon",
    email
  };
}

// Gmail-tilit tallennetaan tietokantaan: "office" on toimiston tili, muut tunnisteet ovat taloyhtiöitä.
// Taloyhtiö ilman omaa tiliä käyttää toimiston tiliä. Vanha token.json toimii toimiston tilinä,
// kunnes tili yhdistetään asetuksista.
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send"
];
export const OFFICE_ACCOUNT = "office";

async function oauthConfig() {
  const credentialsFile = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
  const config = credentialsFile.installed || credentialsFile.web;
  if (!config?.client_id || !config?.client_secret) {
    throw new Error("credentials.json-tiedostosta puuttuvat OAuth-clientin tiedot.");
  }
  return config as { client_id: string; client_secret: string; redirect_uris?: string[] };
}

// Googlen kirjautuminen palaa tähän osoitteeseen. Työpöytätyyppinen OAuth-client sallii localhost-osoitteen.
function gmailRedirectUri(): string {
  return process.env.GMAIL_REDIRECT_URI || `http://localhost:${process.env.PORT || 4000}/api/gmail/callback`;
}

// Kirjautumisosoite, jossa käyttäjä valitsee yhdistettävän Gmail-tilin.
export async function gmailAuthUrl(state: string): Promise<string> {
  const config = await oauthConfig();
  const auth = new google.auth.OAuth2(config.client_id, config.client_secret, gmailRedirectUri());
  return auth.generateAuthUrl({
    access_type: "offline",
    // consent pakottaa uuden refresh tokenin, select_account antaa valita tilin.
    prompt: "consent select_account",
    scope: GMAIL_SCOPES,
    state
  });
}

// Vaihtaa kirjautumiskoodin tunnisteiksi ja tallentaa tilin. Palauttaa yhdistetyn tilin osoitteen.
export async function connectGmailAccount(accountId: string, code: string, connectedBy: string): Promise<string> {
  const config = await oauthConfig();
  const auth = new google.auth.OAuth2(config.client_id, config.client_secret, gmailRedirectUri());
  const { tokens } = await auth.getToken(code);
  if (!tokens.refresh_token) throw new Error("Google ei palauttanut pysyvää tunnistetta. Yritä yhdistämistä uudelleen.");
  auth.setCredentials(tokens);
  const profile = await auth.request<{ emailAddress?: string }>({
    url: "https://gmail.googleapis.com/gmail/v1/users/me/profile"
  });
  const email = profile.data.emailAddress || "";

  const { db } = await import("./db.js");
  const other = db.prepare("SELECT id FROM gmail_accounts WHERE lower(email) = lower(?) AND id != ?").get(email, accountId) as { id: string } | undefined;
  if (other) {
    throw new Error(other.id === OFFICE_ACCOUNT
      ? "Tämä Gmail-tili on jo toimiston tilinä. Taloyhtiö käyttää sitä automaattisesti ilman omaa tiliä."
      : "Tämä Gmail-tili on jo yhdistetty toiseen taloyhtiöön.");
  }
  db.prepare(`
    INSERT INTO gmail_accounts (id, email, token, connected_at, connected_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET email = excluded.email, token = excluded.token,
      connected_at = excluded.connected_at, connected_by = excluded.connected_by
  `).run(accountId, email, JSON.stringify(tokens), new Date().toISOString(), connectedBy);
  // Uuden tilin vanhoja viestejä ei tuoda: tarkistus alkaa yhdistämishetkestä.
  db.prepare("DELETE FROM gmail_sync_state WHERE key IN (?, ?)").run(syncKey(accountId, "last_poll_ms"), syncKey(accountId, "sync_start_ms"));
  return email;
}

export async function disconnectGmailAccount(accountId: string): Promise<boolean> {
  const { db } = await import("./db.js");
  return db.prepare("DELETE FROM gmail_accounts WHERE id = ?").run(accountId).changes > 0;
}

// Tili, jolla taloyhtiön posti kulkee: oma tili, jos sellainen on yhdistetty, muuten toimiston tili.
export async function gmailAccountFor(companyId?: string): Promise<string> {
  if (!companyId) return OFFICE_ACCOUNT;
  const { db } = await import("./db.js");
  return db.prepare("SELECT 1 FROM gmail_accounts WHERE id = ?").get(companyId) ? companyId : OFFICE_ACCOUNT;
}

function syncKey(accountId: string, key: string): string {
  return accountId === OFFICE_ACCOUNT ? key : `${key}:${accountId}`;
}

// GMAIL_DISABLED=1 kytkee postin kokonaan pois (testit ja ympäristöt, joista ei saa lähteä postia).
export const gmailEnabled = process.env.GMAIL_DISABLED !== "1";

async function getGmailClient(accountId: string = OFFICE_ACCOUNT) {
  if (!gmailEnabled) throw new Error("Gmail on kytketty pois päältä (GMAIL_DISABLED=1).");
  const config = await oauthConfig();
  const { db } = await import("./db.js");
  const row = db.prepare("SELECT token FROM gmail_accounts WHERE id = ?").get(accountId) as { token: string } | undefined;

  let token: Record<string, unknown>;
  if (row) token = JSON.parse(row.token);
  else if (accountId === OFFICE_ACCOUNT) token = JSON.parse(await fs.readFile(tokenPath, "utf8"));
  else throw new Error("Taloyhtiölle ei ole yhdistetty omaa Gmail-tiliä.");

  if (!token.refresh_token) {
    throw new Error("Gmail-tilin pysyvä tunniste puuttuu. Yhdistä tili uudelleen asetuksista.");
  }

  const auth = new google.auth.OAuth2(config.client_id, config.client_secret, gmailRedirectUri());
  auth.setCredentials(token);
  // Google uusii lyhytikäisen tunnisteen itsestään; uusi arvo tallennetaan tilille.
  if (row) {
    auth.on("tokens", fresh => {
      db.prepare("UPDATE gmail_accounts SET token = ? WHERE id = ?").run(JSON.stringify({ ...token, ...fresh }), accountId);
    });
  }
  return auth;
}

async function getMessageBody(
  auth: Awaited<ReturnType<typeof getGmailClient>>,
  message: GmailMessage
): Promise<string> {
  const payload = message.payload;

  if (!payload) return "";

  const topLevelPart: GmailPart = {
    mimeType: payload.mimeType,
    body: payload.body,
    parts: payload.parts
  };

  const body = findBody(topLevelPart);

  if (body.text) return body.text.trim();
  if (body.html) return htmlToText(body.html);

  return "";
}

export async function getGmailStatus(accountId: string = OFFICE_ACCOUNT): Promise<{
  connected: boolean;
  emailAddress?: string;
  canSend?: boolean;
}> {
  try {
    const auth = await getGmailClient(accountId);
    const profile = await auth.request<{ emailAddress?: string }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile"
    });
    const scope = auth.credentials.scope || "";

    return {
      connected: true,
      emailAddress: profile.data.emailAddress,
      canSend: scope.includes("https://www.googleapis.com/auth/gmail.send")
    };
  } catch {
    return { connected: false };
  }
}

function extractEmails(value: string): string[] {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
}

function findAttachments(part?: GmailPart): GmailPart[] {
  if (!part) return [];
  const own = part.filename && part.body?.attachmentId ? [part] : [];
  return [...own, ...(part.parts || []).flatMap(findAttachments)];
}

async function saveAttachments(
  auth: Awaited<ReturnType<typeof getGmailClient>>,
  message: GmailMessage,
  ticketId: string
): Promise<void> {
  const { db, attachmentsDir } = await import("./db.js");

  for (const part of findAttachments({ parts: message.payload?.parts })) {
    try {
      const response = await auth.request<{ data?: string }>({
        url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.body!.attachmentId!)}`
      });

      const content = Buffer.from(response.data.data || "", "base64url");
      // Vaarallinen liite jätetään tallentamatta; viesti itse tuodaan silti.
      await assertSafeFile(content, part.filename || "");
      const attachmentId = `attachment-${crypto.randomUUID()}`;

      await fs.writeFile(path.join(attachmentsDir, attachmentId), content);

      db.prepare(`
        INSERT INTO attachments (id, ticket_id, filename, mime_type, size, created_at, direction)
        VALUES (?, ?, ?, ?, ?, ?, 'inbound')
      `).run(
        attachmentId,
        ticketId,
        part.filename,
        part.mimeType || "application/octet-stream",
        content.length,
        new Date().toISOString()
      );
    } catch (error) {
      console.warn(
        `Liitteen "${part.filename}" tallennus epäonnistui:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}

// Jokaisella tarkistuksella katsotaan saapuneet viestit näin pitkältä ajalta taaksepäin. Jo tuodut
// viestit tunnistetaan tunnisteesta, joten viesti ei jää väliin, vaikka se ilmestyisi Gmailin
// hakuun vasta myöhemmin kuin se on vastaanotettu.
const LOOKBACK_MS = 6 * 60 * 60 * 1000;

// Viestit, joita ei tuoda (tyhjä sisältö tai pysyvä virhe); ei yritetä uudelleen joka kierroksella.
const skippedMessageIds = new Set<string>();

async function pollGmail(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const { db } = await import("./db.js");
    const companyAccounts = db.prepare("SELECT id FROM gmail_accounts WHERE id != ?").all(OFFICE_ACCOUNT) as { id: string }[];
    for (const accountId of [OFFICE_ACCOUNT, ...companyAccounts.map(account => account.id)]) {
      await pollAccount(accountId);
    }
  } finally {
    isRunning = false;
  }
}

// Tuo yhden Gmail-tilin uudet viestit. Taloyhtiön oman tilin viestit kuuluvat aina sille taloyhtiölle;
// toimiston tilin viestit ohjataan vastaanottajan osoitteen perusteella.
async function pollAccount(accountId: string): Promise<void> {
  try {
    const auth = await getGmailClient(accountId);

    const state = await auth.request({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile"
    });

    if (!state.data) {
      throw new Error("Gmail-profiilin lukeminen epäonnistui.");
    }

    const { db } = await import("./db.js");

    const cursorRow = db.prepare(
      "SELECT value FROM gmail_sync_state WHERE key = ?"
    ).get(syncKey(accountId, "last_poll_ms")) as { value: string } | undefined;

    if (!cursorRow) {
      db.prepare(
        "INSERT INTO gmail_sync_state (key, value) VALUES (?, ?)"
      ).run(syncKey(accountId, "last_poll_ms"), String(Date.now()));
      db.prepare(
        "INSERT OR REPLACE INTO gmail_sync_state (key, value) VALUES (?, ?)"
      ).run(syncKey(accountId, "sync_start_ms"), String(Date.now()));

      console.log(
        "Kotilo Gmail: ensimmäinen tarkistus tehty. Vanhat viestit ohitetaan."
      );
      return;
    }

    const lastPollMs = Number(cursorRow.value);

    if (!Number.isFinite(lastPollMs)) {
      throw new Error("Gmail-synkronoinnin aikaleima ei ole kelvollinen.");
    }

    // Käyttöönottohetkeä vanhempia viestejä ei tuoda koskaan.
    let syncStartRow = db.prepare(
      "SELECT value FROM gmail_sync_state WHERE key = ?"
    ).get(syncKey(accountId, "sync_start_ms")) as { value: string } | undefined;

    if (!syncStartRow) {
      syncStartRow = { value: String(lastPollMs - LOOKBACK_MS) };
      db.prepare(
        "INSERT INTO gmail_sync_state (key, value) VALUES (?, ?)"
      ).run(syncKey(accountId, "sync_start_ms"), syncStartRow.value);
    }

    const lowerBoundMs = Math.max(Number(syncStartRow.value) || 0, Date.now() - LOOKBACK_MS);
    const queryAfter = Math.max(0, Math.floor(lowerBoundMs / 1000) - 60);
    const isImported = db.prepare("SELECT 1 FROM gmail_imports WHERE gmail_message_id = ?");

    let pageToken: string | undefined;
    const messages: { id: string }[] = [];

    do {
      const response = await auth.request<{
        messages?: { id: string }[];
        nextPageToken?: string;
      }>({
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        params: {
          q: `in:inbox after:${queryAfter}`,
          maxResults: 100,
          pageToken
        }
      });

      messages.push(...(response.data.messages || []));
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    let imported = 0;

    // Vanhin ensin, jotta saman ketjun viestit päätyvät tehtävälle oikeassa järjestyksessä.
    for (const listedMessage of messages.reverse()) {
      if (skippedMessageIds.has(listedMessage.id) || isImported.get(listedMessage.id)) continue;

      const messageResponse = await auth.request<GmailMessage>({
        url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(listedMessage.id)}`,
        params: { format: "full" }
      });

      const message = messageResponse.data;
      const receivedAt = Number(message.internalDate || 0);

      if (!message.id || receivedAt < lowerBoundMs) {
        skippedMessageIds.add(listedMessage.id);
        continue;
      }

      const from = getHeader(message, "From");
      const subject =
        getHeader(message, "Subject") || "Uusi yhteydenotto";
      const sender = parseSender(from);
      const body = await getMessageBody(auth, message);

      if (!body.trim()) {
        console.warn(
          `Gmail-viesti ${message.id} ohitettiin: viestin tekstisisältö puuttuu.`
        );
        skippedMessageIds.add(message.id);
        continue;
      }

      // Ketjun aiemmat viestit kertovat, kuuluuko vastaus jo olemassa olevalle tehtävälle.
      let threadMessageIds: string[] = [];
      if (message.threadId && message.threadId !== message.id) {
        try {
          const thread = await auth.request<{ messages?: { id: string }[] }>({
            url: `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(message.threadId)}`,
            params: { format: "minimal" }
          });
          threadMessageIds = (thread.data.messages || [])
            .map((threadMessage) => threadMessage.id)
            .filter((threadMessageId) => threadMessageId !== message.id);
        } catch (error) {
          console.warn(
            `Gmail-ketjun ${message.threadId} lukeminen epäonnistui, viesti käsitellään uutena:`,
            error instanceof Error ? error.message : error
          );
        }
      }

      const response = await fetch(
        `http://127.0.0.1:${process.env.PORT || 4000}/api/inbound/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-token": INTERNAL_TOKEN },
          body: JSON.stringify({
            companyId: accountId === OFFICE_ACCOUNT ? COMPANY_ID : accountId,
            channel: "email",
            senderName: sender.name,
            senderEmail: sender.email || undefined,
            subject,
            body,
            sourceMessageId: message.id,
            threadMessageIds,
            recipientEmails: accountId === OFFICE_ACCOUNT
              ? extractEmails(["To", "Cc", "Delivered-To"].map((name) => getHeader(message, name)).join(" "))
              : []
          })
        }
      );

      if (!response.ok) {
        // Yksi epäonnistunut viesti ei saa pysäyttää muiden tuontia. Pysyvää virhettä (4xx) ei
        // yritetä uudelleen; muut yritetään seuraavalla kierroksella.
        console.error(
          `Kotilo API palautti virheen ${response.status} viestille ${message.id} ("${subject}").`
        );
        if (response.status >= 400 && response.status < 500) skippedMessageIds.add(message.id);
        continue;
      }

      const result = await response.json() as {
        ticketId?: string;
        duplicate?: boolean;
      };

      if (!result.duplicate) {
        if (result.ticketId) {
          await saveAttachments(auth, message, result.ticketId);
        }
        imported++;
        console.log(
          `Gmail-viesti käsitelty: "${subject}" (tehtävä ${result.ticketId || "luotu"})`
        );
      }
    }

    db.prepare(
      "UPDATE gmail_sync_state SET value = ? WHERE key = ?"
    ).run(String(Date.now()), syncKey(accountId, "last_poll_ms"));

    if (imported > 0) {
      console.log(`Kotilo Gmail: ${imported} uutta viestiä käsitelty.`);
    }
  } catch (error) {
    console.error(
      `Gmail-tarkistus epäonnistui (${accountId === OFFICE_ACCOUNT ? "toimiston tili" : accountId}):`,
      error instanceof Error ? error.message : error
    );
  }
}

function encodeHeaderValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;

  // RFC 2047: yksi encoded-word saa olla enintään 75 merkkiä.
  const words: string[] = [];
  let chunk = "";

  for (const char of clean) {
    if (Buffer.byteLength(chunk + char, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);

  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

export type OutgoingAttachment = { filename: string; mimeType: string; content: Buffer };

function base64Lines(content: Buffer): string {
  return content.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

// Liitteen otsakkeet: ASCII-nimi vanhoille ohjelmille ja UTF-8-nimi (RFC 2231) ääkkösiä varten.
function attachmentPart(attachment: OutgoingAttachment): string {
  const safeName = attachment.filename.replace(/[\r\n"\\]/g, "_");
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, "_");
  const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType) ? attachment.mimeType : "application/octet-stream";
  return [
    `Content-Type: ${mimeType}; name="${asciiName}"`,
    `Content-Disposition: attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(attachment.content)
  ].join("\r\n");
}

export async function sendGmailReply(input: {
  to?: string;
  // Piilokopion saajat eivät näe toistensa osoitteita.
  bcc?: string;
  subject: string;
  body: string;
  sourceMessageId?: string;
  attachments?: OutgoingAttachment[];
  // Taloyhtiö, jonka nimissä viesti lähtee: käytetään sen omaa Gmail-tiliä, jos sellainen on.
  companyId?: string;
}): Promise<{ id: string }> {
  const auth = await getGmailClient(await gmailAccountFor(input.companyId));

  let threadId: string | undefined;
  let originalMessageId = "";
  let references = "";

  if (input.sourceMessageId) {
    try {
      const original = await auth.request<GmailMessage & { threadId?: string }>({
        url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(input.sourceMessageId)}`,
        params: { format: "metadata" }
      });

      threadId = original.data.threadId;
      originalMessageId = getHeader(original.data, "Message-ID");
      references = getHeader(original.data, "References");
    } catch (error) {
      // Alkuperäinen viesti on voitu poistaa; vastaus lähetetään silti uutena ketjuna.
      console.warn(
        "Alkuperäisen Gmail-viestin lukeminen epäonnistui:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const attachments = input.attachments ?? [];
  const boundary = `kotilo-${crypto.randomUUID()}`;

  const headers = [
    ...(input.to ? [`To: ${input.to}`] : []),
    ...(input.bcc ? [`Bcc: ${input.bcc}`] : []),
    `Subject: ${encodeHeaderValue(input.subject)}`,
    "MIME-Version: 1.0",
    ...(attachments.length > 0
      ? [`Content-Type: multipart/mixed; boundary="${boundary}"`]
      : ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64"])
  ];

  if (originalMessageId) {
    headers.push(`In-Reply-To: ${originalMessageId}`);
    headers.push(`References: ${`${references} ${originalMessageId}`.trim()}`);
  }

  const encodedBody = base64Lines(Buffer.from(input.body, "utf8"));

  // Liitteiden kanssa viesti on moniosainen: ensin teksti, sitten jokainen liite omana osanaan.
  const content = attachments.length > 0
    ? [
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        encodedBody,
        ...attachments.flatMap(attachment => [`--${boundary}`, attachmentPart(attachment)]),
        `--${boundary}--`
      ].join("\r\n")
    : encodedBody;

  const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${content}`, "utf8")
    .toString("base64url");

  const response = await auth.request<{ id: string }>({
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    method: "POST",
    data: threadId ? { raw, threadId } : { raw }
  });

  return { id: response.data.id };
}

export function startGmailPolling(): void {
  if (!gmailEnabled) {
    console.log("Kotilo Gmail: kytketty pois päältä, postia ei tarkisteta eikä lähetetä.");
    return;
  }
  console.log("Kotilo Gmail: automaattinen tarkistus käynnistetty.");

  void pollGmail();
  setInterval(() => void pollGmail(), POLL_INTERVAL_MS);
}
