import { db } from "./db.js";
import { aiAgentEnabled } from "./routes/office.js";

// ---------------------------------------------------------------------------------------------
// AI-reseptionistin asetukset:
// - automaattinen käynnistys uusiin tehtäviin: toimiston oletus ja taloyhtiökohtainen ohitus
// - agentti hoitaa tehtävän itse (vastaa asukkaalle ja tekee varaukset) ilman aihekohtaista hyväksyntää; aiheet, joista ei
//   ole dokumentaatiota, se ohjaa vastuuisännöitsijälle (ai-agent.ts)
// - agentin nimi ja allekirjoitus
// ---------------------------------------------------------------------------------------------

export const DEFAULT_AGENT_NAME = "Aino-AI";

// Aihekohtaisia hyväksyntöjä ei enää käytetä: agentti hoitaa tehtävät ilman niitä.
db.exec("DROP TABLE IF EXISTS agent_autonomy");
{
  const office = (db.prepare("PRAGMA table_info(office_settings)").all() as { name: string }[]).map(column => column.name);
  if (!office.includes("ai_agent_auto")) db.exec("ALTER TABLE office_settings ADD COLUMN ai_agent_auto INTEGER NOT NULL DEFAULT 0");
  // AI-agentin nimi allekirjoituksessa (asukas näkee, että vastauksen kirjoitti tekoäly).
  if (!office.includes("agent_name")) db.exec(`ALTER TABLE office_settings ADD COLUMN agent_name TEXT NOT NULL DEFAULT '${DEFAULT_AGENT_NAME}'`);
  const companies = (db.prepare("PRAGMA table_info(companies)").all() as { name: string }[]).map(column => column.name);
  // null = toimiston oletus, 1 = päällä, 0 = pois.
  if (!companies.includes("ai_agent_auto")) db.exec("ALTER TABLE companies ADD COLUMN ai_agent_auto INTEGER");
  const tickets = (db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[]).map(column => column.name);
  // details_requested = agentti pyysi asukkaalta lisätietoja; asukkaan vastaus siirtää tehtävän henkilökunnalle.
  if (!tickets.includes("agent_state")) db.exec("ALTER TABLE tickets ADD COLUMN agent_state TEXT");
  // 1 = AI-agentilla on vastuu tehtävän käsittelystä (agentti vastasi tai teki luonnoksen eikä siirtänyt tehtävää).
  // Palautuu 0:ksi, kun agentti siirtää tehtävän henkilökunnalle tai käsittelijä kirjoittaa vastauksen itse.
  if (!tickets.includes("agent_owned")) db.exec("ALTER TABLE tickets ADD COLUMN agent_owned INTEGER NOT NULL DEFAULT 0");
}

export function agentName(): string {
  const row = db.prepare("SELECT agent_name FROM office_settings WHERE id = 1").get() as { agent_name: string } | undefined;
  return row?.agent_name?.trim() || DEFAULT_AGENT_NAME;
}

export function setAgentName(name: string) {
  db.prepare("UPDATE office_settings SET agent_name = ? WHERE id = 1").run(name.trim() || DEFAULT_AGENT_NAME);
}

// Allekirjoitus AI-agentin vastauksiin: asukas näkee aina, että vastauksen kirjoitti tekoäly. Kun käsittelijä lähettää
// agentin luonnoksen, allekirjoituksessa kerrotaan myös, kuka vastauksen tarkisti.
// Allekirjoituksen nimirivit ("Ystävällisin terveisin / Aino-AI, tekoälyavustaja / toimisto").
export function agentSignatureLines(): string {
  const office = (db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string } | undefined)?.name ?? "";
  return ["Ystävällisin terveisin", `${agentName()}, tekoälyavustaja`, ...(office ? [office] : [])].join("\n");
}

// Huomautus allekirjoituksen alle: sähköpostissa pienellä harmaalla (alaviite), portaalissa ja aikajanalla hillitysti.
export const AI_NOTE_PREFIX = "Tämän vastauksen kirjoitti tekoäly";
export function aiNote(reviewer?: string): string {
  return reviewer
    ? `${AI_NOTE_PREFIX}, ja sen tarkisti ${reviewer}. Jos asiasi ei ratkennut, vastaa tähän viestiin, niin henkilökunta jatkaa asian käsittelyä.`
    : `${AI_NOTE_PREFIX}. Jos asiasi ei ratkennut, vastaa tähän viestiin, niin henkilökunta jatkaa asian käsittelyä.`;
}

// Koko allekirjoitus tekstinä (nimirivit ja huomautus), esim. asetusten esikatseluun.
export function agentSignature(reviewer?: string): string {
  return `${agentSignatureLines()}\n\n${aiNote(reviewer)}`;
}

export function agentAutoDefault(): boolean {
  const row = db.prepare("SELECT ai_agent_auto FROM office_settings WHERE id = 1").get() as { ai_agent_auto: number } | undefined;
  return Boolean(row?.ai_agent_auto);
}

export function setAgentAutoDefault(value: boolean) {
  db.prepare("UPDATE office_settings SET ai_agent_auto = ? WHERE id = 1").run(value ? 1 : 0);
}

// Käynnistyykö agentti taloyhtiön uusiin tehtäviin: agentti päällä → taloyhtiön ohitus → toimiston oletus (pois).
export function agentAutoStartEnabled(companyId: string): boolean {
  if (!aiAgentEnabled()) return false;
  const row = db.prepare("SELECT ai_agent_auto FROM companies WHERE id = ?").get(companyId) as { ai_agent_auto: number | null } | undefined;
  if (row?.ai_agent_auto === 0 || row?.ai_agent_auto === 1) return row.ai_agent_auto === 1;
  return agentAutoDefault();
}

export function setAgentAutoOverride(companyId: string, value: boolean | null) {
  db.prepare("UPDATE companies SET ai_agent_auto = ? WHERE id = ?").run(value === null ? null : value ? 1 : 0, companyId);
}

export function agentAutoCompanies() {
  return (db.prepare("SELECT id, name, ai_agent_auto FROM companies ORDER BY name COLLATE NOCASE").all() as
    { id: string; name: string; ai_agent_auto: number | null }[])
    .map(row => ({ id: row.id, name: row.name, autoStart: row.ai_agent_auto === null ? null : row.ai_agent_auto === 1 }));
}
