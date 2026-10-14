import { ImapFlow } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import addressparser from "nodemailer/lib/addressparser/index.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { decryptSecret, encryptSecret } from "./mail-secrets.js";
import {
  extractEmails, getMailAccount, htmlToText, importInboundEmail, type InboundEmail, isImported, isSkipped, mailEnabled,
  NOTIFICATION_HEADER, officeName, type OutgoingEmail, pollWindow, saveMailAccount, skipMessage
} from "./mail-common.js";

// IMAP/SMTP-yhteys: toimii useimpien sähköpostipalvelujen kanssa (oman domainin posti, Telia, Elisa,
// iCloud ym.). Saapuvat viestit luetaan IMAP:lla ja lähtevät lähetetään SMTP:llä. Salasana on salattu.

export type ImapSettings = {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
};

const CONNECT_TIMEOUT_MS = 15_000;

// Portti määrää salauksen: 993 ja 465 ovat suoraan salattuja, muut (143, 587) salataan STARTTLS:llä.
function imapClient(settings: ImapSettings, password: string) {
  return new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: settings.imapPort === 993,
    auth: { user: settings.username, pass: password },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 60_000
  });
}

function smtpTransport(settings: ImapSettings, password: string) {
  return nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpPort === 465,
    requireTLS: settings.smtpPort !== 465 && settings.smtpPort !== 25,
    auth: { user: settings.username, pass: password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS
  });
}

// Selkeä virheilmoitus yleisimmistä syistä; tekninen syy jää lokiin.
function connectionError(kind: "IMAP" | "SMTP", error: unknown): Error {
  const raw = error as { code?: string; authenticationFailed?: boolean; responseCode?: number; message?: string };
  console.warn(`${kind}-yhteys epäonnistui:`, raw?.code ?? "", raw?.message ?? error);
  if (raw?.authenticationFailed || raw?.code === "EAUTH" || raw?.responseCode === 535) {
    return new Error(`${kind}-kirjautuminen epäonnistui. Tarkista käyttäjätunnus ja salasana. Jos tilillä on kaksivaiheinen tunnistautuminen, käytä sovellussalasanaa.`);
  }
  if (raw?.code === "ENOTFOUND" || raw?.code === "EAI_AGAIN") return new Error(`${kind}-palvelinta ei löytynyt. Tarkista palvelimen osoite.`);
  if (raw?.code === "ECONNREFUSED" || raw?.code === "ETIMEDOUT" || raw?.code === "ETIMEOUT" || raw?.code === "ECONNECTION") {
    return new Error(`${kind}-palvelimeen ei saatu yhteyttä. Tarkista palvelimen osoite ja portti.`);
  }
  return new Error(`${kind}-yhteys epäonnistui. Tarkista palvelimen osoite, portti ja tunnukset.`);
}

// Kokeilee IMAP- ja SMTP-yhteyden ja tallentaa tilin vasta, kun molemmat toimivat.
export async function connectImapAccount(input: {
  accountId: string; email: string; settings: ImapSettings; password: string; connectedBy: string;
}): Promise<string> {
  const client = imapClient(input.settings, input.password);
  // Yhteysvirhe tulee myös error-tapahtumana; ilman kuuntelijaa se kaataisi palvelimen.
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.mailboxOpen("INBOX", { readOnly: true });
  } catch (error) {
    throw connectionError("IMAP", error);
  } finally {
    await client.logout().catch(() => undefined);
  }
  try {
    await smtpTransport(input.settings, input.password).verify();
  } catch (error) {
    throw connectionError("SMTP", error);
  }
  saveMailAccount({
    accountId: input.accountId,
    email: input.email,
    provider: "imap",
    settings: input.settings,
    token: encryptSecret(input.password),
    connectedBy: input.connectedBy
  });
  return input.email;
}

function accountCredentials(accountId: string) {
  const account = getMailAccount(accountId);
  if (!account || account.provider !== "imap") throw new Error("IMAP-tiliä ei ole yhdistetty.");
  return { account, settings: account.settings as ImapSettings, password: decryptSecret(account.token) };
}

// Ketjun aiemmat viestit: In-Reply-To ja References kertovat, mihin viestiin tämä vastaa.
function threadIds(parsed: Pick<ParsedMail, "inReplyTo" | "references">): string[] {
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? parsed.references.split(/\s+/) : [];
  return [...new Set([parsed.inReplyTo, ...references].filter((value): value is string => Boolean(value?.trim())))];
}

// Muuntaa jäsennetyn viestin tuotavaksi. Viesti tunnistetaan Message-ID:stä; sen puuttuessa käytetään
// postilaatikon tunnisteita.
export function parsedToInbound(parsed: ParsedMail, fallbackId: string): InboundEmail {
  const header = (name: string) => {
    const value = parsed.headers.get(name.toLowerCase());
    return typeof value === "string" ? value : "";
  };
  const addresses = (value: ParsedMail["to"]) => (Array.isArray(value) ? value : value ? [value] : []).map(item => item.text).join(" ");
  return {
    id: parsed.messageId || fallbackId,
    from: parsed.from?.text ?? "",
    subject: parsed.subject ?? "",
    body: parsed.text?.trim() || (typeof parsed.html === "string" ? htmlToText(parsed.html) : ""),
    threadMessageIds: threadIds(parsed),
    recipients: extractEmails([addresses(parsed.to), addresses(parsed.cc), header("delivered-to")].join(" ")),
    attachments: async () => parsed.attachments
      .filter(attachment => attachment.contentDisposition !== "inline" || attachment.filename)
      .map(attachment => ({
        filename: attachment.filename || "liite",
        mimeType: attachment.contentType || "application/octet-stream",
        content: attachment.content
      }))
  };
}

export function isKotiloNotification(parsed: ParsedMail) {
  return Boolean(parsed.headers.get(NOTIFICATION_HEADER.toLowerCase()));
}

// Tuo IMAP-tilin uudet viestit saapuneet-kansiosta. Ensin haetaan vain kirjekuoret, ja kokonainen viesti
// ladataan vasta, kun se on uusi.
export async function pollImapAccount(accountId: string): Promise<void> {
  const { settings, password } = accountCredentials(accountId);
  const window = pollWindow(accountId);
  if (!window) {
    console.log("Kotilo IMAP: ensimmäinen tarkistus tehty. Vanhat viestit ohitetaan.");
    return;
  }
  const client = imapClient(settings, password);
  client.on("error", () => undefined);
  const fresh: { uid: number; id: string }[] = [];
  const sources = new Map<number, Buffer>();
  try {
    await client.connect();
  } catch (error) {
    throw connectionError("IMAP", error);
  }
  try {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const uidValidity = String(client.mailbox && typeof client.mailbox === "object" ? client.mailbox.uidValidity : "");
      // IMAP:n SINCE-haku on päivätarkkuinen, joten tarkka raja tarkistetaan saapumisajasta.
      const uids = await client.search({ since: new Date(window.lowerBoundMs - 24 * 60 * 60 * 1000) }, { uid: true });
      if (uids && uids.length > 0) {
        for await (const message of client.fetch(uids, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
          const received = message.internalDate ? new Date(message.internalDate).getTime() : 0;
          const id = message.envelope?.messageId || `imap:${accountId}:${uidValidity}:${message.uid}`;
          if (received < window.lowerBoundMs || isSkipped(id) || isImported(id)) continue;
          fresh.push({ uid: message.uid, id });
        }
        if (fresh.length > 0) {
          for await (const message of client.fetch(fresh.map(item => item.uid), { uid: true, source: true }, { uid: true })) {
            if (message.source) sources.set(message.uid, message.source);
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  let imported = 0;
  for (const { uid, id } of fresh) {
    const source = sources.get(uid);
    if (!source) continue;
    const parsed = await simpleParser(source);
    // Kotilon oma hälytys voi palata postilaatikkoon; sitä ei tuoda tehtäväksi.
    if (isKotiloNotification(parsed)) {
      skipMessage(id);
      continue;
    }
    if (await importInboundEmail(accountId, parsedToInbound(parsed, id), "IMAP")) imported++;
  }
  if (imported > 0) console.log(`Kotilo IMAP: ${imported} uutta viestiä käsitelty.`);
}

// Lähettää viestin SMTP:llä. Kopio tallennetaan IMAP-tilin lähetettyihin, koska useimmat palvelut eivät
// tee sitä itse SMTP:llä lähetetystä viestistä.
export async function sendViaImap(accountId: string, input: OutgoingEmail): Promise<{ id: string }> {
  if (!mailEnabled) throw new Error("Sähköposti on kytketty pois päältä (GMAIL_DISABLED=1).");
  const { account, settings, password } = accountCredentials(accountId);
  const replyTo = input.sourceMessageId?.startsWith("<") ? input.sourceMessageId : undefined;
  const name = officeName();
  const composer = new MailComposer({
    from: name ? { name, address: account.email } : account.email,
    to: input.to,
    bcc: input.bcc,
    subject: input.subject,
    text: input.body,
    attachments: (input.attachments ?? []).map(attachment => ({
      filename: attachment.filename, content: attachment.content, contentType: attachment.mimeType
    })),
    inReplyTo: replyTo,
    references: replyTo,
    headers: input.notification ? { [NOTIFICATION_HEADER]: "1", "Auto-Submitted": "auto-generated" } : {}
  });
  const compiled = composer.compile();
  const messageId = compiled.messageId();
  const raw = await compiled.build();

  const recipients = [input.to, input.bcc]
    .filter((value): value is string => Boolean(value))
    .flatMap(value => addressparser(value, { flatten: true }) as { address?: string }[])
    .map(item => item.address)
    .filter((value): value is string => Boolean(value));
  if (recipients.length === 0) throw new Error("Viestillä ei ole vastaanottajaa.");

  try {
    await smtpTransport(settings, password).sendMail({ envelope: { from: account.email, to: recipients }, raw });
  } catch (error) {
    throw connectionError("SMTP", error);
  }

  await saveToSentFolder(settings, password, raw).catch(error =>
    console.warn("Lähetetyn viestin tallennus IMAP-kansioon epäonnistui:", error instanceof Error ? error.message : error));
  return { id: messageId };
}

async function saveToSentFolder(settings: ImapSettings, password: string, raw: Buffer) {
  const client = imapClient(settings, password);
  client.on("error", () => undefined);
  await client.connect();
  try {
    const folders = await client.list();
    const sent = folders.find(folder => folder.specialUse === "\\Sent")
      ?? folders.find(folder => /^(sent|sent items|sent messages|lähetetyt|inbox\.sent)$/i.test(folder.path));
    if (sent) await client.append(sent.path, raw, ["\\Seen"]);
  } finally {
    await client.logout().catch(() => undefined);
  }
}
