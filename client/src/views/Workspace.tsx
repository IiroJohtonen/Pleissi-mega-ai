import { useEffect, useRef, useState } from "react";
import { NavToggle, TabIcon, usePaged } from "../components/common";
import { formatTicketNumber, priorityLabel, statusLabel, ticketAge, ticketStatuses } from "../format";
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
import { KeyRegister } from "./Keys";
import { Knowledge } from "./Knowledge";
import { MeterReadings } from "./Meters";
import { MoveNotices } from "./Moves";
import { ParkingSpaces } from "./Parking";
import { RenovationNotices } from "./Renovations";
import { Reports } from "./Reports";
import { Residents } from "./Residents";
import { type OfficeInfo, Settings } from "./Settings";
import { Waitlists } from "./Waitlists";

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
  const setTab = (next: TicketTab) => navigate(next);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [skipTicketId, setSkipTicketId] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  // Tilasuodatin on käytössä vain Kaikki tehtävät -näkymässä; muut näkymät on jo rajattu tilan mukaan.
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
  const [residentsOpen, setResidentsOpen] = useState(tab === "residents" || tab === "sauna" || tab === "laundry" || tab === "parking" || tab === "announcements" || tab === "moves" || tab === "renovations" || tab === "keys" || tab === "meters" || tab === "waitlist");
  const [myTicketsOpen, setMyTicketsOpen] = useState(true);

  // Alavalikko aukeaa itsestään, kun sen näkymään siirrytään muuta kautta (esim. päätöksen jälkeen).
  useEffect(() => {
    if (tab === "my-tickets" || tab === "ai-handled") setMyTicketsOpen(true);
    if (tab === "residents" || tab === "sauna" || tab === "laundry" || tab === "parking" || tab === "announcements" || tab === "moves" || tab === "renovations" || tab === "keys" || tab === "meters" || tab === "waitlist") setResidentsOpen(true);
  }, [tab]);

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

  async function decide(id: string, decision: "ai" | "human" | "skip", reason?: string) {
    await api(`/tickets/${id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision, actor: actorName(), reason })
    });
    if (decision === "human") {
      setTab("my-tickets");
    }
    await load();
  }

  function requestDecision(id: string, decision: "ai" | "human" | "skip") {
    if (decision === "skip") {
      setSkipTicketId(id);
      return;
    }
    void decide(id, decision);
  }

  async function confirmSkip(reason: string) {
    if (!skipTicketId) return;
    await decide(skipTicketId, "skip", reason);
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
  const sourceTickets = tab === "queue" ? queueTickets : tab === "my-tickets" ? myTickets : tab === "ai-handled" ? aiTickets : tickets;
  // Päätösjonossa ei ole suodattimia; ne koskevat vain tehtävälistoja.
  const visibleTickets = tab === "queue" ? queueTickets : sourceTickets.filter(ticket =>
    (priorityFilter === "all" || ticket.priority === priorityFilter)
    && (typeFilter === "all" || ticket.type === typeFilter)
    && (tab !== "tickets" || statusFilter === "all" || ticket.status === statusFilter)
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
      ? [{ key: "priority", label: "Prioriteetti", value: priorityLabel(priorityFilter), clear: () => setPriorityFilter("all") }]
      : []),
    ...(typeFilter !== "all"
      ? [{ key: "type", label: "Tyyppi", value: typeFilter, clear: () => setTypeFilter("all") }]
      : []),
    ...(tab === "tickets" && statusFilter !== "all"
      ? [{ key: "status", label: "Tila", value: statusLabel(statusFilter), clear: () => setStatusFilter("all") }]
      : []),
    ...(dueFilter !== "all"
      ? [{ key: "due", label: "Määräaika", value: "Myöhässä", clear: () => setDueFilter("all") }]
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
    || (tab === "tickets" && statusFilter !== "all");

  // Myöhässä olevat tehtävät kaikista yhtiöistä päätösjonon laskuria varten.
  const overdueCount = allCompanyTickets.filter(isOverdue).length;

  const statusCounts = ticketStatuses.map(status => ({
    status,
    count: allCompanyTickets.filter(ticket => ticket.status === status).length
  }));
  const oldestQueuedTicket = queueTickets.reduce<Ticket | null>((oldest, ticket) =>
    !oldest || Date.parse(ticket.created_at) < Date.parse(oldest.created_at) ? ticket : oldest
  , null);
  const ticketTypes = [...new Set(tickets.map(ticket => ticket.type))].sort((a, b) => a.localeCompare(b, "fi"));
  const activeCompany = companies.find(company => company.id === selectedCompany);
  const showResidentsLink = residentsOpen;

  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="#/queue" title="Päätösjonoon">
          <img src="/kotilo-logo.svg" alt="Kotilo" />
        </a>

        <nav>
          <button className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}>
            <TabIcon tab="queue" />
            Päätösjono
            <b>{queueTickets.length}</b>
          </button>
          <div className="nav-group">
            <button className={tab === "tickets" ? "active" : ""} onClick={() => setTab("tickets")}>
              <TabIcon tab="tickets" />
              Kaikki tehtävät
            </button>
            <NavToggle open={myTicketsOpen} label="omat tehtävät ja AI tehtävät" onToggle={() => setMyTicketsOpen(!myTicketsOpen)} />
          </div>
          {myTicketsOpen && (
            <>
              <button className={`nav-sub ${tab === "my-tickets" ? "active" : ""}`} onClick={() => setTab("my-tickets")}>
                <TabIcon tab="my-tickets" />
                Omat tehtävät
                <b>{myTickets.length}</b>
              </button>
              <button className={`nav-sub ${tab === "ai-handled" ? "active" : ""}`} onClick={() => setTab("ai-handled")}>
                <TabIcon tab="ai-handled" />
                AI tehtävät
                <b>{aiTickets.length}</b>
              </button>
            </>
          )}
          <button className={tab === "knowledge" ? "active" : ""} onClick={() => setTab("knowledge")}>
            <TabIcon tab="knowledge" />
            Dokumentaatio
          </button>
          <button className={tab === "reports" ? "active" : ""} onClick={() => setTab("reports")}>
            <TabIcon tab="reports" />
            Raportit
          </button>
          <div className="nav-group">
            <button className={tab === "companies" ? "active" : ""} onClick={() => setTab("companies")}>
              <TabIcon tab="companies" />
              Taloyhtiöt
            </button>
            <NavToggle open={showResidentsLink} label="taloyhtiöiden alasivut" onToggle={() => setResidentsOpen(!showResidentsLink)} />
          </div>
          {showResidentsLink && (
            <button className={`nav-sub ${tab === "residents" ? "active" : ""}`} onClick={() => setTab("residents")}>
              <TabIcon tab="residents" />
              Asukastietokanta
            </button>
          )}
          {showResidentsLink && (
            <button className={`nav-sub ${tab === "sauna" ? "active" : ""}`} onClick={() => setTab("sauna")}>
              <TabIcon tab="sauna" />
              Saunavuorot
            </button>
          )}
          {showResidentsLink && (
            <button className={`nav-sub ${tab === "laundry" ? "active" : ""}`} onClick={() => setTab("laundry")}>
              <TabIcon tab="laundry" />
              Pyykkitupavuorot
            </button>
          )}
          {showResidentsLink && (
            <button className={`nav-sub ${tab === "parking" ? "active" : ""}`} onClick={() => setTab("parking")}>
              <TabIcon tab="parking" />
              Autopaikat
            </button>
          )}
          {showResidentsLink && (
            <button className={`nav-sub ${tab === "announcements" ? "active" : ""}`} onClick={() => setTab("announcements")}>
              <TabIcon tab="announcements" />
              Tiedotteet
            </button>
          )}
          {showResidentsLink && (
            <button className={`nav-sub ${tab === "moves" ? "active" : ""}`} onClick={() => setTab("moves")}>
              <TabIcon tab="moves" />
              Muutot
            </button>
          )}
          {showResidentsLink && (
            <button className={`nav-sub ${tab === "renovations" ? "active" : ""}`} onClick={() => setTab("renovations")}>
              <TabIcon tab="renovations" />
              Remontit
            </button>
          )}
          {showResidentsLink && (
            <button className={`nav-sub ${tab === "keys" ? "active" : ""}`} onClick={() => setTab("keys")}>
              <TabIcon tab="keys" />
              Avaimet
            </button>
          )}
          {showResidentsLink && (
            <button className={`nav-sub ${tab === "meters" ? "active" : ""}`} onClick={() => setTab("meters")}>
              <TabIcon tab="meters" />
              Kulutuslukemat
            </button>
          )}
          {showResidentsLink && (
            <button className={`nav-sub ${tab === "waitlist" ? "active" : ""}`} onClick={() => setTab("waitlist")}>
              <TabIcon tab="waitlist" />
              Jonot
            </button>
          )}
        </nav>

        <div className="sidebar-footer">
          <button
            className={`settings-button ${tab === "settings" ? "active" : ""}`}
            onClick={() => setTab("settings")}
            title="Asetukset"
            aria-label="Asetukset"
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
              Kirjaudu ulos
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header>
          <div>
            <p className="eyebrow">KOTILO / ISÄNNÖITSIJÄ</p>
            <h1>{tabTitles[tab]}</h1>
          </div>
        </header>

        {tab === "knowledge" ? (
          <Knowledge
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
            <MoveNotices companies={companies} />
          )
          : tab === "renovations" ? (
            <RenovationNotices companies={companies} />
          )
          : tab === "keys" ? (
            <KeyRegister companies={companies} defaultCompanyId={selectedCompany} />
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
              <a className="back-link" href="#/tickets">← Kaikki tehtävät</a>
            )}
            {tab === "queue" && (
              <div className="queue-summary">
                <div>
                  <span>Jonossa</span>
                  <strong>{queueTickets.length}</strong>
                  <small>odottavaa tehtävää</small>
                </div>
                <div>
                  <span>Vanhin odottava</span>
                  <strong>{oldestQueuedTicket ? ticketAge(oldestQueuedTicket.created_at, clock) : "—"}</strong>
                  <small>{oldestQueuedTicket ? `Tehtävä #${formatTicketNumber(oldestQueuedTicket.ticket_number)}` : "Ei odottavia tehtäviä"}</small>
                </div>
                {statusCounts.map(({ status, count }) => (
                  <button
                    key={status}
                    title="Näytä nämä tehtävät"
                    onClick={() => {
                      setStatusFilter(status);
                      setPriorityFilter("all");
                      setTypeFilter("all");
                      setDueFilter("all");
                      setTab("tickets");
                    }}
                  >
                    <span>{statusLabel(status)}</span>
                    <strong>{count}</strong>
                    <small>{count === 1 ? "tehtävä" : "tehtävää"}</small>
                  </button>
                ))}
                <button
                  className={overdueCount > 0 ? "overdue" : ""}
                  title="Näytä myöhässä olevat tehtävät"
                  onClick={() => {
                    setStatusFilter("all");
                    setPriorityFilter("all");
                    setTypeFilter("all");
                    setDueFilter("overdue");
                    setTab("tickets");
                  }}
                >
                  <span>Myöhässä</span>
                  <strong>{overdueCount}</strong>
                  <small>määräaika mennyt</small>
                </button>
                <button className="create-ticket" onClick={() => setCreating(true)}>+ Luo tehtävä</button>
              </div>
            )}
            {tab !== "queue" && filtersOpen && (
            <div className="ticket-filters">
              <label>
                <span>Yhtiö</span>
                <select
                  value={selectedCompany}
                  onChange={event => changeCompany(event.target.value)}
                >
                  {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
                </select>
              </label>
              <label>
                <span>Prioriteetti</span>
                <select value={priorityFilter} onChange={event => setPriorityFilter(event.target.value)}>
                  <option value="all">Kaikki</option>
                  <option value="emergency">Hätä</option>
                  <option value="urgent">Kiireellinen</option>
                  <option value="normal">Normaali</option>
                  <option value="low">Matala</option>
                </select>
              </label>
              <label>
                <span>Tyyppi</span>
                <select value={typeFilter} onChange={event => setTypeFilter(event.target.value)}>
                  <option value="all">Kaikki</option>
                  {ticketTypes.map(type => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              {tab === "tickets" && (
                <label>
                  <span>Tila</span>
                  <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
                    <option value="all">Kaikki</option>
                    {ticketStatuses.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
                  </select>
                </label>
              )}
              <label>
                <span>Määräaika</span>
                <select value={dueFilter} onChange={event => setDueFilter(event.target.value)}>
                  <option value="all">Kaikki</option>
                  <option value="overdue">Myöhässä</option>
                </select>
              </label>
              {filtersActive && (
                <button className="clear-filters" onClick={() => {
                  setPriorityFilter("all");
                  setTypeFilter("all");
                  setStatusFilter("all");
                  setDueFilter("all");
                }}>Tyhjennä suodattimet</button>
              )}
            </div>
            )}
            {!loading && tab !== "queue" && (
              <div className="filter-chips">
                <button
                  className={`filter-toggle ${filtersOpen || filtersActive ? "active" : ""}`}
                  onClick={() => setFiltersOpen(!filtersOpen)}
                  title={filtersOpen ? "Piilota suodattimet" : "Näytä suodattimet"}
                  aria-label={filtersOpen ? "Piilota suodattimet" : "Näytä suodattimet"}
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
                  title={searchOpen ? "Sulje haku" : "Hae sarakkeista"}
                  aria-label={searchOpen ? "Sulje haku" : "Hae sarakkeista"}
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
                    <button onClick={filter.clear} title="Poista suodatin" aria-label={`Poista suodatin ${filter.label}`}>×</button>
                  </span>
                ))}
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
                      title={`Järjestä sarakkeen ${column.label} mukaan`}
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
                    placeholder="Hae…"
                    aria-label={`Hae sarakkeesta ${column.label}`}
                  />
                ))}
              </div>
            )}
            {loading ? <div className="empty">Ladataan…</div> :
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
                {emptyTicketMessages[tab] ?? "Ei tehtäviä."}
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

      {selected && (
        <TicketDrawer
          detail={selected}
          onClose={closeTicket}
          onDecision={(d) => requestDecision(selected.ticket.id, d)}
          company={companies.find(company => company.id === selected.ticket.company_id)}
          onDraftSaved={(draft) => updateTicketDraft(selected.ticket.id, draft)}
          onChanged={() => load()}
        />
      )}
    </div>
  );
}
