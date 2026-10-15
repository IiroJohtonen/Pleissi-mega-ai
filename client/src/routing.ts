import { useEffect, useState } from "react";
import type { TicketTab } from "./types";
import { t } from "./i18n";

const ticketTabs: TicketTab[] = ["queue", "unassigned", "tickets", "my-tickets", "ai-handled", "knowledge", "knowledge-ai", "knowledge-internal", "reports", "companies", "residents", "sauna", "laundry", "parking", "announcements", "moves", "renovations", "keys", "meters", "waitlist", "settings", "log", "search"];

type Route = { tab: TicketTab; param: string | null };

// Näkymä luetaan osoitteen hash-osasta (esim. #/companies/abc), jotta selaimen
// takaisin- ja eteenpäin-painikkeet liikkuvat näkymien välillä.
export function parseRoute(): Route {
  const [tab, param] = window.location.hash.replace(/^#\/?/, "").split("/");
  return ticketTabs.includes(tab as TicketTab)
    ? { tab: tab as TicketTab, param: param ? decodeURIComponent(param) : null }
    : { tab: "queue", param: null };
}

// Osoitteen jälkimmäinen osa on tehtävän tunniste vain tehtävänäkymissä; Taloyhtiöissä se on
// yhtiön ja Dokumentaatiossa dokumentin tunniste.
export function paramIsTicket(tab: TicketTab) {
  return tab === "queue" || tab === "unassigned" || tab === "tickets" || tab === "my-tickets" || tab === "ai-handled";
}

export function navigate(tab: TicketTab, param?: string) {
  window.location.hash = param ? `/${tab}/${encodeURIComponent(param)}` : `/${tab}`;
}

export function useRoute() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route;
}

export const tabTitles: Record<TicketTab, string> = {
  queue: t("Päätösjono"),
  unassigned: t("Ilman käsittelijää"),
  "my-tickets": t("Omat tehtävät"),
  "ai-handled": t("AI tehtävät"),
  tickets: t("Kaikki tehtävät"),
  knowledge: t("Dokumentaatio"),
  "knowledge-ai": t("AI dokumentaatio"),
  "knowledge-internal": t("Sisäinen dokumentaatio"),
  reports: t("Raportit"),
  log: t("Loki"),
  sauna: t("Sauna"),
  laundry: t("Pyykkitupa"),
  parking: t("Autopaikat"),
  announcements: t("Tiedotteet"),
  moves: t("Muutot"),
  renovations: t("Remontit"),
  keys: t("Avaimet"),
  meters: t("Lukemat"),
  waitlist: t("Jonot"),
  companies: t("Taloyhtiöt"),
  residents: t("Asukkaat"),
  settings: t("Asetukset"),
  search: t("Haku")
};

export const emptyTicketMessages: Partial<Record<TicketTab, string>> = {
  queue: t("Ei sinulle osoitettuja avoimia tehtäviä."),
  unassigned: t("Kaikilla tehtävillä on käsittelijä."),
  "my-tickets": t("Ei omia tehtäviä."),
  "ai-handled": t("Ei AI:n hoidossa olevia tehtäviä.")
};
