// ---------------------------------------------------------------------------------------------
// AI-luonnoksen muokkausmittari. Kun käsittelijä lähettää vastauksen, sitä verrataan tehtävän viimeisimpään
// AI:n vastausehdotukseen. Tulos kertoo, lähetettiinkö luonnos sellaisenaan vai muokattuna. Tämä on
// AI-agentin kokeiluvaiheen mittari: kun luonnokset lähtevät aiheittain lähes muuttamattomina, agentti
// voi alkaa vastata niihin itse.
// ---------------------------------------------------------------------------------------------

export type DraftEdit = "unchanged" | "light" | "heavy" | "rewritten";

// Sanoja verrataan enintään näin monta kummastakin tekstistä (vertailu on neliöllinen).
const MAX_WORDS = 1500;

function words(text: string) {
  return (text.toLowerCase().match(/[a-zåäö0-9€%]+/g) ?? []).slice(0, MAX_WORDS);
}

// Samankaltaisuus 0–1 sanatasolla: pisimmän yhteisen sanajonon osuus (2·LCS / sanoja yhteensä).
// Sanajärjestys vaikuttaa, välimerkit ja isot kirjaimet eivät.
export function draftSimilarity(draft: string, sent: string): number {
  const a = words(draft);
  const b = words(sent);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return (2 * previous[b.length]) / (a.length + b.length);
}

export function classifyDraftEdit(similarity: number): DraftEdit {
  if (similarity >= 0.97) return "unchanged";
  if (similarity >= 0.8) return "light";
  if (similarity >= 0.4) return "heavy";
  return "rewritten";
}
