import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AUTHORIZED_COMPANY_IDS } from "./access.js";
import { INTERNAL_TOKEN } from "./auth.js";
import { attachmentsDir, db } from "./db.js";
import { assertSafeFile } from "./scan.js";

// Sähköpostipalvelujen (Gmail, Microsoft 365, IMAP/SMTP) yhteiset osat: tilit, synkronoinnin tila ja
// saapuneen viestin tuonti tehtäväksi. Palvelukohtainen koodi on tiedostoissa gmail.ts, mail-imap.ts
// ja mail-microsoft.ts; mail.ts valitsee niistä tilin mukaan.

export type MailProvider = "gmail" | "microsoft" | "imap";

// "office" on toimiston tili, muut tunnisteet ovat taloyhtiöitä. Taloyhtiö ilman omaa tiliä käyttää
// toimiston tiliä.
export const OFFICE_ACCOUNT = "office";

// Toimiston käyttäjän oma postilaatikko: tunniste on "user:<käyttäjän id>".
export function userAccountId(userId: string) {
  return `user:${userId}`;
}

export function mailboxOwnerId(accountId: string): string | null {
  return accountId.startsWith("user:") ? accountId.slice("user:".length) : null;
}

// KIITO_COMPANY_ID on muuttujan vanha nimi; se toimii edelleen.
export const DEFAULT_COMPANY_ID = process.env.DEFAULT_COMPANY_ID || process.env.KIITO_COMPANY_ID || "demo-company";

// GMAIL_DISABLED=1 tai MAIL_DISABLED=1 kytkee postin kokonaan pois (testit ja ympäristöt, joista ei saa
// lähteä postia). Nimi GMAIL_DISABLED on ajalta, jolloin Gmail oli ainoa vaihtoehto.
export const mailEnabled = process.env.GMAIL_DISABLED !== "1" && process.env.MAIL_DISABLED !== "1";

// Kotilon oma ilmoitus merkitään tällä otsakkeella, jotta se ei palaa postilaatikosta tehtäväksi.
export const NOTIFICATION_HEADER = "X-Kotilo-Notification";

// Jokaisella tarkistuksella katsotaan saapuneet viestit näin pitkältä ajalta taaksepäin. Jo tuodut
// viestit tunnistetaan tunnisteesta, joten viesti ei jää väliin, vaikka se ilmestyisi hakuun myöhässä.
export const LOOKBACK_MS = 6 * 60 * 60 * 1000;

export type OutgoingAttachment = { filename: string; mimeType: string; content: Buffer };

export type OutgoingEmail = {
  to?: string;
  // Piilokopion saajat eivät näe toistensa osoitteita.
  bcc?: string;
  subject: string;
  body: string;
  // Viesti, johon vastataan; vastaus ketjutetaan siihen.
  sourceMessageId?: string;
  attachments?: OutgoingAttachment[];
  // Taloyhtiö, jonka nimissä viesti lähtee: käytetään sen omaa tiliä, jos sellainen on.
  companyId?: string;
  // Tietty postilaatikko (esim. isännöitsijän oma), jos tehtävä saapui sen kautta. Ohittaa taloyhtiön tilin.
  accountId?: string;
  // Kotilon oma ilmoitus toimiston käyttäjälle: merkitään otsakkeella, jotta sitä ei tuoda tehtäväksi.
  notification?: boolean;
};

export type MailAccount = {
  id: string;
  email: string;
  provider: MailProvider;
  settings: Record<string, unknown>;
  token: string;
  connected_at: string;
  connected_by: string;
};

export function getMailAccount(accountId: string): MailAccount | undefined {
  const row = db.prepare("SELECT * FROM gmail_accounts WHERE id = ?").get(accountId) as
    | (Omit<MailAccount, "settings"> & { settings: string })
    | undefined;
  if (!row) return undefined;
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(row.settings || "{}");
  } catch {
    // Vioittunut asetus: tili toimii oletusarvoilla, ja yhteysvirhe näkyy asetuksissa.
  }
  return { ...row, provider: (row.provider || "gmail") as MailProvider, settings };
}

// Tili, jolla taloyhtiön posti kulkee: oma tili, jos sellainen on yhdistetty, muuten toimiston tili.
export function mailAccountFor(companyId?: string): string {
  if (!companyId) return OFFICE_ACCOUNT;
  return db.prepare("SELECT 1 FROM gmail_accounts WHERE id = ?").get(companyId) ? companyId : OFFICE_ACCOUNT;
}

// Tallentaa yhdistetyn tilin. Samaa osoitetta ei voi yhdistää kahteen paikkaan, koska silloin samat
// viestit tuotaisiin kahdesti.
export function saveMailAccount(input: {
  accountId: string; email: string; provider: MailProvider; settings?: Record<string, unknown>; token: string; connectedBy: string;
}) {
  const other = db.prepare("SELECT id FROM gmail_accounts WHERE lower(email) = lower(?) AND id != ?")
    .get(input.email, input.accountId) as { id: string } | undefined;
  if (other) {
    throw new Error(other.id === OFFICE_ACCOUNT
      ? "Tämä sähköpostitili on jo toimiston tilinä. Taloyhtiö käyttää sitä automaattisesti ilman omaa tiliä."
      : "Tämä sähköpostitili on jo yhdistetty toiseen taloyhtiöön.");
  }
  db.prepare(`
    INSERT INTO gmail_accounts (id, email, token, connected_at, connected_by, provider, settings) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET email = excluded.email, token = excluded.token, connected_at = excluded.connected_at,
      connected_by = excluded.connected_by, provider = excluded.provider, settings = excluded.settings
  `).run(input.accountId, input.email, input.token, new Date().toISOString(), input.connectedBy, input.provider,
    JSON.stringify(input.settings ?? {}));
  // Uuden tilin vanhoja viestejä ei tuoda: tarkistus alkaa yhdistämishetkestä.
  db.prepare("DELETE FROM gmail_sync_state WHERE key IN (?, ?, ?)")
    .run(syncKey(input.accountId, "last_poll_ms"), syncKey(input.accountId, "sync_start_ms"), syncKey(input.accountId, "last_error"));
}

export function disconnectMailAccount(accountId: string): boolean {
  return db.prepare("DELETE FROM gmail_accounts WHERE id = ?").run(accountId).changes > 0;
}

// Toimiston tilin avaimet ovat ilman päätettä, jotta ennen useita tilejä tallennettu tila säilyy.
export function syncKey(accountId: string, key: string): string {
  return accountId === OFFICE_ACCOUNT ? key : `${key}:${accountId}`;
}

export function getSyncValue(accountId: string, key: string): string | undefined {
  return (db.prepare("SELECT value FROM gmail_sync_state WHERE key = ?").get(syncKey(accountId, key)) as { value: string } | undefined)?.value;
}

export function setSyncValue(accountId: string, key: string, value: string) {
  db.prepare("INSERT INTO gmail_sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(syncKey(accountId, key), value);
}

// Tarkistusikkuna: ensimmäisellä kerralla aloitetaan nykyhetkestä, jolloin vanhoja viestejä ei tuoda.
// Palauttaa null, kun tämä oli ensimmäinen tarkistus.
export function pollWindow(accountId: string): { lowerBoundMs: number } | null {
  const last = getSyncValue(accountId, "last_poll_ms");
  if (!last) {
    setSyncValue(accountId, "last_poll_ms", String(Date.now()));
    setSyncValue(accountId, "sync_start_ms", String(Date.now()));
    return null;
  }
  let start = Number(getSyncValue(accountId, "sync_start_ms"));
  if (!Number.isFinite(start) || start <= 0) {
    start = Number(last) - LOOKBACK_MS;
    setSyncValue(accountId, "sync_start_ms", String(start));
  }
  return { lowerBoundMs: Math.max(start, Date.now() - LOOKBACK_MS) };
}

// Tarkistuksen tulos näytetään asetuksissa: tyhjä virhe tarkoittaa, että yhteys toimii.
export function recordPollResult(accountId: string, error?: string) {
  if (!error) setSyncValue(accountId, "last_poll_ms", String(Date.now()));
  setSyncValue(accountId, "last_error", error ?? "");
}

export function lastPollError(accountId: string): string {
  return getSyncValue(accountId, "last_error") ?? "";
}

export function parseSender(from: string): { name: string; email: string } {
  const match = from.match(/^(.*?)\s*<([^<>]+)>$/);
  if (match) {
    return { name: match[1].replace(/^"|"$/g, "").trim() || match[2], email: match[2].trim() };
  }
  const email = from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  return { name: from.trim() || email || "Tuntematon", email };
}

export function extractEmails(value: string): string[] {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
}

export function htmlToText(html: string): string {
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

export function isImported(sourceMessageId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM gmail_imports WHERE gmail_message_id = ?").get(sourceMessageId));
}

// Saapunut viesti palvelusta riippumatta. Liitteet haetaan vasta, kun viesti on tuotu tehtävälle.
export type InboundEmail = {
  // Tunniste, jolla viesti tunnistetaan jo tuoduksi ja johon vastaus ketjutetaan.
  id: string;
  from: string;
  subject: string;
  body: string;
  // Saman ketjun aiempien viestien tunnisteet; niiden avulla vastaus löytää tehtävänsä.
  threadMessageIds: string[];
  // To-, Cc- ja Delivered-To-otsakkeiden osoitteet toimiston tilin viestien ohjaamiseen taloyhtiölle.
  recipients: string[];
  attachments: () => Promise<OutgoingAttachment[]>;
};

// Viestit, joita ei tuoda (tyhjä sisältö tai pysyvä virhe); ei yritetä uudelleen joka kierroksella.
const skippedMessageIds = new Set<string>();

export function isSkipped(sourceMessageId: string) {
  return skippedMessageIds.has(sourceMessageId);
}

export function skipMessage(sourceMessageId: string) {
  skippedMessageIds.add(sourceMessageId);
}

// Taloyhtiö isännöitsijän omaan laatikkoon tulleelle viestille: lähettäjän asuintalo, jos lähettäjä on
// asukas; muuten yhtiö, jonka vastuuisännöitsijä laatikon omistaja on, jos niitä on yksi; muuten oletusyhtiö.
export function companyForUserMailbox(userId: string, senderEmail: string): string {
  const authorized = [...AUTHORIZED_COMPANY_IDS];
  const inList = (column: string) => `${column} IN (${authorized.map(() => "?").join(", ") || "NULL"})`;
  if (senderEmail) {
    const resident = db.prepare(`
      SELECT company_id FROM residents
      WHERE lower(email) = lower(?) AND erased_at IS NULL AND ${inList("company_id")}
      ORDER BY (moved_out_at IS NOT NULL), name LIMIT 1
    `).get(senderEmail, ...authorized) as { company_id: string } | undefined;
    if (resident) return resident.company_id;
  }
  const managed = db.prepare(`SELECT id FROM companies WHERE manager_id = ? AND ${inList("id")}`)
    .all(userId, ...authorized) as { id: string }[];
  return managed.length === 1 ? managed[0].id : DEFAULT_COMPANY_ID;
}

// Tuo yhden saapuneen viestin. Taloyhtiön oman tilin viestit kuuluvat aina sille taloyhtiölle;
// toimiston tilin viestit ohjataan vastaanottajan osoitteen perusteella. Isännöitsijän omaan
// laatikkoon tullut viesti annetaan hänelle.
export async function importInboundEmail(accountId: string, email: InboundEmail, label: string): Promise<boolean> {
  if (!email.body.trim()) {
    console.warn(`${label}-viesti ${email.id} ohitettiin: viestin tekstisisältö puuttuu.`);
    skipMessage(email.id);
    return false;
  }
  const sender = parseSender(email.from);
  const owner = mailboxOwnerId(accountId);
  const target = owner
    ? { companyId: companyForUserMailbox(owner, sender.email), assigneeId: owner, mailAccountId: accountId }
    : { companyId: accountId === OFFICE_ACCOUNT ? DEFAULT_COMPANY_ID : accountId, mailAccountId: accountId };
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 4000}/api/inbound/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-token": INTERNAL_TOKEN },
    body: JSON.stringify({
      ...target,
      channel: "email",
      senderName: sender.name,
      senderEmail: sender.email || undefined,
      subject: email.subject || "Uusi yhteydenotto",
      body: email.body,
      sourceMessageId: email.id,
      threadMessageIds: email.threadMessageIds.filter(threadId => threadId && threadId !== email.id).slice(0, 200),
      recipientEmails: accountId === OFFICE_ACCOUNT ? email.recipients : []
    })
  });

  if (!response.ok) {
    // Yksi epäonnistunut viesti ei saa pysäyttää muiden tuontia. Pysyvää virhettä (4xx) ei
    // yritetä uudelleen; muut yritetään seuraavalla kierroksella.
    console.error(`Kotilo API palautti virheen ${response.status} viestille ${email.id} ("${email.subject}").`);
    if (response.status >= 400 && response.status < 500) skipMessage(email.id);
    return false;
  }

  const result = await response.json() as { ticketId?: string; duplicate?: boolean };
  if (result.duplicate) return false;
  if (result.ticketId) await saveInboundAttachments(email, result.ticketId);
  console.log(`${label}-viesti käsitelty: "${email.subject}" (tehtävä ${result.ticketId || "luotu"})`);
  return true;
}

async function saveInboundAttachments(email: InboundEmail, ticketId: string) {
  let attachments: OutgoingAttachment[];
  try {
    attachments = await email.attachments();
  } catch (error) {
    console.warn(`Viestin ${email.id} liitteiden haku epäonnistui:`, error instanceof Error ? error.message : error);
    return;
  }
  for (const attachment of attachments) {
    try {
      // Vaarallinen liite jätetään tallentamatta; viesti itse tuodaan silti.
      await assertSafeFile(attachment.content, attachment.filename);
      const attachmentId = `attachment-${crypto.randomUUID()}`;
      await fs.writeFile(path.join(attachmentsDir, attachmentId), attachment.content);
      db.prepare(`
        INSERT INTO attachments (id, ticket_id, filename, mime_type, size, created_at, direction)
        VALUES (?, ?, ?, ?, ?, ?, 'inbound')
      `).run(attachmentId, ticketId, attachment.filename, attachment.mimeType || "application/octet-stream",
        attachment.content.length, new Date().toISOString());
    } catch (error) {
      console.warn(`Liitteen "${attachment.filename}" tallennus epäonnistui:`, error instanceof Error ? error.message : error);
    }
  }
}

// Toimiston nimi lähettäjän nimeksi niissä palveluissa, joissa lähettäjä annetaan viestissä.
export function officeName(): string {
  return (db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string } | undefined)?.name ?? "";
}
