// Viimeksi avatut tehtävät yläpalkin Historia-valikkoa varten. Lista tallentuu tähän selaimeen.
export type HistoryEntry = {
  id: string;
  number: number | null;
  subject: string;
  companyName: string;
  openedAt: string;
};

const HISTORY_KEY = "kotilo.history";
const HISTORY_SIZE = 10;

export function readHistory(): HistoryEntry[] {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter(entry => entry && typeof entry.id === "string") : [];
  } catch {
    return [];
  }
}

// Lisää tehtävän listan kärkeen; sama tehtävä esiintyy listalla vain kerran.
export function rememberTicket(entry: Omit<HistoryEntry, "openedAt">): HistoryEntry[] {
  const next = [{ ...entry, openedAt: new Date().toISOString() }, ...readHistory().filter(item => item.id !== entry.id)]
    .slice(0, HISTORY_SIZE);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // Tallennus ei ole käytössä; historia säilyy vain tämän käynnin ajan.
  }
  return next;
}
