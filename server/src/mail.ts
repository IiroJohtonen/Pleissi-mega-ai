import { getGmailStatus, pollGmailAccount, sendViaGmail } from "./gmail.js";
import {
  getMailAccount, lastPollError, mailAccountFor, mailEnabled, type MailProvider, OFFICE_ACCOUNT, type OutgoingEmail,
  recordPollResult
} from "./mail-common.js";
import { db } from "./db.js";
import { pollImapAccount, sendViaImap } from "./mail-imap.js";
import { pollMicrosoftAccount, sendViaMicrosoft } from "./mail-microsoft.js";

// Sähköpostin julkinen rajapinta muulle sovellukselle. Taloyhtiön posti kulkee sen omalla tilillä tai
// toimiston tilillä, ja tilin palvelu (Gmail, Microsoft 365 tai IMAP/SMTP) valitsee toteutuksen.
export {
  mailAccountFor, mailEnabled, OFFICE_ACCOUNT, type OutgoingAttachment, type OutgoingEmail, parseSender
} from "./mail-common.js";

const POLL_INTERVAL_MS = 20_000;

// Toimiston tili ilman tallennettua riviä on vanha Gmail-kirjautuminen (token.json).
function providerOf(accountId: string): MailProvider {
  return getMailAccount(accountId)?.provider ?? "gmail";
}

export async function sendEmail(input: OutgoingEmail): Promise<{ id: string }> {
  const accountId = mailAccountFor(input.companyId);
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
