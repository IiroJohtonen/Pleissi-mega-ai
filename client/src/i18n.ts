import { en } from "./locales/en";

// Käyttöliittymän kieli. Suomenkielinen teksti on koodissa ja toimii samalla käännöksen avaimena:
// t("Tallenna") palauttaa englanniksi "Save" ja suomeksi tekstin sellaisenaan. Kieli luetaan selaimen
// tallennuksesta sivun latautuessa, ja sen vaihtaminen lataa sivun uudelleen.
export type Language = "fi" | "en";

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "fi", label: "Suomi" },
  { value: "en", label: "English" }
];

const LANGUAGE_KEY = "kotilo.language";

export const language: Language = (() => {
  try {
    return localStorage.getItem(LANGUAGE_KEY) === "en" ? "en" : "fi";
  } catch {
    return "fi";
  }
})();

// Päivämäärien ja lukujen esitystapa.
export const locale = language === "en" ? "en-GB" : "fi-FI";

try {
  document.documentElement.lang = language;
} catch {
  // Ei selainta (esim. testit ilman dokumenttia).
}

// Kääntää tekstin. Paikkamerkit {0}, {1}, … korvataan annetuilla arvoilla. Jos käännös puuttuu,
// teksti näytetään suomeksi.
export function t(text: string, ...values: (string | number)[]): string {
  const translated = language === "en" ? en[text] ?? text : text;
  return values.length === 0 ? translated : translated.replace(/\{(\d+)\}/g, (match, index) => {
    const value = values[Number(index)];
    return value === undefined ? match : String(value);
  });
}

export function setLanguage(next: Language) {
  if (next === language) return;
  try {
    localStorage.setItem(LANGUAGE_KEY, next);
  } catch {
    // Selaimen tallennustila ei ole käytössä; kieltä ei voi vaihtaa.
    return;
  }
  window.location.reload();
}
