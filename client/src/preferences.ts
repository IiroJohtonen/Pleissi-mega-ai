// Käyttäjän selainkohtaiset valinnat: päätösjonon järjestys, AI-lisätietoikkuna ja sivupalkin kiinnitys.
// Valinnat tallentuvat tähän selaimeen; jos tallennus ei ole käytössä, käytetään oletuksia.

export type QueueSort = "oldest" | "newest" | "priority" | "due";
export const QUEUE_SORTS: QueueSort[] = ["oldest", "newest", "priority", "due"];

const QUEUE_SORT_KEY = "kotilo.queueSort";
const NAV_PINNED_KEY = "kotilo.navPinned";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Tallennus ei ole käytössä; valinta pysyy voimassa vain tämän käynnin ajan.
  }
}

export function storedQueueSort(): QueueSort {
  const value = read(QUEUE_SORT_KEY);
  return QUEUE_SORTS.includes(value as QueueSort) ? value as QueueSort : "oldest";
}

export function saveQueueSort(sort: QueueSort) {
  write(QUEUE_SORT_KEY, sort);
}

// Onko sivupalkki kiinnitetty auki. Kiinnittämätön palkki näkyy kapeana kuvakerivinä.
export function storedNavPinned(): boolean {
  return read(NAV_PINNED_KEY) !== "off";
}

export function saveNavPinned(pinned: boolean) {
  write(NAV_PINNED_KEY, pinned ? "on" : "off");
}
