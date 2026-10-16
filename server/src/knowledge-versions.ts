import { compareChunksWithAi, stems } from "./ai.js";
import { db } from "./db.js";
import { insertChunk, setChunksStatus } from "./knowledge-chunks.js";
import { now } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Dokumentin uusi versio. Uusi versio odottaa tilassa 'pending', ja sen paloja verrataan edellisen
// version paloihin. Isännöitsijän tarkistamat ja kirjoittamat palat eivät muutu automaattisesti: jos uusi
// versio muuttaa tai poistaa sellaisen, se on ristiriita, joka näytetään erikseen. Vasta hyväksynnän
// jälkeen vanha versio korvataan ja sen palat arkistoidaan.
// ---------------------------------------------------------------------------------------------

export type StoredChunk = {
  id: string; title: string; content: string; page: number | null; tags: string; origin: string;
  verified: number; needs_review: number;
};

export type ComparisonKind = "new" | "changed" | "removed" | "unchanged" | "conflict";

export type ComparisonItem = {
  key: string;
  kind: ComparisonKind;
  oldChunk: StoredChunk | null;
  newChunk: StoredChunk | null;
};

type Pair = { oldId: string; newId: string; same: boolean };

type VersionRow = { id: string; company_id: string; group_id: string; status: string; title: string; version: number; comparison: string | null };

function activeChunks(knowledgeId: string) {
  return db.prepare(`
    SELECT id, title, content, page, tags, origin, verified, needs_review FROM knowledge_chunks
    WHERE knowledge_id = ? AND status = 'active' ORDER BY COALESCE(page, 0), position
  `).all(knowledgeId) as StoredChunk[];
}

export const isProtected = (chunk: StoredChunk) => chunk.verified === 1 || chunk.origin === "manual";

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

function similarity(a: string, b: string) {
  const left = stems(a);
  const right = stems(b);
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter(word => right.has(word)).length;
  return shared / (left.size + right.size - shared);
}

// Paikallinen vertailu: sama teksti on ennallaan, riittävän samankaltainen on muuttunut.
function localPairs(oldChunks: StoredChunk[], newChunks: StoredChunk[]): Pair[] {
  const pairs: Pair[] = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const fresh of newChunks) {
    const same = oldChunks.find(old => !usedOld.has(old.id) && normalized(old.content) === normalized(fresh.content));
    if (same) {
      pairs.push({ oldId: same.id, newId: fresh.id, same: true });
      usedOld.add(same.id);
      usedNew.add(fresh.id);
    }
  }
  for (const fresh of newChunks.filter(chunk => !usedNew.has(chunk.id))) {
    let best: { old: StoredChunk; score: number } | null = null;
    for (const old of oldChunks.filter(chunk => !usedOld.has(chunk.id))) {
      const score = similarity(`${old.title} ${old.content}`, `${fresh.title} ${fresh.content}`);
      if (score >= 0.4 && (!best || score > best.score)) best = { old, score };
    }
    if (best) {
      pairs.push({ oldId: best.old.id, newId: fresh.id, same: false });
      usedOld.add(best.old.id);
    }
  }
  return pairs;
}

// Hyväksyy vain olemassa oleviin paloihin viittaavat parit, kunkin palan enintään kerran.
function validPairs(pairs: Pair[], oldChunks: StoredChunk[], newChunks: StoredChunk[]) {
  const oldIds = new Set(oldChunks.map(chunk => chunk.id));
  const newIds = new Set(newChunks.map(chunk => chunk.id));
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  return pairs.filter(pair => {
    if (!oldIds.has(pair.oldId) || !newIds.has(pair.newId) || usedOld.has(pair.oldId) || usedNew.has(pair.newId)) return false;
    usedOld.add(pair.oldId);
    usedNew.add(pair.newId);
    return true;
  });
}

// Uuden version edellinen, voimassa oleva versio.
export function previousVersion(row: Pick<VersionRow, "group_id">) {
  return db.prepare("SELECT * FROM knowledge WHERE group_id = ? AND status = 'active'").get(row.group_id) as VersionRow | undefined;
}

// Vertailu tehdään kerran ja tallennetaan, jotta sivun avaaminen ei kutsu AI:ta uudelleen.
export async function compareVersions(row: VersionRow, previous: VersionRow) {
  const oldChunks = activeChunks(previous.id);
  const newChunks = activeChunks(row.id);
  let stored: { usedAi: boolean; pairs: Pair[] } | null;
  try {
    stored = row.comparison ? JSON.parse(row.comparison) : null;
  } catch {
    stored = null;
  }
  if (!stored) {
    try {
      stored = { usedAi: true, pairs: await compareChunksWithAi(oldChunks, newChunks) };
    } catch {
      stored = { usedAi: false, pairs: localPairs(oldChunks, newChunks) };
    }
    db.prepare("UPDATE knowledge SET comparison = ? WHERE id = ?").run(JSON.stringify(stored), row.id);
  }

  const pairs = validPairs(stored.pairs, oldChunks, newChunks);
  const byOld = new Map(oldChunks.map(chunk => [chunk.id, chunk]));
  const byNew = new Map(newChunks.map(chunk => [chunk.id, chunk]));
  const items: ComparisonItem[] = pairs.map(pair => {
    const oldChunk = byOld.get(pair.oldId)!;
    const newChunk = byNew.get(pair.newId)!;
    const kind: ComparisonKind = pair.same ? "unchanged" : isProtected(oldChunk) ? "conflict" : "changed";
    return { key: `${oldChunk.id}|${newChunk.id}`, kind, oldChunk, newChunk };
  });
  const pairedOld = new Set(pairs.map(pair => pair.oldId));
  const pairedNew = new Set(pairs.map(pair => pair.newId));
  for (const chunk of oldChunks.filter(item => !pairedOld.has(item.id))) {
    items.push({ key: `${chunk.id}|`, kind: isProtected(chunk) ? "conflict" : "removed", oldChunk: chunk, newChunk: null });
  }
  for (const chunk of newChunks.filter(item => !pairedNew.has(item.id))) {
    items.push({ key: `|${chunk.id}`, kind: "new", oldChunk: null, newChunk: chunk });
  }
  const order: ComparisonKind[] = ["conflict", "changed", "new", "removed", "unchanged"];
  items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { usedAi: stored.usedAi, items };
}

// Hyväksytyt muutokset: accept = uuden version mukaan, reject = vanha säilyy. Oletuksena muutokset
// hyväksytään, mutta ristiriidoissa isännöitsijän tarkistama tai kirjoittama vanha tieto säilyy.
export function applyVersion(
  row: VersionRow,
  previous: VersionRow,
  items: ComparisonItem[],
  decisions: Record<string, "accept" | "reject">
) {
  const removeNew = db.prepare("UPDATE knowledge_chunks SET status = 'deleted', updated_at = ? WHERE id = ?");
  const timestamp = now();
  const keepOld = (chunk: StoredChunk) => insertChunk(row, {
    title: chunk.title,
    content: chunk.content,
    page: chunk.page,
    tags: chunk.tags,
    origin: chunk.origin as "ai" | "local" | "manual",
    verified: chunk.verified === 1,
    needsReview: chunk.needs_review === 1
  });

  db.transaction(() => {
    for (const item of items) {
      const decision = decisions[item.key] ?? (item.kind === "conflict" ? "reject" : "accept");
      // Ennallaan oleva tieto säilyy vanhana, jotta sen tarkistus ja muokkaukset eivät katoa.
      const useOld = item.kind === "unchanged" || (decision === "reject" && item.kind !== "new");
      if (useOld && item.oldChunk) keepOld(item.oldChunk);
      if (item.newChunk && (useOld || (item.kind === "new" && decision === "reject"))) removeNew.run(timestamp, item.newChunk.id);
    }
    db.prepare("UPDATE knowledge SET status = 'replaced' WHERE id = ?").run(previous.id);
    setChunksStatus(previous.id, "archived");
    db.prepare("UPDATE knowledge SET status = 'active', comparison = NULL WHERE id = ?").run(row.id);
  })();
}

// Otsikko ilman numeroita ja välimerkkejä: "Järjestyssäännöt 2026" ~ "järjestyssäännöt".
function baseTitle(text: string) {
  return text.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "").replace(/[^a-zåäö]+/g, " ").trim();
}

// Todennäköinen aiempi versio juuri ladatulle dokumentille: saman yhtiön voimassa oleva dokumentti,
// jonka nimi tai tiedostonimi on sama numeroita lukuun ottamatta.
export function likelyPreviousVersion(row: { id: string; company_id: string; title: string; file_name: string | null }) {
  const title = baseTitle(row.title);
  const file = baseTitle(row.file_name ?? "");
  const candidates = db.prepare(`
    SELECT id, title, file_name FROM knowledge
    WHERE company_id = ? AND kind = 'document' AND status = 'active' AND id != ?
    ORDER BY created_at DESC
  `).all(row.company_id, row.id) as { id: string; title: string; file_name: string | null }[];
  return candidates.find(candidate =>
    (title && baseTitle(candidate.title) === title) || (file && baseTitle(candidate.file_name ?? "") === file)) ?? null;
}
