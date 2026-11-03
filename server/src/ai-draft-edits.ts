import { db } from "./db.js";

// ---------------------------------------------------------------------------------------------
// AI-luonnosten muokkausmittari. Kun käsittelijä lähettää vastauksen, sitä verrataan tehtävän viimeisimpään
// AI:n vastausehdotukseen sanatasolla:
//   unchanged  sellaisenaan (samankaltaisuus ≥ 0,97)
//   light      pieni muokkaus (≥ 0,8)
//   heavy      iso muokkaus (≥ 0,4)
//   rewritten  kirjoitettu uudelleen
// Muokatuista (light, heavy) nopea malli luokittelee eron: sävy vai asiakorjaus (ai.ts classifyDraftChange).
// Agentti saa vastata aiheeseen itse vasta, kun aiheen luonnoksista ≥ 99 % on lähtenyt sellaisenaan tai
// pelkällä sävymuokkauksella ja luonnoksia on vähintään 100 (agentReadiness).
// ---------------------------------------------------------------------------------------------

export type DraftEdit = "unchanged" | "light" | "heavy" | "rewritten";
export type DraftChange = "tone" | "fact";

export const AGENT_READY_SHARE = 0.99;
export const AGENT_READY_MIN_DRAFTS = 100;

// Sanoja verrataan enintään näin monta kummastakin tekstistä (vertailu on neliöllinen).
const MAX_WORDS = 1500;

// Sanat alkuperäisessä muodossaan; vertailu tehdään pienillä kirjaimilla ilman välimerkkejä.
function tokens(text: string) {
  return (text.match(/\S+/g) ?? []).slice(0, MAX_WORDS);
}
const normalize = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}€%]/gu, "");

// Pisimmän yhteisen sanajonon taulukko; sama laskenta antaa samankaltaisuuden ja muuttuneet kohdat.
function lcsTable(a: string[], b: string[]) {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

// Samankaltaisuus 0–1: 2·LCS / sanoja yhteensä. Sanajärjestys vaikuttaa, välimerkit ja isot kirjaimet eivät.
export function draftSimilarity(draft: string, sent: string): number {
  const a = tokens(draft).map(normalize).filter(Boolean);
  const b = tokens(sent).map(normalize).filter(Boolean);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  return (2 * lcsTable(a, b)[0][0]) / (a.length + b.length);
}

export function classifyDraftEdit(similarity: number): DraftEdit {
  if (similarity >= 0.97) return "unchanged";
  if (similarity >= 0.8) return "light";
  if (similarity >= 0.4) return "heavy";
  return "rewritten";
}

// Muuttuneet kohdat: luonnoksesta poistettu ja lähetettyyn lisätty teksti peräkkäisinä pareina. AI:lle
// lähetetään vain nämä, ei koko vastausta.
export function changedParts(draft: string, sent: string, maxParts = 20): { removed: string; added: string }[] {
  const a = tokens(draft);
  const b = tokens(sent);
  const an = a.map(normalize);
  const bn = b.map(normalize);
  const table = lcsTable(an, bn);
  const parts: { removed: string[]; added: string[] }[] = [];
  let current: { removed: string[]; added: string[] } | null = null;
  const flush = () => {
    if (current && (current.removed.length || current.added.length)) parts.push(current);
    current = null;
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && an[i] === bn[j]) {
      flush();
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) {
      current ??= { removed: [], added: [] };
      current.added.push(b[j++]);
    } else {
      current ??= { removed: [], added: [] };
      current.removed.push(a[i++]);
    }
  }
  flush();
  return parts.slice(0, maxParts).map(part => ({ removed: part.removed.join(" "), added: part.added.join(" ") }));
}

// --- Tallennus tehtävälle ---------------------------------------------------------------------

// AI:n vastausehdotus talteen tehtävälle. Vain AI:n tekemä luonnos; dokumentaatiohaun ehdotus ei kerro
// AI:n laadusta.
export function rememberAiDraft(ticketId: string, draft: string) {
  db.prepare("UPDATE tickets SET ai_draft = ? WHERE id = ?").run(draft.trim() || null, ticketId);
}

export type DraftComparison = { draft: string; similarity: number; edit: DraftEdit };

// Lähetetty vastaus verrattuna viimeisimpään AI-luonnokseen. Luonnos tyhjennetään, jotta seuraava vastaus
// verrataan vain sitä varten tehtyyn ehdotukseen. Palauttaa null, jos tehtävällä ei ollut AI-luonnosta.
export function takeDraftComparison(ticketId: string, sentBody: string): DraftComparison | null {
  const row = db.prepare("SELECT ai_draft FROM tickets WHERE id = ?").get(ticketId) as { ai_draft: string | null } | undefined;
  if (!row?.ai_draft) return null;
  db.prepare("UPDATE tickets SET ai_draft = NULL WHERE id = ?").run(ticketId);
  const similarity = Math.round(draftSimilarity(row.ai_draft, sentBody) * 100) / 100;
  return { draft: row.ai_draft, similarity, edit: classifyDraftEdit(similarity) };
}

// Luokittelun tulos lisätään lähetysmerkinnän tietoihin jälkikäteen.
export function recordDraftChange(auditId: string, change: DraftChange, reason: string) {
  const row = db.prepare("SELECT details FROM audit_log WHERE id = ?").get(auditId) as { details: string } | undefined;
  if (!row) return;
  const details = JSON.parse(row.details) as Record<string, unknown>;
  db.prepare("UPDATE audit_log SET details = ? WHERE id = ?")
    .run(JSON.stringify({ ...details, ai_draft_change: change, ai_draft_change_reason: reason }), auditId);
}

// Luonnos kelpaa agentin rajaan: lähti sellaisenaan tai pelkällä sävymuokkauksella.
export function draftCountsAsReady(edit: string | undefined, change: string | undefined) {
  return edit === "unchanged" || ((edit === "light" || edit === "heavy") && change === "tone");
}

// --- Aihekohtainen mittari --------------------------------------------------------------------

export type DraftTopicStats = {
  topic: string;
  // AI:n luonnokset, joiden pohjalta vastaus lähetettiin, muokkauksen mukaan.
  drafts: number; unchanged: number; light: number; heavy: number; rewritten: number;
  // Muokatuista: sävymuokkaus, asiakorjaus tai luokittelematta (AI ei ollut käytettävissä).
  tone: number; fact: number; unclassified: number;
  // Sellaisenaan tai pelkällä sävymuokkauksella lähteneiden osuus ja täyttyykö agentin raja.
  readyShare: number | null; ready: boolean;
  // AI-agentin ajot ja niistä henkilökunnalle siirretyt (seurataan erikseen; eivät ole luonnoksia).
  agentRuns: number; handovers: number; handoverShare: number | null;
};

const topicKeyOf = (topic: string | null) => topic || "other";

// Aiheittain koko historialta: raja lasketaan kaikista luonnoksista, ei vain raportin jaksosta.
export function draftTopicStats(companyIds: string[]): DraftTopicStats[] {
  if (!companyIds.length) return [];
  const placeholders = companyIds.map(() => "?").join(", ");
  const stats = new Map<string, DraftTopicStats>();
  const get = (topic: string) => {
    let item = stats.get(topic);
    if (!item) {
      item = { topic, drafts: 0, unchanged: 0, light: 0, heavy: 0, rewritten: 0, tone: 0, fact: 0, unclassified: 0,
        readyShare: null, ready: false, agentRuns: 0, handovers: 0, handoverShare: null };
      stats.set(topic, item);
    }
    return item;
  };
  for (const row of db.prepare(`
    SELECT t.topic, al.details FROM audit_log al JOIN tickets t ON t.id = al.ticket_id
    WHERE t.company_id IN (${placeholders}) AND al.action = 'reply_sent' AND al.details LIKE '%ai_draft_edit%'
  `).all(...companyIds) as { topic: string | null; details: string }[]) {
    let details: { ai_draft_edit?: string; ai_draft_change?: string };
    try {
      details = JSON.parse(row.details);
    } catch {
      continue;
    }
    const edit = details.ai_draft_edit;
    if (edit !== "unchanged" && edit !== "light" && edit !== "heavy" && edit !== "rewritten") continue;
    const item = get(topicKeyOf(row.topic));
    item.drafts++;
    item[edit]++;
    if (edit === "light" || edit === "heavy") {
      if (details.ai_draft_change === "tone") item.tone++;
      else if (details.ai_draft_change === "fact") item.fact++;
      else item.unclassified++;
    }
  }
  for (const row of db.prepare(`
    SELECT t.topic, al.action FROM audit_log al JOIN tickets t ON t.id = al.ticket_id
    WHERE t.company_id IN (${placeholders}) AND al.action IN ('ai_agent_replied', 'ai_agent_handover')
  `).all(...companyIds) as { topic: string | null; action: string }[]) {
    const item = get(topicKeyOf(row.topic));
    item.agentRuns++;
    if (row.action === "ai_agent_handover") item.handovers++;
  }
  for (const item of stats.values()) {
    if (item.drafts) {
      item.readyShare = (item.unchanged + item.tone) / item.drafts;
      item.ready = item.drafts >= AGENT_READY_MIN_DRAFTS && item.readyShare >= AGENT_READY_SHARE;
    }
    if (item.agentRuns) item.handoverShare = item.handovers / item.agentRuns;
  }
  return [...stats.values()].sort((a, b) => b.drafts - a.drafts || b.agentRuns - a.agentRuns);
}
