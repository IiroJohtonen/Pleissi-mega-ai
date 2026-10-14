import addressparser from "nodemailer/lib/addressparser/index.js";
import { db } from "./db.js";
import { decryptSecret, encryptSecret } from "./mail-secrets.js";
import {
  getMailAccount, importInboundEmail, type InboundEmail, isImported, isSkipped, mailEnabled, NOTIFICATION_HEADER,
  type OutgoingAttachment, type OutgoingEmail, pollWindow, saveMailAccount, skipMessage
} from "./mail-common.js";

// Microsoft 365 / Outlook -yhteys Microsoft Graphin kautta. Kirjautuminen tehdään OAuthilla kuten Gmailissa;
// sovellus rekisteröidään Azure-portaaliin ja sen tunnisteet annetaan muuttujissa MS_CLIENT_ID ja
// MS_CLIENT_SECRET. Viestit tunnistetaan sähköpostin Message-ID:stä, joten ketjut toimivat samoin kuin
// IMAP-tileillä.

const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = ["offline_access", "openid", "email", "User.Read", "Mail.ReadWrite", "Mail.Send"];
// Tätä suuremmat liitteet lähetetään paloina latausistunnolla (Graphin raja on 3 Mt yhdessä pyynnössä).
const SMALL_ATTACHMENT_BYTES = 3 * 1024 * 1024;

function tenant() {
  return process.env.MS_TENANT || "common";
}

export function microsoftConfigured(): boolean {
  return Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

function microsoftRedirectUri(): string {
  return process.env.MS_REDIRECT_URI || `http://localhost:${process.env.PORT || 4000}/api/mail/microsoft/callback`;
}

function requireConfig() {
  if (!microsoftConfigured()) {
    throw new Error("Microsoft 365 -yhteyttä ei ole otettu käyttöön palvelimella (MS_CLIENT_ID ja MS_CLIENT_SECRET puuttuvat).");
  }
  return { clientId: process.env.MS_CLIENT_ID!, clientSecret: process.env.MS_CLIENT_SECRET! };
}

export function microsoftAuthUrl(state: string): string {
  const { clientId } = requireConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: microsoftRedirectUri(),
    response_mode: "query",
    scope: SCOPES.join(" "),
    state,
    prompt: "select_account"
  });
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0/authorize?${params}`;
}

type StoredTokens = { access_token: string; refresh_token: string; expires_at: number };

// Yleisimmät Microsoftin kirjautumisvirheet ja niiden korjaus. Koodi (AADSTS...) näytetään aina, jotta
// muunkin virheen syyn voi tarkistaa Microsoftin ohjeista.
const MICROSOFT_ERRORS: Record<string, string> = {
  AADSTS7000215: "Sovelluksen salaisuus on väärä. Kopioi Azure-portaalista salaisuuden Value-kenttä (ei Secret ID) palvelimen asetukseen MS_CLIENT_SECRET.",
  AADSTS7000222: "Sovelluksen salaisuus on vanhentunut. Luo Azure-portaalissa uusi salaisuus ja vaihda se asetukseen MS_CLIENT_SECRET.",
  AADSTS700016: "Sovellusta ei löydy. Tarkista, että MS_CLIENT_ID on Azure-portaalin Application (client) ID.",
  AADSTS50011: "Paluuosoite ei täsmää. Lisää Azure-portaalin Redirect URI -listaan sama osoite kuin asetuksessa MS_REDIRECT_URI.",
  AADSTS500113: "Azure-sovellukselle ei ole lisätty paluuosoitetta. Lisää Redirect URI (tyyppi Web).",
  AADSTS65001: "Organisaation ylläpitäjän pitää hyväksyä sovellus ennen käyttöä.",
  AADSTS90072: "Tiliä ei ole sovelluksen organisaatiossa. Valitse Azure-portaalissa tilityypiksi kaikki organisaatiot ja henkilökohtaiset Microsoft-tilit.",
  AADSTS50194: "Sovellus on rajattu yhteen organisaatioon. Valitse Azure-portaalissa tilityypiksi useat organisaatiot tai aseta MS_TENANT organisaatiosi tunnukseksi.",
  AADSTS54005: "Kirjautumiskoodi oli jo käytetty. Aloita yhdistäminen uudelleen."
};

export function microsoftErrorMessage(description: string): string {
  const code = description.match(/AADSTS\d+/)?.[0] ?? "";
  const hint = MICROSOFT_ERRORS[code] ?? "Yhdistä tili uudelleen asetuksista.";
  return `Microsoft-kirjautuminen epäonnistui${code ? ` (${code})` : ""}. ${hint}`;
}

async function requestTokens(body: Record<string, string>): Promise<StoredTokens & { refresh_token?: string }> {
  const { clientId, clientSecret } = requireConfig();
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: SCOPES.join(" "), ...body })
  });
  const data = await response.json().catch(() => ({})) as {
    access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string;
  };
  if (!response.ok || !data.access_token) {
    console.warn("Microsoft-tunnisteen haku epäonnistui:", data.error, data.error_description);
    throw new Error(microsoftErrorMessage(data.error_description ?? data.error ?? ""));
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? "",
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000
  };
}

async function graphFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      // Muuttumattomat tunnisteet: viestin tunniste säilyy, vaikka se siirtyy kansiosta toiseen.
      Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`Microsoft Graph palautti virheen ${response.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return (response.status === 202 || response.status === 204 ? undefined : await response.json()) as T;
}

export async function connectMicrosoftAccount(accountId: string, code: string, connectedBy: string): Promise<string> {
  const tokens = await requestTokens({ grant_type: "authorization_code", code, redirect_uri: microsoftRedirectUri() });
  if (!tokens.refresh_token) throw new Error("Microsoft ei palauttanut pysyvää tunnistetta. Yritä yhdistämistä uudelleen.");
  const me = await graphFetch<{ mail?: string; userPrincipalName?: string }>(tokens.access_token, "/me?$select=mail,userPrincipalName");
  const email = me.mail || me.userPrincipalName || "";
  if (!email) throw new Error("Microsoft-tilin sähköpostiosoitetta ei saatu luettua.");
  // Gmail-osoitteella luodun Microsoft-tilin posti menee Gmailiin, joten Microsoftin laatikko pysyy tyhjänä.
  if (/@(gmail|googlemail)\.com$/i.test(email)) {
    throw new Error(`Osoitteen ${email} posti tulee Gmailiin, ei Microsoftille. Yhdistä tili Gmail-painikkeella.`);
  }
  saveMailAccount({ accountId, email, provider: "microsoft", token: encryptSecret(JSON.stringify(tokens)), connectedBy });
  return email;
}

// Voimassa oleva tunniste; vanhentunut uusitaan ja tallennetaan.
async function accessToken(accountId: string): Promise<string> {
  if (!mailEnabled) throw new Error("Sähköposti on kytketty pois päältä (GMAIL_DISABLED=1).");
  const account = getMailAccount(accountId);
  if (!account || account.provider !== "microsoft") throw new Error("Microsoft-tiliä ei ole yhdistetty.");
  const tokens = JSON.parse(decryptSecret(account.token)) as StoredTokens;
  if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  const fresh = await requestTokens({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  const stored: StoredTokens = { ...fresh, refresh_token: fresh.refresh_token || tokens.refresh_token };
  db.prepare("UPDATE gmail_accounts SET token = ? WHERE id = ?").run(encryptSecret(JSON.stringify(stored)), accountId);
  return stored.access_token;
}

type GraphAddress = { emailAddress?: { name?: string; address?: string } };
export type GraphMessage = {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  receivedDateTime?: string;
  internetMessageHeaders?: { name: string; value: string }[];
};

function headerValue(message: GraphMessage, name: string) {
  return message.internetMessageHeaders?.find(header => header.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export function isGraphNotification(message: GraphMessage) {
  return Boolean(headerValue(message, NOTIFICATION_HEADER));
}

// Muuntaa Graphin viestin tuotavaksi. Ketju tunnistetaan In-Reply-To- ja References-otsakkeista sekä
// saman keskustelun muista viesteistä (conversationSiblings).
export function graphToInbound(
  message: GraphMessage,
  conversationSiblings: string[],
  attachments: () => Promise<OutgoingAttachment[]>
): InboundEmail {
  const sender = message.from?.emailAddress;
  const references = [headerValue(message, "In-Reply-To"), ...headerValue(message, "References").split(/\s+/)];
  const id = message.internetMessageId || `ms:${message.id}`;
  return {
    id,
    from: sender?.name ? `${sender.name} <${sender.address ?? ""}>` : sender?.address ?? "",
    subject: message.subject ?? "",
    body: (message.body?.content ?? "").trim(),
    threadMessageIds: [...new Set([...references, ...conversationSiblings].filter(value => value && value !== id))],
    recipients: [...(message.toRecipients ?? []), ...(message.ccRecipients ?? [])]
      .map(recipient => recipient.emailAddress?.address ?? "")
      .filter(Boolean),
    attachments
  };
}

const odataString = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function fetchAttachments(token: string, messageId: string): Promise<OutgoingAttachment[]> {
  const result = await graphFetch<{ value: { "@odata.type"?: string; name?: string; contentType?: string; contentBytes?: string; isInline?: boolean }[] }>(
    token, `/me/messages/${encodeURIComponent(messageId)}/attachments`
  );
  return result.value
    .filter(item => item["@odata.type"] === "#microsoft.graph.fileAttachment" && item.contentBytes && !item.isInline)
    .map(item => ({
      filename: item.name || "liite",
      mimeType: item.contentType || "application/octet-stream",
      content: Buffer.from(item.contentBytes!, "base64")
    }));
}

export async function pollMicrosoftAccount(accountId: string): Promise<void> {
  const token = await accessToken(accountId);
  const window = pollWindow(accountId);
  if (!window) {
    console.log("Kotilo Microsoft 365: ensimmäinen tarkistus tehty. Vanhat viestit ohitetaan.");
    return;
  }
  const select = "id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,body,hasAttachments,receivedDateTime,internetMessageHeaders";
  let next: string | undefined = `/me/mailFolders/inbox/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${new Date(window.lowerBoundMs).toISOString()}`)}`
    + `&$orderby=receivedDateTime asc&$top=50&$select=${select}`;
  const messages: GraphMessage[] = [];
  while (next) {
    const page: { value: GraphMessage[]; "@odata.nextLink"?: string } = await graphFetch(token, next);
    messages.push(...page.value);
    next = page["@odata.nextLink"];
  }

  let imported = 0;
  for (const message of messages) {
    const id = message.internetMessageId || `ms:${message.id}`;
    if (isSkipped(id) || isImported(id)) continue;
    // Kotilon oma hälytys voi palata postilaatikkoon; sitä ei tuoda tehtäväksi.
    if (isGraphNotification(message)) {
      skipMessage(id);
      continue;
    }
    let siblings: string[] = [];
    if (message.conversationId) {
      try {
        const conversation = await graphFetch<{ value: { internetMessageId?: string }[] }>(token,
          `/me/messages?$filter=${encodeURIComponent(`conversationId eq ${odataString(message.conversationId)}`)}&$select=internetMessageId&$top=50`);
        siblings = conversation.value.map(item => item.internetMessageId ?? "").filter(Boolean);
      } catch (error) {
        console.warn("Microsoft-keskustelun lukeminen epäonnistui, viesti käsitellään uutena:", error instanceof Error ? error.message : error);
      }
    }
    const inbound = graphToInbound(message, siblings, () => message.hasAttachments ? fetchAttachments(token, message.id) : Promise.resolve([]));
    if (await importInboundEmail(accountId, inbound, "Microsoft 365")) imported++;
  }
  if (imported > 0) console.log(`Kotilo Microsoft 365: ${imported} uutta viestiä käsitelty.`);
}

function recipientsOf(value?: string) {
  if (!value) return [];
  return (addressparser(value, { flatten: true }) as { address?: string; name?: string }[])
    .filter(item => item.address)
    .map(item => ({ emailAddress: { address: item.address!, ...(item.name ? { name: item.name } : {}) } }));
}

async function addAttachment(token: string, draftId: string, attachment: OutgoingAttachment) {
  const base = `/me/messages/${encodeURIComponent(draftId)}/attachments`;
  if (attachment.content.length <= SMALL_ATTACHMENT_BYTES) {
    await graphFetch(token, base, {
      method: "POST",
      body: JSON.stringify({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: attachment.filename,
        contentType: attachment.mimeType,
        contentBytes: attachment.content.toString("base64")
      })
    });
    return;
  }
  const session = await graphFetch<{ uploadUrl: string }>(token, `${base}/createUploadSession`, {
    method: "POST",
    body: JSON.stringify({ AttachmentItem: { attachmentType: "file", name: attachment.filename, size: attachment.content.length } })
  });
  // Palat ovat 320 kt:n monikertoja, kuten Graph edellyttää.
  const chunk = 320 * 1024 * 10;
  for (let start = 0; start < attachment.content.length; start += chunk) {
    const end = Math.min(start + chunk, attachment.content.length);
    const response = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(end - start),
        "Content-Range": `bytes ${start}-${end - 1}/${attachment.content.length}`
      },
      body: new Uint8Array(attachment.content.subarray(start, end))
    });
    if (!response.ok) throw new Error(`Liitteen ${attachment.filename} lataus Microsoftille epäonnistui (${response.status}).`);
  }
}

// Lähettää viestin luonnoksen kautta: vastaus luodaan alkuperäiseen viestiin, jolloin se ketjuuntuu
// Outlookissa, ja palautetaan lähetetyn viestin Message-ID.
export async function sendViaMicrosoft(accountId: string, input: OutgoingEmail): Promise<{ id: string }> {
  const token = await accessToken(accountId);
  const message = {
    subject: input.subject,
    body: { contentType: "Text", content: input.body },
    toRecipients: recipientsOf(input.to),
    bccRecipients: recipientsOf(input.bcc)
  };

  let draftId = "";
  if (input.sourceMessageId?.startsWith("<")) {
    try {
      const original = await graphFetch<{ value: { id: string }[] }>(token,
        `/me/messages?$filter=${encodeURIComponent(`internetMessageId eq ${odataString(input.sourceMessageId)}`)}&$select=id&$top=1`);
      if (original.value[0]) {
        draftId = (await graphFetch<{ id: string }>(token, `/me/messages/${encodeURIComponent(original.value[0].id)}/createReply`, { method: "POST" })).id;
        await graphFetch(token, `/me/messages/${encodeURIComponent(draftId)}`, { method: "PATCH", body: JSON.stringify(message) });
      }
    } catch (error) {
      // Alkuperäinen viesti on voitu poistaa; vastaus lähetetään silti uutena viestinä.
      console.warn("Alkuperäisen Microsoft-viestin haku epäonnistui:", error instanceof Error ? error.message : error);
      draftId = "";
    }
  }
  if (!draftId) {
    draftId = (await graphFetch<{ id: string }>(token, "/me/messages", {
      method: "POST",
      body: JSON.stringify({
        ...message,
        ...(input.notification ? { internetMessageHeaders: [{ name: NOTIFICATION_HEADER, value: "1" }] } : {})
      })
    })).id;
  }

  for (const attachment of input.attachments ?? []) await addAttachment(token, draftId, attachment);
  const draft = await graphFetch<{ internetMessageId?: string }>(token, `/me/messages/${encodeURIComponent(draftId)}?$select=internetMessageId`);
  await graphFetch(token, `/me/messages/${encodeURIComponent(draftId)}/send`, { method: "POST" });
  return { id: draft.internetMessageId || `ms:${draftId}` };
}
