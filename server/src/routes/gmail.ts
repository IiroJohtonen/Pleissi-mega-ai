import crypto from "node:crypto";
import express, { type Router } from "express";
import { companyIdFromContext } from "../access.js";
import { requireAdmin } from "../auth.js";
import {
  connectGmailAccount, disconnectGmailAccount, getGmailStatus, gmailAccountFor, gmailAuthUrl, OFFICE_ACCOUNT
} from "../gmail.js";

export const gmailRouter: Router = express.Router();

gmailRouter.get("/gmail/status", async (_req, res) => {
  // Ilman taloyhtiötä palautetaan toimiston tili. Taloyhtiölle palautetaan sen käyttämä tili ja tieto,
  // onko se taloyhtiön oma (own) vai toimiston yhteinen.
  const companyId = typeof _req.query.companyId === "string" ? companyIdFromContext(_req.query.companyId) : null;
  const accountId = companyId ? await gmailAccountFor(companyId) : OFFICE_ACCOUNT;
  res.json({ ...(await getGmailStatus(accountId)), own: accountId !== OFFICE_ACCOUNT });
});

// Gmail-tilin yhdistäminen: palauttaa Googlen kirjautumisosoitteen. target = "office" tai taloyhtiön tunniste.
const gmailConnectStates = new Map<string, { target: string; userName: string; returnTo: string; expiresAt: number }>();

gmailRouter.post("/gmail/connect", requireAdmin, async (req, res) => {
  const target = req.body?.target === OFFICE_ACCOUNT ? OFFICE_ACCOUNT : companyIdFromContext(req.body?.target);
  if (!target || (target !== OFFICE_ACCOUNT && typeof req.body?.target !== "string")) {
    return res.status(400).json({ error: "Valitse toimisto tai taloyhtiö." });
  }
  const state = crypto.randomBytes(24).toString("hex");
  const origin = typeof req.headers.origin === "string" && /^https?:\/\/[^\s/]+$/.test(req.headers.origin)
    ? req.headers.origin
    : process.env.APP_URL || "http://localhost:5173";
  gmailConnectStates.set(state, { target, userName: res.locals.user?.name ?? "Pääkäyttäjä", returnTo: origin, expiresAt: Date.now() + 10 * 60 * 1000 });
  try {
    res.json({ url: await gmailAuthUrl(state) });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? "Gmail-kirjautumisen aloitus epäonnistui." });
  }
});

// Google ohjaa selaimen tänne kirjautumisen jälkeen. Vastaus on pieni sivu, jolta palataan alustalle.
gmailRouter.get("/gmail/callback", async (req, res) => {
  const escape = (text: string) => text.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] as string));
  const page = (title: string, text: string, returnTo = "") => res.status(200).type("html").send(
    `<!doctype html><meta charset="utf-8"><title>Kotilo</title>
<body style="font-family:system-ui,sans-serif;background:#171c22;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="background:#fff;color:#1d2329;border-radius:16px;padding:32px;max-width:440px">
<h1 style="font-size:20px;margin:0 0 10px">${escape(title)}</h1><p style="margin:0 0 18px;line-height:1.5">${escape(text)}</p>
${returnTo ? `<a href="${escape(returnTo)}/#/settings" style="color:#2f6ba8;font-weight:700">Palaa Kotiloon</a>` : ""}</div></body>`
  );
  const state = typeof req.query.state === "string" ? gmailConnectStates.get(req.query.state) : undefined;
  if (typeof req.query.state === "string") gmailConnectStates.delete(req.query.state);
  if (!state || state.expiresAt < Date.now()) {
    return page("Yhdistäminen epäonnistui", "Kirjautumispyyntö on vanhentunut tai virheellinen. Aloita yhdistäminen uudelleen Kotilon asetuksista.");
  }
  if (typeof req.query.code !== "string") {
    return page("Yhdistäminen peruttiin", "Gmail-tiliä ei yhdistetty.", state.returnTo);
  }
  try {
    const email = await connectGmailAccount(state.target, req.query.code, state.userName);
    page("Gmail-tili yhdistetty", `Tili ${email} on nyt käytössä. Voit sulkea tämän välilehden.`, state.returnTo);
  } catch (error: any) {
    console.error("Gmail-tilin yhdistäminen epäonnistui:", error?.message ?? error);
    page("Yhdistäminen epäonnistui", error?.message ?? "Tuntematon virhe.", state.returnTo);
  }
});

// Poistaa taloyhtiön oman tilin, jolloin taloyhtiö palaa käyttämään toimiston tiliä.
gmailRouter.delete("/gmail/accounts/:companyId", requireAdmin, async (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId || req.params.companyId === OFFICE_ACCOUNT) return res.status(400).json({ error: "Toimiston tiliä ei voi poistaa; vaihda se toiseen." });
  if (!(await disconnectGmailAccount(companyId))) return res.status(404).json({ error: "Taloyhtiöllä ei ole omaa Gmail-tiliä." });
  res.json({ ok: true });
});
