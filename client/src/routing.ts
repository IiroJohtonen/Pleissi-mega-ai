import { useEffect, useState } from "react";
import type { TicketTab } from "./types";
import { t } from "./i18n";

const ticketTabs: TicketTab[] = ["queue", "tickets", "my-tickets", "ai-handled", "knowledge", "reports", "companies", "residents", "sauna", "laundry", "parking", "announcements", "moves", "renovations", "keys", "meters", "waitlist", "settings", "log"];

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
  return tab === "queue" || tab === "tickets" || tab === "my-tickets" || tab === "ai-handled";
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
  "my-tickets": t("Omat tehtävät"),
  "ai-handled": t("AI tehtävät"),
  tickets: t("Kaikki tehtävät"),
  knowledge: t("Dokumentaatio"),
  reports: t("Raportit"),
  log: t("Loki"),
  sauna: t("Saunavuorot"),
  laundry: t("Pyykkitupavuorot"),
  parking: t("Autopaikat"),
  announcements: t("Tiedotteet"),
  moves: t("Muuttoilmoitukset"),
  renovations: "Remontti-ilmoitukset",
  keys: t("Avainhallinta"),
  meters: t("Kulutuslukemat"),
  waitlist: t("Jonot"),
  companies: t("Taloyhtiöt"),
  residents: t("Asukastietokanta"),
  settings: t("Asetukset")
};

export const emptyTicketMessages: Partial<Record<TicketTab, string>> = {
  queue: t("Ei päätösjonoon sopivia tehtäviä."),
  "my-tickets": t("Ei omia tehtäviä."),
  "ai-handled": t("Ei AI:n hoidossa olevia tehtäviä.")
};
