import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { requireAdmin } from "../auth.js";
import { connectGmailAccount, gmailAuthUrl, gmailConfigured } from "../gmail.js";
import { getMailStatus, mailAccountFor, OFFICE_ACCOUNT } from "../mail.js";
import { disconnectMailAccount } from "../mail-common.js";
import { connectImapAccount } from "../mail-imap.js";
import { connectMicrosoftAccount, microsoftAuthUrl, microsoftConfigured } from "../mail-microsoft.js";

// Sähköpostitilien yhdistäminen ja tila. Reittien nimet /gmail/... ovat ajalta, jolloin Gmail oli ainoa
// vaihtoehto; ne koskevat nyt kaikkia palveluja. Uudet palvelut ovat polussa /mail/...
export const gmailRouter: Router = express.Router();

async function statusRoute(req: Request, res: Response) {
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

// target = "office" tai taloyhtiön tunniste, johon pyynnön tekijällä on oikeus.
function connectTarget(value: unknown): string | null {
  if (value === OFFICE_ACCOUNT) return OFFICE_ACCOUNT;
  return typeof value === "string" ? companyIdFromContext(value) : null;
}

type ConnectState = { provider: "gmail" | "microsoft"; target: string; userName: string; returnTo: string; expiresAt: number };
const connectStates = new Map<string, ConnectState>();

function startConnect(req: Request, res: Response, provider: ConnectState["provider"]): string | null {
  const target = connectTarget(req.body?.target);
  if (!target) {
    res.status(400).json({ error: "Valitse toimisto tai taloyhtiö." });
    return null;
  }
  const state = crypto.randomBytes(24).toString("hex");
  const origin = typeof req.headers.origin === "string" && /^https?:\/\/[^\s/]+$/.test(req.headers.origin)
    ? req.headers.origin
    : process.env.APP_URL || "http://localhost:5173";
  connectStates.set(state, { provider, target, userName: res.locals.user?.name ?? "Pääkäyttäjä", returnTo: origin, expiresAt: Date.now() + 10 * 60 * 1000 });
  return state;
}

// Gmail-tilin yhdistäminen: palauttaa Googlen kirjautumisosoitteen.
gmailRouter.post("/gmail/connect", requireAdmin, async (req, res) => {
  const state = startConnect(req, res, "gmail");
  if (!state) return;
  try {
    res.json({ url: await gmailAuthUrl(state) });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Gmail-kirjautumisen aloitus epäonnistui." });
  }
});

// Microsoft 365 -tilin yhdistäminen: palauttaa Microsoftin kirjautumisosoitteen.
gmailRouter.post("/mail/microsoft/connect", requireAdmin, (req, res) => {
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
    `<!doctype html><meta charset="utf-8"><title>Kotilo</title>
<body style="font-family:system-ui,sans-serif;background:#171c22;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="background:#fff;color:#1d2329;border-radius:16px;padding:32px;max-width:440px">
<h1 style="font-size:20px;margin:0 0 10px">${escape(title)}</h1><p style="margin:0 0 18px;line-height:1.5">${escape(text)}</p>
${returnTo ? `<a href="${escape(returnTo)}/#/settings" style="color:#2f6ba8;font-weight:700">Palaa Kotiloon</a>` : ""}</div></body>`
  );
  const state = typeof req.query.state === "string" ? connectStates.get(req.query.state) : undefined;
  if (typeof req.query.state === "string") connectStates.delete(req.query.state);
  if (!state || state.expiresAt < Date.now() || state.provider !== provider) {
    return page("Yhdistäminen epäonnistui", "Kirjautumispyyntö on vanhentunut tai virheellinen. Aloita yhdistäminen uudelleen Kotilon asetuksista.");
  }
  if (typeof req.query.code !== "string") {
    return page("Yhdistäminen peruttiin", `${label}-tiliä ei yhdistetty.`, state.returnTo);
  }
  try {
    const email = provider === "gmail"
      ? await connectGmailAccount(state.target, req.query.code, state.userName)
      : await connectMicrosoftAccount(state.target, req.query.code, state.userName);
    page(`${label}-tili yhdistetty`, `Tili ${email} on nyt käytössä. Voit sulkea tämän välilehden.`, state.returnTo);
  } catch (error: any) {
    console.error(`${label}-tilin yhdistäminen epäonnistui:`, error?.message ?? error);
    page("Yhdistäminen epäonnistui", error?.message ?? "Tuntematon virhe.", state.returnTo);
  }
}
gmailRouter.get("/gmail/callback", (req, res) => connectCallback(req, res, "gmail"));
gmailRouter.get("/mail/microsoft/callback", (req, res) => connectCallback(req, res, "microsoft"));

// IMAP/SMTP-tilin yhdistäminen: yhteys kokeillaan ennen tallennusta, jotta virheelliset tiedot huomataan heti.
const hostSchema = z.string().trim().min(3).max(200).regex(/^[a-z0-9.-]+$/i, "Palvelimen osoite on virheellinen.");
const portSchema = z.coerce.number().int().min(1).max(65535);
gmailRouter.post("/mail/imap", requireAdmin, async (req, res) => {
  const target = connectTarget(req.body?.target);
  if (!target) return res.status(400).json({ error: "Valitse toimisto tai taloyhtiö." });
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
