import { draftTopicStats, type DraftTopicStats } from "./ai-draft-edits.js";
import { db } from "./db.js";
import { aiAgentEnabled } from "./routes/office.js";
import { id, now } from "./util.js";

// ---------------------------------------------------------------------------------------------
// AI-reseptionistin asetukset:
// - automaattinen käynnistys uusiin tehtäviin: toimiston oletus ja taloyhtiökohtainen ohitus
// - autonomia taloyhtiöittäin ja aiheittain: oletuksena agentti tekee luonnoksen, jonka ihminen hyväksyy. Aihe
//   vastataan itse vasta, kun taloyhtiön luonnosmittarin raja (99 % / 100 luonnosta, ai-draft-edits.ts) täyttyy JA
//   pääkäyttäjä on hyväksynyt aiheen taloyhtiölle.
//   Raja tarkistetaan jokaisella ajolla: jos osuus putoaa rajan alle, aihe palaa luonnostilaan.
// ---------------------------------------------------------------------------------------------

export const DEFAULT_AGENT_NAME = "Aino-AI";

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_autonomy (
    company_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    PRIMARY KEY (company_id, topic)
  );
`);
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

export type TopicAutonomy = DraftTopicStats & { approved: boolean; approvedBy: string | null; approvedAt: string | null; autonomous: boolean };

// Taloyhtiön aiheiden luonnosmittari ja pääkäyttäjän hyväksynnät.
export function topicAutonomy(companyId: string): TopicAutonomy[] {
  const approvals = new Map((db.prepare("SELECT topic, approved_by, approved_at FROM agent_autonomy WHERE company_id = ?").all(companyId) as
    { topic: string; approved_by: string; approved_at: string }[]).map(row => [row.topic, row]));
  const stats = draftTopicStats([companyId]);
  for (const topic of approvals.keys()) {
    if (!stats.some(item => item.topic === topic)) {
      stats.push({ topic, drafts: 0, unchanged: 0, light: 0, heavy: 0, rewritten: 0, tone: 0, fact: 0, unclassified: 0,
        readyShare: null, ready: false, agentRuns: 0, handovers: 0, handoverShare: null });
    }
  }
  return stats.map(item => {
    const approval = approvals.get(item.topic);
    return {
      ...item, approved: Boolean(approval), approvedBy: approval?.approved_by ?? null, approvedAt: approval?.approved_at ?? null,
      autonomous: Boolean(approval) && item.ready
    };
  });
}

// Vastaako agentti taloyhtiön aiheeseen itse (muuten luonnos). Aiheeton tehtävä ei ole koskaan itsenäinen.
export function topicAutonomous(companyId: string, topic: string | null): boolean {
  if (!topic) return false;
  if (!db.prepare("SELECT 1 FROM agent_autonomy WHERE company_id = ? AND topic = ?").get(companyId, topic)) return false;
  return draftTopicStats([companyId]).some(item => item.topic === topic && item.ready);
}

export class AutonomyError extends Error {}

// Pääkäyttäjä hyväksyy aiheen itsenäiseksi (vain kun raja täyttyy) tai palauttaa sen luonnostilaan.
export function setTopicAutonomy(companyId: string, topic: string, autonomous: boolean, actor: string) {
  if (autonomous) {
    const stats = draftTopicStats([companyId]).find(item => item.topic === topic);
    if (!stats?.ready) throw new AutonomyError("Aihetta ei voi hyväksyä: taloyhtiön vähintään 100 luonnoksesta 99 % pitää lähteä sellaisenaan tai pelkällä sävymuokkauksella.");
    db.prepare("INSERT OR REPLACE INTO agent_autonomy (company_id, topic, approved_by, approved_at) VALUES (?, ?, ?, ?)").run(companyId, topic, actor, now());
  } else {
    db.prepare("DELETE FROM agent_autonomy WHERE company_id = ? AND topic = ?").run(companyId, topic);
  }
  const company = (db.prepare("SELECT name FROM companies WHERE id = ?").get(companyId) as { name: string } | undefined)?.name ?? companyId;
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), null, actor, autonomous ? "agent_topic_autonomous" : "agent_topic_draft", JSON.stringify({ topic, company }), now()
  );
}
