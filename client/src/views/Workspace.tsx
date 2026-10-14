import { Fragment, useEffect, useRef, useState } from "react";
import { NavToggle, TabIcon, usePaged } from "../components/common";
import { priorityLabel, statusLabel, ticketStatuses } from "../format";
import { emptyTicketMessages, navigate, paramIsTicket, parseRoute, tabTitles, useRoute } from "../routing";
import { actorName, api, logout, MANAGEMENT_OFFICE, type OfficeUser } from "../session";
import {
  assignableUsers, canAssignTickets, compareTickets, fetchTicketDetail, isOverdue, ticketColumns, ticketColumnText,
  type TicketSort, type TicketSortKey
} from "../tickets/ticket-utils";
import { TicketCard } from "../tickets/TicketCard";
import { TicketDrawer } from "../tickets/TicketDrawer";
import { SkipTicketModal, TicketCreateModal } from "../tickets/TicketModals";
import type { Company, Ticket, TicketDetail, TicketTab } from "../types";
import { Announcements } from "./Announcements";
import { AuditLog } from "./AuditLog";
import { BookingCalendar } from "./Bookings";
import { Companies } from "./Companies";
import { isKeyLate, KeyRegister } from "./Keys";
import { Knowledge } from "./Knowledge";
import { MeterReadings } from "./Meters";
import { MoveNotices } from "./Moves";
import { ParkingSpaces } from "./Parking";
import { RenovationNotices } from "./Renovations";
import { Reports } from "./Reports";
import { Residents } from "./Residents";
import { type OfficeInfo, Settings } from "./Settings";
import { Waitlists } from "./Waitlists";
import { t } from "../i18n";

// Taloyhtiöt-valikon alasivut ryhmiteltyinä.
const navGroups: { key: string; label: string; tabs: TicketTab[] }[] = [
  { key: "residents", label: t("Asukkaat"), tabs: ["residents", "moves", "waitlist"] },
  { key: "facilities", label: t("Tilat"), tabs: ["sauna", "laundry", "parking", "keys"] },
  { key: "notices", label: t("Ilmoitukset"), tabs: ["announcements", "renovations", "meters"] }
];
const NAV_GROUPS_KEY = "kotilo.closedNavGroups";
const subTabs = navGroups.flatMap(group => group.tabs);
// Tilat, joissa tehtävä on käsittelijänsä omissa tehtävissä.
const ownTicketStatuses = ["waiting_manager", "waiting_third_party"];

// Mitä alasivun laskuri tarkoittaa.
const navCountTitles: Partial<Record<TicketTab, string>> = {
  moves: t("Odottaa käsittelyä"),
  renovations: t("Odottaa käsittelyä"),
  keys: t("Palautus myöhässä")
};

export function Workspace({ user }: { user: OfficeUser }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [myTickets, setMyTickets] = useState<Ticket[]>([]);
  // Kaikkien yhtiöiden tehtävät päätösjonoa ja sen laskureita varten.
  const [allCompanyTickets, setAllCompanyTickets] = useState<Ticket[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [, setOfficeVersion] = useState(0);
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
        setOfficeVersion(version => version + 1);
      })
      .catch(() => undefined);
  }, []);
  const [selectedCompany, setSelectedCompany] = useState("demo-company");
  const [selected, setSelected] = useState<TicketDetail | null>(null);
  const { tab, param: routeParam } = useRoute();
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
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  // Tilasuodatin on käytössä Kaikki tehtävät- ja Omat tehtävät -näkymissä; muut näkymät on jo rajattu tilan mukaan.
  const [statusFilter, setStatusFilter] = useState("all");
  // Määräaikasuodatin: "overdue" näyttää vain myöhässä olevat tehtävät.
  const [dueFilter, setDueFilter] = useState("all");
  // Tehtävälistan järjestys sarakeotsikosta; null = palvelimen oletusjärjestys.
  const [ticketSort, setTicketSort] = useState<TicketSort | null>(null);
  // Tehtävälistoissa suodatinpalkki avataan sarakeotsikoiden suodatinkuvakkeesta.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Sarakekohtainen tekstihaku; hakurivi avataan suurennuslasista. Haut säilyvät, vaikka rivi suljetaan.
  const [searchOpen, setSearchOpen] = useState(false);
  const [columnSearch, setColumnSearch] = useState<Partial<Record<TicketSortKey, string>>>({});
  const [clock, setClock] = useState(Date.now());
  const [residentsOpen, setResidentsOpen] = useState(subTabs.includes(tab));
  const [myTicketsOpen, setMyTicketsOpen] = useState(true);
  const [knowledgeOpen, setKnowledgeOpen] = useState(true);
  // Puhelimella navigaatio on sivusta avautuva valikko; se sulkeutuu, kun näkymä vaihtuu.
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
  }, [tab, routeParam]);
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
    if (tab === "my-tickets" || tab === "ai-handled") setMyTicketsOpen(true);
    if (tab === "knowledge-ai" || tab === "knowledge-internal") setKnowledgeOpen(true);
    if (subTabs.includes(tab)) setResidentsOpen(true);
    // Suljettu ryhmä aukeaa, kun sen näkymään siirrytään.
    const group = navGroups.find(item => item.tabs.includes(tab));
    if (group) setClosedGroups(current => current.filter(key => key !== group.key));
  }, [tab]);

  // Alavalikon laskurit: käsittelyä odottavat muutto- ja remontti-ilmoitukset sekä myöhässä olevat avaimet.
  async function refreshNavCounts() {
    if (companies.length === 0) return;
    const lists = <T,>(resource: string) => Promise.all(companies.map(company =>
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
  }, [companies.length, tab, clock]);

  // silent = taustapäivitys: listaa ei vaihdeta hetkeksi "Ladataan…"-tilaan.
  async function load(companyId = selectedCompany, companyList = companies, silent = false) {
    if (!silent) setLoading(true);
    const companyQuery = `?companyId=${encodeURIComponent(companyId)}`;
    // Päätösjono kokoaa kaikkien yhtiöiden tehtävät; yhtiö, johon ei ole oikeutta, jää pois.
    const [allTickets, managedTickets, ...otherCompanies] = await Promise.all([
      api<Ticket[]>(`/tickets${companyQuery}`),
      api<Ticket[]>(`/my-tickets${companyQuery}`),
      ...companyList
        .filter(company => company.id !== companyId)
        .map(company => api<Ticket[]>(`/tickets?companyId=${encodeURIComponent(company.id)}`).catch(() => [] as Ticket[]))
    ]);
    setTickets(allTickets);
    setMyTickets(managedTickets);
    setAllCompanyTickets([...allTickets, ...otherCompanies.flat()]);
    setLoading(false);

    // Päivitetään avoin tehtävä osoitteen perusteella, jotta juuri suljettu paneeli ei aukea uudelleen.
    const route = parseRoute();
    const refreshId = paramIsTicket(route.tab) ? route.param : null;
    if (refreshId && companyId === selectedCompany) {
      const detail = await fetchTicketDetail(refreshId);
      const current = parseRoute();
      if (paramIsTicket(current.tab) && current.param === refreshId) setSelected(detail);
    }
  }

  useEffect(() => {
    async function initialize() {
      const availableCompanies = await api<Company[]>("/companies");
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
    setTickets(prev => prev.map(ticket => ticket.id === ticketId ? { ...ticket, draft, updated_at: updatedAt } : ticket));
    setMyTickets(prev => prev.map(ticket => ticket.id === ticketId ? { ...ticket, draft, updated_at: updatedAt } : ticket));
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
        console.error(error);
        if (!cancelled) navigate(tab);
      });
    return () => {
      cancelled = true;
    };
  }, [openTicketId]);

  function closeTicket() {
    if (openTicketId) navigate(tab);
  }

  function changeCompany(companyId: string) {
    closeTicket();
    setSelectedCompany(companyId);
    load(companyId).catch(console.error);
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
    residentName?: string;
    apartmentNumber?: string;
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

  const queueTickets = allCompanyTickets
    .filter(ticket => ticket.status === "open")
    .sort((a, b) => compareTickets(a, b, "priority") || compareTickets(b, a, "created"));
  const aiTickets = tickets.filter(ticket => ticket.status === "waiting_third_party" && ticket.ai_action === "ai");
  const statusFilterTab = tab === "tickets" || tab === "my-tickets";
  const sourceTickets = tab === "queue" ? queueTickets : tab === "my-tickets" ? myTickets : tab === "ai-handled" ? aiTickets : tickets;
  // Päätösjonossa ei ole suodattimia; ne koskevat vain tehtävälistoja.
  const visibleTickets = tab === "queue" ? queueTickets : sourceTickets.filter(ticket =>
    (priorityFilter === "all" || ticket.priority === priorityFilter)
    && (typeFilter === "all" || ticket.type === typeFilter)
    && (!statusFilterTab || statusFilter === "all" || ticket.status === statusFilter)
    && (dueFilter === "all" || isOverdue(ticket))
    && ticketColumns.every(column => {
      const search = (columnSearch[column.key] ?? "").trim().toLowerCase();
      return !search || ticketColumnText(ticket, column.key).toLowerCase().includes(search);
    })
  );
  const searchActive = Object.values(columnSearch).some(value => value?.trim());

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
    ...(priorityFilter !== "all"
      ? [{ key: "priority", label: t("Prioriteetti"), value: priorityLabel(priorityFilter), clear: () => setPriorityFilter("all") }]
      : []),
    ...(typeFilter !== "all"
      ? [{ key: "type", label: t("Tyyppi"), value: t(typeFilter), clear: () => setTypeFilter("all") }]
      : []),
    ...(statusFilterTab && statusFilter !== "all"
      ? [{ key: "status", label: t("Tila"), value: statusLabel(statusFilter), clear: () => setStatusFilter("all") }]
      : []),
    ...(dueFilter !== "all"
      ? [{ key: "due", label: t("Määräaika"), value: t("Myöhässä"), clear: () => setDueFilter("all") }]
      : [])
  ];
  const listedTickets = ticketSort && tab !== "queue"
    ? [...visibleTickets].sort((a, b) =>
        compareTickets(a, b, ticketSort.key) * (ticketSort.descending ? -1 : 1))
    : visibleTickets;

  const pagedTickets = usePaged(listedTickets, [
    tab, selectedCompany, priorityFilter, typeFilter, statusFilter, dueFilter,
    JSON.stringify(columnSearch), ticketSort?.key, ticketSort?.descending
  ].join("|"));

  // Ensimmäinen painallus: uusin tai suurin numero ensin, muut sarakkeet nousevasti. Toinen kääntää suunnan.
  function sortTicketsBy(key: TicketSortKey) {
    setTicketSort(current => current?.key === key
      ? { key, descending: !current.descending }
      : { key, descending: key === "created" || key === "updated" || key === "number" });
  }

  const filtersActive = priorityFilter !== "all" || typeFilter !== "all" || dueFilter !== "all"
    || (statusFilterTab && statusFilter !== "all");

  // Päätösjonon laskurit: käyttäjän omat tehtävät kaikista yhtiöistä tiloittain.
  const ownStatusCounts = ownTicketStatuses.map(status => ({
    status,
    count: allCompanyTickets.filter(ticket => ticket.assignee_id === user.id && ticket.status === status).length
  }));
  const ticketTypes = [...new Set(tickets.map(ticket => ticket.type))].sort((a, b) => a.localeCompare(b, "fi"));
  const activeCompany = companies.find(company => company.id === selectedCompany);
  const showResidentsLink = residentsOpen;

  return (
    <div className={`app ${navOpen ? "nav-open" : ""}`}>
      <div className="mobile-bar">
        <button className="mobile-menu" onClick={() => setNavOpen(true)} aria-label={t("Avaa valikko")} aria-expanded={navOpen}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 6h16" />
            <path d="M4 12h16" />
            <path d="M4 18h16" />
          </svg>
        </button>
        <img src="/kotilo-logo.svg" alt="Kotilo" />
        <strong>{tabTitles[tab]}</strong>
      </div>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className="sidebar">
        <button className="mobile-nav-close" onClick={() => setNavOpen(false)} aria-label={t("Sulje valikko")}>×</button>
        <a className="brand" href="#/queue" title={t("Päätösjonoon")}>
          <img src="/kotilo-logo.svg" alt="Kotilo" />
        </a>

        <nav>
          <button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}>
            <TabIcon tab="queue" />
            {t("Päätösjono")}
            <b>{queueTickets.length}</b>
          </button>
          <div className="nav-group">
            <button className={tab === "tickets" ? "active" : ""} onClick={() => setTab("tickets")}>
              <TabIcon tab="tickets" />
              {t("Kaikki tehtävät")}
            </button>
            <NavToggle open={myTicketsOpen} label={t("omat tehtävät ja AI tehtävät")} onToggle={() => setMyTicketsOpen(!myTicketsOpen)} />
          </div>
          {myTicketsOpen && (
            <>
              <button className={`nav-sub ${tab === "my-tickets" ? "active" : ""}`} onClick={() => setTab("my-tickets")}>
                <TabIcon tab="my-tickets" />
                {t("Omat tehtävät")}
                <b>{myTickets.length}</b>
              </button>
              <button className={`nav-sub ${tab === "ai-handled" ? "active" : ""}`} onClick={() => setTab("ai-handled")}>
                <TabIcon tab="ai-handled" />
                {t("AI tehtävät")}
                <b>{aiTickets.length}</b>
              </button>
            </>
          )}
          <div className="nav-group">
            <button className={tab === "knowledge" ? "active" : ""} onClick={() => setTab("knowledge")}>
              <TabIcon tab="knowledge" />
              {t("Dokumentaatio")}
            </button>
            <NavToggle open={knowledgeOpen} label={t("AI dokumentaatio ja sisäinen dokumentaatio")} onToggle={() => setKnowledgeOpen(!knowledgeOpen)} />
          </div>
          {knowledgeOpen && (
            <>
              <button className={`nav-sub ${tab === "knowledge-ai" ? "active" : ""}`} onClick={() => setTab("knowledge-ai")}>
                <TabIcon tab="knowledge-ai" />
                {t("AI dokumentaatio")}
              </button>
              <button className={`nav-sub ${tab === "knowledge-internal" ? "active" : ""}`} onClick={() => setTab("knowledge-internal")}>
                <TabIcon tab="knowledge-internal" />
                {t("Sisäinen dokumentaatio")}
              </button>
            </>
          )}
          <button className={tab === "reports" ? "active" : ""} onClick={() => setTab("reports")}>
            <TabIcon tab="reports" />
            {t("Raportit")}
          </button>
          <div className="nav-group">
            <button className={tab === "companies" ? "active" : ""} onClick={() => setTab("companies")}>
              <TabIcon tab="companies" />
              {t("Taloyhtiöt")}
            </button>
            <NavToggle open={showResidentsLink} label={t("taloyhtiöiden alasivut")} onToggle={() => setResidentsOpen(!showResidentsLink)} />
          </div>
          {showResidentsLink && (
            <div className="nav-subs">
              {navGroups.map(group => {
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
                      {tabTitles[item]}
                      {navCounts[item] ? <b title={navCountTitles[item]}>{navCounts[item]}</b> : null}
                    </button>
                  ))}
                </Fragment>
                );
              })}
            </div>
          )}
        </nav>

        <div className="sidebar-footer">
          <button
            className={`settings-button ${tab === "settings" ? "active" : ""}`}
            onClick={() => setTab("settings")}
            title={t("Asetukset")}
            aria-label={t("Asetukset")}
          >
            <TabIcon tab="settings" />
          </button>
          <div className="company">
            <small>{MANAGEMENT_OFFICE.name}</small>
            <strong>{user.name}</strong>
            <button
              className="logout"
              onClick={logout}
            >
              {t("Kirjaudu ulos")}
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        {/* Avattu tehtävä näytetään omana sivunaan listan tilalla; navigaatio pysyy vieressä käytössä. */}
        {openTicketId && (selected ? (
          <TicketDrawer
            detail={selected}
            backLabel={`← ${tabTitles[tab]}`}
            onClose={closeTicket}
            onDecision={(d) => requestDecision(selected.ticket.id, d)}
            company={companies.find(company => company.id === selected.ticket.company_id)}
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

        {!openTicketId && (
        <header>
          <div>
            <p className="eyebrow">{t("KOTILO / ISÄNNÖITSIJÄ")}</p>
            <h1>{tabTitles[tab]}</h1>
          </div>
        </header>
        )}

        {openTicketId ? null : tab === "knowledge" || tab === "knowledge-ai" || tab === "knowledge-internal" ? (
          <Knowledge
            // Avain vaihtaa suodattimien ja haun tilan, kun siirrytään alasivulta toiselle.
            key={tab}
            audience={tab === "knowledge-ai" ? "ai" : tab === "knowledge-internal" ? "internal" : undefined}
            companyId={selectedCompany}
            companies={companies}
            initialEntryId={routeParam}
            onCompanyChange={changeCompany}
          />
        )
          : tab === "log" ? (
            <AuditLog />
          )
          : tab === "parking" ? (
            <ParkingSpaces companies={companies} defaultCompanyId={selectedCompany} />
          )
          : tab === "announcements" ? (
            <Announcements companies={companies} defaultCompanyId={selectedCompany} />
          )
          : tab === "moves" ? (
            <MoveNotices companies={companies} onChanged={() => void refreshNavCounts()} />
          )
          : tab === "renovations" ? (
            <RenovationNotices companies={companies} onChanged={() => void refreshNavCounts()} />
          )
          : tab === "keys" ? (
            <KeyRegister companies={companies} defaultCompanyId={selectedCompany} onChanged={() => void refreshNavCounts()} />
          )
          : tab === "meters" ? (
            <MeterReadings companies={companies} defaultCompanyId={selectedCompany} />
          )
          : tab === "waitlist" ? (
            <Waitlists companies={companies} />
          )
          : tab === "sauna" || tab === "laundry" ? (
            <BookingCalendar
              // Avain vaihtaa kalenterin tilan, kun siirrytään saunasta pyykkitupaan.
              key={tab}
              resource={tab}
              companyId={selectedCompany}
              companies={companies}
              onCompanyChange={changeCompany}
            />
          )
          : tab === "reports" ? (
            <Reports
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
              companyId={selectedCompany}
              companies={companies}
              onCompanyChange={changeCompany}
              onChanged={async () => setCompanies(await api<Company[]>("/companies"))}
            />
          )
          : tab === "settings" ? (
            <Settings
              company={activeCompany}
              onSaved={async () => setCompanies(await api<Company[]>("/companies"))}
            />
          ) : (
          <section className="content">
            {(tab === "my-tickets" || tab === "ai-handled") && (
              <a className="back-link" href="#/tickets">{t("← Kaikki tehtävät")}</a>
            )}
            {tab === "queue" && (
              <div className="queue-summary queue-summary-large">
                <div>
                  <span>{t("Jonossa")}</span>
                  <strong>{queueTickets.length}</strong>
                  <small>{t("odottavaa tehtävää")}</small>
                </div>
                {ownStatusCounts.map(({ status, count }) => (
                  <button
                    key={status}
                    title={t("Näytä nämä tehtävät")}
                    onClick={() => {
                      setStatusFilter(status);
                      setPriorityFilter("all");
                      setTypeFilter("all");
                      setDueFilter("all");
                      setTab("my-tickets");
                    }}
                  >
                    <span>{statusLabel(status)}</span>
                    <strong>{count}</strong>
                    <small>{count === 1 ? t("oma tehtävä") : t("omaa tehtävää")}</small>
                  </button>
                ))}
              </div>
            )}
            {tab !== "queue" && filtersOpen && (
            <div className="ticket-filters">
              <label>
                <span>{t("Yhtiö")}</span>
                <select
                  value={selectedCompany}
                  onChange={event => changeCompany(event.target.value)}
                >
                  {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
                </select>
              </label>
              <label>
                <span>{t("Prioriteetti")}</span>
                <select value={priorityFilter} onChange={event => setPriorityFilter(event.target.value)}>
                  <option value="all">{t("Kaikki")}</option>
                  <option value="emergency">{t("Hätä")}</option>
                  <option value="urgent">{t("Kiireellinen")}</option>
                  <option value="normal">{t("Normaali")}</option>
                  <option value="low">{t("Matala")}</option>
                </select>
              </label>
              <label>
                <span>{t("Tyyppi")}</span>
                <select value={typeFilter} onChange={event => setTypeFilter(event.target.value)}>
                  <option value="all">{t("Kaikki")}</option>
                  {ticketTypes.map(type => <option key={type} value={type}>{t(type)}</option>)}
                </select>
              </label>
              {statusFilterTab && (
                <label>
                  <span>{t("Tila")}</span>
                  <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
                    <option value="all">{t("Kaikki")}</option>
                    {(tab === "my-tickets" ? ownTicketStatuses : ticketStatuses).map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
                  </select>
                </label>
              )}
              <label>
                <span>{t("Määräaika")}</span>
                <select value={dueFilter} onChange={event => setDueFilter(event.target.value)}>
                  <option value="all">{t("Kaikki")}</option>
                  <option value="overdue">{t("Myöhässä")}</option>
                </select>
              </label>
              {filtersActive && (
                <button className="clear-filters" onClick={() => {
                  setPriorityFilter("all");
                  setTypeFilter("all");
                  setStatusFilter("all");
                  setDueFilter("all");
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
              pagedTickets.items.map(ticket => (
                <TicketCard
                  key={ticket.id}
                  ticket={ticket}
                  compact={tab !== "queue"}
                  companyName={companies.find(company => company.id === ticket.company_id)?.name}
                  users={assignableUsers(companies.find(company => company.id === ticket.company_id), officeUsers)}
                  allUsers={officeUsers}
                  canAssign={canAssignTickets(companies.find(company => company.id === ticket.company_id))}
                  onAssign={assigneeId => assignTicket(ticket.id, assigneeId)}
                  onOpen={() => openTicket(ticket.id)}
                  onDecision={(d) => requestDecision(ticket.id, d)}
                />
              ))
            }
            {!loading && pagedTickets.pager}
            {!loading && visibleTickets.length === 0 && (
              <div className="empty">
                {emptyTicketMessages[tab] ?? t("Ei tehtäviä.")}
              </div>
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
