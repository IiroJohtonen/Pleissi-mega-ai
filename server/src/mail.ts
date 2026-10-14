import { getGmailStatus, hasLegacyGmailToken, pollGmailAccount, sendViaGmail } from "./gmail.js";
import {
  getMailAccount, lastPollError, mailAccountFor, mailEnabled, type MailProvider, OFFICE_ACCOUNT, type OutgoingEmail,
  recordPollResult, userAccountId
} from "./mail-common.js";
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

// Tehtävän vastaus lähtee samasta postilaatikosta, jonka kautta tehtävä tuli. Muuten vastaaja
// lähettää omasta postilaatikostaan, jos on yhdistänyt sellaisen, ja viimeisenä taloyhtiön tai
// toimiston tililtä.
export function replyAccountFor(ticket: { company_id: string; mail_account_id?: string | null }, userId?: string): string {
  if (ticket.mail_account_id && getMailAccount(ticket.mail_account_id)) return ticket.mail_account_id;
  if (userId && getMailAccount(userAccountId(userId))) return userAccountId(userId);
  return mailAccountFor(ticket.company_id);
}

// Osoite, josta tilin viestit lähtevät; tyhjä, jos tiliä ei ole yhdistetty.
export function mailAccountAddress(accountId: string): string {
  return getMailAccount(accountId)?.email ?? "";
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordPollResult(accountId, message);
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
