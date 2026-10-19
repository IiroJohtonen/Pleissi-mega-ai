import crypto from "node:crypto";
import express, { type Router } from "express";
import { z } from "zod";
import { raiseAlert } from "./alerts.js";
import { hashToken, issueStaffSession, type User } from "./auth.js";
import { db } from "./db.js";
import { getMailAccount, mailEnabled, OFFICE_ACCOUNT } from "./mail-common.js";
import { hasLegacyGmailToken } from "./gmail.js";
import { sendEmail } from "./mail.js";

// ---------------------------------------------------------------------------------------------
// Kaksivaiheinen tunnistautuminen henkilökunnalle. Kun pääkäyttäjä on kytkenyt sen päälle, oikean
// salasanan jälkeen käyttäjän sähköpostiin lähetetään kuusinumeroinen koodi, joka on voimassa
// 10 minuuttia. Väärä koodi hyväksytään enintään viisi kertaa, minkä jälkeen kirjautuminen
// aloitetaan alusta. Laitteen voi merkitä luotetuksi, jolloin koodia ei kysytä 30 päivään.
// Hätäkatkaisin: ympäristömuuttuja TWO_FACTOR_DISABLED=1 ohittaa asetuksen (esim. jos posti ei toimi).
// ---------------------------------------------------------------------------------------------
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 3;
const RESEND_INTERVAL_MS = 30 * 1000;
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Uusia kirjautumisia (ja siten koodiyrityksiä) käyttäjää kohden: salasanan tietävä ei voi arvata
// koodia aloittamalla kirjautumista yhä uudelleen.
const MAX_CHALLENGES = 5;
const CHALLENGE_WINDOW_MS = 15 * 60 * 1000;
const recentChallenges = new Map<string, number[]>();

const officeColumns = db.prepare("PRAGMA table_info(office_settings)").all() as { name: string }[];
if (!officeColumns.some(column => column.name === "two_factor")) {
  db.exec("ALTER TABLE office_settings ADD COLUMN two_factor INTEGER NOT NULL DEFAULT 0");
}

export function loginCodeSetting(): boolean {
  return Boolean((db.prepare("SELECT two_factor FROM office_settings WHERE id = 1").get() as { two_factor: number }).two_factor);
}

export function loginCodeRequired(): boolean {
  return process.env.TWO_FACTOR_DISABLED !== "1" && loginCodeSetting();
}

// Koodit lähtevät toimiston sähköpostitililtä, joten se pitää olla yhdistetty ennen käyttöönottoa.
export function loginCodeMailReady(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  return mailEnabled && (Boolean(getMailAccount(OFFICE_ACCOUNT)) || hasLegacyGmailToken());
}

const codeHash = (challengeId: string, code: string) => crypto.createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

// Näytetään käyttäjälle, mihin koodi lähetettiin, paljastamatta koko osoitetta.
function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  return `${local.slice(0, 2)}${"•".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

type Challenge = { id_hash: string; user_id: string; code_hash: string; attempts: number; sends: number; created_at: string; sent_at: string };

function purgeExpired() {
  db.prepare("DELETE FROM login_challenges WHERE created_at < ?").run(new Date(Date.now() - CODE_TTL_MS).toISOString());
  db.prepare("DELETE FROM trusted_devices WHERE expires_at < ?").run(new Date().toISOString());
}

async function sendCode(user: User, code: string) {
  // Testeissä postia ei lähetetä; koodi tulostetaan palvelimen lokiin testien luettavaksi.
  if (process.env.NODE_ENV === "test") {
    console.log(`Kirjautumiskoodi ${user.email}: ${code}`);
    return;
  }
  const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string };
  await sendEmail({
    to: user.email,
    notification: true,
    subject: "Pleissi-kirjautumiskoodi",
    body: [
      `Hei ${user.name},`,
      "",
      `kirjautumiskoodisi Pleissiin on: ${code}`,
      "",
      "Koodi on voimassa 10 minuuttia. Jos et yrittänyt kirjautua, joku tietää salasanasi: vaihda se heti ja kerro pääkäyttäjälle.",
      "",
      office.name
    ].join("\n")
  });
}

export async function startLoginChallenge(user: User): Promise<{ challengeId: string; maskedEmail: string } | { error: string; status: number }> {
  purgeExpired();
  const recent = (recentChallenges.get(user.id) ?? []).filter(at => Date.now() - at < CHALLENGE_WINDOW_MS);
  if (recent.length >= MAX_CHALLENGES) {
    return { error: "Liian monta kirjautumisyritystä. Yritä uudelleen 15 minuutin kuluttua.", status: 429 };
  }
  recentChallenges.set(user.id, [...recent, Date.now()]);
  const challengeId = crypto.randomBytes(32).toString("hex");
  const code = newCode();
  const timestamp = new Date().toISOString();
  // Käyttäjällä on kerrallaan yksi voimassa oleva koodi.
  db.prepare("DELETE FROM login_challenges WHERE user_id = ?").run(user.id);
  db.prepare("INSERT INTO login_challenges (id_hash, user_id, code_hash, created_at, sent_at) VALUES (?, ?, ?, ?, ?)")
    .run(hashToken(challengeId), user.id, codeHash(challengeId, code), timestamp, timestamp);
  try {
    await sendCode(user, code);
  } catch (error: any) {
    db.prepare("DELETE FROM login_challenges WHERE id_hash = ?").run(hashToken(challengeId));
    console.error("Kirjautumiskoodin lähetys epäonnistui:", error?.message ?? error);
    raiseAlert("login-code", "Kirjautumiskoodin lähetys epäonnistui",
      `Henkilökunnan kirjautumiskoodia ei saatu lähetettyä. Tarkista toimiston sähköpostiyhteys.\n\nVirhe: ${error?.message ?? error}`);
    return { error: "Kirjautumiskoodin lähetys epäonnistui. Yritä hetken kuluttua uudelleen.", status: 502 };
  }
  return { challengeId, maskedEmail: maskEmail(user.email) };
}

export function trustedDevice(userId: string, deviceToken?: string): boolean {
  if (!deviceToken) return false;
  const row = db.prepare("SELECT user_id, expires_at FROM trusted_devices WHERE token_hash = ?").get(hashToken(deviceToken)) as
    | { user_id: string; expires_at: string }
    | undefined;
  return Boolean(row && row.user_id === userId && Date.parse(row.expires_at) > Date.now());
}

function activeChallenge(challengeId: string) {
  const row = db.prepare("SELECT * FROM login_challenges WHERE id_hash = ?").get(hashToken(challengeId)) as Challenge | undefined;
  if (!row || Date.now() - Date.parse(row.created_at) > CODE_TTL_MS) return null;
  return row;
}

function staffUser(userId: string) {
  return db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(userId) as User | undefined;
}

export const loginCodesRouter: Router = express.Router();

const expired = "Koodi on vanhentunut. Kirjaudu uudelleen, niin saat uuden koodin.";

loginCodesRouter.post("/auth/verify-code", (req, res) => {
  const parsed = z.object({
    challengeId: z.string().min(20).max(200),
    code: z.string().trim().regex(/^\d{6}$/),
    rememberDevice: z.boolean().default(false)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Anna sähköpostiin tullut kuusinumeroinen koodi." });

  const challenge = activeChallenge(parsed.data.challengeId);
  if (!challenge) return res.status(401).json({ error: expired });

  const expected = Buffer.from(challenge.code_hash, "hex");
  const actual = Buffer.from(codeHash(parsed.data.challengeId, parsed.data.code), "hex");
  if (!crypto.timingSafeEqual(expected, actual)) {
    const attempts = challenge.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare("DELETE FROM login_challenges WHERE id_hash = ?").run(challenge.id_hash);
      return res.status(401).json({ error: "Liian monta väärää koodia. Kirjaudu uudelleen, niin saat uuden koodin." });
    }
    db.prepare("UPDATE login_challenges SET attempts = ? WHERE id_hash = ?").run(attempts, challenge.id_hash);
    return res.status(401).json({ error: `Väärä koodi. Yrityksiä jäljellä ${MAX_ATTEMPTS - attempts}.` });
  }

  db.prepare("DELETE FROM login_challenges WHERE id_hash = ?").run(challenge.id_hash);
  const user = staffUser(challenge.user_id);
  if (!user) return res.status(401).json({ error: expired });

  let deviceToken: string | undefined;
  if (parsed.data.rememberDevice) {
    deviceToken = crypto.randomBytes(32).toString("hex");
    const timestamp = Date.now();
    db.prepare("INSERT INTO trusted_devices (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
      hashToken(deviceToken), user.id, new Date(timestamp).toISOString(), new Date(timestamp + DEVICE_TTL_MS).toISOString()
    );
  }
  res.json({ ...issueStaffSession(user), ...(deviceToken ? { deviceToken } : {}) });
});

loginCodesRouter.post("/auth/resend-code", async (req, res) => {
  const parsed = z.object({ challengeId: z.string().min(20).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: expired });
  const challenge = activeChallenge(parsed.data.challengeId);
  if (!challenge) return res.status(401).json({ error: expired });
  if (challenge.sends >= MAX_SENDS) return res.status(429).json({ error: "Koodi on lähetetty jo kolme kertaa. Kirjaudu uudelleen hetken kuluttua." });
  if (Date.now() - Date.parse(challenge.sent_at) < RESEND_INTERVAL_MS) {
    return res.status(429).json({ error: "Odota hetki ennen kuin pyydät uuden koodin." });
  }
  const user = staffUser(challenge.user_id);
  if (!user) return res.status(401).json({ error: expired });

  const code = newCode();
  db.prepare("UPDATE login_challenges SET code_hash = ?, sends = sends + 1, sent_at = ? WHERE id_hash = ?")
    .run(codeHash(parsed.data.challengeId, code), new Date().toISOString(), challenge.id_hash);
  try {
    await sendCode(user, code);
  } catch (error: any) {
    console.error("Kirjautumiskoodin lähetys epäonnistui:", error?.message ?? error);
    return res.status(502).json({ error: "Kirjautumiskoodin lähetys epäonnistui. Yritä hetken kuluttua uudelleen." });
  }
  res.json({ ok: true });
});
