import { getGmailStatus, hasLegacyGmailToken, pollGmailAccount, sendViaGmail } from "./gmail.js";
import {
  getMailAccount, lastPollError, mailAccountFor, mailboxOwnerId, mailEnabled, type MailProvider, OFFICE_ACCOUNT, type OutgoingEmail,
  recordPollResult, userAccountId
} from "./mail-common.js";
import { trackMailPoll } from "./alerts.js";
import { db } from "./db.js";
import { pollImapAccount, sendViaImap } from "./mail-imap.js";
import { pollMicrosoftAccount, sendViaMicrosoft } from "./mail-microsoft.js";

// Sähköpostin julkinen rajapinta muulle sovellukselle. Taloyhtiön posti kulkee sen omalla tilillä tai
// toimiston tilillä, ja tilin palvelu (Gmail, Microsoft 365 tai IMAP/SMTP) valitsee toteutuksen.
export {
  mailAccountFor, mailEnabled, OFFICE_ACCOUNT, userAccountId, type OutgoingAttachment, type OutgoingEmail, parseSender
} from "./mail-common.js";

const POLL_INTERVAL_MS = 20_000;

// Toimiston tili ilman tallennettua riviä on vanha Gmail-kirjautuminen (token.json).
function providerOf(accountId: string): MailProvider {
  return getMailAccount(accountId)?.provider ?? "gmail";
}

export type ReplyAccountKind = "own" | "office" | "company" | "user";
export type ReplyAccount = { id: string; email: string; kind: ReplyAccountKind; arrived: boolean };

function replyAccountKind(accountId: string, userId?: string): ReplyAccountKind {
  if (accountId === OFFICE_ACCOUNT) return "office";
  if (userId && accountId === userAccountId(userId)) return "own";
  return mailboxOwnerId(accountId) ? "user" : "company";
}

function accountUsable(accountId: string): boolean {
  return Boolean(getMailAccount(accountId)) || (accountId === OFFICE_ACCOUNT && hasLegacyGmailToken());
}

// Tilit, joilta käyttäjä voi vastata tehtävään. Ensimmäisenä on postilaatikko, johon tehtävän viesti
// saapui; sitten vastaajan oma laatikko, taloyhtiön oma tili ja toimiston tili. Toisen käyttäjän
// omasta laatikosta ei voi lähettää.
export function replyAccountsFor(
  ticket: { id: string; company_id: string; mail_account_id?: string | null }, userId?: string
): ReplyAccount[] {
  // Ennen saapumislaatikon tallentamista tuodut sähköpostit tulivat taloyhtiön tai toimiston tilille.
  const arrivedVia = ticket.mail_account_id
    || (db.prepare("SELECT 1 FROM messages WHERE ticket_id = ? AND direction = 'inbound' AND channel = 'email' LIMIT 1").get(ticket.id)
      ? mailAccountFor(ticket.company_id) : "");
  const candidates: { id: string; arrived: boolean }[] = [];
  if (arrivedVia) candidates.push({ id: arrivedVia, arrived: true });
  if (userId) candidates.push({ id: userAccountId(userId), arrived: false });
  candidates.push({ id: mailAccountFor(ticket.company_id), arrived: false });
  candidates.push({ id: OFFICE_ACCOUNT, arrived: false });

  const accounts: ReplyAccount[] = [];
  for (const candidate of candidates) {
    if (accounts.some(account => account.id === candidate.id) || !accountUsable(candidate.id)) continue;
    const kind = replyAccountKind(candidate.id, userId);
    if (kind === "user") continue;
    accounts.push({ id: candidate.id, email: getMailAccount(candidate.id)?.email ?? "", kind, arrived: candidate.arrived });
  }
  return accounts;
}

export async function sendEmail(input: OutgoingEmail): Promise<{ id: string }> {
  const accountId = input.accountId && getMailAccount(input.accountId) ? input.accountId : mailAccountFor(input.companyId);
  const provider = providerOf(accountId);
  if (provider === "imap") return sendViaImap(accountId, input);
  if (provider === "microsoft") return sendViaMicrosoft(accountId, input);
  return sendViaGmail(accountId, input);
}

export type MailStatus = {
  connected: boolean;
  provider?: MailProvider;
  emailAddress?: string;
  canSend?: boolean;
  // Viimeisimmän postin tarkistuksen virhe, jos yhteys ei toimi.
  error?: string;
};

export async function getMailStatus(accountId: string = OFFICE_ACCOUNT): Promise<MailStatus> {
  const account = getMailAccount(accountId);
  const provider = providerOf(accountId);
  if (provider === "gmail") return { ...(await getGmailStatus(accountId)), provider };
  const error = lastPollError(accountId);
  return { connected: Boolean(account) && !error, provider, emailAddress: account?.email, canSend: true, ...(error ? { error } : {}) };
}

// Hälytyksessä näytettävä tilin nimi: osoite, jos se tiedetään.
function mailLabel(accountId: string) {
  return getMailAccount(accountId)?.email || (accountId === OFFICE_ACCOUNT ? "toimiston tili" : accountId);
}

let isRunning = false;

async function pollAll(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const companyAccounts = db.prepare("SELECT id FROM gmail_accounts WHERE id != ?").all(OFFICE_ACCOUNT) as { id: string }[];
    for (const accountId of [OFFICE_ACCOUNT, ...companyAccounts.map(account => account.id)]) {
      // Toimistolle ei ole vielä yhdistetty tiliä: tarkistettavaa ei ole, eikä lokia täytetä virheillä.
      if (!getMailAccount(accountId) && !hasLegacyGmailToken()) continue;
      const provider = providerOf(accountId);
      try {
        if (provider === "imap") await pollImapAccount(accountId);
        else if (provider === "microsoft") await pollMicrosoftAccount(accountId);
        else await pollGmailAccount(accountId);
        recordPollResult(accountId);
        trackMailPoll(accountId, mailLabel(accountId));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordPollResult(accountId, message);
        trackMailPoll(accountId, mailLabel(accountId), message);
        console.error(`Postin tarkistus epäonnistui (${accountId === OFFICE_ACCOUNT ? "toimiston tili" : accountId}, ${provider}):`, message);
      }
    }
  } finally {
    isRunning = false;
  }
}

export function startMailPolling(): void {
  if (!mailEnabled) {
    console.log("Kotilo sähköposti: kytketty pois päältä, postia ei tarkisteta eikä lähetetä.");
    return;
  }
  console.log("Kotilo sähköposti: automaattinen tarkistus käynnistetty.");
  void pollAll();
  setInterval(() => void pollAll(), POLL_INTERVAL_MS);
}
