import { AUTHORIZED_COMPANY_IDS } from "./access.js";
import { aiAvailable, proposeMemories } from "./ai.js";
import { aiBudgetExhausted } from "./ai-budget.js";
import { withAiLog } from "./ai-log.js";
import { db } from "./db.js";
import { ADJUSTABLE_TOPICS, isTopic, TOPIC_RULES } from "./incidents.js";
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
};

// Ensimmäinen haku käy läpi puolen vuoden ratkaisut; myöhemmät vain edellisen haun jälkeiset.
const FIRST_SCAN_DAYS = 180;
const MAX_CASES = 60;

// Hyväksytyt, voimassa olevat tiedot AI:lle. Ensin tehtävän aihetta ja porrasta koskevat, sitten yleiset.
export function memoryForAi(companyId: string, context: { topic?: string | null; stairwell?: string } = {}, limit = 8): string[] {
  const rows = db.prepare(`
    SELECT topic, stairwell, text FROM company_memory
    WHERE company_id = ? AND status = 'approved' AND (valid_until IS NULL OR valid_until >= ?)
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

  const cases = [
    ...incidents.map(row => ({
      sources: [] as string[],
      text: `Shared fault (${row.reports} apartments), topic ${row.topic}, ${row.stairwell ? `staircase ${row.stairwell}` : "whole company"}, ` +
        `${row.first_report_at.slice(0, 10)}. Resolution: ${row.resolution}`
    })),
    ...tickets.map(row => ({
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
    INSERT INTO company_memory (id, company_id, topic, stairwell, text, sources, status, valid_until, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, 'ai', ?, ?)
  `);
  let proposed = 0;
  for (const note of notes) {
    const text = note.text.trim();
    if (!text || existing.includes(text)) continue;
    const sources = [...new Set(note.sources.filter(number => Number.isInteger(number) && number >= 1 && number <= cases.length)
      .flatMap(number => cases[number - 1].sources))];
    const validUntil = note.validMonths && note.validMonths > 0
      ? (() => { const date = new Date(); date.setMonth(date.getMonth() + Math.min(Math.round(note.validMonths), 60)); return date.toLocaleDateString("sv-SE"); })()
      : null;
    insert.run(id("memory"), companyId, note.topic && isTopic(note.topic) ? note.topic : null,
      /^[A-ZÅÄÖ]{1,3}$/.test(note.stairwell.trim().toUpperCase()) ? note.stairwell.trim().toUpperCase() : "",
      text.slice(0, 500), JSON.stringify(sources), validUntil, now(), now());
    proposed++;
  }
  db.prepare("UPDATE companies SET memory_scanned_at = ? WHERE id = ?").run(startedAt, companyId);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), null, "ai", "memory_proposed", JSON.stringify({ company: companyId, cases: cases.length, proposed }), now()
  );
  return { proposed, cases: cases.length };
}

// Viikoittainen haku kaikille taloyhtiöille, kun toimisto on kytkenyt sen päälle.
export async function weeklyMemoryProposals() {
  if (!memoryAutoEnabled() || !aiAvailable()) return;
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  for (const companyId of AUTHORIZED_COMPANY_IDS) {
    const company = db.prepare("SELECT memory_scanned_at FROM companies WHERE id = ?").get(companyId) as { memory_scanned_at: string | null } | undefined;
    if (!company || (company.memory_scanned_at && company.memory_scanned_at > weekAgo)) continue;
    try {
      await proposeCompanyMemory(companyId);
    } catch (error: any) {
      console.error("Muistiehdotusten haku epäonnistui:", companyId, error?.message ?? error);
    }
  }
}
