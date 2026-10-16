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

function budgetSettings() {
  return db.prepare("SELECT ai_monthly_limit AS limitUsd, ai_warning_percent AS warningPercent FROM office_settings WHERE id = 1")
    .get() as { limitUsd: number; warningPercent: number };
}

function monthCost(month = currentMonth()): number {
  return (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM ai_usage WHERE month = ?").get(month) as { cost: number }).cost;
}

// true, kun kuukauden raja on täynnä ja AI-kutsuja ei enää tehdä.
export function aiBudgetExhausted(): boolean {
  const { limitUsd } = budgetSettings();
  return limitUsd > 0 && monthCost() >= limitUsd;
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
  return {
    month, costUsd: cost, limitUsd, warningPercent,
    exhausted: limitUsd > 0 && cost >= limitUsd,
    calls: byFeature.reduce((total, row) => total + row.calls, 0),
    byFeature, history
  };
}
