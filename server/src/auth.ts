import crypto from "node:crypto";
import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import { z } from "zod";
import { db } from "./db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Asukkaiden kirjautuminen: salasana ja istunnot omissa tauluissaan, erillään henkilökunnasta.
CREATE TABLE IF NOT EXISTS resident_credentials (
  resident_id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(resident_id) REFERENCES residents(id)
);

-- Salasanan palautuslinkit. Linkin tunnisteesta tallennetaan vain tiiviste; linkki on kertakäyttöinen.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resident_sessions (
  token_hash TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(resident_id) REFERENCES residents(id)
);
`);

export type ResidentAccount = {
  id: string;
  name: string;
  email: string;
  companyId: string;
  companyName: string;
  apartmentId: string;
  apartmentNumber: string;
};

export type User = { id: string; name: string; email: string; role: string };

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
export const USER_ROLES = ["Pääkäyttäjä", "Isännöitsijä", "Asiakaspalvelu"] as const;
export const ADMIN_ROLE = "Pääkäyttäjä";

// Käyttäjien hallinta ja asetukset kuuluvat vain pääkäyttäjälle.
export function isAdmin(res: Response): boolean {
  return (res.locals.user as User | undefined)?.role === ADMIN_ROLE;
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction) {
  if (!isAdmin(res)) return res.status(403).json({ error: "Tämä toiminto vaatii pääkäyttäjän oikeudet." });
  next();
}

// Taloyhtiöiden tiedot, tietopankki, tiedotteet, muuttojen hyväksyntä, laskutusmerkinnät, loki ja
// asukkaan tietojen vienti ja poisto kuuluvat isännöitsijälle ja pääkäyttäjälle, eivät asiakaspalvelulle.
export const MANAGER_ROLES: readonly string[] = ["Isännöitsijä", ADMIN_ROLE];

// _req on tyypitön, jotta reitin omat parametrityypit säilyvät käsittelijässä.
export function requireManager(_req: unknown, res: Response, next: NextFunction) {
  if (!MANAGER_ROLES.includes((res.locals.user as User | undefined)?.role ?? "")) {
    return res.status(403).json({ error: "Tämä toiminto vaatii isännöitsijän oikeudet." });
  }
  next();
}

function localToday(): string {
  return new Date().toLocaleDateString("sv-SE");
}

// Palvelimen omat sisäiset kutsut (Gmail-tuonti) tunnistetaan tällä käynnistyskohtaisella avaimella.
export const INTERNAL_TOKEN = crypto.randomBytes(32).toString("hex");

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Istuntotunnisteesta tallennetaan vain tiiviste, jotta tietokannan lukija ei voi käyttää istuntoja.
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Ensimmäisellä käynnistyksellä luodaan testitoimiston käyttäjät yhteisellä aloitussalasanalla. Salasana
// annetaan ympäristömuuttujassa INITIAL_PASSWORD; ilman sitä se arvotaan ja tulostetaan kerran lokiin.
const userCount = (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
if (userCount === 0) {
  const INITIAL_PASSWORD = process.env.INITIAL_PASSWORD || crypto.randomBytes(9).toString("base64url");
  if (INITIAL_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`INITIAL_PASSWORD-salasanassa pitää olla vähintään ${MIN_PASSWORD_LENGTH} merkkiä.`);
  }
  if (!process.env.INITIAL_PASSWORD) {
    console.log(`Kotilo: ensimmäiset käyttäjät luotu. Aloitussalasana kaikille: ${INITIAL_PASSWORD}`);
    console.log("Kotilo: kirjaudu osoitteella demo@pohjantahti-isannointi.fi ja vaihda salasanat asetuksista.");
  }
  const insert = db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)");
  const seedUsers: [string, string, string][] = [
    ["Demo Isännöitsijä", "demo@pohjantahti-isannointi.fi", "Pääkäyttäjä"],
    ["Hanna Lehtonen", "hanna.lehtonen@pohjantahti-isannointi.fi", "Isännöitsijä"],
    ["Mikko Rantanen", "mikko.rantanen@pohjantahti-isannointi.fi", "Isännöitsijä"],
    ["Elina Koskinen", "elina.koskinen@pohjantahti-isannointi.fi", "Asiakaspalvelu"]
  ];
  for (const [name, email, role] of seedUsers) {
    insert.run(`user-${crypto.randomUUID()}`, name, email, role, hashPassword(INITIAL_PASSWORD), new Date().toISOString());
  }
}

function userForToken(token: string): User | null {
  const row = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, s.created_at AS session_created_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(hashToken(token)) as (User & { session_created_at: string }) | undefined;

  if (!row) return null;
  if (Date.now() - Date.parse(row.session_created_at) > SESSION_TTL_MS) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    return null;
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

const RESIDENT_SELECT = `
  SELECT r.id, r.name, r.email, r.company_id AS companyId, c.name AS companyName,
         r.apartment_id AS apartmentId, a.apartment_number AS apartmentNumber
  FROM residents r
  JOIN companies c ON c.id = r.company_id
  JOIN apartments a ON a.id = r.apartment_id
`;

function residentForToken(token: string): ResidentAccount | null {
  const session = db.prepare(
    "SELECT resident_id, created_at FROM resident_sessions WHERE token_hash = ?"
  ).get(hashToken(token)) as { resident_id: string; created_at: string } | undefined;

  if (!session) return null;
  if (Date.now() - Date.parse(session.created_at) > SESSION_TTL_MS) {
    db.prepare("DELETE FROM resident_sessions WHERE token_hash = ?").run(hashToken(token));
    return null;
  }
  // Pois muuttanut asukas ei enää pääse portaaliin.
  return (db.prepare(`${RESIDENT_SELECT} WHERE r.id = ? AND (r.moved_out_at IS NULL OR r.moved_out_at > ?)`)
    .get(session.resident_id, localToday()) as ResidentAccount | undefined) ?? null;
}

// Asettaa tai vaihtaa asukkaan salasanan. Vaihto kirjaa asukkaan ulos kaikilta laitteilta.
export function setResidentPassword(residentId: string, password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Salasanassa pitää olla vähintään ${MIN_PASSWORD_LENGTH} merkkiä.`;
  }
  db.prepare(`
    INSERT INTO resident_credentials (resident_id, password_hash, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(resident_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at
  `).run(residentId, hashPassword(password), new Date().toISOString());
  db.prepare("DELETE FROM resident_sessions WHERE resident_id = ?").run(residentId);
  return null;
}

// Vaihtaa henkilökunnan käyttäjän salasanan ja kirjaa hänet ulos kaikilta laitteilta.
function setUserPassword(userId: string, password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Salasanassa pitää olla vähintään ${MIN_PASSWORD_LENGTH} merkkiä.`;
  }
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return null;
}

const RESET_TTL_MS = 60 * 60 * 1000;

export type PasswordReset = { token: string; name: string; label: string };

// Luo palautuslinkin tunnisteen jokaiselle tilille, jolla on tämä sähköposti: henkilökunnan käyttäjälle
// ja asukkaille, joilla on jo salasana. Tuntemattomalle osoitteelle palautuu tyhjä lista.
export function createPasswordResets(email: string): PasswordReset[] {
  db.prepare("DELETE FROM password_resets WHERE created_at < ?").run(new Date(Date.now() - RESET_TTL_MS).toISOString());
  const accounts: { kind: string; id: string; name: string; label: string }[] = [];
  const user = db.prepare("SELECT id, name FROM users WHERE email = ?").get(email) as { id: string; name: string } | undefined;
  if (user) accounts.push({ kind: "user", id: user.id, name: user.name, label: "Henkilökunnan tunnus" });
  const residents = db.prepare(`
    SELECT r.id, r.name, c.name AS company
    FROM residents r
    JOIN resident_credentials rc ON rc.resident_id = r.id
    JOIN companies c ON c.id = r.company_id
    WHERE lower(r.email) = lower(?) AND (r.moved_out_at IS NULL OR r.moved_out_at > ?)
  `).all(email, localToday()) as { id: string; name: string; company: string }[];
  for (const resident of residents) {
    accounts.push({ kind: "resident", id: resident.id, name: resident.name, label: `Asukasportaali, ${resident.company}` });
  }

  return accounts.map(account => {
    const token = crypto.randomBytes(32).toString("hex");
    // Tilillä on kerrallaan yksi voimassa oleva linkki.
    db.prepare("DELETE FROM password_resets WHERE kind = ? AND subject_id = ?").run(account.kind, account.id);
    db.prepare("INSERT INTO password_resets (token_hash, kind, subject_id, created_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(token), account.kind, account.id, new Date().toISOString());
    return { token, name: account.name, label: account.label };
  });
}

// Vaihtaa salasanan palautuslinkin tunnisteella. Palauttaa virhetekstin tai null, kun vaihto onnistui.
export function consumePasswordReset(token: string, password: string): string | null {
  const row = db.prepare("SELECT kind, subject_id, created_at FROM password_resets WHERE token_hash = ?")
    .get(hashToken(token)) as { kind: string; subject_id: string; created_at: string } | undefined;
  if (!row || Date.now() - Date.parse(row.created_at) > RESET_TTL_MS) {
    return "Palautuslinkki on vanhentunut tai jo käytetty. Pyydä uusi linkki.";
  }
  const error = row.kind === "user" ? setUserPassword(row.subject_id, password) : setResidentPassword(row.subject_id, password);
  if (error) return error;
  db.prepare("DELETE FROM password_resets WHERE token_hash = ?").run(hashToken(token));
  return null;
}

// Istuntotunniste kulkee vain Authorization-otsakkeessa, ei koskaan osoitteessa, jotta se ei päädy
// selainhistoriaan tai palvelinlokeihin. Tiedostot ladataan samalla otsakkeella.
function tokenFromRequest(req: Request): string {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

// Kaikki rajapinnan kutsut vaativat kirjautumisen, paitsi kirjautuminen itse ja tilatarkistus.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.method === "OPTIONS") return next();
  if (req.path === "/auth/login" || req.path === "/health") return next();
  // Googlen ja Microsoftin kirjautuminen palaa tähän ilman istuntoa; pyyntö tunnistetaan kertakäyttöisestä state-arvosta.
  if (req.path === "/gmail/callback" || req.path === "/mail/microsoft/callback") return next();
  // Salasanan palautus tehdään kirjautumatta.
  if (req.path === "/auth/forgot" || req.path === "/auth/reset") return next();
  // Kotisivun yhteydenottolomake lähetetään kirjautumatta.
  if (req.path === "/contact" && req.method === "POST") return next();
  if (req.path === "/inbound/messages" && req.headers["x-internal-token"] === INTERNAL_TOKEN) return next();

  const token = tokenFromRequest(req);
  const user = token ? userForToken(token) : null;
  if (user) {
    // Henkilökunta ei käytä asukasportaalin rajapintaa.
    if (req.path.startsWith("/portal/")) return res.status(403).json({ error: "Vain asukkaille." });
    res.locals.user = user;
    res.locals.token = token;
    return next();
  }

  // Asukas pääsee vain asukasportaalin rajapintaan, ei mihinkään henkilökunnan tietoihin.
  const resident = token ? residentForToken(token) : null;
  if (!resident) return res.status(401).json({ error: "Kirjaudu sisään." });
  if (!req.path.startsWith("/portal/") && req.path !== "/auth/logout") {
    return res.status(403).json({ error: "Ei käyttöoikeutta." });
  }

  res.locals.resident = resident;
  res.locals.token = token;
  next();
}

// Kirjautumisyritysten rajoitus sähköpostiosoitetta kohden.
const failedLogins = new Map<string, { count: number; firstAt: number }>();
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

export const authRouter: Router = express.Router();

authRouter.post("/auth/login", (req, res) => {
  const parsed = z.object({
    email: z.string().trim().min(1),
    password: z.string().min(1)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Anna sähköposti ja salasana." });

  const key = parsed.data.email.toLowerCase();
  const attempts = failedLogins.get(key);
  if (attempts && Date.now() - attempts.firstAt > FAILED_LOGIN_WINDOW_MS) failedLogins.delete(key);
  if ((failedLogins.get(key)?.count ?? 0) >= MAX_FAILED_LOGINS) {
    return res.status(429).json({ error: "Liian monta yritystä. Yritä uudelleen 15 minuutin kuluttua." });
  }

  const row = db.prepare(
    "SELECT id, name, email, role, password_hash FROM users WHERE email = ?"
  ).get(parsed.data.email) as (User & { password_hash: string }) | undefined;

  if (!row || !verifyPassword(parsed.data.password, row.password_hash)) {
    // Ei henkilökunnan tunnus: kokeillaan asukasta. Sama sähköposti voi olla usean yhtiön
    // asukkaalla, joten valitaan se, jonka salasana täsmää.
    const candidates = db.prepare(`
      SELECT rc.resident_id, rc.password_hash
      FROM resident_credentials rc
      JOIN residents r ON r.id = rc.resident_id
      WHERE lower(r.email) = lower(?) AND (r.moved_out_at IS NULL OR r.moved_out_at > ?)
    `).all(parsed.data.email, localToday()) as { resident_id: string; password_hash: string }[];
    const match = candidates.find(candidate => verifyPassword(parsed.data.password, candidate.password_hash));

    if (match) {
      failedLogins.delete(key);
      const residentToken = crypto.randomBytes(32).toString("hex");
      db.prepare("INSERT INTO resident_sessions VALUES (?, ?, ?)").run(
        hashToken(residentToken), match.resident_id, new Date().toISOString()
      );
      const account = db.prepare(`${RESIDENT_SELECT} WHERE r.id = ?`).get(match.resident_id) as ResidentAccount;
      return res.json({
        token: residentToken,
        kind: "resident",
        user: { id: account.id, name: account.name, email: account.email, role: "Asukas" },
        resident: account
      });
    }

    const current = failedLogins.get(key) ?? { count: 0, firstAt: Date.now() };
    failedLogins.set(key, { count: current.count + 1, firstAt: current.firstAt });
    return res.status(401).json({ error: "Väärä sähköposti tai salasana." });
  }

  failedLogins.delete(key);
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(hashToken(token), row.id, new Date().toISOString());

  res.json({ token, user: { id: row.id, name: row.name, email: row.email, role: row.role } });
});

authRouter.post("/auth/logout", (_req, res) => {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(res.locals.token));
  db.prepare("DELETE FROM resident_sessions WHERE token_hash = ?").run(hashToken(res.locals.token));
  res.json({ ok: true });
});

authRouter.get("/auth/me", (_req, res) => {
  res.json(res.locals.user);
});

authRouter.get("/users", (_req, res) => {
  // mail_email = käyttäjän oman postilaatikon osoite, jos hän on yhdistänyt sellaisen.
  res.json(db.prepare(`
    SELECT u.id, u.name, u.email, u.role, m.email AS mail_email
    FROM users u LEFT JOIN gmail_accounts m ON m.id = 'user:' || u.id
    ORDER BY u.name
  `).all());
});

authRouter.post("/users", requireAdmin, (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1),
    email: z.email(),
    role: z.enum(USER_ROLES),
    password: z.string()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista nimi, sähköposti ja rooli." });

  const { name, email, role, password } = parsed.data;
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Salasanassa pitää olla vähintään ${MIN_PASSWORD_LENGTH} merkkiä.` });
  }

  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
    return res.status(409).json({ error: "Sähköposti on jo toisen käyttäjän käytössä." });
  }

  const userId = `user-${crypto.randomUUID()}`;
  db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)").run(
    userId, name, email, role, hashPassword(password), new Date().toISOString()
  );

  res.status(201).json({ id: userId, name, email, role });
});

authRouter.put("/users/:id", (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1),
    email: z.email(),
    role: z.enum(USER_ROLES).optional(),
    // Tyhjä = salasanaa ei vaihdeta.
    password: z.string().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista nimi ja sähköposti." });

  const user = db.prepare("SELECT id, role FROM users WHERE id = ?").get(req.params.id) as
    | { id: string; role: string }
    | undefined;
  if (!user) return res.status(404).json({ error: "Käyttäjää ei löytynyt." });

  // Omia tietojaan saa muokata jokainen; muiden tiedot ja roolit kuuluvat pääkäyttäjälle.
  const self = (res.locals.user as User).id === user.id;
  const roleChanges = parsed.data.role !== undefined && parsed.data.role !== user.role;
  if (!isAdmin(res) && (!self || roleChanges)) {
    return res.status(403).json({ error: "Tämä toiminto vaatii pääkäyttäjän oikeudet." });
  }
  if (roleChanges && user.role === ADMIN_ROLE) {
    const admins = (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = ?").get(ADMIN_ROLE) as { count: number }).count;
    if (admins <= 1) return res.status(400).json({ error: "Toimistolla pitää olla vähintään yksi pääkäyttäjä." });
  }

  const { name, email, password } = parsed.data;
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Salasanassa pitää olla vähintään ${MIN_PASSWORD_LENGTH} merkkiä.` });
  }

  const emailTaken = db.prepare("SELECT 1 FROM users WHERE email = ? AND id != ?").get(email, user.id);
  if (emailTaken) return res.status(409).json({ error: "Sähköposti on jo toisen käyttäjän käytössä." });

  db.prepare("UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?").run(
    name, email, parsed.data.role ?? user.role, user.id
  );

  if (password) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), user.id);
    // Salasanan vaihto kirjaa käyttäjän ulos muilta laitteilta; muutoksen tekijän oma istunto säilyy.
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(
      user.id, hashToken(res.locals.token)
    );
  }

  res.json(db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(user.id));
});

// Poistaa käyttäjän. Keskeneräiset tehtävät siirtyvät taloyhtiön vastuuisännöitsijälle tai, jos
// häntä ei ole, poistajalle, jotta ne eivät jää kenenkään Omien tehtävien ulkopuolelle.
authRouter.delete("/users/:id", requireAdmin, (req, res) => {
  const user = db.prepare("SELECT id, name, role FROM users WHERE id = ?").get(req.params.id) as
    | { id: string; name: string; role: string }
    | undefined;
  if (!user) return res.status(404).json({ error: "Käyttäjää ei löytynyt." });

  const actor = res.locals.user as User;
  if (user.id === actor.id) return res.status(400).json({ error: "Omaa tunnusta ei voi poistaa." });
  if (user.role === ADMIN_ROLE) {
    const admins = (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = ?").get(ADMIN_ROLE) as { count: number }).count;
    if (admins <= 1) return res.status(400).json({ error: "Toimistolla pitää olla vähintään yksi pääkäyttäjä." });
  }

  db.transaction(() => {
    db.prepare("UPDATE companies SET manager_id = NULL WHERE manager_id = ?").run(user.id);
    db.prepare("DELETE FROM company_managers WHERE user_id = ?").run(user.id);
    db.prepare(`
      UPDATE tickets
      SET assignee_id = COALESCE((SELECT manager_id FROM companies WHERE id = tickets.company_id), ?)
      WHERE assignee_id = ? AND status != 'closed'
    `).run(actor.id, user.id);
    db.prepare("UPDATE tickets SET assignee_id = NULL WHERE assignee_id = ?").run(user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM password_resets WHERE kind = 'user' AND subject_id = ?").run(user.id);
    db.prepare("DELETE FROM reminder_log WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM gmail_accounts WHERE id = ?").run(`user:${user.id}`);
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      `audit-${crypto.randomUUID()}`, null, actor.name, "user_deleted",
      JSON.stringify({ name: user.name, role: user.role }), new Date().toISOString()
    );
  })();

  res.json({ ok: true });
});
