import { t } from "./i18n";
// Rajapinnan osoite: kehityksessä paikallinen palvelin, tuotannossa sama osoite kuin käyttöliittymällä.
// VITE_API_URL ohittaa oletuksen.
export const API: string = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? "http://localhost:4000/api" : "/api");

// Alustaa käyttävä isännöitsijätoimisto. Testitieto, kunnes toimistot tulevat kirjautumisen mukana.
export const MANAGEMENT_OFFICE = {
  name: "Pohjantähti Isännöinti Oy",
  email: "toimisto@pohjantahti-isannointi.fi"
};

// mail_email = käyttäjän oman, Kotiloon yhdistetyn postilaatikon osoite.
export type OfficeUser = { id: string; name: string; email: string; role: string; mail_email?: string | null };
export type ResidentAccount = {
  id: string;
  name: string;
  email: string;
  companyId: string;
  companyName: string;
  apartmentNumber: string;
};

// kind "resident" = asukas, joka näkee vain asukasportaalin.
export type Session = { token: string; user: OfficeUser; kind?: "resident"; resident?: ResidentAccount };

export const USER_ROLES = ["Pääkäyttäjä", "Isännöitsijä", "Asiakaspalvelu"];
const SESSION_KEY = "kotilo.session";
// Avaimen vanha nimi: luetaan kerran, jotta nimenvaihto ei kirjaa ketään ulos.
const LEGACY_SESSION_KEY = "kiito.session";

// Kirjautunut käyttäjä ja istuntotunniste. Säilyy selaimessa, jotta sivun päivitys ei kirjaa ulos.
export let session: Session | null = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) || localStorage.getItem(LEGACY_SESSION_KEY) || "null");
    return stored?.token && stored?.user ? stored as Session : null;
  } catch {
    return null;
  }
})();

export const sessionListeners = new Set<() => void>();

export function setSession(next: Session | null) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    // Selaimen tallennustila ei ole käytössä; istunto säilyy vain tämän sivulatauksen.
  }
  sessionListeners.forEach(listener => listener());
}

// Käyttäjien hallinta ja asetukset kuuluvat vain pääkäyttäjälle; palvelin tarkistaa saman.
export function isAdmin() {
  return session?.user.role === "Pääkäyttäjä";
}

// Taloyhtiöiden tiedot, tietopankki, tiedotteet, muuttojen hyväksyntä, laskutusmerkinnät, loki ja
// asukkaan tietojen vienti ja poisto kuuluvat isännöitsijälle ja pääkäyttäjälle; palvelin tarkistaa saman.
export function isManager() {
  return session?.user.role === "Isännöitsijä" || isAdmin();
}

// Lokiin ja muistiinpanoihin kirjattava tekijä.
export function actorName() {
  return session?.user.name ?? "Isännöitsijä";
}

// Hakee tiedoston kirjautumisotsakkeella ja antaa sen selaimelle tallennettavaksi. Istuntotunniste ei
// kulje osoitteessa, joten tavallinen latauslinkki ei riitä.
export async function downloadFile(path: string, filename: string) {
  const response = await fetch(`${API}${path}`, {
    headers: session ? { Authorization: `Bearer ${session.token}` } : {}
  });
  if (response.status === 401) setSession(null);
  if (!response.ok) throw new Error(await response.text());
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.token}` } : {})
    },
    ...options
  });
  // Vanhentunut tai mitätöity istunto palauttaa kirjautumissivulle.
  if (response.status === 401 && path !== "/auth/login") setSession(null);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

// Kirjaa ulos heti selaimessa. Palvelimen istunto mitätöidään taustalla, joten uloskirjautuminen
// ei jää odottamaan verkkoa eikä esty, vaikka palvelin ei vastaisi.
export function logout() {
  // Tunniste luetaan myös selaimen tallennuksesta: kehityspalvelimen päivittäessä koodia sivun ollessa
  // auki muistissa oleva istunto voi olla vanhentunut kopio.
  let token = session?.token;
  try {
    token = token ?? JSON.parse(localStorage.getItem(SESSION_KEY) || localStorage.getItem(LEGACY_SESSION_KEY) || "null")?.token;
  } catch {
    // Tallennettu istunto ei ole luettavissa; kirjaudutaan silti ulos.
  }
  setSession(null);
  if (token) {
    fetch(`${API}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true
    }).catch(() => undefined);
  }
  // Sivu ladataan kokonaan uudelleen, jotta kirjautumissivu tulee näkyviin varmasti eikä näkymän
  // vaihtuminen jää yhden tilapäivityksen varaan.
  window.location.replace(window.location.pathname);
}

export function errorMessage(error: unknown, fallback: string) {
  try {
    // Palvelimen virheteksti on suomeksi; se käännetään, jos sille on käännös.
    const message = JSON.parse((error as Error).message).error;
    return message ? t(String(message)) : fallback;
  } catch {
    return fallback;
  }
}
