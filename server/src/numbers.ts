// Näytettävät numerot: tehtävät muotoa T000123 ja dokumentit K000123 (risuaita lisätään eteen näytettäessä).
export function formatTicketNumber(value?: number | null) {
  return typeof value === "number" ? `T${String(value).padStart(6, "0")}` : "T------";
}

export function formatDocumentNumber(value?: number | null) {
  return typeof value === "number" ? `K${String(value).padStart(6, "0")}` : "K------";
}

// Haku numerolla: "#T123", "T000123", "#123" ja "123" etsivät tehtävää; "#K12" ja "K000012" dokumenttia.
export function parseNumberQuery(query: string): { kind: "ticket" | "document"; number: number } | null {
  const match = query.trim().match(/^#?\s*([TtKk]?)\s*(\d+)$/);
  if (!match) return null;
  return { kind: match[1].toUpperCase() === "K" ? "document" : "ticket", number: Number(match[2]) };
}
