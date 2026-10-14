import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./db.js";

// Sähköpostitilien salasanat ja tunnisteet salataan tietokantaan AES-256-GCM:llä. Avain on muuttujassa
// MAIL_SECRET_KEY (64 heksamerkkiä) tai syntyy ensimmäisellä käytöllä tiedostoon data-kansioon.
// Näin pelkkä tietokantatiedosto (esim. varmuuskopio) ei paljasta salasanoja.
const KEY_FILE = path.join(dataDir, "mail-secret.key");
let cachedKey: Buffer | null = null;

function secretKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = (process.env.MAIL_SECRET_KEY || "").trim();
  if (fromEnv) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv)) throw new Error("MAIL_SECRET_KEY pitää olla 64 heksamerkkiä.");
    cachedKey = Buffer.from(fromEnv, "hex");
    return cachedKey;
  }
  if (!fs.existsSync(KEY_FILE)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  }
  cachedKey = Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
  return cachedKey;
}

const PREFIX = "enc:v1:";

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const data = Buffer.from(stored.slice(PREFIX.length), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}
