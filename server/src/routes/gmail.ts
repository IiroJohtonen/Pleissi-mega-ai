import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { isAdmin, requireAdmin } from "../auth.js";
import { connectGmailAccount, gmailAuthUrl, gmailConfigured } from "../gmail.js";
import { getMailStatus, mailAccountFor, OFFICE_ACCOUNT, userAccountId } from "../mail.js";
import { disconnectMailAccount } from "../mail-common.js";
import { connectImapAccount } from "../mail-imap.js";
import { connectMicrosoftAccount, logMicrosoft, microsoftAuthUrl, microsoftConfigured, microsoftDescription } from "../mail-microsoft.js";

// Sähköpostitilien yhdistäminen ja tila. Reittien nimet /gmail/... ovat ajalta, jolloin Gmail oli ainoa
// vaihtoehto; ne koskevat nyt kaikkia palveluja. Uudet palvelut ovat polussa /mail/...
export const gmailRouter: Router = express.Router();

async function statusRoute(req: Request, res: Response) {
  // target=me palauttaa kirjautuneen käyttäjän oman postilaatikon.
  if (req.query.target === "me") {
    const accountId = userAccountId(res.locals.user?.id ?? "");
    return res.json({ ...(await getMailStatus(accountId)), own: true });
  }
  // Ilman taloyhtiötä palautetaan toimiston tili. Taloyhtiölle palautetaan sen käyttämä tili ja tieto,
  // onko se taloyhtiön oma (own) vai toimiston yhteinen.
  const companyId = typeof req.query.companyId === "string" ? companyIdFromContext(req.query.companyId) : null;
  const accountId = companyId ? mailAccountFor(companyId) : OFFICE_ACCOUNT;
  res.json({ ...(await getMailStatus(accountId)), own: accountId !== OFFICE_ACCOUNT });
}
gmailRouter.get("/gmail/status", statusRoute);
gmailRouter.get("/mail/status", statusRoute);

// Mitkä palvelut on otettu käyttöön palvelimella. IMAP/SMTP ei vaadi palvelimen asetuksia.
gmailRouter.get("/mail/providers", (_req, res) => {
  res.json({ gmail: gmailConfigured(), microsoft: microsoftConfigured(), imap: true });
});

// target = "me" (käyttäjän oma postilaatikko), "office" tai taloyhtiön tunniste. Oman laatikon voi
// yhdistää jokainen käyttäjä itse; toimiston ja taloyhtiöiden tilit vain pääkäyttäjä.
function connectTarget(req: Request, res: Response): string | null {
  const value = req.body?.target;
  if (value === "me") {
    if (res.locals.user?.id) return userAccountId(res.locals.user.id);
  } else if (!isAdmin(res)) {
    res.status(403).json({ error: "Tämä toiminto vaatii pääkäyttäjän oikeudet." });
    return null;
  } else if (value === OFFICE_ACCOUNT) {
    return OFFICE_ACCOUNT;
  } else if (typeof value === "string" && companyIdFromContext(value)) {
    return value;
  }
  res.status(400).json({ error: "Valitse toimisto tai taloyhtiö." });
  return null;
}

type ConnectState = { provider: "gmail" | "microsoft"; target: string; userName: string; returnTo: string; expiresAt: number; browserNonce: string };

// Yhdistämisen aloittaneen selaimen eväste. Vastauksen viimeistely (Googlen/Microsoftin paluu) hyväksytään
// vain samasta selaimesta, jotta aloittaja ei voi lähettää kirjautumislinkkiä kollegalle ja tallentaa tämän
// postilaatikkoa omalle tililleen.
const CONNECT_COOKIE = "kotilo_mail_connect";
function readConnectCookie(req: Request): string {
  const match = (req.headers.cookie ?? "").match(/(?:^|;\s*)kotilo_mail_connect=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}
const connectStates = new Map<string, ConnectState>();

function startConnect(req: Request, res: Response, provider: ConnectState["provider"]): string | null {
  const target = connectTarget(req, res);
  if (!target) return null;
  const state = crypto.randomBytes(24).toString("hex");
  const browserNonce = crypto.randomBytes(24).toString("hex");
  const origin = typeof req.headers.origin === "string" && /^https?:\/\/[^\s/]+$/.test(req.headers.origin)
    ? req.headers.origin
    : process.env.APP_URL || "http://localhost:5173";
  connectStates.set(state, { provider, target, userName: res.locals.user?.name ?? "Pääkäyttäjä", returnTo: origin, expiresAt: Date.now() + 10 * 60 * 1000, browserNonce });
  // Eväste kulkee mukana, kun palveluntarjoaja ohjaa selaimen takaisin /gmail/callback-osoitteeseen.
  res.cookie(CONNECT_COOKIE, browserNonce, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 10 * 60 * 1000, path: "/api" });
  return state;
}

// Gmail-tilin yhdistäminen: palauttaa Googlen kirjautumisosoitteen.
gmailRouter.post("/gmail/connect", async (req, res) => {
  const state = startConnect(req, res, "gmail");
  if (!state) return;
  try {
    res.json({ url: await gmailAuthUrl(state) });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Gmail-kirjautumisen aloitus epäonnistui." });
  }
});

// Microsoft 365 -tilin yhdistäminen: palauttaa Microsoftin kirjautumisosoitteen.
gmailRouter.post("/mail/microsoft/connect", (req, res) => {
  if (!microsoftConfigured()) {
    return res.status(400).json({ error: "Microsoft 365 -yhteyttä ei ole otettu käyttöön palvelimella. Katso ohje tiedostosta deploy/server/README.md." });
  }
  const state = startConnect(req, res, "microsoft");
  if (!state) return;
  res.json({ url: microsoftAuthUrl(state) });
});

// Kirjautumisen jälkeen palvelu ohjaa selaimen tänne. Vastaus on pieni sivu, jolta palataan alustalle.
async function connectCallback(req: Request, res: Response, provider: ConnectState["provider"]) {
  const label = provider === "gmail" ? "Gmail" : "Microsoft 365";
  const escape = (text: string) => text.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] as string));
  const page = (title: string, text: string, returnTo = "") => res.status(200).type("html").send(
    `<!doctype html><meta charset="utf-8"><title>Pleissi</title>
<body style="font-family:system-ui,sans-serif;background:#171c22;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="background:#fff;color:#1d2329;border-radius:16px;padding:32px;max-width:440px">
<h1 style="font-size:20px;margin:0 0 10px">${escape(title)}</h1><p style="margin:0 0 18px;line-height:1.5">${escape(text)}</p>
${returnTo ? `<a href="${escape(returnTo)}/#/settings" style="color:#2f6ba8;font-weight:700">Palaa Pleissiin</a>` : ""}</div></body>`
  );
  const state = typeof req.query.state === "string" ? connectStates.get(req.query.state) : undefined;
  if (typeof req.query.state === "string") connectStates.delete(req.query.state);
  // Kirjautumispalvelu palauttaa virheen osoitteen parametreissa (error, error_description) ilman koodia.
  const providerError = typeof req.query.error === "string" ? req.query.error : "";
  const providerDescription = typeof req.query.error_description === "string" ? microsoftDescription(req.query.error_description) : "";
  if (provider === "microsoft") {
    logMicrosoft("paluu kirjautumisesta", {
      code: typeof req.query.code === "string", error: providerError || undefined, description: providerDescription || undefined,
      knownState: Boolean(state), target: state?.target
    });
  }
  const browserNonce = readConnectCookie(req);
  res.clearCookie(CONNECT_COOKIE, { path: "/api" });
  if (!state || state.expiresAt < Date.now() || state.provider !== provider) {
    return page("Yhdistäminen epäonnistui", "Kirjautumispyyntö on vanhentunut tai virheellinen. Aloita yhdistäminen uudelleen Pleissin asetuksista.");
  }
  // Viimeistelyn pitää tapahtua samassa selaimessa, josta yhdistäminen aloitettiin.
  if (!browserNonce || browserNonce !== state.browserNonce) {
    return page("Viimeistele samassa selaimessa", "Sähköpostitilin yhdistäminen pitää viimeistellä samassa selaimessa, josta se aloitettiin. Aloita uudelleen Pleissin asetuksista.", state.returnTo);
  }
  if (typeof req.query.code !== "string") {
    // Käyttäjä perui kirjautumisen (access_denied) tai palvelu hylkäsi pyynnön: näytetään palvelun oma selitys.
    if (providerError && providerError !== "access_denied") {
      return page("Yhdistäminen epäonnistui", `${label} hylkäsi kirjautumisen: ${providerDescription || providerError}`, state.returnTo);
    }
    return page("Yhdistäminen peruttiin", `${label}-tiliä ei yhdistetty.`, state.returnTo);
  }
  try {
    const email = provider === "gmail"
      ? await connectGmailAccount(state.target, req.query.code, state.userName)
      : await connectMicrosoftAccount(state.target, req.query.code, state.userName);
    if (provider === "microsoft") logMicrosoft("tili yhdistetty", { email, target: state.target });
    page(`${label}-tili yhdistetty`, `Tili ${email} on nyt käytössä. Voit sulkea tämän välilehden.`, state.returnTo);
  } catch (error: any) {
    console.error(`${label}-tilin yhdistäminen epäonnistui:`, error?.message ?? error);
    page("Yhdistäminen epäonnistui", error?.message ?? "Tuntematon virhe.", state.returnTo);
  }
}
gmailRouter.get("/gmail/callback", (req, res) => connectCallback(req, res, "gmail"));
gmailRouter.get("/mail/microsoft/callback", (req, res) => connectCallback(req, res, "microsoft"));

// IMAP/SMTP-tilin yhdistäminen: yhteys kokeillaan ennen tallennusta, jotta virheelliset tiedot huomataan heti.
// Postipalvelimen osoitteeksi kelpaa vain julkinen verkkonimi. Sisäverkon ja pilven metatieto-osoitteet
// torjutaan, jottei asetuksilla voi saada palvelinta ottamaan yhteyttä sisäisiin palveluihin (SSRF).
export function isPublicMailHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/\.$/, "");
  if (!value || !value.includes(".")) return false; // yksiosaiset nimet (esim. docker-palvelun nimi, localhost)
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(value)) return false;
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (ipv4.slice(1).some(part => Number(part) > 255)) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;      // tämä verkko, yksityinen, loopback, multicast/varattu
    if (a === 169 && b === 254) return false;                            // link-local ja pilven metatieto
    if (a === 192 && b === 168) return false;                            // yksityinen
    if (a === 172 && b >= 16 && b <= 31) return false;                   // yksityinen
    if (a === 100 && b >= 64 && b <= 127) return false;                  // CGNAT
  }
  return true;
}
const hostSchema = z.string().trim().min(3).max(200).regex(/^[a-z0-9.-]+$/i, "Palvelimen osoite on virheellinen.")
  .refine(host => process.env.NODE_ENV === "test" || isPublicMailHost(host), "Palvelimen osoitteeksi tarvitaan julkinen verkkonimi.");
const portSchema = z.coerce.number().int().min(1).max(65535);
gmailRouter.post("/mail/imap", async (req, res) => {
  const target = connectTarget(req, res);
  if (!target) return;
  const parsed = z.object({
    email: z.string().trim().email().max(200),
    imapHost: hostSchema,
    imapPort: portSchema.default(993),
    smtpHost: hostSchema,
    smtpPort: portSchema.default(465),
    username: z.string().trim().max(200).optional(),
    password: z.string().min(1).max(500)
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Tarkista sähköpostiosoite, palvelimet, portit ja salasana." });
  const { email, password, ...rest } = parsed.data;
  try {
    const connected = await connectImapAccount({
      accountId: target,
      email,
      password,
      settings: { ...rest, username: rest.username || email },
      connectedBy: res.locals.user?.name ?? "Pääkäyttäjä"
    });
    res.json({ ok: true, email: connected });
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? "Sähköpostitilin yhdistäminen epäonnistui." });
  }
});

// Poistaa taloyhtiön oman tilin, jolloin taloyhtiö palaa käyttämään toimiston tiliä.
gmailRouter.delete("/gmail/accounts/:companyId", requireAdmin, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId || req.params.companyId === OFFICE_ACCOUNT) return res.status(400).json({ error: "Toimiston tiliä ei voi poistaa; vaihda se toiseen." });
  if (!disconnectMailAccount(companyId)) return res.status(404).json({ error: "Taloyhtiöllä ei ole omaa sähköpostitiliä." });
  res.json({ ok: true });
});

// Käyttäjän oman postilaatikon poisto. Pääkäyttäjä voi poistaa minkä tahansa käyttäjän laatikon.
gmailRouter.delete("/mail/accounts/me", (_req, res) => {
  if (!disconnectMailAccount(userAccountId(res.locals.user?.id ?? ""))) return res.status(404).json({ error: "Sinulla ei ole yhdistettyä sähköpostitiliä." });
  res.json({ ok: true });
});

gmailRouter.delete("/mail/accounts/user/:userId", requireAdmin, (req: Request<{ userId: string }>, res) => {
  if (!disconnectMailAccount(userAccountId(req.params.userId))) return res.status(404).json({ error: "Käyttäjällä ei ole yhdistettyä sähköpostitiliä." });
  res.json({ ok: true });
});
