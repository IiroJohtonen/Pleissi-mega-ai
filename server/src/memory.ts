import { AUTHORIZED_COMPANY_IDS } from "./access.js";
import { aiAvailable, proposeMemories } from "./ai.js";
import { aiBudgetExhausted } from "./ai-budget.js";
import { withAiLog } from "./ai-log.js";
import { db } from "./db.js";
import { ADJUSTABLE_TOPICS, isTopic, TOPIC_RULES } from "./incidents.js";
import { sendEmail } from "./mail.js";
import { id, now, stairwellOf, today } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Taloyhtiön muisti: ratkaistuista tehtävistä opitut pysyvät tiedot (toistuvat viat ja niiden syyt,
// korjaukset, laitteiden tiedot). AI ehdottaa, isännöitsijä hyväksyy, ja vain hyväksytyt tiedot
// annetaan AI:lle vastausehdotuksessa, agentissa ja yhteisen vian tulkinnassa. Asukkaista ei tallenneta
// mitään: tiedot koskevat rakennusta.
// ---------------------------------------------------------------------------------------------

export type MemoryNote = {
  id: string; company_id: string; topic: string | null; stairwell: string; text: string; sources: string; status: string;
  valid_until: string | null; origin: string; created_at: string; decided_by: string | null; decided_at: string | null; updated_at: string;
  // memory = rakennustieto, documentation = asukasohje (doc_title + text), none = kertaluonteinen päätös.
  target: "memory" | "documentation" | "none"; doc_title: string | null; gap: number; knowledge_id: string | null;
};

// Ensimmäinen haku käy läpi puolen vuoden ratkaisut; myöhemmät vain edellisen haun jälkeiset.
const FIRST_SCAN_DAYS = 180;
const MAX_CASES = 60;

// Hyväksytyt, voimassa olevat tiedot AI:lle. Ensin tehtävän aihetta ja porrasta koskevat, sitten yleiset.
export function memoryForAi(companyId: string, context: { topic?: string | null; stairwell?: string } = {}, limit = 8): string[] {
  const rows = db.prepare(`
    SELECT topic, stairwell, text FROM company_memory
    WHERE company_id = ? AND status = 'approved' AND target = 'memory' AND (valid_until IS NULL OR valid_until >= ?)
    ORDER BY updated_at DESC
  `).all(companyId, today()) as { topic: string | null; stairwell: string; text: string }[];
  // Toista aihetta tai toista porrasta koskeva tieto jätetään pois; tarkimmin osuvat ensin.
  const matches = (row: { topic: string | null; stairwell: string }) =>
    (!row.topic || !context.topic || row.topic === context.topic) && (!row.stairwell || !context.stairwell || row.stairwell === context.stairwell);
  const score = (row: { topic: string | null; stairwell: string }) =>
    (context.topic && row.topic === context.topic ? 2 : 0) + (context.stairwell && row.stairwell === context.stairwell ? 1 : 0);
  return rows
    .filter(matches)
    .map(row => ({ row, score: score(row) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row }) => `${row.stairwell ? `(${row.stairwell}-porras) ` : ""}${row.text}`);
}

export function memoryAutoEnabled(): boolean {
  const row = db.prepare("SELECT memory_auto FROM office_settings WHERE id = 1").get() as { memory_auto: number } | undefined;
  return Boolean(row?.memory_auto);
}

export class MemoryUnavailableError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Hakee AI:lta muistiehdotukset taloyhtiön uusista ratkaisuista. Jos uusia ratkaistuja tehtäviä ei ole,
// AI:ta ei kutsuta. Palauttaa lisättyjen ehdotusten määrän.
export async function proposeCompanyMemory(companyId: string): Promise<{ proposed: number; cases: number }> {
  if (!aiAvailable() || aiBudgetExhausted()) throw new MemoryUnavailableError("AI ei ole juuri nyt käytettävissä.", 503);
  const company = db.prepare("SELECT name, memory_scanned_at FROM companies WHERE id = ?").get(companyId) as
    { name: string; memory_scanned_at: string | null } | undefined;
  if (!company) throw new MemoryUnavailableError("Taloyhtiötä ei löytynyt.", 404);
  const since = company.memory_scanned_at ?? new Date(Date.now() - FIRST_SCAN_DAYS * 86_400_000).toISOString();
  const startedAt = now();

  // Ratkaistut tehtävät: käsittelijän kirjaama ratkaisu. Arkaluonteisia ei lähetetä AI:lle.
  const tickets = db.prepare(`
    SELECT t.id, t.subject, t.summary, t.topic, t.created_at, t.resolution, a.apartment_number, a.staircase
    FROM tickets t LEFT JOIN apartments a ON a.id = t.apartment_id
    WHERE t.company_id = ? AND t.resolution IS NOT NULL AND t.sensitive = 0 AND t.resolution_at >= ?
    ORDER BY t.resolution_at DESC LIMIT ?
  `).all(companyId, since, MAX_CASES) as { id: string; subject: string; summary: string; topic: string | null; created_at: string;
    resolution: string; apartment_number: string | null; staircase: string | null }[];
  const incidents = db.prepare(`
    SELECT id, topic, stairwell, first_report_at, resolution,
           (SELECT COUNT(*) FROM incident_tickets it WHERE it.incident_id = incidents.id) AS reports
    FROM incidents WHERE company_id = ? AND resolution IS NOT NULL AND handled_at >= ?
  `).all(companyId, since) as { id: string; topic: string; stairwell: string; first_report_at: string; resolution: string; reports: number }[];

  // Osaamisaukot: kysymykset, joihin AI ei osannut vastata ja joihin toimisto on sen jälkeen vastannut
  // asukkaalle. Ne käsitellään ensin, ja niistä syntyneet ehdotukset nousevat listassa kärkeen.
  const gaps = db.prepare(`
    SELECT g.id, g.ticket_id, g.topic, g.question,
           (SELECT m.body FROM messages m WHERE m.ticket_id = g.ticket_id AND m.direction = 'outbound'
              AND COALESCE(m.channel, '') != 'contractor' AND m.sender != 'Pleissi AI-agentti' AND m.created_at > g.created_at
            ORDER BY m.created_at LIMIT 1) AS answer
    FROM knowledge_gaps g JOIN tickets t ON t.id = g.ticket_id
    WHERE g.company_id = ? AND g.proposed_at IS NULL AND t.sensitive = 0
    ORDER BY g.created_at LIMIT 20
  `).all(companyId) as { id: string; ticket_id: string; topic: string | null; question: string; answer: string | null }[];
  const answeredGaps = gaps.filter(gap => gap.answer);

  const cases = [
    ...answeredGaps.map(gap => ({
      sources: [gap.ticket_id],
      gap: true,
      text: `[KNOWLEDGE GAP] topic ${gap.topic ?? "other"}. Question the AI could not answer: ${gap.question}. ` +
        `The office answered: ${gap.answer!.replace(/\s+/g, " ").slice(0, 800)}`
    })),
    ...incidents.map(row => ({
      sources: [] as string[],
      text: `Shared fault (${row.reports} apartments), topic ${row.topic}, ${row.stairwell ? `staircase ${row.stairwell}` : "whole company"}, ` +
        `${row.first_report_at.slice(0, 10)}. Resolution: ${row.resolution}`
    })),
    ...tickets.filter(row => !answeredGaps.some(gap => gap.ticket_id === row.id)).map(row => ({
      sources: [row.id],
      text: `${row.created_at.slice(0, 10)}, topic ${row.topic ?? "other"}, staircase ${stairwellOf(row.apartment_number, row.staircase) || "?"}, ` +
        `apartment ${row.apartment_number ?? "?"}: ${row.subject} – ${row.summary.slice(0, 300)}. Resolution: ${row.resolution}`
    }))
  ];
  if (!cases.length) {
    db.prepare("UPDATE companies SET memory_scanned_at = ? WHERE id = ?").run(startedAt, companyId);
    return { proposed: 0, cases: 0 };
  }

  const existing = (db.prepare(`
    SELECT text FROM company_memory WHERE company_id = ? AND status IN ('approved', 'proposed') ORDER BY updated_at DESC LIMIT 60
  `).all(companyId) as { text: string }[]).map(row => row.text);

  const { result: notes } = await withAiLog(undefined, () => proposeMemories({
    company: company.name,
    topics: ADJUSTABLE_TOPICS.map(key => ({ key, label: TOPIC_RULES[key].label })),
    cases: cases.map((item, index) => `${index + 1}. ${item.text}`),
    existing
  }));

  const insert = db.prepare(`
    INSERT INTO company_memory (id, company_id, topic, stairwell, text, sources, status, valid_until, origin, created_at, updated_at, target, doc_title, gap)
    VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, 'ai', ?, ?, ?, ?, ?)
  `);
  let proposed = 0;
  for (const note of notes) {
    const text = note.text.trim();
    if (!text || existing.includes(text)) continue;
    const caseNumbers = note.sources.filter(number => Number.isInteger(number) && number >= 1 && number <= cases.length);
    const sources = [...new Set(caseNumbers.flatMap(number => cases[number - 1].sources))];
    const fromGap = caseNumbers.some(number => "gap" in cases[number - 1]);
    const validUntil = note.validMonths && note.validMonths > 0
      ? (() => { const date = new Date(); date.setMonth(date.getMonth() + Math.min(Math.round(note.validMonths), 60)); return date.toLocaleDateString("sv-SE"); })()
      : null;
    insert.run(id("memory"), companyId, note.topic && isTopic(note.topic) ? note.topic : null,
      /^[A-ZÅÄÖ]{1,3}$/.test(note.stairwell.trim().toUpperCase()) ? note.stairwell.trim().toUpperCase() : "",
      text.slice(0, note.target === "documentation" ? 1500 : 500), JSON.stringify(sources), validUntil, now(), now(),
      note.target, note.target === "documentation" ? note.title.trim().slice(0, 120) || "Ohje" : null, fromGap ? 1 : 0);
    proposed++;
  }
  const markGap = db.prepare("UPDATE knowledge_gaps SET proposed_at = ? WHERE id = ?");
  for (const gap of answeredGaps) markGap.run(now(), gap.id);
  db.prepare("UPDATE companies SET memory_scanned_at = ? WHERE id = ?").run(startedAt, companyId);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), null, "ai", "memory_proposed", JSON.stringify({ company: companyId, cases: cases.length, proposed }), now()
  );
  return { proposed, cases: cases.length };
}

// --- Viikkoajo ---------------------------------------------------------------------------------
// Yksi viikoittainen ajo, kun toimisto on kytkenyt muistiehdotukset päälle: luokitellut ehdotukset viikon
// ratkaistuista tehtävistä ja osaamisaukoista, toistuvien aiheiden raportti (AI-kutsu vain, jos uusia
// tehtäviä on) ja viikkokooste vastuuisännöitsijöille sähköpostilla.

export function isoWeek(at = Date.now()) {
  const date = new Date(at);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function weeklyMemoryProposals(at = Date.now()) {
  if (!memoryAutoEnabled()) return;
  const weekAgo = new Date(at - 7 * 86_400_000).toISOString();
  if (aiAvailable()) {
    for (const companyId of AUTHORIZED_COMPANY_IDS) {
      const company = db.prepare("SELECT memory_scanned_at FROM companies WHERE id = ?").get(companyId) as { memory_scanned_at: string | null } | undefined;
      if (!company) continue;
      if (!company.memory_scanned_at || company.memory_scanned_at <= weekAgo) {
        try {
          await proposeCompanyMemory(companyId);
        } catch (error: any) {
          console.error("Muistiehdotusten haku epäonnistui:", companyId, error?.message ?? error);
        }
      }
      await weeklyTopicReport(companyId, weekAgo);
    }
  }
  await sendWeeklyDigests(at);
}

// Viikon toistuvien aiheiden raportti, jos edellisestä on viikko ja uusia tehtäviä on tullut.
async function weeklyTopicReport(companyId: string, weekAgo: string) {
  const last = db.prepare("SELECT generated_at FROM topic_reports WHERE company_id = ? AND period = 'week'").get(companyId) as { generated_at: string } | undefined;
  if (last && last.generated_at > weekAgo) return;
  const since = last?.generated_at && last.generated_at > weekAgo ? last.generated_at : weekAgo;
  const fresh = (db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE company_id = ? AND created_at >= ? AND sensitive = 0 AND company_pending = 0")
    .get(companyId, since) as { count: number }).count;
  if (!fresh) return;
  try {
    const { generateTopicReport } = await import("./routes/reports.js");
    await withAiLog(undefined, () => generateTopicReport(companyId, "week", weekAgo, "Viikkoajo"));
  } catch (error: any) {
    console.error("Viikon toistuvien aiheiden raportti epäonnistui:", companyId, error?.message ?? error);
  }
}

export type WeeklyDigest = { documentation: number; memory: number; gaps: number; reviews: number; companies: string[] };

// Kooste vastuuisännöitsijän taloyhtiöistä: odottavat ehdotukset, viikon osaamisaukot ja pian tarkistettavat ohjeet.
export function weeklyDigestFor(userId: string, at = Date.now()): WeeklyDigest {
  const companies = (db.prepare("SELECT id, name FROM companies WHERE manager_id = ?").all(userId) as { id: string; name: string }[])
    .filter(company => AUTHORIZED_COMPANY_IDS.has(company.id));
  const ids = companies.map(company => company.id);
  if (!ids.length) return { documentation: 0, memory: 0, gaps: 0, reviews: 0, companies: [] };
  const placeholders = ids.map(() => "?").join(", ");
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...ids, ...params) as { count: number }).count;
  return {
    documentation: count(`SELECT COUNT(*) AS count FROM company_memory WHERE company_id IN (${placeholders}) AND status = 'proposed' AND target = 'documentation'`),
    memory: count(`SELECT COUNT(*) AS count FROM company_memory WHERE company_id IN (${placeholders}) AND status = 'proposed' AND target = 'memory'`),
    gaps: count(`SELECT COUNT(DISTINCT lower(question)) AS count FROM knowledge_gaps WHERE company_id IN (${placeholders}) AND created_at >= ?`,
      new Date(at - 7 * 86_400_000).toISOString()),
    reviews: count(`SELECT COUNT(*) AS count FROM knowledge WHERE company_id IN (${placeholders}) AND status = 'active' AND review_at <= ?`,
      new Date(at + 30 * 86_400_000).toISOString().slice(0, 10)),
    companies: companies.map(company => company.name)
  };
}

async function sendWeeklyDigests(at: number) {
  const week = isoWeek(at);
  const managers = db.prepare(`
    SELECT DISTINCT u.id, u.name, u.email FROM users u JOIN companies c ON c.manager_id = u.id
  `).all() as { id: string; name: string; email: string }[];
  for (const manager of managers) {
    if (db.prepare("SELECT 1 FROM weekly_digests WHERE user_id = ? AND week = ?").get(manager.id, week)) continue;
    const digest = weeklyDigestFor(manager.id, at);
    if (!digest.documentation && !digest.memory && !digest.gaps && !digest.reviews) continue;
    const subject = `Pleissin viikkokooste: ${digest.documentation} ehdotusta dokumentaatioon, ${digest.memory} muistiin, `
      + `${digest.gaps} aihetta, joihin AI ei osannut vastata`;
    const link = `${process.env.APP_URL || "http://localhost:5173"}/#/reports/memory`;
    try {
      await sendEmail({
        to: manager.email,
        notification: true,
        subject,
        body: [
          `Hei ${manager.name},`,
          "",
          `Viikon yhteenveto taloyhtiöistäsi (${digest.companies.join(", ")}):`,
          `- ${digest.documentation} ehdotusta dokumentaatioon`,
          `- ${digest.memory} ehdotusta taloyhtiön muistiin`,
          `- ${digest.gaps} kysymystä, joihin AI ei osannut vastata`,
          ...(digest.reviews ? [`- ${digest.reviews} ohjetta tarkistettavana 30 päivän sisällä`] : []),
          "",
          `Hyväksy tai hylkää ehdotukset (Raportit › Taloyhtiön muisti): ${link}`
        ].join("\n")
      });
      db.prepare("INSERT INTO weekly_digests (user_id, week, sent_at) VALUES (?, ?, ?)").run(manager.id, week, now());
    } catch (error: any) {
      console.error("Viikkokoosteen lähetys epäonnistui:", error?.message ?? error);
    }
  }
}
