import { db } from "./db.js";
import { TOPIC_RULES, type TopicKey } from "./incidents.js";

// ---------------------------------------------------------------------------------------------
// Trendihälytykset ilman AI:ta: aihe kasvaa selvästi, kun taloyhtiön viimeisen kolmen kuukauden ilmoituksia on
// vähintään kaksinkertainen määrä edelliseen kolmeen kuukauteen verrattuna (ja vähintään TREND_MIN_REPORTS).
// Hälytys näkyy Trendit-raportissa ja vastuuisännöitsijän viikkokoosteessa. trend_alerts muistaa, milloin
// hälytys havaittiin ensimmäisen kerran, jotta koosteessa voi erottaa uudet hälytykset.
// ---------------------------------------------------------------------------------------------

export const TREND_WINDOW_DAYS = 91;
export const TREND_FACTOR = 2;
export const TREND_MIN_REPORTS = 5;

db.exec(`
  CREATE TABLE IF NOT EXISTS trend_alerts (
    company_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    current INTEGER NOT NULL,
    previous INTEGER NOT NULL,
    PRIMARY KEY (company_id, topic)
  );
`);

export type TrendAlert = {
  companyId: string; companyName: string; topic: string; label: string;
  // Ilmoituksia viimeisen kolmen kuukauden aikana ja sitä edeltäneen kolmen kuukauden aikana.
  current: number; previous: number;
  firstSeenAt: string | null;
};

// Yhdistettyjä tehtäviä ja aiheettomia (muu) ei lasketa. Arkaluonteiset lasketaan määrinä (ei sisältöä).
export function topicTrendAlerts(companyIds: string[], at = Date.now()): TrendAlert[] {
  if (!companyIds.length) return [];
  const windowStart = new Date(at - TREND_WINDOW_DAYS * 86_400_000).toISOString();
  const previousStart = new Date(at - 2 * TREND_WINDOW_DAYS * 86_400_000).toISOString();
  const end = new Date(at).toISOString();
  const rows = db.prepare(`
    SELECT t.company_id, c.name AS company_name, t.topic,
           SUM(CASE WHEN t.created_at >= ? THEN 1 ELSE 0 END) AS current,
           SUM(CASE WHEN t.created_at < ? THEN 1 ELSE 0 END) AS previous
    FROM tickets t JOIN companies c ON c.id = t.company_id
    WHERE t.company_id IN (${companyIds.map(() => "?").join(", ")})
      AND t.kind = 'ticket' AND t.merged_into IS NULL AND t.topic IS NOT NULL AND t.topic != 'other'
      AND t.created_at >= ? AND t.created_at < ?
    GROUP BY t.company_id, t.topic
  `).all(windowStart, windowStart, ...companyIds, previousStart, end) as
    { company_id: string; company_name: string; topic: string; current: number; previous: number }[];
  const seen = db.prepare("SELECT first_seen_at FROM trend_alerts WHERE company_id = ? AND topic = ?");
  return rows
    .filter(row => row.current >= TREND_MIN_REPORTS && row.current >= TREND_FACTOR * row.previous)
    .map(row => ({
      companyId: row.company_id, companyName: row.company_name, topic: row.topic,
      label: TOPIC_RULES[row.topic as TopicKey]?.label ?? row.topic, current: row.current, previous: row.previous,
      firstSeenAt: (seen.get(row.company_id, row.topic) as { first_seen_at: string } | undefined)?.first_seen_at ?? null
    }))
    .sort((a, b) => b.current - a.current);
}

// Päivittää havaitut hälytykset (ajastettu); palauttaa hälytykset, jotka havaittiin nyt ensimmäistä kertaa.
export function refreshTrendAlerts(companyIds: string[], at = Date.now()): TrendAlert[] {
  const timestamp = new Date(at).toISOString();
  const alerts = topicTrendAlerts(companyIds, at);
  const upsert = db.prepare(`
    INSERT INTO trend_alerts (company_id, topic, first_seen_at, last_seen_at, current, previous) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (company_id, topic) DO UPDATE SET last_seen_at = excluded.last_seen_at, current = excluded.current, previous = excluded.previous
  `);
  const fresh: TrendAlert[] = [];
  db.transaction(() => {
    for (const alert of alerts) {
      if (!alert.firstSeenAt) fresh.push({ ...alert, firstSeenAt: timestamp });
      upsert.run(alert.companyId, alert.topic, timestamp, timestamp, alert.current, alert.previous);
    }
    // Hälytys, joka ei enää täyty, unohdetaan: jos aihe kasvaa myöhemmin uudelleen, se on taas uusi.
    const active = new Set(alerts.map(alert => `${alert.companyId}|${alert.topic}`));
    const stored = db.prepare(`SELECT company_id, topic FROM trend_alerts WHERE company_id IN (${companyIds.map(() => "?").join(", ") || "''"})`)
      .all(...companyIds) as { company_id: string; topic: string }[];
    for (const row of stored) {
      if (!active.has(`${row.company_id}|${row.topic}`)) db.prepare("DELETE FROM trend_alerts WHERE company_id = ? AND topic = ?").run(row.company_id, row.topic);
    }
  })();
  return fresh;
}
