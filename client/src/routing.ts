import { useEffect, useState } from "react";
import type { TicketTab } from "./types";

const ticketTabs: TicketTab[] = ["queue", "tickets", "my-tickets", "ai-handled", "knowledge", "reports", "companies", "residents", "sauna", "laundry", "parking", "announcements", "moves", "waitlist", "settings", "log"];

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
  queue: "Päätösjono",
  "my-tickets": "Omat tehtävät",
  "ai-handled": "AI tehtävät",
  tickets: "Kaikki tehtävät",
  knowledge: "Dokumentaatio",
  reports: "Raportit",
  log: "Loki",
  sauna: "Saunavuorot",
  laundry: "Pyykkitupavuorot",
  parking: "Autopaikat",
  announcements: "Tiedotteet",
  moves: "Muuttoilmoitukset",
  waitlist: "Jonot",
  companies: "Taloyhtiöt",
  residents: "Asukastietokanta",
  settings: "Asetukset"
};

export const emptyTicketMessages: Partial<Record<TicketTab, string>> = {
  queue: "Ei päätösjonoon sopivia tehtäviä.",
  "my-tickets": "Ei omia tehtäviä.",
  "ai-handled": "Ei AI:n hoidossa olevia tehtäviä."
};
