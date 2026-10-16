import { db } from "./db.js";
import { sendEmail } from "./mail.js";
import { id, now, VALID_EMAIL } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Järjestelmähälytykset: palvelimen virheet, katkenneet postiyhteydet, epäonnistuneet varmuuskopiot ja
// AI-kulujen raja. Hälytys tallennetaan tietokantaan, josta pääkäyttäjä näkee sen asetuksista, ja
// lähetetään sähköpostina osoitteisiin ALERT_EMAIL (pilkuilla erotettu lista) tai, jos sitä ei ole
// asetettu, toimiston pääkäyttäjille. Saman hälytyksen sähköposti lähtee enintään kerran tunnissa;
// avoin hälytys päivittyy (määrä ja viimeisin aika) uuden rivin sijaan.
// ---------------------------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS system_alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  emailed_at TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS system_alerts_open ON system_alerts(kind, resolved_at);
`);

const EMAIL_INTERVAL_MS = 60 * 60 * 1000;
const DETAILS_MAX = 4000;

export type SystemAlert = {
  id: string; kind: string; title: string; details: string; count: number;
  created_at: string; last_at: string; emailed_at: string | null; resolved_at: string | null;
};

function alertRecipients(): string[] {
  const configured = (process.env.ALERT_EMAIL ?? "").split(",").map(email => email.trim()).filter(email => VALID_EMAIL.test(email));
  if (configured.length > 0) return configured;
  return (db.prepare("SELECT email FROM users WHERE role = 'Pääkäyttäjä'").all() as { email: string }[])
    .map(user => user.email.trim())
    .filter(email => VALID_EMAIL.test(email));
}

// Kirjaa hälytyksen ja lähettää siitä sähköpostin taustalla. kind yksilöi hälytyksen lajin
// (esim. "mail:office"), jotta toistuva virhe ei täytä listaa eikä postilaatikkoa.
export function raiseAlert(kind: string, title: string, details = ""): void {
  try {
    const timestamp = now();
    const trimmed = details.length > DETAILS_MAX ? `${details.slice(0, DETAILS_MAX)}…` : details;
    const open = db.prepare("SELECT * FROM system_alerts WHERE kind = ? AND resolved_at IS NULL").get(kind) as SystemAlert | undefined;
    let alertId: string;
    if (open) {
      alertId = open.id;
      db.prepare("UPDATE system_alerts SET title = ?, details = ?, count = count + 1, last_at = ? WHERE id = ?")
        .run(title, trimmed, timestamp, open.id);
      if (open.emailed_at && Date.now() - Date.parse(open.emailed_at) < EMAIL_INTERVAL_MS) return;
    } else {
      alertId = id("alert");
      db.prepare(`
        INSERT INTO system_alerts (id, kind, title, details, count, created_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(alertId, kind, title, trimmed, timestamp, timestamp);
    }
    void emailAlert(alertId);
  } catch (error) {
    // Hälytys ei saa kaataa toimintoa, jonka virheestä se kertoo.
    console.error("Hälytyksen kirjaus epäonnistui:", error);
  }
}

// Merkitsee lajin avoimen hälytyksen korjautuneeksi, esimerkiksi kun postiyhteys palaa.
export function resolveAlert(kind: string): void {
  db.prepare("UPDATE system_alerts SET resolved_at = ? WHERE kind = ? AND resolved_at IS NULL").run(now(), kind);
}

async function emailAlert(alertId: string) {
  const alert = db.prepare("SELECT * FROM system_alerts WHERE id = ?").get(alertId) as SystemAlert | undefined;
  const recipients = alertRecipients();
  if (!alert || recipients.length === 0) return;
  // Merkitään ennen lähetystä, jotta samaan aikaan tuleva toinen virhe ei lähetä toista viestiä.
  db.prepare("UPDATE system_alerts SET emailed_at = ? WHERE id = ?").run(now(), alertId);
  const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string };
  for (const to of recipients) {
    try {
      await sendEmail({
        to,
        notification: true,
        subject: `Pleissi-hälytys: ${alert.title}`,
        body: [
          `Pleississä (${office.name}) on havaittu ongelma:`,
          "",
          alert.title,
          ...(alert.details ? ["", alert.details] : []),
          "",
          ...(alert.count > 1 ? [`Toistunut ${alert.count} kertaa, ensimmäisen kerran ${new Date(alert.created_at).toLocaleString("fi-FI")}.`, ""] : []),
          `Hälytykset näkyvät myös Pleissin asetuksissa kohdassa Järjestelmän tila: ${process.env.APP_URL || "http://localhost:5173"}`
        ].join("\n")
      });
    } catch (error: any) {
      // Posti ei toimi: hälytys näkyy silti sovelluksessa.
      console.error("Hälytyssähköpostin lähetys epäonnistui:", error?.message ?? error);
    }
  }
}

export function listAlerts(limit = 50): SystemAlert[] {
  return db.prepare(`
    SELECT * FROM system_alerts ORDER BY resolved_at IS NOT NULL, last_at DESC LIMIT ?
  `).all(limit) as SystemAlert[];
}

export function markAlertResolved(alertId: string): boolean {
  return db.prepare("UPDATE system_alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL").run(now(), alertId).changes > 0;
}

// Postin tarkistus: yksittäinen katkos on tavallinen, joten hälytys lähtee vasta, kun tili on
// epäonnistunut yhtäjaksoisesti MAIL_ALERT_AFTER_MS ajan.
const MAIL_ALERT_AFTER_MS = 15 * 60 * 1000;
const mailFailingSince = new Map<string, number>();

export function trackMailPoll(accountId: string, label: string, error?: string): void {
  const kind = `mail:${accountId}`;
  if (!error) {
    mailFailingSince.delete(accountId);
    resolveAlert(kind);
    return;
  }
  const since = mailFailingSince.get(accountId) ?? Date.now();
  mailFailingSince.set(accountId, since);
  if (Date.now() - since >= MAIL_ALERT_AFTER_MS) {
    raiseAlert(kind, `Sähköpostin vastaanotto ei toimi (${label})`, `Postin tarkistus on epäonnistunut ${Math.round((Date.now() - since) / 60000)} minuutin ajan.\n\nVirhe: ${error}`);
  }
}
