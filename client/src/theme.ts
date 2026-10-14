// Sovelluksen värimaailma: vaalea tai tumma. Valinta tallentuu tähän selaimeen.
export type Theme = "light" | "dark";

const THEME_KEY = "kotilo.theme";

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  // Selaimen omat osat (vierityspalkit, lomakekentät) seuraavat valittua teemaa.
  document.documentElement.style.colorScheme = theme;
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Tallennus ei ole käytössä; valinta pysyy voimassa vain tämän käynnin ajan.
  }
  applyTheme(theme);
}
