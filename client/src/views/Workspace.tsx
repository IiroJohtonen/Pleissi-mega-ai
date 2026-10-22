import { Fragment, useEffect, useRef, useState } from "react";
import { Dropdown, FactDropdown, MultiSelect, NavToggle, TabIcon, usePaged } from "../components/common";
import { priorityLabel, queueTicketStatuses, statusLabel, ticketStatuses } from "../format";
import { type QueueSort, saveNavPinned, saveQueueSort, storedNavPinned, storedQueueSort } from "../preferences";
import { emptyTicketMessages, navigate, paramIsTicket, parseRoute, tabTitles, useRoute } from "../routing";
import { canSeeTab, dataTables, firstVisibleTab, navGroups } from "../role-tables";
import { actorName, api, canSeeTable, MANAGEMENT_OFFICE, type OfficeUser } from "../session";
import {
  assignableUsers, canAssignTickets, compareQueue, compareTickets, fetchTicketDetail, isDueSoon, isOverdue, type ReminderSettings, ticketColumns,
  ticketColumnText, ticketReminders, type TicketSort, type TicketSortKey
} from "../tickets/ticket-utils";
import { TicketCard } from "../tickets/TicketCard";
import { TicketDrawer } from "../tickets/TicketDrawer";
import { SkipTicketModal, TicketCreateModal } from "../tickets/TicketModals";
import type { Company, Ticket, TicketDetail, TicketTab } from "../types";
import { Announcements } from "./Announcements";
import { AuditLog } from "./AuditLog";
import { BookingCalendar } from "./Bookings";
import { Companies } from "./Companies";
import { DataTable } from "./DataTable";
import { isKeyLate, KeyRegister } from "./Keys";
import { Knowledge } from "./Knowledge";
import { MeterReadings } from "./Meters";
import { MoveNotices } from "./Moves";
import { ParkingSpaces } from "./Parking";
import { RenovationNotices } from "./Renovations";
import { SystemAlertBanner } from "../components/SystemAlertBanner";
import { ReportsHub, type ReportsTab } from "./Metrics";
import { Residents } from "./Residents";
import { Apartments } from "./Apartments";
import { Topbar } from "../components/Topbar";
import { type HistoryEntry, readHistory, rememberTicket } from "../history";
import { documentNumberQuery, type SearchResponse, SearchResults, ticketNumberQuery } from "./Search";
import { type OfficeInfo, Settings } from "./Settings";
import { Waitlists } from "./Waitlists";
import { t } from "../i18n";

const NAV_GROUPS_KEY = "kotilo.closedNavGroups";
// Raporttien alasivut sivupalkissa (#/reports/<alasivu>).
const reportTabs: [ReportsTab, string][] = [["metrics", t("Mittarit")], ["custom", t("Omat raportit")], ["company", t("Taloyhtiön raportit")]];
const reportTabIcons: Record<ReportsTab, TicketTab> = { metrics: "reports", custom: "my-tickets", company: "companies" };
// Ryhmän alasivun nimi, kun se poikkeaa näkymän otsikosta.
const navItemTitles: Partial<Record<TicketTab, string>> = { knowledge: t("Kaikki dokumentit") };
// Sivupalkissa valittu taloyhtiö, jonka tiedot, dokumentaatio, asukkaat, tilat ja ilmoitukset näytetään.
// Tämä on ainoa taloyhtiön valinta; tehtävälistat näyttävät kaikki yhtiöt. Valinta säilyy selaimessa.
const NAV_COMPANY_KEY = "kotilo.navCompany";
// Tilat, joissa tehtävä on käsittelijänsä omissa tehtävissä.
const ownTicketStatuses = ["active", "waiting_manager", "answered", "waiting_third_party"];
// Päätösjonon yhteenvedon laatikot: omat tehtävät näissä tiloissa.
const summaryTicketStatuses = ["waiting_manager", "waiting_third_party"];
// Keskeneräisen tehtävän tilat.
const openTicketStatuses = ["open", ...ownTicketStatuses];

// Mitä alasivun laskuri tarkoittaa.
const navCountTitles: Partial<Record<TicketTab, string>> = {
  moves: t("Odottaa käsittelyä"),
  renovations: t("Odottaa käsittelyä"),
  keys: t("Palautus myöhässä")
};

// Monivalintasuodatin: null = kaikki arvot kelpaavat.
function picked(filter: string[] | null, value: string | null | undefined) {
  return filter === null || filter.includes(value ?? "");
}

// Palvelimen vastaus arkaluonteiseksi rajatusta tehtävästä (403, restricted: true).
function restrictedMessage(error: unknown): string {
  try {
    const body = JSON.parse((error as Error).message);
    return body?.restricted ? t("Tehtävä on arkaluonteinen. Sen näkevät vain käsittelijä, taloyhtiön vastuuisännöitsijä ja pääkäyttäjät.") : "";
  } catch {
    return "";
  }
}

// Omat tehtävät: aloitetut, vastatut ja kolmatta osapuolta odottavat (vastaa palvelimen /my-tickets-rajausta).
const MY_TICKET_STATUSES = ["active", "waiting_manager", "answered", "waiting_third_party"];

export function Workspace({ user }: { user: OfficeUser }) {
  // Kaikkien käyttäjälle näkyvien taloyhtiöiden tehtävät. Kaikki tehtävänäkymät näyttävät kaikki yhtiöt;
  // listan voi rajata yhteen yhtiöön Taloyhtiö-suodattimella.
  const [allCompanyTickets, setAllCompanyTickets] = useState<Ticket[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [, setOfficeVersion] = useState(0);
  const [reminderSettings, setReminderSettings] = useState<ReminderSettings>({ replyDays: 2, dueDays: 1 });
  // Toimiston käyttäjät tehtävien käsittelijän näyttämistä ja vaihtamista varten.
  const [officeUsers, setOfficeUsers] = useState<OfficeUser[]>([]);
  useEffect(() => {
    api<OfficeUser[]>("/users").then(setOfficeUsers).catch(() => setOfficeUsers([]));
  }, []);

  async function assignTicket(id: string, assigneeId: string) {
    await api(`/tickets/${id}/fields`, {
      method: "PUT",
      body: JSON.stringify({ assigneeId, actor: actorName() })
    });
    await load();
  }
  useEffect(() => {
    api<OfficeInfo>("/office")
      .then(office => {
        MANAGEMENT_OFFICE.name = office.name;
        MANAGEMENT_OFFICE.aiPrompt = office.aiPrompt !== 0;
        MANAGEMENT_OFFICE.aiAgent = Boolean(office.aiAgent) && office.aiAvailable !== false;
        setOfficeVersion(version => version + 1);
        setReminderSettings({ replyDays: office.replyReminderDays ?? 2, dueDays: office.dueReminderDays ?? 1 });
      })
      .catch(() => undefined);
  }, []);
  const [selectedCompany, setSelectedCompany] = useState("demo-company");
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  // Ilmoitus, kun avattava tehtävä on arkaluonteisena rajattu käyttäjältä.
  const [restrictedNotice, setRestrictedNotice] = useState("");
  const { tab, param: routeParam } = useRoute();
  // Roolin ulkopuolinen näkymä (esim. vanha linkki) vaihtuu ensimmäiseen näkymään, jonka rooli näkee.
  const tabAllowed = canSeeTab(tab, routeParam);
  useEffect(() => {
    if (!tabAllowed) navigate(firstVisibleTab());
  }, [tabAllowed]);
  // Data ilman taulua (esim. #/data) avaa ensimmäisen taulun, jonka rooli näkee.
  useEffect(() => {
    const first = dataTables.find(item => canSeeTable(item));
    if (tab === "data" && !routeParam && first) navigate("data", first);
  }, [tab, routeParam]);
  // Avatun tehtävän tallentamattomat muutokset: navigointi varmistaa poistumisen.
  const ticketDirty = useRef(false);
  const setTab = (next: TicketTab) => {
    if (ticketDirty.current && !window.confirm(t("Tallentamattomat muutokset menetetään. Suljetaanko tehtävä?"))) return;
    ticketDirty.current = false;
    navigate(next);
  };
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [skipTicketId, setSkipTicketId] = useState<string | null>(null);
  // Suodattimet ovat monivalintoja: valitut arvot, null = kaikki (oletus).
  const [priorityFilter, setPriorityFilter] = useState<string[] | null>(null);
  const [typeFilter, setTypeFilter] = useState<string[] | null>(null);
  // Tilasuodatin on käytössä Kaikki tehtävät- ja Omat tehtävät -näkymissä; muut näkymät on jo rajattu tilan mukaan.
  // Valitut tilat; null = kaikki tilat (oletus).
  const [statusFilter, setStatusFilter] = useState<string[] | null>(null);
  // Tehtävälistojen rajaus yhteen taloyhtiöön; oletuksena kaikki yhtiöt.
  const [companyFilter, setCompanyFilter] = useState<string[] | null>(null);
  // Määräaikasuodatin: "overdue" = myöhässä, "due_soon" = umpeutumassa, "reminders" = muistutus,
  // "other" = ei mitään näistä.
  const [dueFilter, setDueFilter] = useState<string[] | null>(null);
  // Tehtävälistan järjestys sarakeotsikosta; null = palvelimen oletusjärjestys.
  const [ticketSort, setTicketSort] = useState<TicketSort | null>(null);
  // Tehtävälistoissa suodatinpalkki avataan sarakeotsikoiden suodatinkuvakkeesta.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Sarakekohtainen tekstihaku; hakurivi avataan suurennuslasista. Haut säilyvät, vaikka rivi suljetaan.
  const [searchOpen, setSearchOpen] = useState(false);
  const [columnSearch, setColumnSearch] = useState<Partial<Record<TicketSortKey, string>>>({});
  // Vasemman valikon tehtävälista avautuu aina ilman suodattimia, vaikka sinne olisi tultu esim.
  // Muistutukset-laatikosta tai lista olisi jo auki.
  function openTaskList(next: TicketTab) {
    setPriorityFilter(null);
    setTypeFilter(null);
    setStatusFilter(null);
    setCompanyFilter(null);
    setDueFilter(null);
    setColumnSearch({});
    setTab(next);
  }
  const [clock, setClock] = useState(Date.now());
  const [myTicketsOpen, setMyTicketsOpen] = useState(true);
  // Sivupalkin kohdat, jotka käyttäjän rooli näkee.
  const taskSubTabs = canSeeTable("unidentified") || canSeeTable("my-tickets") || canSeeTable("tickets");
  const visibleNavGroups = navGroups
    .map(group => ({ ...group, tabs: group.tabs.filter(item => canSeeTable(item)) }))
    .filter(group => group.tabs.length > 0);
  const [reportsOpen, setReportsOpen] = useState(true);
  // Puhelimella navigaatio on sivusta avautuva valikko; se sulkeutuu, kun näkymä vaihtuu.
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
  }, [tab, routeParam]);
  // Kiinnittämätön sivupalkki näkyy kapeana kuvakerivinä ja aukeaa, kun hiiri viedään sen päälle.
  const [navPinned, setNavPinned] = useState(storedNavPinned);
  function changeNavPinned(pinned: boolean) {
    setNavPinned(pinned);
    saveNavPinned(pinned);
  }
  // Viimeksi avatut tehtävät yläpalkin Historia-valikkoon.
  const [history, setHistory] = useState<HistoryEntry[]>(readHistory);
  useEffect(() => {
    if (!selected) return;
    setHistory(rememberTicket({
      id: selected.ticket.id,
      number: selected.ticket.ticket_number ?? null,
      subject: selected.ticket.subject,
      companyName: selected.ticket.company_name ?? companies.find(company => company.id === selected.ticket.company_id)?.name ?? ""
    }));
  }, [selected?.ticket.id]);
  const [searchText, setSearchText] = useState(() => parseRoute().tab === "search" ? parseRoute().param ?? "" : "");
  async function submitSearch() {
    const query = searchText.trim();
    if (!query) return;
    // #K123 avaa dokumentin suoraan, jos numerolla löytyy täsmälleen yksi dokumentti.
    const documentNumber = documentNumberQuery(query);
    if (documentNumber !== null) {
      try {
        const found = await api<SearchResponse>(`/search?q=${encodeURIComponent(query)}`);
        if (found.knowledge.length === 1) {
          setSearchText("");
          changeCompany(found.knowledge[0].company_id);
          navigate("knowledge", found.knowledge[0].id);
          return;
        }
      } catch {
        // Näytetään hakusivu, joka kertoo virheestä.
      }
    }
    // #T123 (tai #123) avaa tehtävän suoraan, jos numerolla löytyy täsmälleen yksi tehtävä.
    const number = ticketNumberQuery(query);
    if (number !== null) {
      try {
        const found = await api<SearchResponse>(`/search?q=${encodeURIComponent(query)}`);
        const exact = found.tickets.filter(ticket => ticket.ticket_number === number);
        if (exact.length === 1) {
          setSearchText("");
          navigate("tickets", exact[0].id);
          return;
        }
      } catch {
        // Näytetään hakusivu, joka kertoo virheestä.
      }
    }
    navigate("search", query);
  }
  const [queueSort, setQueueSort] = useState<QueueSort>(storedQueueSort);
  function changeQueueSort(sort: QueueSort) {
    setQueueSort(sort);
    saveQueueSort(sort);
  }
  const [navCounts, setNavCounts] = useState<Partial<Record<TicketTab, number>>>({});
  // Suljetut alavalikon ryhmät; valinta säilyy selaimessa.
  const [closedGroups, setClosedGroups] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(NAV_GROUPS_KEY) || "[]");
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  });

  const [navCompanyId, setNavCompanyIdState] = useState(() => {
    try {
      return localStorage.getItem(NAV_COMPANY_KEY) ?? "";
    } catch {
      return "";
    }
  });
  function setNavCompanyId(companyId: string) {
    setNavCompanyIdState(companyId);
    try {
      localStorage.setItem(NAV_COMPANY_KEY, companyId);
    } catch {
      // Selaimen tallennustila ei ole käytössä; valinta säilyy vain tämän käynnin ajan.
    }
  }
  const navCompany = companies.find(company => company.id === navCompanyId);
  const reportsTab: ReportsTab = reportTabs.some(([key]) => key === routeParam) ? routeParam as ReportsTab : "metrics";
  // Alasivut näyttävät vain valitun taloyhtiön tiedot.
  const navCompanyKey = navCompany?.id ?? selectedCompany;
  // Yhtiön näkymät (asukkaat, jonot, ilmoitukset…) näyttävät vain sivupalkissa valitun yhtiön, joten
  // niissä ei ole omaa taloyhtiösuodatinta.
  const companyScope = navCompany ? [navCompany] : companies;

  // Yläpalkin taloyhtiövalinnalla on aina arvo: oletuksena tehtävänäkymän yhtiö tai ensimmäinen yhtiö.
  useEffect(() => {
    if (companies.length > 0 && !navCompany) {
      setNavCompanyId(companies.some(company => company.id === selectedCompany) ? selectedCompany : companies[0].id);
    }
  }, [tab, companies.length, navCompany?.id]);

  function toggleGroup(key: string) {
    const next = closedGroups.includes(key) ? closedGroups.filter(item => item !== key) : [...closedGroups, key];
    setClosedGroups(next);
    try {
      localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(next));
    } catch {
      // Selaimen tallennustila ei ole käytössä; valinta säilyy vain tämän käynnin ajan.
    }
  }

  // Alavalikko aukeaa itsestään, kun sen näkymään siirrytään muuta kautta (esim. päätöksen jälkeen).
  useEffect(() => {
    if (tab === "my-tickets" || tab === "ai-handled" || tab === "unidentified") setMyTicketsOpen(true);
    if (tab === "reports") setReportsOpen(true);
    // Suljettu ryhmä aukeaa, kun sen näkymään siirrytään. Data-osion ryhmien avaimet alkavat data-.
    const dataGroup = tab === "data" ? navGroups.find(item => item.tabs.includes(routeParam as TicketTab)) : undefined;
    if (dataGroup) setClosedGroups(current => current.filter(key => key !== "data" && key !== `data-${dataGroup.key}`));
    if (tab === "companies" && !routeParam) setClosedGroups(current => current.filter(key => key !== "data"));
    const group = navGroups.find(item => item.tabs.includes(tab));
    if (group) setClosedGroups(current => current.filter(key => key !== group.key));
  }, [tab, routeParam]);

  // Alavalikon laskurit: käsittelyä odottavat muutto- ja remontti-ilmoitukset sekä myöhässä olevat avaimet.
  async function refreshNavCounts() {
    if (!navCompany) return;
    const lists = <T,>(resource: string) => Promise.all([navCompany].map(company =>
      api<T[]>(`/companies/${encodeURIComponent(company.id)}/${resource}`).catch(() => [] as T[]))).then(all => all.flat());
    const [moves, renovations, keys] = await Promise.all([
      lists<{ status: string }>("moves"),
      lists<{ status: string }>("renovations"),
      lists<{ loan_id: string | null; due_date: string | null }>("keys")
    ]);
    setNavCounts({
      moves: moves.filter(notice => notice.status === "pending").length,
      renovations: renovations.filter(notice => notice.status === "pending").length,
      keys: keys.filter(isKeyLate).length
    });
  }

  // Laskurit päivittyvät yhtiöiden latauduttua, näkymää vaihdettaessa ja minuutin välein.
  useEffect(() => {
    void refreshNavCounts();
  }, [navCompany?.id, tab, clock]);

  // silent = taustapäivitys: listaa ei vaihdeta hetkeksi "Ladataan…"-tilaan. Tehtävät haetaan kaikista
  // yhtiöistä yhdellä haulla.
  async function load(_companyId = selectedCompany, _companyList = companies, silent = false) {
    if (!silent) setLoading(true);
    const rows = await api<Ticket[]>("/tickets?companyId=all");
    setAllCompanyTickets([...rows].sort((a, b) => compareTickets(a, b, "priority") || compareTickets(b, a, "created")));
    setLoading(false);

    // Päivitetään avoin tehtävä osoitteen perusteella, jotta juuri suljettu paneeli ei aukea uudelleen.
    const route = parseRoute();
    const refreshId = paramIsTicket(route.tab) ? route.param : null;
    if (refreshId) {
      try {
        const detail = await fetchTicketDetail(refreshId);
        const current = parseRoute();
        if (paramIsTicket(current.tab) && current.param === refreshId) setSelected(detail);
      } catch (error) {
        // Tehtävä merkittiin juuri arkaluonteiseksi, eikä käyttäjä enää näe sitä.
        if (restrictedMessage(error)) {
          setRestrictedNotice(restrictedMessage(error));
          navigate(route.tab);
        } else {
          throw error;
        }
      }
    }
  }

  useEffect(() => {
    // Jos palvelin ei vastaa (esim. se käynnistyy juuri uudelleen julkaisun jälkeen), haku yritetään
    // uudelleen, jotta taloyhtiöt eivät jää puuttumaan ennen sivun uudelleenlatausta.
    async function initialize(attempt = 0): Promise<void> {
      let availableCompanies: Company[];
      try {
        availableCompanies = await api<Company[]>("/companies");
      } catch (error) {
        if (attempt >= 10) throw error;
        await new Promise(resolve => window.setTimeout(resolve, 3000));
        return initialize(attempt + 1);
      }
      setCompanies(availableCompanies);
      const initialCompany = availableCompanies.find(company => company.id === selectedCompany) ?? availableCompanies[0];
      if (initialCompany) {
        setSelectedCompany(initialCompany.id);
        await load(initialCompany.id, availableCompanies);
      } else {
        setLoading(false);
      }
    }

    initialize().catch(console.error);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  // Saapuvat sähköpostit tulevat näkyviin itsestään: tehtävät ja avoin tehtävä haetaan
  // taustalla uudelleen 15 sekunnin välein, kun välilehti on näkyvissä.
  const refreshInBackground = useRef(() => {});
  refreshInBackground.current = () => {
    if (document.hidden || companies.length === 0) return;
    load(selectedCompany, companies, true).catch(console.error);
  };

  useEffect(() => {
    const interval = window.setInterval(() => refreshInBackground.current(), 15_000);
    return () => window.clearInterval(interval);
  }, []);

  function updateTicketDraft(ticketId: string, draft: string) {
    const updatedAt = new Date().toISOString();
    setAllCompanyTickets(prev => prev.map(ticket => ticket.id === ticketId ? { ...ticket, draft, updated_at: updatedAt } : ticket));
    setSelected(prev => prev && prev.ticket.id === ticketId
      ? { ...prev, ticket: { ...prev.ticket, draft, updated_at: updatedAt } }
      : prev);
  }

  // Avoin tehtävä luetaan osoitteesta (esim. #/queue/<tehtävän id>), jotta
  // takaisin-painike sulkee paneelin ja tehtävään voi linkittää.
  const openTicketId = paramIsTicket(tab) ? routeParam : null;

  useEffect(() => {
    if (!openTicketId) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    fetchTicketDetail(openTicketId)
      .then(detail => {
        if (!cancelled) setSelected(detail);
      })
      .catch(error => {
        if (cancelled) return;
        const restricted = restrictedMessage(error);
        if (restricted) setRestrictedNotice(restricted); else console.error(error);
        navigate(tab);
      });
    return () => {
      cancelled = true;
    };
  }, [openTicketId]);

  function closeTicket() {
    if (openTicketId) navigate(tab);
  }

  // Yhtiön näkymät (dokumentaatio ym.) näyttävät sivupalkissa valitun taloyhtiön tiedot. Tehtävälistat
  // eivät riipu valinnasta, joten tehtäviä ei tarvitse hakea uudelleen.
  useEffect(() => {
    if (navCompany && navCompany.id !== selectedCompany) setSelectedCompany(navCompany.id);
  }, [tab, navCompany?.id]);

  // Taloyhtiön sivu avattuna (esim. listasta): sivupalkin valinta seuraa sitä.
  useEffect(() => {
    if (tab === "companies" && routeParam && companies.some(company => company.id === routeParam)) setNavCompanyId(routeParam);
  }, [tab, routeParam, companies.length]);

  // Vaihtaa sivupalkin taloyhtiön. Avattu taloyhtiön sivu vaihtuu valitun yhtiön sivuksi.
  function changeCompany(companyId: string) {
    setNavCompanyId(companyId);
    setSelectedCompany(companyId);
    if (tab === "companies" && routeParam) navigate("companies", companyId);
  }

  function openTicket(id: string) {
    navigate(tab, id);
  }

  async function decide(id: string, decision: "ai" | "human" | "skip", reason?: string, comment?: string) {
    await api(`/tickets/${id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision, actor: actorName(), reason, comment })
    });
    // "Osoita minulle" ei vaihda näkymää: tehtävä poistuu päätösjonosta ja käyttäjä jatkaa siitä, missä oli.
    await load();
  }

  function requestDecision(id: string, decision: "ai" | "human" | "skip") {
    if (decision === "skip") {
      setSkipTicketId(id);
      return;
    }
    void decide(id, decision);
  }

  async function confirmSkip(reason: string, comment: string) {
    if (!skipTicketId) return;
    await decide(skipTicketId, "skip", reason, comment);
    setSkipTicketId(null);
  }

  async function createTicket(payload: {
    companyId: string;
    subject: string;
    summary: string;
    type: string;
    priority: string;
    residentId?: string;
    newResident?: { name: string; address: string; apartmentNumber: string };
  }) {
    const response = await api<{ ok: boolean; ticketId: string; status: string }>("/tickets", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    setCreating(false);
    setTab("my-tickets");
    await load();
    return response;
  }

  // Päätösjonossa ovat käyttäjälle jo osoitetut avoimet tehtävät käyttäjän valitsemassa järjestyksessä.
  // Remonttitehtävät ovat auki pitkään, joten ne ovat Remontit-osiossa eivätkä päätösjonossa.
  const queueTickets = allCompanyTickets
    .filter(ticket => queueTicketStatuses.includes(ticket.status) && ticket.assignee_id === user.id && ticket.kind !== "renovation")
    .sort((a, b) => compareQueue(a, b, queueSort));
  // Päätösjonon alla ovat käyttäjän omat Käsittelyssä-tilaiset tehtävät samassa järjestyksessä.
  const inProgressTickets = allCompanyTickets
    .filter(ticket => ticket.status === "waiting_manager" && ticket.assignee_id === user.id && ticket.kind !== "renovation")
    .sort((a, b) => compareQueue(a, b, queueSort));
  // Omat keskeneräiset tehtävät, jotka vaativat huomiota; näytetään päätösjonon kärjessä.
  const reminderOrder = { overdue: 0, due: 1, waiting: 2 };
  const reminderTickets = allCompanyTickets
    .filter(ticket => ticket.assignee_id === user.id)
    .map(ticket => ({ ticket, reminders: ticketReminders(ticket, reminderSettings) }))
    .filter(item => item.reminders.length > 0)
    .sort((a, b) => reminderOrder[a.reminders[0].kind] - reminderOrder[b.reminders[0].kind]
      || compareTickets(a.ticket, b.ticket, "priority"));
  // Keskeneräiset remonttitehtävät kaikista yhtiöistä.
  const openRenovations = allCompanyTickets.filter(ticket => ticket.kind === "renovation" && ticket.status !== "closed");
  const tickets = allCompanyTickets;
  // Tunnistamattomat: avoimet tehtävät, joiden taloyhtiötä ei ole tunnistettu (palvelin lähettää ne vain jonon
  // käsittelijöille ja tehtävän omalle käsittelijälle), sekä kaikkien yhtiöiden tehtävät ilman käsittelijää.
  const unidentifiedTickets = allCompanyTickets
    .filter(ticket => ticket.status !== "closed"
      && (ticket.company_pending || (!ticket.assignee_id && ticket.kind !== "renovation")))
    .sort((a, b) => compareTickets(a, b, "priority") || compareTickets(a, b, "created"));
  // Omat tehtävät: käsittelijän kaikki aloitetut tehtävät kaikista yhtiöistä.
  const myTickets = allCompanyTickets.filter(ticket => ticket.assignee_id === user.id && MY_TICKET_STATUSES.includes(ticket.status));
  // AI tehtävät: AI-agentin hoitamat tehtävät. Laskurissa ovat ne, joissa agentti odottaa asukkaan vastausta.
  const aiTickets = tickets.filter(ticket => ticket.ai_action === "ai");
  const aiWaitingCount = aiTickets.filter(ticket => ticket.status === "waiting_third_party").length;
  const ticketTypes = [...new Set(tickets.map(ticket => ticket.type))].sort((a, b) => a.localeCompare(b, "fi"));
  // Määräaikasuodattimen valinnat; "other" = ei myöhässä, ei umpeutumassa eikä muistutusta.
  function dueMatches(ticket: Ticket, kind: string): boolean {
    if (kind === "overdue") return isOverdue(ticket);
    if (kind === "due_soon") return isDueSoon(ticket, reminderSettings.dueDays);
    if (kind === "reminders") return ticketReminders(ticket, reminderSettings).length > 0;
    return !["overdue", "due_soon", "reminders"].some(other => dueMatches(ticket, other));
  }
  const statusFilterTab = tab === "tickets" || tab === "my-tickets" || tab === "unidentified" || tab === "ai-handled";
  // Tilasuodattimen vaihtoehdot: näkymän mahdolliset tilat.
  const statusOptions = tab === "my-tickets" ? ownTicketStatuses : tab === "unidentified" ? openTicketStatuses : ticketStatuses;
  // Muistutukset koskevat kaikkia omia keskeneräisiä tehtäviä kaikista yhtiöistä, myös päätösjonon avoimia.
  const sourceTickets = tab === "queue" ? queueTickets
    : tab === "unidentified" ? unidentifiedTickets
    : tab === "my-tickets" ? (dueFilter?.length === 1 && dueFilter[0] === "reminders" ? reminderTickets.map(item => item.ticket) : myTickets)
    : tab === "ai-handled" ? aiTickets : tickets;
  // Päätösjonossa ei ole suodattimia; ne koskevat vain tehtävälistoja.
  const visibleTickets = tab === "queue" ? queueTickets : sourceTickets.filter(ticket =>
    picked(companyFilter, ticket.company_id)
    && picked(priorityFilter, ticket.priority)
    && picked(typeFilter, ticket.type)
    && (!statusFilterTab || picked(statusFilter, ticket.status))
    && (dueFilter === null || dueFilter.some(kind => dueMatches(ticket, kind)))
    && ticketColumns.every(column => {
      const search = (columnSearch[column.key] ?? "").trim().toLowerCase();
      return !search || ticketColumnText(ticket, column.key).toLowerCase().includes(search);
    })
  );
  const searchActive = Object.values(columnSearch).some(value => value?.trim());

  // Suodatinpalkin monivalinnat; sama lista tuottaa päällä olevien suodattimien merkit.
  const filterGroups: { key: string; label: string; value: string[] | null; options: { value: string; label: string }[]; onChange: (value: string[] | null) => void }[] = [
    { key: "company", label: t("Taloyhtiö"), value: companyFilter, onChange: setCompanyFilter,
      options: companies.map(company => ({ value: company.id, label: company.name })) },
    { key: "priority", label: t("Prioriteetti"), value: priorityFilter, onChange: setPriorityFilter,
      options: ["emergency", "urgent", "normal", "low"].map(priority => ({ value: priority, label: priorityLabel(priority) })) },
    { key: "type", label: t("Tyyppi"), value: typeFilter, onChange: setTypeFilter,
      options: ticketTypes.map(type => ({ value: type, label: t(type) })) },
    ...(statusFilterTab
      ? [{ key: "status", label: t("Tila"), value: statusFilter, onChange: setStatusFilter,
          options: statusOptions.map(status => ({ value: status, label: statusLabel(status) })) }]
      : []),
    { key: "due", label: t("Määräaika"), value: dueFilter, onChange: setDueFilter,
      options: [
        { value: "overdue", label: t("Myöhässä") },
        { value: "due_soon", label: t("Umpeutumassa") },
        { value: "reminders", label: t("Muistutus") },
        { value: "other", label: t("Muut") }
      ] }
  ];

  // Päällä olevat suodattimet ja haut näytetään merkkeinä sarakeotsikoiden yläpuolella.
  const activeFilters: { key: string; label: string; value: string; clear: () => void }[] = tab === "queue" ? [] : [
    ...ticketColumns
      .filter(column => (columnSearch[column.key] ?? "").trim())
      .map(column => ({
        key: `search-${column.key}`,
        label: column.label,
        value: (columnSearch[column.key] ?? "").trim(),
        clear: () => setColumnSearch(current => ({ ...current, [column.key]: "" }))
      })),
    ...filterGroups
      .filter(group => group.value !== null && group.value.length < group.options.length)
      .map(group => ({
        key: group.key,
        label: group.label,
        value: group.value!.length === 0 ? t("Ei mitään")
          : group.value!.map(value => group.options.find(option => option.value === value)?.label ?? value).join(", "),
        clear: () => group.onChange(null)
      }))
  ];
  const listedTickets = ticketSort && tab !== "queue"
    ? [...visibleTickets].sort((a, b) =>
        compareTickets(a, b, ticketSort.key) * (ticketSort.descending ? -1 : 1))
    // Omat tehtävät näytetään oletuksena vanhimmasta uusimpaan.
    : tab === "my-tickets" ? [...visibleTickets].sort((a, b) => compareTickets(a, b, "created"))
    : visibleTickets;

  const pagedInProgress = usePaged(inProgressTickets, `in-progress|${queueSort}`);
  const pagedTickets = usePaged(listedTickets, [
    tab, JSON.stringify([companyFilter, priorityFilter, typeFilter, statusFilter, dueFilter]),
    JSON.stringify(columnSearch), ticketSort?.key, ticketSort?.descending
  ].join("|"));

  // Ensimmäinen painallus: uusin tai suurin numero ensin, muut sarakkeet nousevasti. Toinen kääntää suunnan.
  function sortTicketsBy(key: TicketSortKey) {
    setTicketSort(current => current?.key === key
      ? { key, descending: !current.descending }
      : { key, descending: key === "created" || key === "updated" || key === "number" });
  }

  const filtersActive = filterGroups.some(group => group.value !== null && group.value.length < group.options.length);

  // Päätösjonon laskurit: käyttäjän omat tehtävät kaikista yhtiöistä tiloittain.
  const ownStatusCounts = summaryTicketStatuses.map(status => ({
    status,
    count: allCompanyTickets.filter(ticket => ticket.assignee_id === user.id && ticket.status === status).length
  }));

  function renderTicketCard(ticket: Ticket) {
    return (
      <TicketCard
        key={ticket.id}
        ticket={ticket}
        // Päätösjonon korteissa ei ole määräaikatägejä (määräaika näkyy tehtäväsivulla); odotusmuistutus näkyy.
        reminders={ticketReminders(ticket, reminderSettings).filter(reminder =>
          tab === "queue" ? reminder.kind === "waiting" : reminder.kind !== "overdue")}
        compact={tab !== "queue"}
        companyName={ticket.company_pending
          ? t("Taloyhtiö tunnistamatta")
          : companies.find(company => company.id === ticket.company_id)?.name}
        users={assignableUsers(companies.find(company => company.id === ticket.company_id), officeUsers)}
        allUsers={officeUsers}
        canAssign={canAssignTickets(companies.find(company => company.id === ticket.company_id))}
        assignToMe={tab !== "queue"}
        onAssign={assigneeId => assignTicket(ticket.id, assigneeId)}
        onOpen={() => openTicket(ticket.id)}
        onDecision={(d) => requestDecision(ticket.id, d)}
      />
    );
  }

  return (
    <div className={`app ${navOpen ? "nav-open" : ""} ${navPinned ? "" : "nav-collapsed"}`}>
      <Topbar
        user={user}
        searchText={searchText}
        onSearchTextChange={setSearchText}
        onSearch={() => void submitSearch()}
        history={history}
        onOpenTicket={ticketId => navigate("tickets", ticketId)}
        onOpenSettings={() => setTab("settings")}
        onOpenMenu={() => setNavOpen(true)}
      />
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className="sidebar">
        <button className="mobile-nav-close" onClick={() => setNavOpen(false)} aria-label={t("Sulje valikko")}>×</button>
        <nav>
          {/* Päätösjonon vieressä on sivupalkin kiinnitys: kiinnittämätön palkki kutistuu kuvakeriviksi. */}
          <div className={`nav-group nav-queue-row ${canSeeTable("queue") ? "" : "pin-only"}`}>
            {canSeeTable("queue") && (
              <button className={tab === "queue" ? "active" : ""} onClick={() => openTaskList("queue")}>
                <TabIcon tab="queue" />
                {t("Päätösjono")}
                <b>{queueTickets.length}</b>
              </button>
            )}
            <button
              type="button"
              className={`nav-pin ${navPinned ? "pinned" : ""}`}
              onClick={event => {
                changeNavPinned(!navPinned);
                // Painike ei jää kohdistetuksi, jotta pienennetty palkki sulkeutuu heti hiiren poistuessa.
                event.currentTarget.blur();
              }}
              title={navPinned ? t("Pienennä valikko") : t("Kiinnitä valikko auki")}
              aria-label={navPinned ? t("Pienennä valikko") : t("Kiinnitä valikko auki")}
              aria-pressed={navPinned}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z" />
                <path d="M12 14v7" />
              </svg>
            </button>
          </div>
          {canSeeTable("tickets") && (
            <div className="nav-group">
              <button className={tab === "tickets" ? "active" : ""} onClick={() => openTaskList("tickets")}>
                <TabIcon tab="tickets" />
                {t("Kaikki tehtävät")}
              </button>
              {taskSubTabs && (
                <NavToggle open={myTicketsOpen} label={t("tunnistamattomat ja omat tehtävät")} onToggle={() => setMyTicketsOpen(!myTicketsOpen)} />
              )}
            </div>
          )}
          {/* Ilman Kaikki tehtävät -näkymää alasivut näkyvät aina. */}
          {(myTicketsOpen || !canSeeTable("tickets")) && (
            <>
              {canSeeTable("unidentified") && (
                <button className={`nav-sub ${tab === "unidentified" ? "active" : ""}`} onClick={() => openTaskList("unidentified")}>
                  <TabIcon tab="unidentified" />
                  {t("Tunnistamattomat")}
                  <b>{unidentifiedTickets.length}</b>
                </button>
              )}
              {canSeeTable("my-tickets") && (
                <button className={`nav-sub ${tab === "my-tickets" ? "active" : ""}`} onClick={() => openTaskList("my-tickets")}>
                  <TabIcon tab="my-tickets" />
                  {t("Omat tehtävät")}
                  <b>{myTickets.length}</b>
                </button>
              )}
              {canSeeTable("tickets") && (
                <button
                  className={`nav-sub ${tab === "ai-handled" ? "active" : ""}`}
                  onClick={() => openTaskList("ai-handled")}
                  title={t("AI-agentin hoitamat tehtävät")}
                >
                  <TabIcon tab="ai-handled" />
                  {t("AI tehtävät")}
                  {aiWaitingCount > 0 && <b title={t("Odottaa asukkaan vastausta")}>{aiWaitingCount}</b>}
                </button>
              )}
            </>
          )}
          {/* Raportit: alasivuina mittarit, omat raportit ja taloyhtiön raportit. */}
          {canSeeTable("reports") && (
          <>
          <div className="nav-group">
            <button className={tab === "reports" ? "active" : ""} onClick={() => navigate("reports", reportsTab)}>
              <TabIcon tab="reports" />
              {t("Raportit")}
            </button>
            <NavToggle open={reportsOpen} label={t("raporttien alasivut")} onToggle={() => setReportsOpen(!reportsOpen)} />
          </div>
          {reportsOpen && reportTabs.map(([key, label]) => (
            <button key={key} className={`nav-sub ${tab === "reports" && reportsTab === key ? "active" : ""}`} onClick={() => navigate("reports", key)}>
              <TabIcon tab={reportTabIcons[key]} />
              {label}
            </button>
          ))}
          </>
          )}
          {/* Data: taloyhtiöosion alasivut kaikista taloyhtiöistä suodattamattomina sekä kaikkien taloyhtiöiden lista. */}
          {(canSeeTable("companies") || visibleNavGroups.length > 0) && (
          <div className="nav-company-section nav-data-section">
            <div className="nav-group">
              <button
                className={tab === "data" ? "active" : ""}
                onClick={() => {
                  const first = dataTables.find(item => canSeeTable(item));
                  if (first) navigate("data", first); else navigate("companies");
                }}
              >
                <TabIcon tab="data" />
                {t("Data")}
              </button>
              <NavToggle open={!closedGroups.includes("data")} label={t("Data-osion taulut")} onToggle={() => toggleGroup("data")} />
            </div>
            {!closedGroups.includes("data") && (
            <div className="nav-subs">
              {canSeeTable("companies") && (
                <button className={`nav-sub ${tab === "companies" && !routeParam ? "active" : ""}`} onClick={() => navigate("companies")}>
                  <TabIcon tab="companies" />
                  {t("Kaikki taloyhtiöt")}
                </button>
              )}
              {visibleNavGroups.map(group => {
                const key = `data-${group.key}`;
                const open = !closedGroups.includes(key);
                return (
                <Fragment key={key}>
                  <button
                    className={`nav-label ${open ? "open" : ""}`}
                    onClick={() => toggleGroup(key)}
                    aria-expanded={open}
                    title={`${open ? t("Piilota") : t("Näytä")} ${group.label}`}
                  >
                    {group.label}
                    <svg
                      className="tab-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  {open && group.tabs.map(item => (
                    <button key={item} className={`nav-sub ${tab === "data" && routeParam === item ? "active" : ""}`} onClick={() => navigate("data", item)}>
                      <TabIcon tab={item} />
                      {navItemTitles[item] ?? tabTitles[item]}
                    </button>
                  ))}
                </Fragment>
                );
              })}
            </div>
            )}
          </div>
          )}
          {/* Taloyhtiöosio: otsikkona taloyhtiön valinta; alasivut koskevat valittua yhtiötä. */}
          {(canSeeTable("companies") || visibleNavGroups.length > 0) && (
          <div className="nav-company-section">
            <Dropdown
              className="nav-company-select"
              icon={<TabIcon tab="companies" />}
              value={navCompany?.id ?? ""}
              placeholder={t("Valitse taloyhtiö")}
              ariaLabel={t("Taloyhtiö")}
              options={companies.map(company => ({ value: company.id, label: company.name }))}
              onChange={changeCompany}
            />
            <div className="nav-subs">
              {navCompany && canSeeTable("companies") && (
                <button
                  className={`nav-sub ${tab === "companies" && routeParam === navCompany.id ? "active" : ""}`}
                  onClick={() => navigate("companies", navCompany.id)}
                >
                  <TabIcon tab="companies" />
                  {t("Yhtiön tiedot")}
                </button>
              )}
              {navCompany && visibleNavGroups.map(group => {
                const open = !closedGroups.includes(group.key);
                // Suljetun ryhmän otsikossa näkyy sen laskurien summa, jotta odottavat asiat eivät jää piiloon.
                const hiddenCount = open ? 0 : group.tabs.reduce((sum, item) => sum + (navCounts[item] ?? 0), 0);
                return (
                <Fragment key={group.key}>
                  <button
                    className={`nav-label ${open ? "open" : ""}`}
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={open}
                    title={`${open ? t("Piilota") : t("Näytä")} ${group.label}`}
                  >
                    {group.label}
                    {hiddenCount > 0 && <b>{hiddenCount}</b>}
                    <svg
                      className="tab-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  {open && group.tabs.map(item => (
                    <button key={item} className={`nav-sub ${tab === item ? "active" : ""}`} onClick={() => setTab(item)}>
                      <TabIcon tab={item} />
                      {navItemTitles[item] ?? tabTitles[item]}
                      {navCounts[item] ? <b title={navCountTitles[item]}>{navCounts[item]}</b> : null}
                    </button>
                  ))}
                </Fragment>
                );
              })}
            </div>
          </div>
          )}
        </nav>

      </aside>

      <main className="main">
        <SystemAlertBanner />
        {restrictedNotice && !openTicketId && (
          <p className="sensitive-note active restricted-notice" role="status">
            <span>{restrictedNotice}</span>
            <button type="button" className="back-link" onClick={() => setRestrictedNotice("")}>{t("Sulje")}</button>
          </p>
        )}
        {/* Avattu tehtävä näytetään omana sivunaan listan tilalla; navigaatio pysyy vieressä käytössä. */}
        {openTicketId && tabAllowed && (selected ? (
          <TicketDrawer
            detail={selected}
            backLabel={`← ${tabTitles[tab]}`}
            onClose={closeTicket}
            onDecision={(d) => requestDecision(selected.ticket.id, d)}
            company={companies.find(company => company.id === selected.ticket.company_id)}
            companies={companies}
            onDraftSaved={(draft) => updateTicketDraft(selected.ticket.id, draft)}
            onChanged={() => load()}
            onDirtyChange={dirty => { ticketDirty.current = dirty; }}
            onDeleted={async () => {
              closeTicket();
              setSelected(null);
              await load();
            }}
          />
        ) : <div className="empty">{t("Ladataan…")}</div>)}

        {!openTicketId && tabAllowed && (
        <header>
          <div>
            {/* Toimiston nimi tulee isännöitsijätoimiston asetuksista ja päivittyy tallennettaessa. */}
            <p className="eyebrow">PLEISSI / {MANAGEMENT_OFFICE.name}</p>
            <h1>
              {tab === "reports" ? reportTabs.find(([key]) => key === reportsTab)?.[1]
                : tab === "data" && routeParam ? `${t("Data")} › ${navItemTitles[routeParam as TicketTab] ?? tabTitles[routeParam as TicketTab]}`
                : tabTitles[tab]}
            </h1>
          </div>
        </header>
        )}

        {openTicketId || !tabAllowed ? null : tab === "knowledge" || tab === "knowledge-ai" || tab === "knowledge-internal" ? (
          <Knowledge
            // Avain vaihtaa suodattimien ja haun tilan, kun siirrytään alasivulta toiselle.
            key={tab}
            audience={tab === "knowledge-ai" ? "ai" : tab === "knowledge-internal" ? "internal" : undefined}
            companyId={selectedCompany}
            companies={companies}
            initialEntryId={routeParam}
            onCompanyChange={changeCompany}
            onOpenEntry={entryId => navigate(tab, entryId ?? undefined)}
          />
        )
          : tab === "data" ? (
            routeParam ? (
              <DataTable
                key={routeParam}
                table={routeParam as TicketTab}
                onOpenCompany={companyId => { setNavCompanyId(companyId); navigate(routeParam as TicketTab); }}
              />
            ) : null
          )
          : tab === "search" ? (
            <SearchResults
              query={routeParam ?? ""}
              onOpenTicket={ticketId => navigate("tickets", ticketId)}
              onOpenKnowledge={(companyId, entryId) => { changeCompany(companyId); navigate("knowledge", entryId); }}
              onOpenResidents={companyId => { setNavCompanyId(companyId); navigate("residents"); }}
              onOpenAnnouncements={companyId => { setNavCompanyId(companyId); navigate("announcements"); }}
            />
          )
          : tab === "log" ? (
            <AuditLog />
          )
          : tab === "parking" ? (
            <ParkingSpaces key={navCompanyKey} companies={companies} defaultCompanyId={navCompanyKey} />
          )
          : tab === "announcements" ? (
            <Announcements
              key={navCompanyKey}
              companies={companyScope}
              defaultCompanyId={navCompanyKey}
              routeParam={routeParam}
              onNavigate={param => navigate("announcements", param ?? undefined)}
            />
          )
          : tab === "moves" ? (
            <MoveNotices key={navCompanyKey} companies={companyScope} defaultCompanyId={navCompanyKey} onChanged={() => void refreshNavCounts()} />
          )
          : tab === "renovations" ? (
            <RenovationNotices key={navCompanyKey} companies={companyScope} defaultCompanyId={navCompanyKey} onChanged={() => void refreshNavCounts()} />
          )
          : tab === "keys" ? (
            <KeyRegister key={navCompanyKey} companies={companyScope} defaultCompanyId={navCompanyKey} onChanged={() => void refreshNavCounts()} />
          )
          : tab === "meters" ? (
            <MeterReadings key={navCompanyKey} companies={companyScope} defaultCompanyId={navCompanyKey} />
          )
          : tab === "apartments" ? (
            <Apartments
              key={navCompanyKey}
              companyId={navCompanyKey}
              openApartmentId={routeParam}
              onOpenApartment={apartmentId => navigate("apartments", apartmentId ?? undefined)}
              onOpenResident={residentId => navigate("residents", residentId)}
            />
          )
          : tab === "waitlist" ? (
            <Waitlists key={navCompanyKey} companies={companyScope} defaultCompanyId={navCompanyKey} />
          )
          : tab === "sauna" || tab === "laundry" ? (
            <BookingCalendar
              // Avain vaihtaa kalenterin tilan, kun siirrytään saunasta pyykkitupaan.
              key={`${tab}-${navCompanyKey}`}
              resource={tab}
              companyId={selectedCompany}
              companies={companies}
              onCompanyChange={changeCompany}
              routeSlot={routeParam}
              onOpenSlot={slot => navigate(tab, slot ?? undefined)}
            />
          )
          : tab === "reports" ? (
            <ReportsHub
              tab={reportsTab}
              tickets={tickets}
              loading={loading}
              companyId={selectedCompany}
              companies={companies}
              onCompanyChange={changeCompany}
            />
          )
          : tab === "companies" ? (
            <Companies
              companies={companies}
              openCompanyId={routeParam}
              onOpenCompany={companyId => navigate("companies", companyId ?? undefined)}
              onChanged={async () => setCompanies(await api<Company[]>("/companies"))}
            />
          )
          : tab === "residents" ? (
            <Residents
              key={navCompanyKey}
              companyId={navCompanyKey}
              companies={companyScope}
              formCompanies={companies}
              openResidentId={routeParam}
              onResidentClosed={() => navigate("residents")}
              onOpenResident={residentId => navigate("residents", residentId)}
              onChanged={async () => setCompanies(await api<Company[]>("/companies"))}
            />
          )
          : tab === "settings" ? (
            <Settings
              key={`settings-${routeParam ?? ""}`}
              initialTab={routeParam === "office" ? "office" : "user"}
              onSaved={async () => setCompanies(await api<Company[]>("/companies"))}
            />
          ) : (
          <section className="content">
            {(tab === "my-tickets" || tab === "ai-handled" || tab === "unidentified") && (
              <a className="back-link" href="#/tickets">{t("← Kaikki tehtävät")}</a>
            )}
            {tab === "queue" && (
              <div className="queue-summary queue-summary-large">
                <button
                  title={t("Näytä tehtävät, joiden taloyhtiötä ei ole tunnistettu tai joilla ei ole käsittelijää")}
                  onClick={() => {
                    setStatusFilter(null);
                    setPriorityFilter(null);
                    setTypeFilter(null);
                    setDueFilter(null);
                    setTab("unidentified");
                  }}
                >
                  <span>{t("Tunnistamattomat")}</span>
                  <strong>{unidentifiedTickets.length}</strong>
                  <small>{t("tehtävää jonossa")}</small>
                </button>
                {ownStatusCounts.map(({ status, count }) => (
                  <button
                    key={status}
                    title={t("Näytä nämä tehtävät")}
                    onClick={() => {
                      setStatusFilter([status]);
                      setPriorityFilter(null);
                      setTypeFilter(null);
                      setDueFilter(null);
                      setTab("my-tickets");
                    }}
                  >
                    <span>{statusLabel(status)}</span>
                    <strong>{count}</strong>
                    <small>{count === 1 ? t("oma tehtävä") : t("omaa tehtävää")}</small>
                  </button>
                ))}
                <button
                  title={t("Avaa Remontit-osio")}
                  onClick={() => setTab("renovations")}
                >
                  <span>{t("Remontti-ilmoitukset")}</span>
                  <strong>{openRenovations.length}</strong>
                  <small>{openRenovations.length === 1 ? t("avoin remontti") : t("avointa remonttia")}</small>
                </button>
                <button
                  className={reminderTickets.length > 0 ? "reminder-box active" : "reminder-box"}
                  title={t("Näytä omat tehtävät, jotka vaativat huomiota")}
                  onClick={() => {
                    setStatusFilter(null);
                    setPriorityFilter(null);
                    setTypeFilter(null);
                    setDueFilter(["reminders"]);
                    setTab("my-tickets");
                  }}
                >
                  <span>{t("Muistutukset")}</span>
                  <strong>{reminderTickets.length}</strong>
                  <small>{t("vaatii huomiota")}</small>
                </button>
              </div>
            )}
            {tab === "queue" && (
              <div className="queue-heading-row">
                <h2 className="queue-subheading">
                  {t("Avoimet tehtäväsi")}
                  <b>{queueTickets.length}</b>
                </h2>
                {/* Sama pyöristetty valikko kuin tehtäväsivun kentissä. */}
                <div className="queue-sort">
                  <span>{t("Järjestys")}</span>
                  <FactDropdown
                    value={queueSort}
                    options={[
                      { value: "oldest", label: t("Vanhin ensin") },
                      { value: "newest", label: t("Uusin ensin") },
                      { value: "priority", label: t("Kiireellisin ensin") },
                      { value: "due", label: t("Määräaika ensin") }
                    ]}
                    onChange={value => changeQueueSort(value as QueueSort)}
                  />
                </div>
              </div>
            )}
            {tab !== "queue" && filtersOpen && (
            <div className="ticket-filters">
              {filterGroups.map(group => (
                <div className="filter-field" key={group.key}>
                  <span>{group.label}</span>
                  <MultiSelect value={group.value} options={group.options} onChange={group.onChange} ariaLabel={group.label} />
                </div>
              ))}
              {filtersActive && (
                <button className="clear-filters" onClick={() => {
                  setCompanyFilter(null);
                  setPriorityFilter(null);
                  setTypeFilter(null);
                  setStatusFilter(null);
                  setDueFilter(null);
                }}>{t("Tyhjennä suodattimet")}</button>
              )}
            </div>
            )}
            {!loading && tab !== "queue" && (
              <div className="filter-chips">
                <button
                  className={`filter-toggle ${filtersOpen || filtersActive ? "active" : ""}`}
                  onClick={() => setFiltersOpen(!filtersOpen)}
                  title={filtersOpen ? t("Piilota suodattimet") : t("Näytä suodattimet")}
                  aria-label={filtersOpen ? t("Piilota suodattimet") : t("Näytä suodattimet")}
                  aria-expanded={filtersOpen}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.200"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 5h18l-7 8.500V19l-4 2v-7.500z" />
                  </svg>
                  {filtersActive && <i />}
                </button>
                <button
                  className={`filter-toggle search-toggle ${searchOpen ? "active" : ""}`}
                  onClick={() => setSearchOpen(!searchOpen)}
                  title={searchOpen ? t("Sulje haku") : t("Hae sarakkeista")}
                  aria-label={searchOpen ? t("Sulje haku") : t("Hae sarakkeista")}
                  aria-expanded={searchOpen}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.200"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0" />
                    <path d="M21 21l-4.300-4.300" />
                  </svg>
                  {searchActive && <i />}
                </button>
                {activeFilters.map(filter => (
                  <span className="filter-chip" key={filter.key}>
                    <small>{filter.label}</small>
                    {filter.value}
                    <button onClick={filter.clear} title={t("Poista suodatin")} aria-label={t("Poista suodatin {0}", filter.label)}>×</button>
                  </span>
                ))}
                {tab === "tickets" && (
                  <button className="create-ticket" onClick={() => setCreating(true)}>{t("+ Luo tehtävä")}</button>
                )}
              </div>
            )}
            {!loading && tab !== "queue" && (
              <div className="ticket-row-header">
                {ticketColumns.map(column => {
                  const active = ticketSort?.key === column.key;
                  const sortButton = (
                    <button
                      key={column.key}
                      className={active ? "active" : ""}
                      onClick={() => sortTicketsBy(column.key)}
                      title={t("Järjestä sarakkeen {0} mukaan", column.label)}
                      aria-sort={active ? (ticketSort.descending ? "descending" : "ascending") : undefined}
                    >
                      {column.label}
                      <svg
                        className={active && !ticketSort.descending ? "up" : ""}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.500"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                  );
                  return sortButton;
                })}
              </div>
            )}
            {!loading && tab !== "queue" && searchOpen && (
              <div className="ticket-row-search">
                {ticketColumns.map(column => (
                  <input
                    key={column.key}
                    value={columnSearch[column.key] ?? ""}
                    onChange={event => setColumnSearch({ ...columnSearch, [column.key]: event.target.value })}
                    placeholder={t("Hae…")}
                    aria-label={t("Hae sarakkeesta {0}", column.label)}
                  />
                ))}
              </div>
            )}
            {loading ? <div className="empty">{t("Ladataan…")}</div> :
              pagedTickets.items.map(renderTicketCard)
            }
            {!loading && pagedTickets.pager}
            {!loading && visibleTickets.length === 0 && (
              <div className="empty">
                {emptyTicketMessages[tab] ?? t("Ei tehtäviä.")}
              </div>
            )}
            {!loading && tab === "queue" && (
              <>
                <h2 className="queue-subheading queue-subheading-section">
                  {t("Käsittelyssä olevat tehtäväsi")}
                  <b>{inProgressTickets.length}</b>
                </h2>
                {pagedInProgress.items.map(renderTicketCard)}
                {pagedInProgress.pager}
                {inProgressTickets.length === 0 && <div className="empty">{t("Sinulla ei ole käsittelyssä olevia tehtäviä.")}</div>}
              </>
            )}
          </section>
        )}
      </main>

      {creating && (
        <TicketCreateModal
          companies={companies}
          defaultCompanyId={selectedCompany}
          onClose={() => setCreating(false)}
          onSubmit={async (payload) => {
            await createTicket(payload);
          }}
        />
      )}

      {skipTicketId && (
        <SkipTicketModal
          onClose={() => setSkipTicketId(null)}
          onSubmit={confirmSkip}
        />
      )}

    </div>
  );
}
