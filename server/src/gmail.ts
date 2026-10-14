import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { db } from "./db.js";
import {
  extractEmails, htmlToText, importInboundEmail, isImported, isSkipped, mailEnabled, NOTIFICATION_HEADER, OFFICE_ACCOUNT,
  type OutgoingAttachment, type OutgoingEmail, pollWindow, saveMailAccount, skipMessage
} from "./mail-common.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Googlen OAuth-clientin tiedot ja vanha kirjautumistunniste ovat oletuksena server-kansiossa.
// Tuotannossa ne annetaan polkuina, jotta salaisuudet eivät ole sovelluksen kansiossa.
const credentialsPath = path.resolve(process.env.GMAIL_CREDENTIALS_FILE || path.join(__dirname, "../credentials.json"));
const tokenPath = path.resolve(process.env.GMAIL_TOKEN_FILE || path.join(__dirname, "../token.json"));


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

function getHeader(message: GmailMessage, name: string): string {
  const header = message.payload?.headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase()
  );
  return header?.value || "";
}

// Gmail-tilit tallennetaan tietokantaan: "office" on toimiston tili, muut tunnisteet ovat taloyhtiöitä.
// Taloyhtiö ilman omaa tiliä käyttää toimiston tiliä. Vanha token.json toimii toimiston tilinä,
// kunnes tili yhdistetään asetuksista.
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send"
];

async function oauthConfig() {
  const credentialsFile = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
  const config = credentialsFile.installed || credentialsFile.web;
  if (!config?.client_id || !config?.client_secret) {
    throw new Error("credentials.json-tiedostosta puuttuvat OAuth-clientin tiedot.");
  }
  return config as { client_id: string; client_secret: string; redirect_uris?: string[] };
}

// Gmail-yhteys on käytössä, kun Googlen OAuth-clientin tiedot on tallennettu palvelimelle.
export function gmailConfigured(): boolean {
  return existsSync(credentialsPath);
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

  saveMailAccount({ accountId, email, provider: "gmail", token: JSON.stringify(tokens), connectedBy });
  return email;
}

async function getGmailClient(accountId: string = OFFICE_ACCOUNT) {
  if (!mailEnabled) throw new Error("Sähköposti on kytketty pois päältä (GMAIL_DISABLED=1).");
  const config = await oauthConfig();
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

function getMessageBody(message: GmailMessage): string {
  const payload = message.payload;
  if (!payload) return "";
  const body = findBody({ mimeType: payload.mimeType, body: payload.body, parts: payload.parts });
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

function findAttachments(part?: GmailPart): GmailPart[] {
  if (!part) return [];
  const own = part.filename && part.body?.attachmentId ? [part] : [];
  return [...own, ...(part.parts || []).flatMap(findAttachments)];
}

async function fetchAttachments(
  auth: Awaited<ReturnType<typeof getGmailClient>>,
  message: GmailMessage
): Promise<OutgoingAttachment[]> {
  const attachments: OutgoingAttachment[] = [];
  for (const part of findAttachments({ parts: message.payload?.parts })) {
    try {
      const response = await auth.request<{ data?: string }>({
        url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.body!.attachmentId!)}`
      });
      attachments.push({
        filename: part.filename || "liite",
        mimeType: part.mimeType || "application/octet-stream",
        content: Buffer.from(response.data.data || "", "base64url")
      });
    } catch (error) {
      console.warn(`Liitteen "${part.filename}" haku epäonnistui:`, error instanceof Error ? error.message : error);
    }
  }
  return attachments;
}

// Tuo yhden Gmail-tilin uudet viestit.
export async function pollGmailAccount(accountId: string): Promise<void> {
  const auth = await getGmailClient(accountId);
  const window = pollWindow(accountId);
  if (!window) {
    console.log("Kotilo Gmail: ensimmäinen tarkistus tehty. Vanhat viestit ohitetaan.");
    return;
  }
  const { lowerBoundMs } = window;
  const queryAfter = Math.max(0, Math.floor(lowerBoundMs / 1000) - 60);

  let pageToken: string | undefined;
  const messages: { id: string }[] = [];
  do {
    const response = await auth.request<{ messages?: { id: string }[]; nextPageToken?: string }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      params: { q: `in:inbox after:${queryAfter}`, maxResults: 100, pageToken }
    });
    messages.push(...(response.data.messages || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  let imported = 0;
  // Vanhin ensin, jotta saman ketjun viestit päätyvät tehtävälle oikeassa järjestyksessä.
  for (const listedMessage of messages.reverse()) {
    if (isSkipped(listedMessage.id) || isImported(listedMessage.id)) continue;

    const message = (await auth.request<GmailMessage>({
      url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(listedMessage.id)}`,
      params: { format: "full" }
    })).data;

    if (!message.id || Number(message.internalDate || 0) < lowerBoundMs) {
      skipMessage(listedMessage.id);
      continue;
    }

    // Kotilon oma hälytys voi päätyä takaisin tähän postilaatikkoon. Sitä ei tuoda tehtäväksi,
    // koska hälytyksen teksti tunnistettaisiin uudeksi hätätapaukseksi.
    if (getHeader(message, NOTIFICATION_HEADER)) {
      skipMessage(message.id);
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
        threadMessageIds = (thread.data.messages || []).map(threadMessage => threadMessage.id);
      } catch (error) {
        console.warn(
          `Gmail-ketjun ${message.threadId} lukeminen epäonnistui, viesti käsitellään uutena:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    const done = await importInboundEmail(accountId, {
      id: message.id,
      from: getHeader(message, "From"),
      subject: getHeader(message, "Subject"),
      body: getMessageBody(message),
      threadMessageIds,
      recipients: extractEmails(["To", "Cc", "Delivered-To"].map(name => getHeader(message, name)).join(" ")),
      attachments: () => fetchAttachments(auth, message)
    }, "Gmail");
    if (done) imported++;
  }

  if (imported > 0) console.log(`Kotilo Gmail: ${imported} uutta viestiä käsitelty.`);
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

// Lähettää viestin Gmail-tililtä. Vastaus ketjutetaan alkuperäiseen viestiin; tunniste on joko Gmailin
// oma tunniste tai sähköpostin Message-ID (jos viesti tuli aiemmin toisen palvelun kautta).
export async function sendViaGmail(accountId: string, input: OutgoingEmail): Promise<{ id: string }> {
  const auth = await getGmailClient(accountId);

  let threadId: string | undefined;
  let originalMessageId = "";
  let references = "";

  if (input.sourceMessageId?.startsWith("<")) {
    originalMessageId = input.sourceMessageId;
  } else if (input.sourceMessageId) {
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
    ...(input.notification ? [`${NOTIFICATION_HEADER}: 1`, "Auto-Submitted: auto-generated"] : []),
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
