import { t } from "./i18n";
import { paramIsTicket, tabTitles } from "./routing";
import { canSeeTable } from "./session";
import type { TicketTab } from "./types";

// Taloyhtiöosion ryhmät sivupalkissa: kaikki näkymät koskevat sivupalkissa valittua taloyhtiötä.
export const navGroups: { key: string; label: string; tabs: TicketTab[] }[] = [
  { key: "docs", label: t("Dokumentaatio"), tabs: ["knowledge", "knowledge-ai", "knowledge-internal"] },
  { key: "residents", label: t("Perustiedot"), tabs: ["residents", "apartments", "waitlist", "keys"] },
  { key: "facilities", label: t("Tilat"), tabs: ["sauna", "laundry", "parking"] },
  { key: "notices", label: t("Ilmoitukset"), tabs: ["announcements", "moves", "renovations", "meters"] }
];

// Taulut, joihin roolille annetaan pääsy (Asetukset › Roolit). Sivupalkin taloyhtiöryhmät tulevat
// tähän suoraan, joten niihin lisätty uusi taulu tulee roolien valintoihin automaattisesti.
// Muu uusi sivupalkin näkymä lisätään tähän tai ALWAYS_VISIBLE-listaan (testi tarkistaa).
export const roleTableGroups: { key: string; label: string; tabs: TicketTab[] }[] = [
  { key: "tasks", label: t("Tehtävät"), tabs: ["queue", "tickets", "unidentified", "my-tickets"] },
  { key: "reports", label: t("Raportit"), tabs: ["reports"] },
  { key: "companies", label: t("Taloyhtiöt"), tabs: ["companies"] },
  ...navGroups
];

// Näkymät, jotka jokainen käyttäjä näkee: asetukset, haku ja loki (loki on pääkäyttäjän asetuksissa).
export const ALWAYS_VISIBLE: TicketTab[] = ["settings", "search", "log"];

// Näkymät, jotka kuuluvat toisen taulun alle.
const TAB_ALIASES: Partial<Record<TicketTab, TicketTab>> = { unassigned: "unidentified", "ai-handled": "tickets" };

const TASK_TABS = roleTableGroups[0].tabs;

// Taulun nimi roolin valinnoissa.
export const roleTableTitles: Partial<Record<TicketTab, string>> = {
  ...tabTitles,
  knowledge: t("Kaikki dokumentit"),
  companies: t("Taloyhtiöiden tiedot")
};

// Saako käyttäjä avata näkymän. Avatun tehtävän näkee, jos rooli näkee jonkin tehtävälistan.
export function canSeeTab(tab: TicketTab, param?: string | null) {
  if (ALWAYS_VISIBLE.includes(tab)) return true;
  if (param && paramIsTicket(tab) && TASK_TABS.some(canSeeTable)) return true;
  return canSeeTable(TAB_ALIASES[tab] ?? tab);
}

// Ensimmäinen näkymä, jonka käyttäjä näkee; asetukset, jos rooli ei näe yhtään taulua.
export function firstVisibleTab(): TicketTab {
  return roleTableGroups.flatMap(group => group.tabs).find(tab => canSeeTable(tab)) ?? "settings";
}
