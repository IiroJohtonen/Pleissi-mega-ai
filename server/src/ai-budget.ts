import { createHash } from "node:crypto";
import { raiseAlert, resolveAlert } from "./alerts.js";
import { db } from "./db.js";
import { id, now } from "./util.js";

// ---------------------------------------------------------------------------------------------
// AI-kulujen seuranta ja kuukausiraja. Jokaisen Claude-kutsun käyttämät tokenit kirjataan, ja niistä
// lasketaan kustannusarvio Anthropicin hinnaston mukaan (dollareina, kuten Anthropic laskuttaa).
// Kun kuukauden kulut ylittävät pääkäyttäjän asettaman rajan, AI-kutsut lopetetaan kuun loppuun asti:
// vastausehdotukset tehdään silloin dokumentaatiohaulla ja saapuvat viestit käsitellään ilman AI:ta.
// Pääkäyttäjät saavat ilmoituksen, kun kulut ovat ylittäneet varoitusrajan ja kun raja täyttyy.
// ---------------------------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_usage_month ON ai_usage(month);

-- Lähetetyt kulurajan ilmoitukset: kukin taso (varoitus / raja) enintään kerran kuukaudessa.
CREATE TABLE IF NOT EXISTS ai_budget_notices (
  month TEXT NOT NULL,
  level TEXT NOT NULL,
  PRIMARY KEY(month, level)
);
`);

// Kuukausiraja dollareina (0 = ei rajaa) ja varoitusraja prosentteina rajasta.
const officeColumns = db.prepare("PRAGMA table_info(office_settings)").all() as { name: string }[];
if (!officeColumns.some(column => column.name === "ai_monthly_limit")) {
  db.exec("ALTER TABLE office_settings ADD COLUMN ai_monthly_limit REAL NOT NULL DEFAULT 50");
}
if (!officeColumns.some(column => column.name === "ai_warning_percent")) {
  db.exec("ALTER TABLE office_settings ADD COLUMN ai_warning_percent INTEGER NOT NULL DEFAULT 80");
}
// Päiväraja dollareina (0 = ei rajaa), toimintoryhmien osuudet kuukausirajasta (JSON, prosentteina, 0 = ei
// omaa rajaa), AI-agentin ajot tehtävää kohden vuorokaudessa ja saapuvan viestin AI-arvioinnit lähettäjää
// kohden tunnissa.
for (const [column, definition] of [
  ["ai_daily_limit", "REAL NOT NULL DEFAULT 10"],
  ["ai_feature_limits", `TEXT NOT NULL DEFAULT '{"agent":40,"assess":0,"suggest":0,"other":30}'`],
  ["ai_agent_runs_per_day", "INTEGER NOT NULL DEFAULT 5"],
  ["ai_assess_per_sender_hour", "INTEGER NOT NULL DEFAULT 10"]
] as const) {
  if (!officeColumns.some(existing => existing.name === column)) db.exec(`ALTER TABLE office_settings ADD COLUMN ${column} ${definition}`);
}
// Saapuvan viestin AI-arviointien laskuri lähettäjittäin (lähettäjä tiivisteenä, ei osoitteena).
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_sender_calls (sender_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS ai_sender_calls_sender ON ai_sender_calls (sender_hash, created_at);
`);

// Hinnat dollareina miljoonaa tokenia kohden: syöte, tuloste. Välimuistista luettu syöte maksaa
// kymmenesosan ja välimuistiin kirjoitettu 1,25-kertaisesti syötteen hinnan.
const PRICES: [prefix: string, input: number, output: number][] = [
  ["claude-fable", 10, 50],
  ["claude-mythos", 10, 50],
  ["claude-opus-5-5", 4, 20],
  ["claude-opus", 5, 25],
  ["claude-sonnet-4", 3, 15],
  ["claude-sonnet", 2, 10],
  ["claude-haiku-5", 0.1, 0.5],
  ["claude-haiku", 1, 5]
];

export type AiUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export function estimateCost(model: string, usage: AiUsage): number {
  // Tuntemattomalle mallille käytetään kalleinta hintaa, jotta raja ei koskaan jää arvioimatta alakanttiin.
  const [, input, output] = PRICES.find(([prefix]) => model.startsWith(prefix)) ?? PRICES[0];
  return (
    (usage.input_tokens ?? 0) * input
    + (usage.cache_read_input_tokens ?? 0) * input * 0.1
    + (usage.cache_creation_input_tokens ?? 0) * input * 1.25
    + (usage.output_tokens ?? 0) * output
  ) / 1_000_000;
}

const currentMonth = () => new Date().toISOString().slice(0, 7);
const startOfDay = () => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
};

// Toimintoryhmät, joille voi antaa oman osuuden kuukausirajasta. Agentti ei voi käyttää arvioinnin ja
// vastausehdotusten osuutta, kun sen ja muiden ryhmien osuudet jättävät niille tilaa.
export const AI_FEATURE_GROUPS = ["agent", "assess", "suggest", "other"] as const;
export type AiFeatureGroup = (typeof AI_FEATURE_GROUPS)[number];
export function featureGroup(feature: string): AiFeatureGroup {
  if (feature === "agent") return "agent";
  if (feature === "assess") return "assess";
  if (feature === "suggest" || feature === "draft_change") return "suggest";
  return "other";
}
const GROUP_FEATURES = (group: AiFeatureGroup) =>
  group === "agent" ? ["agent"] : group === "assess" ? ["assess"] : group === "suggest" ? ["suggest", "draft_change"] : null;

export type AiLimits = {
  monthlyLimit: number; warningPercent: number; dailyLimit: number;
  featureLimits: Record<AiFeatureGroup, number>; agentRunsPerDay: number; assessPerSenderHour: number;
};

export function aiLimits(): AiLimits {
  const row = db.prepare(`
    SELECT ai_monthly_limit AS monthlyLimit, ai_warning_percent AS warningPercent, ai_daily_limit AS dailyLimit,
           ai_feature_limits AS featureLimits, ai_agent_runs_per_day AS agentRunsPerDay, ai_assess_per_sender_hour AS assessPerSenderHour
    FROM office_settings WHERE id = 1
  `).get() as Omit<AiLimits, "featureLimits"> & { featureLimits: string };
  let featureLimits: Partial<Record<AiFeatureGroup, number>> = {};
  try {
    featureLimits = JSON.parse(row.featureLimits);
  } catch {
    // Virheellinen arvo: ei ryhmäkohtaisia rajoja.
  }
  return {
    ...row,
    featureLimits: Object.fromEntries(AI_FEATURE_GROUPS.map(group => [group, Number(featureLimits[group]) || 0])) as Record<AiFeatureGroup, number>
  };
}

export function saveAiLimits(limits: Partial<Omit<AiLimits, "monthlyLimit" | "warningPercent">>) {
  if (limits.dailyLimit !== undefined) db.prepare("UPDATE office_settings SET ai_daily_limit = ? WHERE id = 1").run(Math.round(limits.dailyLimit * 100) / 100);
  if (limits.featureLimits) db.prepare("UPDATE office_settings SET ai_feature_limits = ? WHERE id = 1").run(JSON.stringify(limits.featureLimits));
  if (limits.agentRunsPerDay !== undefined) db.prepare("UPDATE office_settings SET ai_agent_runs_per_day = ? WHERE id = 1").run(limits.agentRunsPerDay);
  if (limits.assessPerSenderHour !== undefined) db.prepare("UPDATE office_settings SET ai_assess_per_sender_hour = ? WHERE id = 1").run(limits.assessPerSenderHour);
}

function costSince(since: string, features: string[] | null = null): number {
  return (db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM ai_usage WHERE created_at >= ?
    ${features ? `AND feature IN (${features.map(() => "?").join(", ")})` : ""}
  `).get(since, ...(features ?? [])) as { cost: number }).cost;
}

function groupMonthCost(group: AiFeatureGroup, month = currentMonth()): number {
  const features = GROUP_FEATURES(group);
  const other = ["agent", "assess", "suggest", "draft_change"];
  return (db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM ai_usage WHERE month = ?
      AND feature ${features ? "IN" : "NOT IN"} (${(features ?? other).map(() => "?").join(", ")})
  `).get(month, ...(features ?? other)) as { cost: number }).cost;
}

// Syy, miksi AI-kutsua ei tehdä (kuukausiraja, päiväraja tai toimintoryhmän osuus), tai null.
export function aiBudgetBlocked(feature?: string): "month" | "day" | "feature" | null {
  const limits = aiLimits();
  if (limits.monthlyLimit > 0 && monthCost() >= limits.monthlyLimit) return "month";
  if (limits.dailyLimit > 0 && costSince(startOfDay()) >= limits.dailyLimit) return "day";
  if (feature && limits.monthlyLimit > 0) {
    const group = featureGroup(feature);
    const share = limits.featureLimits[group];
    if (share > 0 && groupMonthCost(group) >= limits.monthlyLimit * share / 100) return "feature";
  }
  return null;
}

export const BUDGET_REASONS: Record<"month" | "day" | "feature", string> = {
  month: "AI-kulujen kuukausiraja on täynnä.",
  day: "AI-kulujen päiväraja on täynnä.",
  feature: "Tämän toiminnon osuus AI-kulujen kuukausirajasta on käytetty."
};

// Saapuvan viestin AI-arvioinnit lähettäjää kohden tunnissa. Palauttaa true ja kirjaa kutsun, jos raja ei
// ole täynnä; muuten viesti arvioidaan avainsanoilla.
export function allowAssessFor(sender: string, at = Date.now()): boolean {
  const limit = aiLimits().assessPerSenderHour;
  const normalized = sender.trim().toLowerCase();
  if (limit <= 0 || !normalized) return true;
  const hash = createHash("sha256").update(normalized).digest("hex");
  const since = new Date(at - 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM ai_sender_calls WHERE created_at < ?").run(since);
  const count = (db.prepare("SELECT COUNT(*) AS count FROM ai_sender_calls WHERE sender_hash = ? AND created_at >= ?").get(hash, since) as { count: number }).count;
  if (count >= limit) return false;
  db.prepare("INSERT INTO ai_sender_calls (sender_hash, created_at) VALUES (?, ?)").run(hash, new Date(at).toISOString());
  return true;
}

// AI-agentin ajot tehtävällä viimeisen vuorokauden aikana (lokin AI-pyynnöistä).
export function agentRunsToday(ticketId: string): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE ticket_id = ? AND action = 'ai_request' AND details LIKE '%"feature":"agent"%' AND created_at >= ?
  `).get(ticketId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()) as { count: number }).count;
}

function budgetSettings() {
  return db.prepare("SELECT ai_monthly_limit AS limitUsd, ai_warning_percent AS warningPercent FROM office_settings WHERE id = 1")
    .get() as { limitUsd: number; warningPercent: number };
}

function monthCost(month = currentMonth()): number {
  return (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM ai_usage WHERE month = ?").get(month) as { cost: number }).cost;
}

// true, kun kuukauden tai päivän raja on täynnä ja AI-kutsuja ei enää tehdä.
export function aiBudgetExhausted(): boolean {
  const blocked = aiBudgetBlocked();
  return blocked === "month" || blocked === "day";
}

// Kirjaa yhden kutsun käytön. feature = mihin AI:ta käytettiin (suggest, topics, assess).
export function recordAiUsage(feature: string, model: string, usage: AiUsage | null | undefined): void {
  if (!usage) return;
  const month = currentMonth();
  db.prepare(`
    INSERT INTO ai_usage (id, month, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id("ai"), month, feature, model, usage.input_tokens ?? 0, usage.output_tokens ?? 0,
    usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0, estimateCost(model, usage), now()
  );
  checkBudget(month);
}

const usd = (value: number) => `${value.toFixed(2).replace(".", ",")} $`;

function checkBudget(month: string) {
  const { limitUsd, warningPercent } = budgetSettings();
  if (limitUsd <= 0) return;
  const cost = monthCost(month);
  const notice = (level: string) => db.prepare("INSERT OR IGNORE INTO ai_budget_notices (month, level) VALUES (?, ?)").run(month, level).changes > 0;

  if (cost >= limitUsd) {
    if (notice("limit")) {
      raiseAlert(
        "ai-budget-limit",
        "AI-kulujen kuukausiraja on täynnä",
        `Tämän kuun AI-kulut ovat noin ${usd(cost)}, ja raja on ${usd(limitUsd)}. AI on pois käytöstä kuun loppuun asti: `
          + "vastausehdotukset tehdään dokumentaatiohaulla ja saapuvat viestit käsitellään ilman AI:ta. "
          + "Voit nostaa rajaa Pleissin asetuksista."
      );
    }
  } else if (warningPercent > 0 && cost >= limitUsd * warningPercent / 100) {
    if (notice("warning")) {
      raiseAlert(
        "ai-budget-warning",
        `AI-kulut ovat ${Math.floor((cost / limitUsd) * 100)} % kuukausirajasta`,
        `Tämän kuun AI-kulut ovat noin ${usd(cost)}, ja raja on ${usd(limitUsd)}. Kun raja täyttyy, AI on pois käytöstä kuun loppuun asti.`
      );
    }
  }
}

// Kun rajaa nostetaan tai kuukausi vaihtuu, vanhat kulurajan hälytykset eivät ole enää ajankohtaisia.
export function refreshBudgetAlerts(): void {
  const { limitUsd, warningPercent } = budgetSettings();
  const cost = monthCost();
  if (limitUsd <= 0 || cost < limitUsd) resolveAlert("ai-budget-limit");
  if (limitUsd <= 0 || cost < limitUsd * warningPercent / 100) resolveAlert("ai-budget-warning");
}

export function aiUsageSummary() {
  const month = currentMonth();
  const { limitUsd, warningPercent } = budgetSettings();
  const cost = monthCost(month);
  const byFeature = db.prepare(`
    SELECT feature, COUNT(*) AS calls, SUM(cost_usd) AS cost FROM ai_usage WHERE month = ? GROUP BY feature ORDER BY cost DESC
  `).all(month) as { feature: string; calls: number; cost: number }[];
  const history = db.prepare(`
    SELECT month, COUNT(*) AS calls, SUM(cost_usd) AS cost FROM ai_usage GROUP BY month ORDER BY month DESC LIMIT 6
  `).all() as { month: string; calls: number; cost: number }[];
  const limits = aiLimits();
  return {
    month, costUsd: cost, limitUsd, warningPercent,
    exhausted: limitUsd > 0 && cost >= limitUsd,
    today: { costUsd: costSince(startOfDay()), limitUsd: limits.dailyLimit },
    groups: AI_FEATURE_GROUPS.map(group => ({
      group, costUsd: groupMonthCost(group, month), percent: limits.featureLimits[group],
      limitUsd: limits.featureLimits[group] > 0 && limitUsd > 0 ? limitUsd * limits.featureLimits[group] / 100 : null
    })),
    calls: byFeature.reduce((total, row) => total + row.calls, 0),
    byFeature, history
  };
}
