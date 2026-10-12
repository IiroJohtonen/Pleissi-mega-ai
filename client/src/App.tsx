import { type FormEvent, useEffect, useRef, useState, type ReactNode } from "react";

const API = "http://localhost:4000/api";

// Alustaa käyttävä isännöitsijätoimisto. Testitieto, kunnes toimistot tulevat kirjautumisen mukana.
const MANAGEMENT_OFFICE = {
  name: "Pohjantähti Isännöinti Oy",
  email: "toimisto@pohjantahti-isannointi.fi"
};

type OfficeUser = { id: string; name: string; email: string; role: string };
type ResidentAccount = {
  id: string;
  name: string;
  email: string;
  companyId: string;
  companyName: string;
  apartmentNumber: string;
};

// kind "resident" = asukas, joka näkee vain asukasportaalin.
type Session = { token: string; user: OfficeUser; kind?: "resident"; resident?: ResidentAccount };

const USER_ROLES = ["Pääkäyttäjä", "Isännöitsijä", "Asiakaspalvelu"];
const SESSION_KEY = "kiito.session";

// Kirjautunut käyttäjä ja istuntotunniste. Säilyy selaimessa, jotta sivun päivitys ei kirjaa ulos.
let session: Session | null = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return stored?.token && stored?.user ? stored as Session : null;
  } catch {
    return null;
  }
})();

const sessionListeners = new Set<() => void>();

function setSession(next: Session | null) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Selaimen tallennustila ei ole käytössä; istunto säilyy vain tämän sivulatauksen.
  }
  sessionListeners.forEach(listener => listener());
}

// Käyttäjien hallinta ja asetukset kuuluvat vain pääkäyttäjälle; palvelin tarkistaa saman.
function isAdmin() {
  return session?.user.role === "Pääkäyttäjä";
}

// Taloyhtiöiden tiedot, tietopankki, tiedotteet, muuttojen hyväksyntä, laskutusmerkinnät, loki ja
// asukkaan tietojen vienti ja poisto kuuluvat isännöitsijälle ja pääkäyttäjälle; palvelin tarkistaa saman.
function isManager() {
  return session?.user.role === "Isännöitsijä" || isAdmin();
}

// Lokiin ja muistiinpanoihin kirjattava tekijä.
function actorName() {
  return session?.user.name ?? "Isännöitsijä";
}

// Latauslinkki ei voi lähettää kirjautumisotsaketta, joten tunniste kulkee osoitteessa.
function fileUrl(path: string) {
  return `${API}${path}?token=${encodeURIComponent(session?.token ?? "")}`;
}

type Ticket = {
  id: string;
  ticket_number?: number;
  company_id: string;
  // Käsittelijä: toimiston käyttäjän tunniste.
  assignee_id?: string | null;
  apartment_number?: string;
  resident_name?: string;
  type: string;
  priority: string;
  status: string;
  subject: string;
  summary: string;
  source_channel: string;
  ai_action: string;
  ai_reason: string;
  // Määräaika muodossa VVVV-KK-PP; puuttuu, jos sitä ei ole asetettu.
  due_date?: string | null;
  // 1, kun asukas on vastannut eikä hänelle ole vielä vastattu.
  has_new_reply?: number;
  // 1, kun tehtävälle on pyydetty AI-ehdotus.
  ai_suggested?: number;
  knowledge_source_id?: string | null;
  knowledge_source_title?: string | null;
  draft?: string;
  created_at: string;
  updated_at?: string;
};

type Company = {
  id: string;
  name: string;
  email_address: string;
  business_id?: string;
  address?: string;
  phone?: string;
  maintenance_name?: string;
  maintenance_phone?: string;
  maintenance_email?: string;
  maintenance_emergency_phone?: string;
  // Vastuuisännöitsijä: toimiston käyttäjän tunniste ja nimi.
  manager_id?: string | null;
  manager_name?: string | null;
  // Taloyhtiön muut isännöitsijät (ilman vastuuisännöitsijää).
  manager_ids?: string[];
  resident_count?: number;
};

type KnowledgeEntry = {
  id: string;
  title: string;
  // Pilkuilla erotetut avainsanat.
  tags?: string;
  content: string;
  content_length: number;
  kind: "fact" | "document";
  valid_from: string | null;
  valid_until: string | null;
  file_name: string | null;
  version: number;
  state: string;
  created_at: string;
};

type KnowledgeDetail = KnowledgeEntry & {
  status: string;
  company_name: string;
  versions: KnowledgeEntry[];
};

type GmailStatus = {
  connected: boolean;
  emailAddress?: string;
  canSend?: boolean;
};

type WorkOrder = {
  id: string;
  ticket_id: string;
  contractor_name: string;
  contractor_email: string;
  description: string;
  status: "ordered" | "done";
  email_sent: number;
  ordered_by: string;
  ordered_at: string;
  done_by: string | null;
  done_at: string | null;
  ticket_subject?: string;
  ticket_number?: number;
};

type TicketDetail = {
  ticket: Ticket & { company_name?: string };
  messages: { id: string; direction: string; sender: string; subject: string; body: string; created_at: string; channel?: string }[];
  audit: { id: string; actor: string; action: string; details: string; created_at: string }[];
  reporters: { id: string; name: string; email?: string; apartment_number?: string }[];
  apartments: { id: string; apartment_number: string; address: string }[];
  notes: { id: string; author: string; body: string; created_at: string }[];
  workOrders: WorkOrder[];
  // Taloyhtiön huoltoyhtiö, jolle työtilaus lähetetään.
  contractor: { name: string; email: string; phone: string } | null;
  attachments: { id: string; filename: string; mime_type: string; size: number; created_at: string; direction?: string }[];
};

type TicketTab = "queue" | "tickets" | "my-tickets" | "ai-handled" | "knowledge" | "reports" | "companies" | "residents" | "sauna" | "laundry" | "parking" | "announcements" | "moves" | "waitlist" | "settings" | "log";

const ticketTabs: TicketTab[] = ["queue", "tickets", "my-tickets", "ai-handled", "knowledge", "reports", "companies", "residents", "sauna", "laundry", "parking", "announcements", "moves", "waitlist", "settings", "log"];

// Paikkamerkkikuvakkeet näkymille (24×24, viivapiirros).
const tabIcons: Record<TicketTab, string[]> = {
  queue: [
    "M22 12h-6l-2 3h-4l-2-3H2",
    "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
  ],
  "my-tickets": [
    "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2",
    "M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0"
  ],
  "ai-handled": ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
  tickets: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  knowledge: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  reports: ["M18 20V10", "M12 20V4", "M6 20v-6"],
  log: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  sauna: ["M12 2c1 3 4.500 5 4.500 9.500a4.500 4.500 0 0 1-9 0c0-1.600.6-2.800 1.600-3.800C9.300 9.500 9.800 6 12 2z"],
  moves: [
    "M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2",
    "M15 18H9",
    "M19 18h2a1 1 0 0 0 1-1v-3.650a1 1 0 0 0-.220-.624l-3.480-4.350A1 1 0 0 0 17.520 8H14",
    "M15 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
    "M5 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0"
  ],
  waitlist: [
    "M10 6h11",
    "M10 12h11",
    "M10 18h11",
    "M4 6h1v4",
    "M4 10h2",
    "M6 18H4c0-1 2-2 2-3s-1-1.500-2-1"
  ],
  announcements: [
    "m3 11 18-5v12L3 14v-3z",
    "M11.6 16.8a3 3 0 1 1-5.8-1.6"
  ],
  parking: [
    "M5 17h14v-5l-1.600-4.500A2 2 0 0 0 15.500 6h-7a2 2 0 0 0-1.900 1.500L5 12z",
    "M5 17v2h2v-2",
    "M17 17v2h2v-2",
    "M8 13.500h.01",
    "M16 13.500h.01"
  ],
  laundry: [
    "M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
    "M8 13.500a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
    "M7.500 6.500h.01"
  ],
  companies: [
    "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    "M9 22V12h6v10"
  ],
  residents: [
    "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2",
    "M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
    "M23 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75"
  ],
  settings: [
    "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
  ]
};

function TabIcon({ tab }: { tab: TicketTab }) {
  return (
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
      {tabIcons[tab].map(d => <path key={d} d={d} />)}
    </svg>
  );
}

function NavToggle({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  const title = `${open ? "Piilota" : "Näytä"} ${label}`;
  return (
    <button
      className={`nav-toggle ${open ? "open" : ""}`}
      onClick={onToggle}
      title={title}
      aria-label={title}
      aria-expanded={open}
    >
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
  );
}

type Route = { tab: TicketTab; param: string | null };

// Näkymä luetaan osoitteen hash-osasta (esim. #/companies/abc), jotta selaimen
// takaisin- ja eteenpäin-painikkeet liikkuvat näkymien välillä.
function parseRoute(): Route {
  const [tab, param] = window.location.hash.replace(/^#\/?/, "").split("/");
  return ticketTabs.includes(tab as TicketTab)
    ? { tab: tab as TicketTab, param: param ? decodeURIComponent(param) : null }
    : { tab: "queue", param: null };
}

// Osoitteen jälkimmäinen osa on tehtävän tunniste vain tehtävänäkymissä; Taloyhtiöissä se on
// yhtiön ja Dokumentaatiossa dokumentin tunniste.
function paramIsTicket(tab: TicketTab) {
  return tab === "queue" || tab === "tickets" || tab === "my-tickets" || tab === "ai-handled";
}

function navigate(tab: TicketTab, param?: string) {
  window.location.hash = param ? `/${tab}/${encodeURIComponent(param)}` : `/${tab}`;
}

function useRoute() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route;
}

type Resident = {
  id: string;
  name: string;
  email?: string;
  apartment_number: string;
  address: string;
  // 1, kun asukkaalle on asetettu salasana ja hän voi kirjautua asukasportaaliin.
  has_password?: number;
  // Täytetään selaimessa, kun asukkaat haetaan kaikista taloyhtiöistä.
  company_id?: string;
  company_name?: string;
};

const tabTitles: Record<TicketTab, string> = {
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

const emptyTicketMessages: Partial<Record<TicketTab, string>> = {
  queue: "Ei päätösjonoon sopivia tehtäviä.",
  "my-tickets": "Ei omia tehtäviä.",
  "ai-handled": "Ei AI:n hoidossa olevia tehtäviä."
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
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
function logout() {
  // Tunniste luetaan myös selaimen tallennuksesta: kehityspalvelimen päivittäessä koodia sivun ollessa
  // auki muistissa oleva istunto voi olla vanhentunut kopio.
  let token = session?.token;
  try {
    token = token ?? JSON.parse(localStorage.getItem(SESSION_KEY) || "null")?.token;
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

async function fetchTicketDetail(id: string): Promise<TicketDetail> {
  const detail = await api<Partial<TicketDetail> & Pick<TicketDetail, "ticket">>(`/tickets/${id}`);
  return {
    ticket: detail.ticket,
    messages: detail.messages ?? [],
    audit: detail.audit ?? [],
    reporters: detail.reporters ?? [],
    apartments: detail.apartments ?? [],
    notes: detail.notes ?? [],
    attachments: detail.attachments ?? [],
    workOrders: detail.workOrders ?? [],
    contractor: detail.contractor ?? null
  };
}

const ticketPriorities = ["emergency", "urgent", "normal", "low"];
const ticketTypeOptions = ["Kysymys", "Ilmoitus", "Pyyntö", "Toimenpide", "Vikailmoitus", "Muutto", "Muu"];

function priorityLabel(priority: string) {
  return {
    emergency: "Hätä",
    urgent: "Kiireellinen",
    normal: "Normaali",
    low: "Matala"
  }[priority] || priority;
}

type TicketSortKey = "number" | "subject" | "priority" | "type" | "contact" | "status" | "created" | "updated";
type TicketSort = { key: TicketSortKey; descending: boolean };

// Tehtävälistan sarakkeet samassa järjestyksessä kuin rivin kentät.
const ticketColumns: { key: TicketSortKey; label: string }[] = [
  { key: "number", label: "Numero" },
  { key: "subject", label: "Aihe" },
  { key: "priority", label: "Prioriteetti" },
  { key: "type", label: "Tyyppi" },
  { key: "contact", label: "Yhteyshenkilö" },
  { key: "status", label: "Tila" },
  { key: "created", label: "Luotu" },
  { key: "updated", label: "Muokattu" }
];

const priorityRank: Record<string, number> = { emergency: 0, urgent: 1, normal: 2, low: 3 };

// Tehtävä on myöhässä, kun se on kesken ja määräaika on mennyt.
function isOverdue(ticket: Ticket) {
  return ticket.status !== "closed" && Boolean(ticket.due_date)
    && (ticket.due_date as string) < new Date().toLocaleDateString("sv-SE");
}

function compareTickets(a: Ticket, b: Ticket, key: TicketSortKey) {
  switch (key) {
    case "number": return (a.ticket_number ?? 0) - (b.ticket_number ?? 0);
    case "subject": return a.subject.localeCompare(b.subject, "fi");
    case "priority": return (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
    case "type": return a.type.localeCompare(b.type, "fi");
    case "contact":
      return (a.resident_name || a.apartment_number || "").localeCompare(b.resident_name || b.apartment_number || "", "fi");
    case "status": return statusLabel(a.status).localeCompare(statusLabel(b.status), "fi");
    case "created": return Date.parse(a.created_at) - Date.parse(b.created_at);
    case "updated":
      return Date.parse(a.updated_at || a.created_at) - Date.parse(b.updated_at || b.created_at);
  }
}

// Sarakkeessa näkyvä teksti, josta sarakekohtainen haku etsii.
function ticketColumnText(ticket: Ticket, key: TicketSortKey) {
  switch (key) {
    case "number": return `#${formatTicketNumber(ticket.ticket_number)}`;
    case "subject": return `${ticket.subject} ${ticket.summary}`;
    case "priority": return priorityLabel(ticket.priority);
    case "type": return ticket.type;
    case "contact": return ticket.resident_name || ticket.apartment_number || "Ei yhteyshenkilöä";
    case "status": return statusLabel(ticket.status);
    case "created": return formatDate(ticket.created_at);
    case "updated": return formatDate(ticket.updated_at || ticket.created_at);
  }
}

const ticketStatuses = ["open", "waiting_manager", "waiting_third_party", "closed"];

function statusLabel(status: string) {
  return {
    open: "Avoin",
    waiting_manager: "Odottaa isännöitsijää",
    waiting_third_party: "Odottaa kolmatta osapuolta",
    closed: "Suljettu"
  }[status] || status;
}

function channelLabel(channel?: string) {
  if (!channel) return "Tuntematon kanava";
  return {
    email: "Sähköposti",
    portal: "Portaali",
    quick_note: "Pikamuistio",
    contractor: "Huoltoyhtiö",
    manual: "Manuaalinen"
  }[channel] || channel;
}

function actionLabel(action: string) {
  return {
    ticket_created: "Tehtävä luotu",
    ticket_created_manual: "Tehtävä luotu käsin",
    ticket_created_portal: "Asukas loi tehtävän portaalissa",
    ticket_assigned: "Tehtävän käsittelijä vaihdettu",
    work_order_created: "Työtilaus tehty huoltoyhtiölle",
    work_order_done: "Työtilaus kuitattu tehdyksi",
    work_order_message: "Viesti lähetetty huoltoyhtiölle",
    attachment_added: "Liite lisätty tehtävälle",
    triaged: "AI luokitteli tehtävän",
    emergency_routed: "Ohjattu hätätapauksena",
    decision_ai: "Päätös: AI hoitaa",
    decision_human: "Päätös: Osoitettu minulle",
    decision_skip: "Tehtävä suljettu",
    draft_saved: "Luonnos tallennettu",
    ticket_updated: "Tehtävän tietoja muutettu",
    ai_suggested: "AI laati vastausehdotuksen",
    message_created: "Viesti lisätty",
    reply_sent: "Vastaus lähetetty",
    reply_received: "Asukas vastasi sähköpostiin",
    reply_received_reopened: "Asukas vastasi, tehtävä avattu uudelleen",
    portal_message: "Asukas lähetti viestin portaalissa",
    ticket_reopened: "Tehtävä avattu uudelleen",
    user_deleted: "Käyttäjä poistettu",
    resident_erased: "Asukkaan henkilötiedot poistettu",
    retention_purge: "Säilytysajan ylittäneet tiedot poistettu",
    reporter_linked: "Asukas linkitetty tehtävään",
    reporter_unlinked: "Asukkaan linkitys poistettu"
  }[action] || action;
}

function actorLabel(actor: string) {
  return {
    ai: "AI",
    system: "Järjestelmä",
    isannoitsija: "Isännöitsijä"
  }[actor] || actor;
}

const MAX_REPLY_ATTACHMENTS = 10;
const MAX_REPLY_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// Lukee tiedoston base64-muotoon lähetettäväksi vastauksen liitteenä.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} t`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kt`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mt`;
}

function formatDate(value?: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString("fi-FI", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatTicketNumber(value?: number | null) {
  return typeof value === "number" ? String(value).padStart(4, "0") : "----";
}

function ticketAge(createdAt: string, currentTime: number) {
  const createdAtTime = Date.parse(createdAt);
  if (Number.isNaN(createdAtTime)) return "—";
  const ageMinutes = Math.max(0, Math.floor((currentTime - createdAtTime) / 60_000));
  if (ageMinutes < 60) return `${ageMinutes} min`;
  const hours = Math.floor(ageMinutes / 60);
  if (hours < 24) return `${hours} h ${ageMinutes % 60} min`;
  const days = Math.floor(hours / 24);
  return `${days} pv ${hours % 24} h`;
}

const PAGE_SIZE = 15;

// Sivuttaa listan 15 tietueen sivuihin. resetKey vaihtuu, kun listan rajaus tai järjestys muuttuu,
// jolloin palataan ensimmäiselle sivulle; taustapäivitys ei vaihda sivua.
function usePaged<T>(items: T[], resetKey: string) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const first = (current - 1) * PAGE_SIZE;

  // Sivun vaihto palauttaa näkymän listan alkuun.
  function goTo(next: number) {
    setPage(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return {
    items: items.slice(first, first + PAGE_SIZE),
    pager: pageCount > 1 ? (
      <nav className="pager" aria-label="Sivutus">
        <button onClick={() => goTo(current - 1)} disabled={current === 1}>← Edellinen</button>
        <span>
          Sivu {current} / {pageCount} · {first + 1}–{Math.min(first + PAGE_SIZE, items.length)} / {items.length}
        </span>
        <button onClick={() => goTo(current + 1)} disabled={current === pageCount}>Seuraava →</button>
      </nav>
    ) : null
  };
}

export default function App() {
  const [current, setCurrent] = useState(session);

  useEffect(() => {
    const listener = () => setCurrent(session);
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
    };
  }, []);

  if (!current) return <Login />;
  if (current.kind === "resident" && current.resident) {
    return <ResidentPortal key={current.resident.id} resident={current.resident} />;
  }
  return <Workspace key={current.user.id} user={current.user} />;
}

// Palautuslinkin tunniste osoitteesta #/reset/<tunniste>.
function resetTokenFromHash() {
  return window.location.hash.match(/^#\/reset\/([0-9a-f]{20,})$/i)?.[1] ?? "";
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // login = kirjautuminen, forgot = palautuslinkin pyyntö, reset = uuden salasanan asetus linkistä.
  const [resetToken, setResetToken] = useState(resetTokenFromHash);
  const [mode, setMode] = useState<"login" | "forgot" | "reset">(resetToken ? "reset" : "login");
  const [repeat, setRepeat] = useState("");
  const [notice, setNotice] = useState("");

  function show(next: "login" | "forgot") {
    setMode(next);
    setError("");
    setPassword("");
    setRepeat("");
  }

  async function requestReset(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api("/auth/forgot", { method: "POST", body: JSON.stringify({ email: email.trim() }) });
      setNotice("Jos osoitteella on tunnus, lähetimme siihen linkin salasanan vaihtoon. Linkki on voimassa tunnin.");
      show("login");
    } catch (resetError) {
      setError(errorMessage(resetError, "Palautuslinkin pyyntö epäonnistui. Tarkista, että palvelin on käynnissä."));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitNewPassword(event: FormEvent) {
    event.preventDefault();
    if (password !== repeat) {
      setError("Salasanat eivät täsmää.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await api("/auth/reset", { method: "POST", body: JSON.stringify({ token: resetToken, password }) });
      window.history.replaceState(null, "", window.location.pathname);
      setResetToken("");
      setNotice("Salasana on vaihdettu. Kirjaudu sisään uudella salasanalla.");
      show("login");
    } catch (resetError) {
      setError(errorMessage(resetError, "Salasanan vaihto epäonnistui."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      setSession(await api<Session>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      }));
    } catch (loginError) {
      let message = "Kirjautuminen epäonnistui. Tarkista, että palvelin on käynnissä.";
      try {
        message = JSON.parse((loginError as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === "forgot") {
    return (
      <div className="login-page">
        <form className="login-card" onSubmit={requestReset}>
          <img src="/kotilo-logo.svg" alt="Kotilo" />
          <h1>Unohtunut salasana</h1>
          <p>Anna sähköpostiosoitteesi, niin lähetämme linkin, jolla voit asettaa uuden salasanan.</p>
          <label>
            <span>Sähköposti</span>
            <input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" autoFocus required />
          </label>
          {error && <p className="send-error">{error}</p>}
          <button type="submit" disabled={submitting || !email.trim()}>
            {submitting ? "Lähetetään…" : "Lähetä palautuslinkki"}
          </button>
          <button type="button" className="login-link" onClick={() => show("login")}>← Takaisin kirjautumiseen</button>
        </form>
      </div>
    );
  }

  if (mode === "reset") {
    return (
      <div className="login-page">
        <form className="login-card" onSubmit={submitNewPassword}>
          <img src="/kotilo-logo.svg" alt="Kotilo" />
          <h1>Aseta uusi salasana</h1>
          <p>Salasanassa pitää olla vähintään 8 merkkiä.</p>
          <label>
            <span>Uusi salasana</span>
            <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" autoFocus required />
          </label>
          <label>
            <span>Uusi salasana uudelleen</span>
            <input type="password" value={repeat} onChange={event => setRepeat(event.target.value)} autoComplete="new-password" required />
          </label>
          {error && <p className="send-error">{error}</p>}
          <button type="submit" disabled={submitting || password.length < 8 || !repeat}>
            {submitting ? "Tallennetaan…" : "Vaihda salasana"}
          </button>
          <button
            type="button"
            className="login-link"
            onClick={() => {
              window.history.replaceState(null, "", window.location.pathname);
              setResetToken("");
              show("login");
            }}
          >
            ← Takaisin kirjautumiseen
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <img src="/kotilo-logo.svg" alt="Kotilo" />
        <h1>Kirjaudu sisään</h1>
        <p>{MANAGEMENT_OFFICE.name} · henkilökunta ja asukkaat</p>

        <label>
          <span>Sähköposti</span>
          <input
            type="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label>
          <span>Salasana</span>
          <input
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && <p className="send-error">{error}</p>}

        {notice && <p className="login-notice">{notice}</p>}

        <button type="submit" disabled={submitting || !email.trim() || !password}>
          {submitting ? "Kirjaudutaan…" : "Kirjaudu"}
        </button>
        <button type="button" className="login-link" onClick={() => { setNotice(""); show("forgot"); }}>Unohditko salasanan?</button>
      </form>
    </div>
  );
}

function Workspace({ user }: { user: OfficeUser }) {
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
  const [residentsOpen, setResidentsOpen] = useState(tab === "residents" || tab === "sauna" || tab === "laundry" || tab === "parking" || tab === "announcements" || tab === "moves" || tab === "waitlist");
  const [myTicketsOpen, setMyTicketsOpen] = useState(true);

  // Alavalikko aukeaa itsestään, kun sen näkymään siirrytään muuta kautta (esim. päätöksen jälkeen).
  useEffect(() => {
    if (tab === "my-tickets" || tab === "ai-handled") setMyTicketsOpen(true);
    if (tab === "residents" || tab === "sauna" || tab === "laundry" || tab === "parking" || tab === "announcements" || tab === "moves" || tab === "waitlist") setResidentsOpen(true);
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

type ReportPeriod = "week" | "month" | "year";

const reportPeriodLabels: Record<ReportPeriod, string> = {
  week: "Viikko",
  month: "Kuukausi",
  year: "Vuosi"
};

const reportPeriodNames: Record<ReportPeriod, string> = {
  week: "viimeiset 7 päivää",
  month: "viimeiset 30 päivää",
  year: "viimeiset 12 kuukautta"
};

type TopicReport = {
  generatedAt: string;
  generatedBy: string;
  ticketCount: number;
  // documentation = AI:n luonnos dokumentaatiotietueen sisällöksi (puuttuu ennen tätä muutosta luoduista raporteista).
  topics: { title: string; summary: string; documentation?: string; ticketIds: string[] }[];
};

type ReportBucket = { start: number; end: number; label: string; title: string; count: number };

// Jakaa valitun jakson pylväiksi: viikko ja kuukausi päivittäin, vuosi kuukausittain.
function reportBuckets(period: ReportPeriod, now: Date): ReportBucket[] {
  const buckets: ReportBucket[] = [];
  if (period === "year") {
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({
        start: start.getTime(),
        end: end.getTime(),
        label: start.toLocaleDateString("fi-FI", { month: "short" }),
        title: start.toLocaleDateString("fi-FI", { month: "long", year: "numeric" }),
        count: 0
      });
    }
    return buckets;
  }
  const days = period === "week" ? 7 : 30;
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
    buckets.push({
      start: start.getTime(),
      end: end.getTime(),
      label: period === "week"
        ? start.toLocaleDateString("fi-FI", { weekday: "short" })
        : i % 5 === 0 ? `${start.getDate()}.${start.getMonth() + 1}.` : "",
      title: start.toLocaleDateString("fi-FI", { weekday: "short", day: "numeric", month: "numeric", year: "numeric" }),
      count: 0
    });
  }
  return buckets;
}

function ticketCountLabel(count: number) {
  return count === 1 ? "1 tehtävä" : `${count} tehtävää`;
}

const reportStopWords = new Set([
  "että", "joka", "jotka", "tämä", "tässä", "ovat", "olla", "onko", "voisi", "voiko", "kiitos", "terve",
  "asukas", "kysyy", "ilmoittaa", "haluaa", "koskien", "liittyen", "myös", "kuin", "mutta", "sekä", "minun",
  "meidän", "teidän", "milloin", "miten", "missä", "pitäisi", "asunto", "asunnon", "taloyhtiö", "tiedustelu"
].map(word => word.slice(0, 5)));

// Karkea avainsanapoiminta: sanan viisi ensimmäistä kirjainta toimii taivutusmuodot yhdistävänä vartalona.
function ticketKeywords(ticket: Ticket) {
  const words = `${ticket.subject} ${ticket.summary}`.toLowerCase().match(/[a-zåäö]{4,}/g) ?? [];
  return new Set(words.map(word => word.slice(0, 5)).filter(stem => !reportStopWords.has(stem)));
}

type TicketGroup = { tickets: Ticket[]; keywords: Set<string> };

// Alustava ryhmittely: tehtävä liitetään ryhmään, jonka kanssa sillä on vähintään kaksi yhteistä
// avainsanaa ja yhteisiä sanoja on vähintään puolet lyhyemmän tehtävän avainsanoista.
function groupSimilarTickets(tickets: Ticket[]): TicketGroup[] {
  const groups: TicketGroup[] = [];
  for (const ticket of tickets) {
    const keywords = ticketKeywords(ticket);
    const match = groups.find(group => {
      const shared = [...keywords].filter(word => group.keywords.has(word)).length;
      return shared >= 2 && shared / Math.min(keywords.size, group.keywords.size) >= 0.5;
    });
    if (match) match.tickets.push(ticket);
    else groups.push({ tickets: [ticket], keywords });
  }
  return groups.filter(group => group.tickets.length > 1).sort((a, b) => b.tickets.length - a.tickets.length);
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

function Reports({
  tickets,
  loading,
  companyId,
  companies,
  onCompanyChange
}: {
  tickets: Ticket[];
  loading: boolean;
  companyId: string;
  companies: Company[];
  onCompanyChange: (companyId: string) => void;
}) {
  const [period, setPeriod] = useState<ReportPeriod>("month");

  const buckets = reportBuckets(period, new Date());
  const periodStart = buckets[0].start;
  const periodEnd = buckets[buckets.length - 1].end;
  const previousStart = period === "year"
    ? new Date(new Date(periodStart).getFullYear() - 1, new Date(periodStart).getMonth(), 1).getTime()
    : periodStart - (periodEnd - periodStart);

  const periodTickets: Ticket[] = [];
  let previousCount = 0;
  for (const ticket of tickets) {
    const createdAt = Date.parse(ticket.created_at);
    if (Number.isNaN(createdAt)) continue;
    if (createdAt >= previousStart && createdAt < periodStart) previousCount++;
    const bucket = buckets.find(candidate => createdAt >= candidate.start && createdAt < candidate.end);
    if (!bucket) continue;
    bucket.count++;
    periodTickets.push(ticket);
  }

  const total = periodTickets.length;
  const change = total - previousCount;
  const maxCount = Math.max(...buckets.map(bucket => bucket.count));
  const axisMax = Math.max(2, maxCount + (maxCount % 2));

  const typeCounts = new Map<string, number>();
  for (const ticket of periodTickets) typeCounts.set(ticket.type, (typeCounts.get(ticket.type) ?? 0) + 1);
  const types = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);

  const groups = groupSimilarTickets(periodTickets);

  // AI:n luoma raportti toistuvista aiheista; tallennetaan palvelimelle yhtiö- ja jaksokohtaisesti.
  const [topicReport, setTopicReport] = useState<TopicReport | null>(null);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [ticketTab, setTicketTab] = useState<"incoming" | "types" | "topics" | "orders">("incoming");
  const [topicError, setTopicError] = useState("");
  const [openTopic, setOpenTopic] = useState<TopicReport["topics"][number] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTopicReport(null);
    setTopicError("");
    api<{ report: TopicReport | null; aiAvailable: boolean }>(
      `/companies/${encodeURIComponent(companyId)}/reports/topics?period=${period}`
    )
      .then(result => {
        if (cancelled) return;
        setTopicReport(result.report);
        setAiAvailable(result.aiAvailable);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [companyId, period]);

  async function generateTopicReport() {
    setGenerating(true);
    setTopicError("");
    try {
      const result = await api<{ report: TopicReport | null }>(
        `/companies/${encodeURIComponent(companyId)}/reports/topics`,
        { method: "POST", body: JSON.stringify({ period, since: new Date(periodStart).toISOString() }) }
      );
      setTopicReport(result.report);
    } catch (error) {
      setTopicError(errorMessage(error, "AI-raportin luominen epäonnistui."));
    } finally {
      setGenerating(false);
    }
  }

  const ticketTabs = (
    <div className="billing-tabs-head">
      <h2>Tehtäväraportit</h2>
      <div className="billing-tabs" role="tablist">
        {([["incoming", "Saapuneet tehtävät"], ["types", "Tehtävät tyypeittäin"], ["topics", "Toistuvat aiheet"], ["orders", "Työtilaukset"]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={ticketTab === key}
            className={ticketTab === key ? "active" : ""}
            onClick={() => setTicketTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section className="content">
      <div className="ticket-filters">
        <label>
          <span>Yhtiö</span>
          <select value={companyId} onChange={event => onCompanyChange(event.target.value)}>
            {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </label>
        <div className="report-period">
          <span>Jakso</span>
          <div className="card-tabs">
            {(Object.keys(reportPeriodLabels) as ReportPeriod[]).map(option => (
              <button key={option} className={period === option ? "active" : ""} onClick={() => setPeriod(option)}>
                {reportPeriodLabels[option]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? <div className="empty">Ladataan…</div> : (
        <>
          <div className="queue-summary">
            <div>
              <span>Tehtäviä</span>
              <strong>{total}</strong>
              <small>{reportPeriodNames[period]}</small>
            </div>
            <div>
              <span>Muutos</span>
              <strong>{change > 0 ? `+${change}` : change}</strong>
              <small>edellisellä jaksolla {ticketCountLabel(previousCount)}</small>
            </div>
            <div>
              <span>Toistuvia aiheita</span>
              <strong>{groups.length}</strong>
              <small>vähintään kaksi samanlaista tehtävää</small>
            </div>
          </div>

          {ticketTab === "incoming" && (
          <div className="report-card">
            {ticketTabs}
            <h2>Saapuneet tehtävät</h2>
            <p className="muted">
              {period === "year" ? "Tehtäviä kuukaudessa" : "Tehtäviä päivässä"}, {reportPeriodNames[period]}.
            </p>
            <div className="report-chart">
              <div className="report-axis">
                <span>{axisMax}</span>
                <span>{axisMax / 2}</span>
                <span>0</span>
              </div>
              <div className="report-plot">
                <div className="report-bars">
                  {buckets.map(bucket => (
                    <div key={bucket.start} className="report-bar-col">
                      <div className="report-tooltip">{bucket.title}: {ticketCountLabel(bucket.count)}</div>
                      <div className="report-bar" style={{ height: `${(bucket.count / axisMax) * 100}%` }} />
                    </div>
                  ))}
                </div>
                <div className="report-labels">
                  {buckets.map(bucket => <span key={bucket.start}>{bucket.label}</span>)}
                </div>
              </div>
            </div>
          </div>
          )}

          {ticketTab === "types" && (
          <div className="report-card">
            {ticketTabs}
            <h2>Tehtävät tyypeittäin</h2>
            {types.length === 0 ? <p className="muted">Ei tehtäviä valitulla jaksolla.</p> : (
              <div className="report-rows">
                {types.map(([type, count]) => (
                  <div key={type} className="report-row">
                    <span>{type}</span>
                    <div className="report-row-track">
                      <div className="report-row-fill" style={{ width: `${(count / types[0][1]) * 100}%` }} />
                    </div>
                    <strong>{count}</strong>
                    <small>{Math.round((count / total) * 100)} %</small>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}

          {ticketTab === "topics" && (
          <div className="report-card">
            {ticketTabs}
            <div className="suggest-header report-ai-head">
              <h2>
                Toistuvat aiheet
                <span className="report-tag">{topicReport ? "AI-raportti" : "Alustava"}</span>
              </h2>
              <button
                className="ai-button"
                onClick={generateTopicReport}
                disabled={generating || !aiAvailable}
                title={aiAvailable ? undefined : "AI ei ole käytössä palvelimella."}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2l1.900 5.600a4 4 0 0 0 2.500 2.500L22 12l-5.600 1.900a4 4 0 0 0-2.500 2.500L12 22l-1.900-5.600a4 4 0 0 0-2.500-2.500L2 12l5.600-1.900a4 4 0 0 0 2.500-2.500z" />
                </svg>
                {generating ? "AI analysoi tehtäviä…" : topicReport ? "Päivitä AI:lla" : "Luo AI-raportti"}
              </button>
            </div>
            {topicError && <p className="send-error">{topicError}</p>}

            {topicReport ? (
              <>
                <p className="muted">
                  AI ryhmitteli {ticketCountLabel(topicReport.ticketCount)} merkityksen perusteella · luotu{" "}
                  {formatDate(topicReport.generatedAt)} · {topicReport.generatedBy}. Raportti ei päivity itsestään,
                  kun uusia tehtäviä saapuu.
                </p>
                {topicReport.topics.length === 0 ? (
                  <p className="muted">AI ei löytänyt jaksolta toistuvia aiheita.</p>
                ) : (
                  <div className="table-card">
                    <table className="data-table report-topics">
                      <thead>
                        <tr>
                          <th>Aihe</th>
                          <th>Tehtäviä</th>
                          <th>Osuus</th>
                          <th>Esimerkit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topicReport.topics.map(topic => {
                          const numbers = topic.ticketIds
                            .map(id => tickets.find(ticket => ticket.id === id))
                            .filter((ticket): ticket is Ticket => Boolean(ticket))
                            .map(ticket => `#${formatTicketNumber(ticket.ticket_number)}`);
                          return (
                            <tr
                              key={topic.title}
                              className="clickable"
                              title="Avaa aiheen tiedot"
                              role="button"
                              tabIndex={0}
                              onClick={() => setOpenTopic(topic)}
                              onKeyDown={event => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  setOpenTopic(topic);
                                }
                              }}
                            >
                              <td>
                                <strong>{topic.title}</strong>
                                <span>{topic.summary}</span>
                              </td>
                              <td>{topic.ticketIds.length}</td>
                              <td>{Math.round((topic.ticketIds.length / Math.max(1, topicReport.ticketCount)) * 100)} %</td>
                              <td>
                                {numbers.slice(0, 3).join(", ")}
                                {numbers.length > 3 && " …"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="muted">
                  Samankaltaiset tehtävät ryhmiteltynä otsikon ja tiivistelmän yhteisten sanojen perusteella.
                  Luo AI-raportti, niin aiheet ryhmitellään merkityksen perusteella ja saat ehdotukset automatisoinnista.
                </p>
                {groups.length === 0 ? <p className="muted">Valitulla jaksolla ei löytynyt toistuvia aiheita.</p> : (
                  <div className="table-card">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Aihe</th>
                          <th>Tyyppi</th>
                          <th>Tehtäviä</th>
                          <th>Osuus</th>
                          <th>Esimerkit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups.map(group => (
                          <tr key={group.tickets[0].id}>
                            <td><strong>{mostCommon(group.tickets.map(ticket => ticket.subject))}</strong></td>
                            <td>{mostCommon(group.tickets.map(ticket => ticket.type))}</td>
                            <td>{group.tickets.length}</td>
                            <td>{Math.round((group.tickets.length / total) * 100)} %</td>
                            <td>
                              {group.tickets.slice(0, 3).map(ticket => `#${formatTicketNumber(ticket.ticket_number)}`).join(", ")}
                              {group.tickets.length > 3 && " …"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
          )}

          {ticketTab === "orders" && <WorkOrderReport companyId={companyId} tabs={ticketTabs} />}

          <BillingReports companyId={companyId} />
        </>
      )}

      {openTopic && topicReport && (
        <TopicDrawer
          topic={openTopic}
          ticketCount={topicReport.ticketCount}
          tickets={tickets}
          companyId={companyId}
          companies={companies}
          onClose={() => setOpenTopic(null)}
        />
      )}
    </section>
  );
}

// Toistuvan aiheen tietokortti. Aiheesta voi luoda dokumentaatiotietueen, jota AI käyttää
// jatkossa samantapaisiin tehtäviin.
function TopicDrawer({
  topic,
  ticketCount,
  tickets,
  companyId,
  companies,
  onClose
}: {
  topic: TopicReport["topics"][number];
  ticketCount: number;
  tickets: Ticket[];
  companyId: string;
  companies: Company[];
  onClose: () => void;
}) {
  const topicTickets = topic.ticketIds
    .map(id => tickets.find(ticket => ticket.id === id))
    .filter((ticket): ticket is Ticket => Boolean(ticket));

  const [creating, setCreating] = useState(false);
  const [targetCompany, setTargetCompany] = useState(companyId);
  const [title, setTitle] = useState(topic.title);
  // Sisältö esitäytetään AI:n luonnoksella; käyttäjä tarkistaa ja muokkaa sen ennen luomista.
  const [content, setContent] = useState(topic.documentation ?? "");
  // Ehdotetaan avainsanoiksi aiheen otsikon sanoja; käyttäjä voi muokata.
  const [tags, setTags] = useState(
    [...new Set(topic.title.toLowerCase().match(/[a-zåäö]{4,}/g) ?? [])].join(", ")
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [createdId, setCreatedId] = useState("");

  const tagList = [...new Set(tags.split(",").map(tag => tag.trim()).filter(Boolean))];

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await api<{ knowledgeId: string }>(
        `/companies/${encodeURIComponent(targetCompany)}/knowledge/facts`,
        { method: "POST", body: JSON.stringify({ question: title.trim(), answer: content.trim(), tags: tagList }) }
      );
      setCreatedId(result.knowledgeId);
      setCreating(false);
    } catch (submitError) {
      setError(errorMessage(submitError, "Dokumentaation luominen epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer form-drawer resident-drawer topic-drawer" onClick={event => event.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        <span className="report-tag">Toistuva aihe</span>
        <h2>{topic.title}</h2>
        <p className="muted">{topic.summary}</p>

        <dl className="ticket-facts">
          <div>
            <dt>Tehtäviä</dt>
            <dd>{topic.ticketIds.length}</dd>
          </div>
          <div>
            <dt>Osuus jakson tehtävistä</dt>
            <dd>{Math.round((topic.ticketIds.length / Math.max(1, ticketCount)) * 100)} %</dd>
          </div>
        </dl>

        <section className="drawer-section">
          <h3>Aiheen tehtävät</h3>
          {topicTickets.map(ticket => (
            <a className="topic-ticket" key={ticket.id} href={`#/tickets/${encodeURIComponent(ticket.id)}`} target="_blank" rel="noreferrer">
              <span className="ticket-number">#{formatTicketNumber(ticket.ticket_number)}</span>
              <span>
                <strong>{ticket.subject}</strong>
                <small>{ticket.summary}</small>
              </span>
            </a>
          ))}
          {topicTickets.length === 0 && <p className="drawer-empty">Aiheen tehtäviä ei löytynyt valitusta yhtiöstä.</p>}
        </section>

        <section className="drawer-section">
          <h3>Dokumentaatio</h3>
          {createdId ? (
            <p className="ai-reason created">
              Dokumentaatio luotu. AI käyttää sitä jatkossa samantapaisten tehtävien vastausehdotuksissa.{" "}
              <a href={`#/knowledge/${encodeURIComponent(createdId)}`} target="_blank" rel="noreferrer">Avaa tietue ↗</a>
            </p>
          ) : !creating ? (
            <>
              <p className="topic-text">
                Luo aiheesta dokumentaatiotietue, niin AI osaa käyttää sitä vastausehdotuksissa, kun samasta
                asiasta tulee uusi tehtävä.
              </p>
              <button className="ai-button topic-create" onClick={() => setCreating(true)}>Luo dokumentaatio</button>
            </>
          ) : (
            <form className="ticket-form" onSubmit={handleSubmit}>
              <label>
                <span>Taloyhtiö</span>
                <select value={targetCompany} onChange={event => setTargetCompany(event.target.value)}>
                  {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
                </select>
              </label>

              <label>
                <span>Otsikko</span>
                <input value={title} onChange={event => setTitle(event.target.value)} />
              </label>

              <label>
                <span>Sisältö (tieto, jonka pohjalta AI vastaa asukkaalle)</span>
                <textarea
                  value={content}
                  onChange={event => setContent(event.target.value)}
                  placeholder="Kirjoita taloyhtiön ohje tai vastaus tähän aiheeseen, esim. miten asia hoidetaan ja keneen otetaan yhteyttä."
                />
              </label>
              <p className="reply-hint">
                {topic.documentation
                  ? "AI:n luonnos tehtävien ja lähetettyjen vastausten pohjalta. Tarkista teksti ja täydennä hakasulkeissa olevat kohdat ennen luomista."
                  : "Tälle aiheelle ei ole AI:n luonnosta. Päivitä raportti AI:lla tai kirjoita sisältö itse."}
              </p>
              {/\[[^\]]*\]/.test(content) && (
                <p className="send-error">Sisällössä on vielä täydennettäviä kohtia hakasulkeissa.</p>
              )}

              <label>
                <span>Tagit (pilkulla erotettuna)</span>
                <input value={tags} onChange={event => setTags(event.target.value)} placeholder="esim. sauna, varaus, yhteistilat" />
              </label>
              {tagList.length > 0 && (
                <div className="knowledge-tags">
                  {tagList.map(tag => <span key={tag}>{tag}</span>)}
                </div>
              )}

              {error && <p className="send-error">{error}</p>}

              <div className="drawer-actions compact-actions">
                <button type="button" onClick={() => setCreating(false)}>Peruuta</button>
                <button className="primary" type="submit" disabled={saving || !title.trim() || !content.trim()}>
                  {saving ? "Luodaan…" : "Luo dokumentaatio"}
                </button>
              </div>
            </form>
          )}
        </section>
      </aside>
    </div>
  );
}

function SkipTicketModal({
  onClose,
  onSubmit
}: {
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!reason) return;
    setSubmitting(true);
    try {
      await onSubmit(reason);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay skip-overlay" onClick={onClose}>
      <aside className="drawer skip-drawer" onClick={event => event.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        <h2>Sulje tehtävä</h2>
        <p className="muted">Tehtävä suljetaan ilman muita toimenpiteitä. Valitse sulkemisen syy.</p>
        <form className="ticket-form" onSubmit={handleSubmit}>
          <label>
            <span>Syy <em className="required-label">Pakollinen</em></span>
            <select required value={reason} onChange={event => setReason(event.target.value)}>
              <option value="">Valitse syy</option>
              <option value="already_handled">Jo hoidettu</option>
              <option value="no_action_required">Ei vaadi toimia</option>
              <option value="spam">Roskaposti</option>
            </select>
          </label>
          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>Peruuta</button>
            <button className="primary" type="submit" disabled={!reason || submitting}>
              {submitting ? "Suljetaan…" : "Sulje tehtävä"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function TicketCreateModal({
  companies,
  defaultCompanyId,
  onClose,
  onSubmit
}: {
  companies: Company[];
  defaultCompanyId: string;
  onClose: () => void;
  onSubmit: (payload: {
    companyId: string;
    subject: string;
    summary: string;
    type: string;
    priority: string;
    residentName?: string;
    apartmentNumber?: string;
  }) => Promise<void>;
}) {
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const [subject, setSubject] = useState("");
  const [summary, setSummary] = useState("");
  const [type, setType] = useState("Ilmoitus");
  const [priority, setPriority] = useState("normal");
  const [residentName, setResidentName] = useState("");
  const [apartmentNumber, setApartmentNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!subject.trim() || !summary.trim()) return;

    setSubmitting(true);
    try {
      await onSubmit({
        companyId,
        subject: subject.trim(),
        summary: summary.trim(),
        type,
        priority,
        residentName: residentName.trim() || undefined,
        apartmentNumber: apartmentNumber.trim() || undefined
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer form-drawer" onClick={e => e.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        <h2>Luo uusi tehtävä</h2>
        <p className="muted">Lisää manuaalinen tehtävä omiin tehtäviin.</p>

        <form className="ticket-form" onSubmit={handleSubmit}>
          <label>
            <span>Taloyhtiö</span>
            <select value={companyId} onChange={e => setCompanyId(e.target.value)}>
              {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>

          <label>
            <span>Aihe</span>
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Esim. Käytävävalot" />
          </label>

          <label>
            <span>Luokka</span>
            <select value={type} onChange={e => setType(e.target.value)}>
              <option>Ilmoitus</option>
              <option>Kysymys</option>
              <option>Pyyntö</option>
              <option>Toimenpide</option>
            </select>
          </label>

          <label>
            <span>Prioriteetti</span>
            <select value={priority} onChange={e => setPriority(e.target.value)}>
              <option value="normal">Normaali</option>
              <option value="urgent">Kiireellinen</option>
              <option value="low">Matala</option>
              <option value="emergency">Hätä</option>
            </select>
          </label>

          <label>
            <span>Asukkaan nimi</span>
            <input value={residentName} onChange={e => setResidentName(e.target.value)} placeholder="Valinnainen" />
          </label>

          <label>
            <span>Asunto</span>
            <input value={apartmentNumber} onChange={e => setApartmentNumber(e.target.value)} placeholder="Valinnainen, esim. A 12" />
          </label>

          <label>
            <span>Kuvaus</span>
            <textarea value={summary} onChange={e => setSummary(e.target.value)} rows={6} placeholder="Kerro tehtävän sisältö..." />
          </label>

          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>Peruuta</button>
            <button className="primary" type="submit" disabled={submitting || !subject.trim() || !summary.trim()}>
              {submitting ? "Luodaan…" : "Luo tehtävä"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

// Tehtävän voi osoittaa isännöitsijälle tai pääkäyttäjälle.
function isManagerRole(user: OfficeUser) {
  return user.role === "Isännöitsijä" || user.role === "Pääkäyttäjä";
}

// Kenelle taloyhtiön tehtävän voi antaa: vastuuisännöitsijälle ja taloyhtiön muille isännöitsijöille.
// Jos taloyhtiölle ei ole valittu muita isännöitsijöitä, valittavana ovat kaikki toimiston isännöitsijät.
function assignableUsers(company: Company | undefined, users: OfficeUser[]) {
  const others = company?.manager_ids ?? [];
  if (others.length === 0) return users.filter(isManagerRole);
  return users.filter(user => user.id === company?.manager_id || others.includes(user.id));
}

// Tehtävän saa antaa toiselle taloyhtiön vastuuisännöitsijä tai pääkäyttäjä; palvelin tarkistaa saman.
// Ilman vastuuisännöitsijää jakaminen on sallittu kaikille.
function canAssignTickets(company: Company | undefined) {
  return isAdmin() || !company?.manager_id || company.manager_id === session?.user.id;
}

// "Anna toiselle" -nappi: avaa listan toimiston isännöitsijöistä ja vaihtaa tehtävän käsittelijän.
function AssignPicker({
  users,
  assigneeId,
  onAssign
}: {
  users: OfficeUser[];
  assigneeId: string | null;
  onAssign: (assigneeId: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const managers = users.filter(isManagerRole);

  async function choose(userId: string) {
    setOpen(false);
    if (userId === assigneeId) return;
    setSaving(true);
    try {
      await onAssign(userId);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`assign-picker ${open ? "open" : ""}`}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button type="button" aria-haspopup="listbox" aria-expanded={open} disabled={saving} onClick={() => setOpen(!open)}>
        {saving ? "Siirretään…" : "Anna toiselle"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="assign-menu" role="listbox" aria-label="Valitse isännöitsijä">
          <small>Valitse isännöitsijä</small>
          {managers.length === 0 && <p>Ei isännöitsijöitä.</p>}
          {managers.map(user => (
            <button
              type="button"
              key={user.id}
              role="option"
              aria-selected={user.id === assigneeId}
              className={user.id === assigneeId ? "current" : ""}
              onClick={() => void choose(user.id)}
            >
              <span className="user-avatar">{user.name.split(" ").map(part => part[0]).join("").slice(0, 2)}</span>
              <span className="assign-name">
                <strong>{user.name}{session?.user.id === user.id ? " (sinä)" : ""}</strong>
                <em>{user.id === assigneeId ? "Nykyinen käsittelijä" : user.role}</em>
              </span>
              {user.id === assigneeId && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12l5 5 9-10" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Tehtävän liitteet yläpalkin pudotusvalikossa; liite latautuu klikkaamalla.
function AttachmentsMenu({
  attachments,
  ticketId,
  onChanged
}: {
  attachments: TicketDetail["attachments"];
  ticketId: string;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  // Liittää valitut tiedostot suoraan tehtävälle; mitään ei lähetetä.
  async function upload(files: File[]) {
    if (files.length === 0) return;
    if (files.reduce((total, file) => total + file.size, 0) > MAX_REPLY_ATTACHMENT_BYTES) {
      setError("Liitteiden yhteiskoko saa olla enintään 15 Mt.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      await api(`/tickets/${encodeURIComponent(ticketId)}/attachments`, {
        method: "POST",
        body: JSON.stringify({
          attachments: await Promise.all(files.slice(0, MAX_REPLY_ATTACHMENTS).map(async file => ({
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            data: await fileToBase64(file)
          })))
        })
      });
      await onChanged();
    } catch (uploadError) {
      setError(errorMessage(uploadError, "Liitteen lisääminen epäonnistui."));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div
      className={`assign-picker attachments-menu ${open ? "open" : ""}`}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button type="button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg className="clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 11.500l-8.600 8.600a5.500 5.500 0 0 1-7.800-7.800l8.600-8.600a3.700 3.700 0 0 1 5.200 5.200l-8.500 8.500a1.800 1.800 0 0 1-2.600-2.600l7.800-7.800" />
        </svg>
        Liitteet
        <b>{attachments.length}</b>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="assign-menu">
          <small>Tehtävän liitteet</small>
          {attachments.length === 0 && <p>Ei liitteitä.</p>}
          {attachments.map(attachment => (
            <a
              key={attachment.id}
              href={fileUrl(`/attachments/${attachment.id}`)}
              download={attachment.filename}
              title={`Lataa ${attachment.filename}`}
            >
              <strong>{attachment.filename}</strong>
              <em>
                {attachment.direction === "outbound" ? "Lähetetty" : attachment.direction === "internal" ? "Lisätty" : attachment.direction === "portal" ? "Asukkaalta" : "Saapunut"} · {formatFileSize(attachment.size)} · {formatDate(attachment.created_at)}
              </em>
            </a>
          ))}
          <label className="attachments-add">
            {uploading ? "Lisätään…" : "+ Lisää liite"}
            <input
              type="file"
              multiple
              disabled={uploading}
              onChange={event => {
                const picked = [...(event.target.files ?? [])];
                event.target.value = "";
                void upload(picked);
              }}
            />
          </label>
          {error && <p className="send-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

function TicketCard({
  ticket,
  compact = false,
  companyName,
  users,
  canAssign,
  allUsers,
  onAssign,
  onOpen,
  onDecision
}: {
  ticket: Ticket;
  compact?: boolean;
  companyName?: string;
  // Käyttäjät, joille tehtävän voi antaa, ja saako kirjautunut käyttäjä antaa sen eteenpäin.
  users: OfficeUser[];
  canAssign: boolean;
  allUsers: OfficeUser[];
  onAssign: (assigneeId: string) => Promise<void>;
  onOpen: () => void;
  onDecision: (d: "ai" | "human" | "skip") => void;
}) {
  const hasDraft = Boolean((ticket.draft || "").trim());
  const assignee = allUsers.find(user => user.id === ticket.assignee_id);

  if (compact) {
    return (
      <article
        className="ticket-row"
        onClick={onOpen}
        onKeyDown={event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <span className="ticket-number">#{formatTicketNumber(ticket.ticket_number)}</span>
        <div className="ticket-row-main">
          <strong>
            {ticket.subject}
            {ticket.has_new_reply ? <em className="new-reply">Uusi viesti</em> : null}
            {isOverdue(ticket) ? <em className="new-reply overdue" title={`Määräaika oli ${formatDay(ticket.due_date)}`}>Myöhässä</em> : null}
          </strong>
        </div>
        <span className={`priority ${ticket.priority}`}>{priorityLabel(ticket.priority)}</span>
        <span className="type">{ticket.type}</span>
        <span className="ticket-row-contact">{ticket.resident_name || ticket.apartment_number || "Ei yhteyshenkilöä"}</span>
        <span className="status-badge">{statusLabel(ticket.status)}</span>
        <time className="date">{formatDate(ticket.created_at)}</time>
        <time className="date">{formatDate(ticket.updated_at || ticket.created_at)}</time>
      </article>
    );
  }

  return (
    <article className={`ticket-card ${ticket.status === "waiting_manager" ? "managed" : ""} ${ticket.priority === "emergency" ? "emergency" : ""}`} onClick={onOpen}>
      <div className="ticket-top">
        <span className="ticket-company" title="Taloyhtiö">
          <TabIcon tab="companies" />
          {companyName ?? "Tuntematon yhtiö"}
        </span>
        <span className="ticket-number">#{formatTicketNumber(ticket.ticket_number)}</span>
        <span className={`priority ${ticket.priority}`}>{priorityLabel(ticket.priority)}</span>
        <span className="type">{ticket.type}</span>
        <span className="status-badge">{statusLabel(ticket.status)}</span>
        <span className="date">{formatDate(ticket.updated_at || ticket.created_at)}</span>
      </div>

      <div className="ticket-main">
        <div>
          <h2>{ticket.subject}</h2>
          <div className="meta">
            <span>{ticket.apartment_number || "Asuntoa ei tunnistettu"}</span>
            <span>{ticket.resident_name || "Asukasta ei tunnistettu"}</span>
            <span className="assignee-pill">{assignee ? `Käsittelijä: ${assignee.name}` : "Ei käsittelijää"}</span>
            {hasDraft && <span className="draft-pill">Luonnos tallennettu</span>}
            {ticket.has_new_reply ? <span className="new-reply">Uusi viesti</span> : null}
            {ticket.due_date && (
              <span className={isOverdue(ticket) ? "new-reply overdue" : "assignee-pill"}>
                {isOverdue(ticket) ? "Myöhässä" : "Määräaika"} {formatDay(ticket.due_date)}
              </span>
            )}
          </div>
        </div>

        <div className="recommendation">
          <small>{ticket.ai_suggested ? "KOTILON EHDOTUS" : "LUONNOS"}</small>
          {/* Peruste näytetään vain, kun AI-ehdotus on pyydetty ja sille löytyi lähde dokumentaatiosta. */}
          {ticket.ai_suggested && ticket.knowledge_source_title ? <strong>{ticket.ai_reason}</strong> : null}
          <p>{ticket.draft || "Ei tallennettua luonnosta."}</p>
          {ticket.ai_suggested && ticket.knowledge_source_title ? (
            <span className="source-pill">Lähde: {ticket.knowledge_source_title}</span>
          ) : null}
        </div>
      </div>

      {ticket.status === "open" && (
        <div className="actions" onClick={e => e.stopPropagation()}>
          {canAssign && <AssignPicker users={users} assigneeId={ticket.assignee_id ?? null} onAssign={onAssign} />}
          <button className="primary" onClick={() => onDecision("human")}>Osoita minulle</button>
          <button onClick={() => onDecision("skip")}>Sulje</button>
        </div>
      )}
    </article>
  );
}

// Erottaa sähköpostivastauksesta lainatun aiemman viestin ("… kirjoitti:" ja >-rivit), jotta
// aikajanalla näkyy vain lähettäjän uusi teksti. Palauttaa uuden tekstin ja lainatun osan erikseen.
function splitQuotedReply(body: string): { text: string; quoted: string } {
  const lines = body.split(/\r?\n/);
  const isQuote = (line: string) => line.trimStart().startsWith(">");
  const writerLine = /(kirjoitti|wrote|skrev|schrieb)\s*:\s*$/i;
  const separator = /^\s*(-{2,}\s*(Original Message|Alkuperäinen viesti|Forwarded message|Välitetty viesti)\s*-{2,}|_{10,})\s*$/i;
  const headerBlock = /^\s*(Lähettäjä|From|Från)\s*:/i;

  let cut = -1;
  for (let index = 0; index < lines.length && cut < 0; index++) {
    const line = lines[index];
    if (separator.test(line)) {
      cut = index;
    } else if (writerLine.test(line) && lines.slice(index + 1, index + 4).some(isQuote)) {
      // Pitkä otsikkorivi voi olla rivitetty kahdelle riville: "ma 12.10. Nimi <osoite>" + "kirjoitti:".
      const wrapped = index > 0 && line.trim().length < 20 && /[@\d]/.test(lines[index - 1]) && !isQuote(lines[index - 1]);
      cut = wrapped ? index - 1 : index;
    } else if (headerBlock.test(line) && lines.slice(index + 1, index + 5).some(next => /^\s*(Lähetetty|Sent|Skickat|Päivämäärä|Date)\s*:/i.test(next))) {
      cut = index;
    }
  }
  // Ilman otsikkoriviä poistetaan viestin lopussa oleva yhtenäinen lainauslohko.
  if (cut < 0) {
    let end = lines.length;
    while (end > 0 && (isQuote(lines[end - 1]) || !lines[end - 1].trim())) end--;
    if (lines.slice(end).some(isQuote)) cut = end;
  }
  if (cut < 0) return { text: body, quoted: "" };

  const text = lines.slice(0, cut).join("\n").trim();
  // Jos viestissä ei ole muuta kuin lainaus, näytetään se kokonaan.
  if (!text) return { text: body, quoted: "" };
  return { text, quoted: lines.slice(cut).join("\n").trim() };
}

// Aikajanan viesti; väkäsestä viestin saa tiivistettyä yhdelle riville.
function TimelineMessage({
  message,
  replying = false,
  onReply
}: {
  message: TicketDetail["messages"][number];
  replying?: boolean;
  // Annetaan vain viesteille, joihin voi vastata sähköpostilla.
  onReply?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);
  const inbound = message.direction === "inbound";
  // Saapuneesta viestistä näytetään oletuksena vain uusi teksti, ei lainattua aiempaa viestiä.
  const { text, quoted } = inbound ? splitQuotedReply(message.body) : { text: message.body, quoted: "" };

  return (
    <div className={`message ${message.direction} ${collapsed ? "collapsed" : ""} ${replying ? "replying" : ""}`}>
      {onReply && (
        <button className="message-reply" onClick={onReply} title="Vastaa tähän viestiin samassa sähköpostiketjussa">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.200"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10a6 6 0 0 1 6 6v4" />
          </svg>
          Vastaa
        </button>
      )}
      <button
        className="message-head"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        title={collapsed ? "Näytä viesti" : "Tiivistä viesti"}
      >
        <span className="message-direction">{inbound ? "Saapunut" : "Lähetetty"}</span>
        <small>{channelLabel(message.channel)} · {actorLabel(message.sender)} · {formatDate(message.created_at)}</small>
        <svg
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
      <strong>{message.subject}</strong>
      <p>{text}</p>
      {quoted && (
        <>
          <button className="message-quoted-toggle" onClick={() => setShowQuoted(!showQuoted)} aria-expanded={showQuoted}>
            {showQuoted ? "Piilota lainattu viesti" : "Näytä lainattu viesti"}
          </button>
          {showQuoted && <p className="message-quoted">{quoted}</p>}
        </>
      )}
    </div>
  );
}

// Lomakkeiden ja suodattimien alasvetovalikko: kentän näköinen painike ja pyöristetty lista
// selaimen vakiovalikon tilalla.
function Dropdown({
  label,
  value,
  options,
  onChange,
  disabled
}: {
  label?: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find(option => option.value === value);

  return (
    <div
      className="dropdown"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      {label && <span className="dropdown-label">{label}</span>}
      <button
        type="button"
        className="dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span>{current?.label ?? value}</span>
        <svg
          className={open ? "up" : ""}
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
      {open && (
        <ul role="listbox">
          {options.map(option => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={option.value === value ? "selected" : ""}
                onClick={() => {
                  setOpen(false);
                  if (option.value !== value) onChange(option.value);
                }}
              >
                {option.label}
                {option.value === value && (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.500"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M5 12l5 5 9-10" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Tehtävän tietokentän oma alasvetovalikko: näyttää tekstiltä, avautuu pyöristettynä listana.
function FactDropdown({
  value,
  options,
  disabled,
  onChange
}: {
  value: string;
  options: { value: string; label: string; pillClass?: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find(option => option.value === value);

  return (
    <div
      className="fact-dropdown"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        className={`fact-dropdown-trigger ${current?.pillClass ?? ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {current?.label ?? value}
        <svg
          className={open ? "up" : ""}
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
      {open && (
        <ul role="listbox">
          {options.map(option => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={option.value === value ? "selected" : ""}
                onClick={() => {
                  setOpen(false);
                  if (option.value !== value) onChange(option.value);
                }}
              >
                {option.pillClass ? <span className={option.pillClass}>{option.label}</span> : option.label}
                {option.value === value && (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.500"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M5 12l5 5 9-10" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TicketDrawer({
  detail,
  onClose,
  onDecision,
  onDraftSaved,
  onChanged,
  company
}: {
  detail: TicketDetail;
  // Tehtävän taloyhtiö: määrää, kenelle tehtävän voi antaa ja kuka saa antaa.
  company?: Company;
  onClose: () => void;
  onDecision: (d: "ai" | "human" | "skip") => void;
  onDraftSaved: (draft: string) => void;
  onChanged: () => Promise<void>;
}) {
  const t = detail.ticket;
  const [draft, setDraft] = useState(t.draft || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState("");
  const [sendError, setSendError] = useState("");
  // Vastauksen mukana lähetettävät liitteet; tallentuvat lähetyksessä tehtävän liitteisiin.
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const replyFilesSize = replyFiles.reduce((total, file) => total + file.size, 0);
  const replyFilesTooLarge = replyFilesSize > MAX_REPLY_ATTACHMENT_BYTES;

  useEffect(() => {
    setReplyFiles([]);
  }, [t.id]);

  // Kuvaus on tehtävän alkuperäinen viesti; käsin luodulla tehtävällä sen tiivistelmä.
  const firstInbound = detail.messages.find(m => m.direction === "inbound");
  const description = (firstInbound ? splitQuotedReply(firstInbound.body).text.trim() : "")
    || t.summary
    || "Ei kuvausta.";
  const lastInbound = [...detail.messages].reverse().find(m => m.direction === "inbound");
  // Sama järjestys kuin palvelimella: ensin alkuperäinen lähettäjä, muuten linkitetyt asukkaat.
  // Aikajanalta valittu viesti, johon vastataan; ilman valintaa vastataan viimeisimpään saapuneeseen.
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const replyTarget = detail.messages.find(m => m.id === replyTargetId && m.direction === "inbound") ?? null;
  const draftEditor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setReplyTargetId(null);
  }, [t.id]);

  function startReply(message: TicketDetail["messages"][number]) {
    setReplyTargetId(message.id);
    draftEditor.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    draftEditor.current?.focus({ preventScroll: true });
  }

  const recipient = (replyTarget ?? lastInbound)?.sender.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    || detail.reporters.map(r => r.email?.trim()).filter(Boolean).join(", ");
  const canReply = t.status === "waiting_manager" || t.status === "waiting_third_party";

  useEffect(() => {
    setDraft(t.draft || "");
    setSaved(false);
  }, [t.id, t.draft]);

  // Viimeisin tässä istunnossa pyydetty AI-ehdotus; muuten näytetään tehtävälle tallennettu peruste ja lähde.
  const [suggestion, setSuggestion] = useState<{
    reason: string;
    source: { id: string; title: string } | null;
    usedAi: boolean;
  } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState("");

  useEffect(() => {
    setSuggestion(null);
    setSuggestError("");
  }, [t.id]);

  // AI-ehdotuksen voi pyytää tehtävälle vain kerran; aiempi pyyntö näkyy lokissa.
  const suggestionUsed = Boolean(suggestion) || detail.audit.some(a => a.action === "ai_suggested");
  const aiReason = suggestion ? suggestion.reason : t.ai_reason;
  // Dokumenttia ehdotetaan vasta, kun tehtävälle on pyydetty AI-ehdotus.
  const aiSource = suggestion
    ? suggestion.source
    : suggestionUsed && t.knowledge_source_id && t.knowledge_source_title
      ? { id: t.knowledge_source_id, title: t.knowledge_source_title }
      : null;

  async function requestSuggestion() {
    if (draft.trim() && draft !== (t.draft || "")
      && !window.confirm("Luonnoksessa on tallentamattomia muutoksia. Korvataanko se AI:n ehdotuksella?")) {
      return;
    }
    setSuggesting(true);
    setSuggestError("");
    try {
      const result = await api<{
        draft: string;
        reason: string;
        source: { id: string; title: string } | null;
        usedAi: boolean;
      }>(`/tickets/${t.id}/suggest`, { method: "POST" });
      setSuggestion(result);
      setDraft(result.draft);
      setSaved(false);
      setSentTo("");
      // Ehdotus tallennetaan heti luonnokseksi; jos tallennus epäonnistuu, teksti jää kenttään tallentamattomana.
      try {
        await api(`/tickets/${t.id}/draft`, {
          method: "POST",
          body: JSON.stringify({ draft: result.draft })
        });
        onDraftSaved(result.draft);
        setSaved(true);
      } catch {
        setSuggestError("AI-ehdotus on kentässä, mutta sen tallennus luonnokseksi epäonnistui. Paina Tallenna luonnos.");
      }
    } catch (error) {
      let message = "AI-ehdotuksen hakeminen epäonnistui. Yritä uudelleen.";
      try {
        message = JSON.parse((error as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setSuggestError(message);
    } finally {
      setSuggesting(false);
    }
  }

  const [note, setNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  useEffect(() => {
    setSentTo("");
    setSendError("");
    setNote("");
  }, [t.id]);

  // reply_sent ja message_created näkyvät aikajanalla jo itse viesteinä.
  const timeline = [
    ...detail.messages.map(m => ({ kind: "message" as const, id: m.id, created_at: m.created_at, message: m })),
    ...detail.notes.map(n => ({ kind: "note" as const, id: n.id, created_at: n.created_at, note: n })),
    ...detail.audit
      .filter(a => a.action !== "reply_sent" && a.action !== "message_created")
      .map(a => ({ kind: "event" as const, id: a.id, created_at: a.created_at, event: a }))
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const unlinkedSenders = detail.reporters.length === 0
    ? [...new Set(detail.messages.filter(m => m.direction === "inbound").map(m => m.sender))]
    : [];

  const [residents, setResidents] = useState<Resident[]>([]);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    api<Resident[]>(`/companies/${encodeURIComponent(t.company_id)}/residents`)
      .then(setResidents)
      .catch(() => setResidents([]));
  }, [t.id, t.company_id]);

  // Tehtävällä on yksi ilmoittaja. Valikossa on mukana myös nykyinen ilmoittaja, vaikka asukaslista ei olisi vielä latautunut.
  const reporter = detail.reporters[0];
  const reporterOptions = reporter && !residents.some(r => r.id === reporter.id)
    ? [reporter, ...residents]
    : residents;
  // Sähköposti haetaan asukastiedoista valitun ilmoittajan perusteella.
  const reporterEmail = reporter
    ? residents.find(r => r.id === reporter.id)?.email || reporter.email
    : "";

  // Ilmoittajan hakukenttä: null = ei muokata, jolloin kentässä näkyy nykyisen ilmoittajan nimi.
  const [reporterQuery, setReporterQuery] = useState<string | null>(null);
  const reporterInput = useRef<HTMLInputElement>(null);
  const reporterSearch = (reporterQuery ?? "").trim().toLowerCase();
  const reporterMatches = reporterOptions
    .filter(r => [r.name, r.apartment_number, r.email].some(value => value?.toLowerCase().includes(reporterSearch)))
    .slice(0, 8);

  function chooseReporter(residentId: string) {
    setReporterQuery(null);
    void setReporter(residentId);
  }

  // Vaihtaa tehtävän ilmoittajan: aiemmat linkitykset poistetaan ja valittu asukas linkitetään tilalle.
  async function setReporter(residentId: string) {
    setLinking(true);
    try {
      for (const current of detail.reporters) {
        if (current.id === residentId) continue;
        await api(`/tickets/${t.id}/reporters/${encodeURIComponent(current.id)}?actor=${encodeURIComponent(actorName())}`, {
          method: "DELETE"
        });
      }
      if (residentId && !detail.reporters.some(current => current.id === residentId)) {
        await api(`/tickets/${t.id}/reporters`, {
          method: "POST",
          body: JSON.stringify({ residentId, actor: actorName() })
        });
      }
      await onChanged();
    } finally {
      setLinking(false);
    }
  }

  const [updatingFields, setUpdatingFields] = useState(false);

  // Toimiston käyttäjät käsittelijän valintaa varten.
  const [officeUsers, setOfficeUsers] = useState<OfficeUser[]>([]);
  useEffect(() => {
    api<OfficeUser[]>("/users").then(setOfficeUsers).catch(() => setOfficeUsers([]));
  }, []);

  async function updateFields(fields: { type?: string; priority?: string; assigneeId?: string | null; dueDate?: string | null }) {
    setUpdatingFields(true);
    try {
      await api(`/tickets/${t.id}/fields`, {
        method: "PUT",
        body: JSON.stringify({ ...fields, actor: actorName() })
      });
      await onChanged();
    } finally {
      setUpdatingFields(false);
    }
  }

  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    setAddingNote(true);
    try {
      await api(`/tickets/${t.id}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: note, author: actorName() })
      });
      setNote("");
      await onChanged();
    } finally {
      setAddingNote(false);
    }
  }

  async function sendReply() {
    if (!draft.trim() || !recipient) return;
    setSending(true);
    setSendError("");
    setSentTo("");
    try {
      const result = await api<{ ok: boolean; to: string }>(`/tickets/${t.id}/reply`, {
        method: "POST",
        body: JSON.stringify({
          body: draft,
          actor: actorName(),
          messageId: replyTarget?.id,
          attachments: await Promise.all(replyFiles.map(async file => ({
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            data: await fileToBase64(file)
          })))
        })
      });
      setDraft("");
      setReplyFiles([]);
      setReplyTargetId(null);
      setSentTo(result.to);
      await onChanged();
    } catch (error) {
      let message = "Lähetys epäonnistui.";
      try {
        message = JSON.parse((error as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setSendError(message);
    } finally {
      setSending(false);
    }
  }

  async function saveDraft() {
    setSaving(true);
    try {
      await api(`/tickets/${t.id}/draft`, {
        method: "POST",
        body: JSON.stringify({ draft })
      });
      onDraftSaved(draft);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer drawer-split" onClick={e => e.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        <div className="drawer-main">
        {/* Yläpalkki pysyy näkyvissä, kun tehtävää vieritetään. */}
        <div className="drawer-topbar">
          <span className="drawer-topbar-number">#{formatTicketNumber(t.ticket_number)} · {statusLabel(t.status)}</span>
          <div className="drawer-topbar-tools">
          <AttachmentsMenu attachments={detail.attachments} ticketId={t.id} onChanged={onChanged} />
          {t.status === "closed" && (
            <div className="drawer-actions">
              <button
                disabled={updatingFields}
                onClick={async () => {
                  setUpdatingFields(true);
                  try {
                    await api(`/tickets/${t.id}/reopen`, { method: "POST" });
                    await onChanged();
                  } finally {
                    setUpdatingFields(false);
                  }
                }}
              >
                Avaa uudelleen
              </button>
            </div>
          )}
          {t.status !== "closed" && (
            <div className="drawer-actions">
              {canAssignTickets(company) && (
                <AssignPicker
                  users={assignableUsers(company, officeUsers)}
                  assigneeId={t.assignee_id ?? null}
                  onAssign={assigneeId => updateFields({ assigneeId })}
                />
              )}
              {t.status === "open" && (
                <button className="primary" onClick={() => onDecision("human")}>Osoita minulle</button>
              )}
              <button onClick={() => onDecision("skip")}>Sulje</button>
            </div>
          )}
          </div>
        </div>
        <h2>{t.subject}</h2>

        <dl className="ticket-facts">
          <div className="fact-number">
            <dt>Tehtävänumero</dt>
            <dd>#{formatTicketNumber(t.ticket_number)}</dd>
          </div>
          <div>
            <dt>Yhtiö</dt>
            <dd>{t.company_name || "-"}</dd>
          </div>
          <div>
            <dt>Osoite</dt>
            <dd>{[...new Set(detail.apartments.map(a => a.address).filter(Boolean))].join(", ") || "-"}</dd>
          </div>
          <div>
            <dt>Tyyppi</dt>
            <dd>
              <FactDropdown
                value={t.type}
                options={(ticketTypeOptions.includes(t.type) ? ticketTypeOptions : [t.type, ...ticketTypeOptions])
                  .map(type => ({ value: type, label: type }))}
                disabled={updatingFields}
                onChange={type => updateFields({ type })}
              />
            </dd>
          </div>
          <div>
            <dt>{detail.apartments.length > 1 ? "Asunnot" : "Asunto"}</dt>
            <dd>
              {detail.apartments.length > 0
                ? detail.apartments.map(a => a.apartment_number).join(", ")
                : "Yhteiset tilat"}
            </dd>
          </div>
          <div>
            <dt>Tila</dt>
            <dd>{statusLabel(t.status)}</dd>
          </div>
          <div>
            <dt>Käsittelijä</dt>
            <dd>
              <FactDropdown
                value={t.assignee_id ?? ""}
                options={[
                  { value: "", label: "Ei käsittelijää" },
                  ...officeUsers
                    .filter(user => assignableUsers(company, officeUsers).includes(user) || user.id === t.assignee_id)
                    .map(user => ({ value: user.id, label: user.name }))
                ]}
                disabled={updatingFields || !canAssignTickets(company)}
                onChange={assigneeId => updateFields({ assigneeId: assigneeId || null })}
              />
            </dd>
          </div>
          <div>
            <dt>Prioriteetti</dt>
            <dd>
              <FactDropdown
                value={t.priority}
                options={ticketPriorities.map(priority => ({
                  value: priority,
                  label: priorityLabel(priority),
                  pillClass: `priority ${priority}`
                }))}
                disabled={updatingFields}
                onChange={priority => updateFields({ priority })}
              />
            </dd>
          </div>
          <div>
            <dt>Määräaika</dt>
            <dd className="fact-due">
              <input
                type="date"
                value={t.due_date ?? ""}
                disabled={updatingFields || t.status === "closed"}
                aria-label="Määräaika"
                onChange={event => updateFields({ dueDate: event.target.value || null })}
              />
              {isOverdue(t) && <em className="new-reply overdue">Myöhässä</em>}
            </dd>
          </div>
          <div>
            <dt>Luotu</dt>
            <dd>{formatDate(t.created_at)}</dd>
          </div>
          <div>
            <dt>Ilmoittaja</dt>
            <dd className="fact-search">
              <input
                ref={reporterInput}
                value={reporterQuery ?? reporter?.name ?? ""}
                placeholder="Hae asukasta nimellä…"
                disabled={linking}
                onFocus={event => {
                  setReporterQuery("");
                  event.target.select();
                }}
                onChange={event => setReporterQuery(event.target.value)}
                onBlur={() => setReporterQuery(null)}
                onKeyDown={event => {
                  if (event.key === "Escape") event.currentTarget.blur();
                  if (event.key === "Enter" && reporterMatches.length > 0) {
                    event.preventDefault();
                    chooseReporter(reporterMatches[0].id);
                    event.currentTarget.blur();
                  }
                }}
              />
              <button
                type="button"
                className="fact-search-button"
                title="Hae asukasta"
                aria-label="Hae asukasta"
                disabled={linking}
                // Kenttä pysyy kohdistettuna, jotta painallus ei sulje juuri avattua hakua.
                onMouseDown={event => event.preventDefault()}
                onClick={() => reporterInput.current?.focus()}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0" />
                  <path d="M21 21l-4.300-4.300" />
                </svg>
              </button>
              {reporterQuery !== null && (
                <ul>
                  {reporterMatches.map(r => (
                    // mousedown ehtii ennen kentän blur-tapahtumaa, joka sulkee listan.
                    <li key={r.id} onMouseDown={() => chooseReporter(r.id)}>
                      <strong>{r.name}</strong>
                      <span>{[r.apartment_number, r.email].filter(Boolean).join(" · ")}</span>
                    </li>
                  ))}
                  {reporterMatches.length === 0 && <li className="empty-option">Ei hakua vastaavia asukkaita</li>}
                  {reporter && (
                    <li className="clear-option" onMouseDown={() => chooseReporter("")}>Poista ilmoittaja</li>
                  )}
                </ul>
              )}
            </dd>
          </div>
          <div>
            <dt>Muokattu</dt>
            <dd>{formatDate(t.updated_at || t.created_at)}</dd>
          </div>
          <div>
            <dt>Sähköposti</dt>
            <dd>
              {reporter
                ? reporterEmail || "-"
                : unlinkedSenders.length > 0 ? `${unlinkedSenders.join(", ")} (ei linkitetty asukkaaseen)` : "-"}
            </dd>
          </div>
        </dl>

        <div className="ticket-description">
          <h3>Kuvaus</h3>
          <p>{description}</p>
        </div>

        <section className="drawer-section">
          <div className="suggest-header">
            <h3>Vastaus asukkaalle</h3>
            <button
              className="ai-button"
              onClick={requestSuggestion}
              disabled={suggesting || suggestionUsed}
              title={suggestionUsed ? "AI-ehdotuksen voi pyytää tehtävälle vain kerran." : undefined}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2l1.900 5.600a4 4 0 0 0 2.500 2.500L22 12l-5.600 1.900a4 4 0 0 0-2.500 2.500L12 22l-1.900-5.600a4 4 0 0 0-2.500-2.500L2 12l5.600-1.900a4 4 0 0 0 2.500-2.500z" />
              </svg>
              {suggesting ? "AI kirjoittaa…" : suggestionUsed ? "AI-ehdotus pyydetty" : "Pyydä AI-ehdotus"}
            </button>
          </div>
          {suggestion?.usedAi && (
            <p className="ai-reason created">AI on luonut ehdotuksen tälle tehtävälle. Tarkista ja muokkaa tekstiä ennen lähettämistä.</p>
          )}
          {aiSource && <p className="ai-reason found">{aiReason}</p>}
          {aiSource ? (
            <p>
              <a
                className="source-pill source-link"
                href={`#/knowledge/${encodeURIComponent(aiSource.id)}`}
                target="_blank"
                rel="noreferrer"
                title="Avaa dokumentti uuteen välilehteen"
              >
                Ehdotettu dokumentti: {aiSource.title} ↗
              </a>
            </p>
          ) : null}
          {suggestion && !suggestion.usedAi && (
            <p className="reply-hint">
              AI ei ollut käytettävissä, joten ehdotus tehtiin avainsanahaulla dokumentaatiosta.
            </p>
          )}
          {suggestion && draft !== (t.draft || "") && (
            <p className="reply-hint">Ehdotusta ei ole vielä tallennettu. Muokkaa tekstiä ja tallenna luonnos.</p>
          )}
          {suggestError && <p className="send-error">{suggestError}</p>}
          {replyTarget && (
            <p className="reply-target">
              <span>
                Vastataan viestiin <strong>{replyTarget.subject}</strong> · {formatDate(replyTarget.created_at)}
              </span>
              <button onClick={() => setReplyTargetId(null)} title="Peru valinta" aria-label="Peru valinta">×</button>
            </p>
          )}
          <textarea
            ref={draftEditor}
            className="draft-editor"
            rows={10}
            placeholder="Kirjoita vastaus tai pyydä AI-ehdotus…"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
              setSentTo("");
            }}
          />
          {canReply && (
            <div className="reply-attachments">
              <label className="attach-button">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 11.500l-8.600 8.600a5.500 5.500 0 0 1-7.800-7.800l8.600-8.600a3.700 3.700 0 0 1 5.200 5.200l-8.500 8.500a1.800 1.800 0 0 1-2.600-2.600l7.800-7.800" />
                </svg>
                Liitä tiedosto
                <input
                  type="file"
                  multiple
                  // Sama tiedosto voidaan valita uudelleen poistamisen jälkeen.
                  onChange={event => {
                    const picked = [...(event.target.files ?? [])];
                    setReplyFiles(current => [...current, ...picked].slice(0, MAX_REPLY_ATTACHMENTS));
                    event.target.value = "";
                    setSendError("");
                  }}
                />
              </label>
              {replyFiles.map((file, index) => (
                <span className="reply-file" key={`${file.name}-${index}`}>
                  {file.name} <small>{formatFileSize(file.size)}</small>
                  <button
                    onClick={() => setReplyFiles(current => current.filter((_, position) => position !== index))}
                    title="Poista liite"
                    aria-label={`Poista liite ${file.name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              {replyFilesTooLarge && (
                <p className="send-error">Liitteiden yhteiskoko saa olla enintään 15 Mt (nyt {formatFileSize(replyFilesSize)}).</p>
              )}
            </div>
          )}
          <div className="draft-actions">
            {canReply && (
              <button className="primary" onClick={sendReply} disabled={sending || !draft.trim() || !recipient || replyFilesTooLarge}>
                {sending ? "Lähetetään…" : "Lähetä"}
              </button>
            )}
            <button className={canReply ? "" : "primary"} onClick={saveDraft} disabled={saving}>
              {saving ? "Tallennetaan…" : "Tallenna luonnos"}
            </button>
            {saved && <span className="saved-indicator">Tallennettu</span>}
            {sentTo && <span className="saved-indicator">Lähetetty: {sentTo}</span>}
          </div>
          {canReply && (
            <p className="reply-hint">
              {recipient
                ? `Vastaus lähetetään osoitteeseen ${recipient}`
                : "Tehtävällä ei ole sähköpostiosoitetta, johon vastauksen voisi lähettää."}
            </p>
          )}
          {sendError && <p className="send-error">{sendError}</p>}
        </section>

        <TicketWorkOrders detail={detail} onChanged={onChanged} />

        </div>

        <section className="drawer-timeline">
          <h3>Aikajana</h3>
          {timeline.map(item => item.kind === "message" ? (
            <TimelineMessage
              key={item.id}
              message={item.message}
              replying={replyTarget?.id === item.message.id}
              onReply={canReply && item.message.direction === "inbound" && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(item.message.sender)
                ? () => startReply(item.message)
                : undefined}
            />
          ) : item.kind === "note" ? (
            <div className="message note" key={item.id}>
              <small>Sisäinen muistiinpano · {actorLabel(item.note.author)} · {formatDate(item.created_at)}</small>
              <p>{item.note.body}</p>
            </div>
          ) : (
            <div className="timeline-event" key={item.id}>
              <span>{actionLabel(item.event.action)}</span>
              <small>{actorLabel(item.event.actor)} · {formatDate(item.created_at)}</small>
            </div>
          ))}
          {timeline.length === 0 && <p className="drawer-empty">Ei tapahtumia.</p>}
          <form className="note-form" onSubmit={addNote}>
            <textarea
              rows={2}
              value={note}
              onChange={event => setNote(event.target.value)}
              placeholder="Lisää sisäinen muistiinpano (ei lähde asukkaalle)…"
            />
            <button type="submit" disabled={addingNote || !note.trim()}>
              {addingNote ? "Lisätään…" : "Lisää muistiinpano"}
            </button>
          </form>
        </section>
      </aside>
    </div>
  );
}

function Companies({
  companies,
  openCompanyId,
  onOpenCompany: setOpenCompanyId,
  onChanged
}: {
  companies: Company[];
  openCompanyId: string | null;
  onOpenCompany: (companyId: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [detailTab, setDetailTab] = useState<"residents" | "material" | "sauna" | "laundry" | "parking">("residents");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  function closeForm() {
    setAdding(false);
    setFormError("");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError("");
    try {
      await api("/companies", {
        method: "POST",
        body: JSON.stringify({ name, businessId, address, phone, emailAddress })
      });
      setName("");
      setBusinessId("");
      setAddress("");
      setPhone("");
      setEmailAddress("");
      setAdding(false);
      await onChanged();
    } catch (error) {
      let message = "Taloyhtiön lisääminen epäonnistui.";
      try {
        message = JSON.parse((error as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  const pagedCompanies = usePaged(companies, "");
  const openCompany = companies.find(company => company.id === openCompanyId);

  if (openCompany) {
    return (
      <section className="content">
        <button className="back-link" onClick={() => setOpenCompanyId(null)}>← Kaikki taloyhtiöt</button>

        <CompanyCard company={openCompany} onSaved={onChanged} />
        <GmailAccountCard target={openCompany.id} />

        <div className="card-tabs">
          <button className={detailTab === "residents" ? "active" : ""} onClick={() => setDetailTab("residents")}>
            Asukkaat
          </button>
          <button className={detailTab === "material" ? "active" : ""} onClick={() => setDetailTab("material")}>
            Materiaalit
          </button>
          <button className={detailTab === "sauna" ? "active" : ""} onClick={() => setDetailTab("sauna")}>
            Saunavuorot
          </button>
          <button className={detailTab === "laundry" ? "active" : ""} onClick={() => setDetailTab("laundry")}>
            Pyykkitupavuorot
          </button>
          <button className={detailTab === "parking" ? "active" : ""} onClick={() => setDetailTab("parking")}>
            Autopaikat
          </button>
        </div>
        {detailTab === "residents" ? (
          <Residents
            companyId={openCompany.id}
            companies={companies}
            onChanged={onChanged}
          />
        ) : detailTab === "material" ? (
          <KnowledgeBase companyId={openCompany.id} />
        ) : detailTab === "parking" ? (
          <ParkingSpaces key={openCompany.id} embedded companies={[openCompany]} defaultCompanyId={openCompany.id} />
        ) : (
          <BookingCalendar
            key={`${openCompany.id}-${detailTab}`}
            embedded
            resource={detailTab}
            companyId={openCompany.id}
            companies={[openCompany]}
            onCompanyChange={() => undefined}
          />
        )}
      </section>
    );
  }

  return (
    <section className="content">
      <div className="residents-toolbar">
        <span>{companies.length} taloyhtiötä</span>
        {isManager() && <button className="secondary" onClick={() => setAdding(true)}>Lisää taloyhtiö</button>}
      </div>

      {companies.length === 0 ? <div className="empty">Ei taloyhtiöitä.</div> : (
        <div className="table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Nimi</th>
                <th>Y-tunnus</th>
                <th>Osoite</th>
                <th>Puhelin</th>
                <th>Sähköposti</th>
                <th>Vastuuisännöitsijä</th>
                <th>Asukkaita</th>
              </tr>
            </thead>
            <tbody>
              {pagedCompanies.items.map(company => (
                <tr
                  key={company.id}
                  className="clickable"
                  title="Avaa taloyhtiön tiedot ja asukkaat"
                  onClick={() => setOpenCompanyId(company.id)}
                  onKeyDown={event => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setOpenCompanyId(company.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <td><strong>{company.name}</strong></td>
                  <td>{company.business_id || "–"}</td>
                  <td>{company.address || "–"}</td>
                  <td>{company.phone || "–"}</td>
                  <td>{company.email_address || "–"}</td>
                  <td>{company.manager_name || "–"}</td>
                  <td>{company.resident_count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pagedCompanies.pager}

      {adding && (
        <div className="overlay" onClick={closeForm}>
          <aside className="drawer form-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={closeForm}>×</button>
            <h2>Lisää taloyhtiö</h2>
            <p className="muted">Taloyhtiö tulee valittavaksi tehtävänäkymiin ja asukastietokantaan.</p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              <label>
                <span>Nimi</span>
                <input value={name} onChange={event => setName(event.target.value)} placeholder="Esim. As Oy Koivikko" />
              </label>

              <label>
                <span>Y-tunnus</span>
                <input value={businessId} onChange={event => setBusinessId(event.target.value)} placeholder="Valinnainen" />
              </label>

              <label>
                <span>Osoite</span>
                <input value={address} onChange={event => setAddress(event.target.value)} placeholder="Valinnainen" />
              </label>

              <label>
                <span>Puhelin</span>
                <input value={phone} onChange={event => setPhone(event.target.value)} placeholder="Valinnainen" />
              </label>

              <label>
                <span>Sähköposti, johon tehtävät saapuvat</span>
                <input type="email" value={emailAddress} onChange={event => setEmailAddress(event.target.value)} placeholder="Valinnainen" />
              </label>

              {formError && <p className="send-error">{formError}</p>}

              <div className="drawer-actions compact-actions">
                <button type="button" onClick={closeForm}>Peruuta</button>
                <button className="primary" type="submit" disabled={submitting || !name.trim()}>
                  {submitting ? "Lisätään…" : "Lisää taloyhtiö"}
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </section>
  );
}

function CompanyCard({
  company,
  onSaved
}: {
  company: Company;
  onSaved: () => Promise<void>;
}) {
  const initialValues = {
    name: company.name,
    businessId: company.business_id ?? "",
    address: company.address ?? "",
    phone: company.phone ?? "",
    emailAddress: company.email_address ?? "",
    managerId: company.manager_id ?? "",
    // Muut isännöitsijät pilkuilla erotettuna, jotta muutoksen tunnistus toimii kuten muissa kentissä.
    managerIds: [...(company.manager_ids ?? [])].sort().join(","),
    maintenanceName: company.maintenance_name ?? "",
    maintenancePhone: company.maintenance_phone ?? "",
    maintenanceEmail: company.maintenance_email ?? "",
    maintenanceEmergencyPhone: company.maintenance_emergency_phone ?? ""
  };
  const [values, setValues] = useState(initialValues);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  // Vastuuisännöitsijäksi voi valita isännöitsijän tai pääkäyttäjän.
  const [managers, setManagers] = useState<OfficeUser[]>([]);
  useEffect(() => {
    api<OfficeUser[]>("/users")
      .then(users => setManagers(users.filter(user => user.role === "Isännöitsijä" || user.role === "Pääkäyttäjä")))
      .catch(() => setManagers([]));
  }, []);

  useEffect(() => {
    setValues(initialValues);
    setSaved(false);
    setError("");
  }, [company.id]);

  function field(key: keyof typeof initialValues) {
    return {
      value: values[key],
      onChange: (event: { target: { value: string } }) => {
        setValues(prev => ({ ...prev, [key]: event.target.value }));
        setSaved(false);
      }
    };
  }

  const dirty = (Object.keys(initialValues) as (keyof typeof initialValues)[])
    .some(key => values[key] !== initialValues[key]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await api(`/companies/${encodeURIComponent(company.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: values.name,
          businessId: values.businessId,
          address: values.address,
          phone: values.phone,
          emailAddress: values.emailAddress,
          managerId: values.managerId || null,
          managerIds: values.managerIds.split(",").filter(id => id && id !== values.managerId),
          maintenance: {
            name: values.maintenanceName,
            phone: values.maintenancePhone,
            email: values.maintenanceEmail,
            emergencyPhone: values.maintenanceEmergencyPhone
          }
        })
      });
      await onSaved();
      setSaved(true);
    } catch (caught) {
      let message = "Tietojen tallennus epäonnistui.";
      try {
        message = JSON.parse((caught as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-card ticket-form" onSubmit={handleSubmit}>
      <h2>Taloyhtiön tiedot</h2>
      <div className="form-columns">
        <label>
          <span>Nimi</span>
          <input {...field("name")} />
        </label>
        <label>
          <span>Y-tunnus</span>
          <input {...field("businessId")} />
        </label>
        <label>
          <span>Osoite</span>
          <input {...field("address")} />
        </label>
        <label>
          <span>Puhelin</span>
          <input {...field("phone")} />
        </label>
        <label>
          <span>Sähköposti, johon tehtävät saapuvat</span>
          <input type="email" {...field("emailAddress")} />
        </label>
        <label>
          <span>Vastuuisännöitsijä</span>
          <select {...field("managerId")}>
            <option value="">Ei valittu</option>
            {managers.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </label>
        <fieldset className="manager-picks">
          <legend>Muut isännöitsijät</legend>
          {managers.filter(user => user.id !== values.managerId).map(user => {
            const selectedIds = values.managerIds.split(",").filter(Boolean);
            const checked = selectedIds.includes(user.id);
            return (
              <label key={user.id} className={checked ? "checked" : ""}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = checked ? selectedIds.filter(id => id !== user.id) : [...selectedIds, user.id];
                    setValues(prev => ({ ...prev, managerIds: next.sort().join(",") }));
                    setSaved(false);
                  }}
                />
                {user.name}
              </label>
            );
          })}
          {managers.filter(user => user.id !== values.managerId).length === 0 && <span className="muted">Ei muita isännöitsijöitä.</span>}
        </fieldset>
      </div>

      <h2>Huoltoyhtiön tiedot</h2>
      <div className="form-columns">
        <label>
          <span>Huoltoyhtiön nimi</span>
          <input {...field("maintenanceName")} />
        </label>
        <label>
          <span>Sähköposti</span>
          <input type="email" {...field("maintenanceEmail")} />
        </label>
        <label>
          <span>Puhelin</span>
          <input {...field("maintenancePhone")} />
        </label>
        <label>
          <span>Päivystysnumero</span>
          <input {...field("maintenanceEmergencyPhone")} />
        </label>
      </div>

      {error && <p className="send-error">{error}</p>}

      {isManager() ? (
        <div className="draft-actions">
          <button className="primary" type="submit" disabled={saving || !dirty || !values.name.trim()}>
            {saving ? "Tallennetaan…" : "Tallenna muutokset"}
          </button>
          {saved && !dirty && <span className="saved-indicator">Tallennettu</span>}
        </div>
      ) : (
        <p className="reply-hint">Taloyhtiön tietoja voi muuttaa isännöitsijä tai pääkäyttäjä.</p>
      )}
    </form>
  );
}

function Residents({
  companyId,
  companies,
  onCompanyChange,
  onChanged
}: {
  companyId: string;
  companies: Company[];
  // Annettuna näkymä on koko asukastietokanta: kaikkien taloyhtiöiden asukkaat ja suodattimet.
  // Ilman tätä näytetään vain yhden, lukitun taloyhtiön asukkaat.
  onCompanyChange?: (companyId: string) => void;
  onChanged: () => Promise<void>;
}) {
  const allCompanies = Boolean(onCompanyChange);
  const companyName = companies.find(company => company.id === companyId)?.name ?? "Taloyhtiö";
  const [residents, setResidents] = useState<Resident[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [companyFilter, setCompanyFilter] = useState("all");
  const [emailFilter, setEmailFilter] = useState("all");
  const [search, setSearch] = useState("");
  // Uuden asukkaan taloyhtiö, kun näkymässä on kaikki yhtiöt.
  const [formCompanyId, setFormCompanyId] = useState(companyId);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [adding, setAdding] = useState(false);
  // Muokattava asukas; null = lomakkeella lisätään uutta asukasta.
  const [editing, setEditing] = useState<Resident | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [apartmentNumber, setApartmentNumber] = useState("");
  const [residentPassword, setResidentPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  function openForm(resident: Resident | null) {
    setResidentPassword("");
    setEditing(resident);
    setName(resident?.name ?? "");
    setEmail(resident?.email ?? "");
    setAddress(resident?.address ?? "");
    setApartmentNumber(resident?.apartment_number ?? "");
    setFormError("");
    setFormCompanyId(companyFilter !== "all" ? companyFilter : companyId);
    setAdding(true);
  }

  async function loadResidents() {
    try {
      if (allCompanies) {
        const lists = await Promise.all(companies.map(async company =>
          (await api<Resident[]>(`/companies/${encodeURIComponent(company.id)}/residents`))
            .map(resident => ({ ...resident, company_id: company.id, company_name: company.name }))
        ));
        setResidents(lists.flat().sort((a, b) => a.name.localeCompare(b.name, "fi")));
      } else {
        setResidents(await api<Resident[]>(`/companies/${encodeURIComponent(companyId)}/residents`));
      }
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void loadResidents();
  }, [companyId, allCompanies, companies.length]);

  const searchText = search.trim().toLowerCase();
  const visibleResidents = allCompanies
    ? residents.filter(resident =>
        (companyFilter === "all" || resident.company_id === companyFilter)
        && (emailFilter === "all" || (emailFilter === "with") === Boolean(resident.email))
        && (!searchText || [resident.name, resident.email, resident.address, resident.apartment_number]
          .some(value => value?.toLowerCase().includes(searchText))))
    : residents;
  // Sarakeotsikot; taloyhtiösarake on mukana vain koko asukastietokannassa.
  const residentColumns: { key: ResidentSortKey; label: string }[] = [
    { key: "name", label: "Nimi" },
    { key: "email", label: "Sähköposti" },
    ...(allCompanies ? [{ key: "company" as const, label: "Taloyhtiö" }] : []),
    { key: "address", label: "Osoite" },
    { key: "apartment", label: "Asunto" }
  ];
  const [residentSort, setResidentSort] = useState<{ key: ResidentSortKey; descending: boolean } | null>(null);
  const residentSortValue = (resident: Resident, key: ResidentSortKey) => ({
    name: resident.name,
    email: resident.email ?? "",
    company: resident.company_name ?? "",
    address: resident.address,
    apartment: resident.apartment_number
  })[key];
  const sortedResidents = residentSort
    ? [...visibleResidents].sort((a, b) =>
        residentSortValue(a, residentSort.key).localeCompare(residentSortValue(b, residentSort.key), "fi", { numeric: true })
        * (residentSort.descending ? -1 : 1))
    : visibleResidents;
  const pagedResidents = usePaged(sortedResidents, [
    companyId, companyFilter, emailFilter, searchText, residentSort?.key, residentSort?.descending
  ].join("|"));

  const residentFilters: { key: string; label: string; value: string; clear: () => void }[] = [
    ...(companyFilter !== "all"
      ? [{
          key: "company",
          label: "Taloyhtiö",
          value: companies.find(company => company.id === companyFilter)?.name ?? "",
          clear: () => setCompanyFilter("all")
        }]
      : []),
    ...(emailFilter !== "all"
      ? [{
          key: "email",
          label: "Sähköposti",
          value: emailFilter === "with" ? "On sähköposti" : "Ei sähköpostia",
          clear: () => setEmailFilter("all")
        }]
      : []),
    ...(searchText ? [{ key: "search", label: "Haku", value: search.trim(), clear: () => setSearch("") }] : [])
  ];

  function closeForm() {
    setAdding(false);
    setFormError("");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError("");
    try {
      await api(editing
        ? `/residents/${encodeURIComponent(editing.id)}`
        : `/companies/${encodeURIComponent(allCompanies ? formCompanyId : companyId)}/residents`, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({ name, email, address, apartmentNumber, password: residentPassword || undefined })
      });
      setName("");
      setEmail("");
      setAddress("");
      setApartmentNumber("");
      setAdding(false);
      await loadResidents();
      await onChanged();
    } catch (error) {
      let message = editing ? "Asukkaan tietojen tallennus epäonnistui." : "Asukkaan lisääminen epäonnistui.";
      try {
        message = JSON.parse((error as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  // Lataa asukkaasta tallennetut tiedot tiedostona (tietosuoja-asetuksen mukainen tietopyyntö).
  async function exportResident(resident: Resident) {
    setFormError("");
    try {
      const data = await api<unknown>(`/residents/${encodeURIComponent(resident.id)}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `asukkaan-tiedot-${resident.name.toLowerCase().replace(/[^a-z0-9åäö]+/g, "-")}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setFormError(errorMessage(error, "Tietojen vienti epäonnistui."));
    }
  }

  // Poistaa asukkaan henkilötiedot pysyvästi; tehtävät jäävät historiaan ilman nimeä ja viestejä.
  async function eraseResident(resident: Resident) {
    if (!window.confirm(
      `Poistetaanko asukkaan ${resident.name} henkilötiedot pysyvästi?\n\n`
      + "Nimi, sähköposti, kirjautumistunnus, viestit, liitteet, tulevat vuorot, jonotukset ja muuttoilmoitukset poistetaan. "
      + "Tehtävät jäävät historiaan ilman nimeä. Poistoa ei voi perua."
    )) return;
    setSubmitting(true);
    setFormError("");
    try {
      await api(`/residents/${encodeURIComponent(resident.id)}`, { method: "DELETE" });
      setAdding(false);
      await loadResidents();
      await onChanged();
    } catch (error) {
      setFormError(errorMessage(error, "Asukkaan tietojen poisto epäonnistui."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="content">
      {allCompanies && <a className="back-link" href="#/companies">← Taloyhtiöt</a>}

      {allCompanies && filtersOpen && (
        <div className="ticket-filters">
          <label>
            <span>Taloyhtiö</span>
            <select value={companyFilter} onChange={event => setCompanyFilter(event.target.value)}>
              <option value="all">Kaikki</option>
              {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>
          <label>
            <span>Sähköposti</span>
            <select value={emailFilter} onChange={event => setEmailFilter(event.target.value)}>
              <option value="all">Kaikki</option>
              <option value="with">On sähköposti</option>
              <option value="without">Ei sähköpostia</option>
            </select>
          </label>
          <label>
            <span>Haku</span>
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Nimi, sähköposti, osoite tai asunto"
            />
          </label>
          {residentFilters.length > 0 && (
            <button className="clear-filters" onClick={() => {
              setCompanyFilter("all");
              setEmailFilter("all");
              setSearch("");
            }}>Tyhjennä suodattimet</button>
          )}
        </div>
      )}

      <div className="residents-toolbar">
        <div className="filter-chips">
          {allCompanies && (
            <button
              className={`filter-toggle ${filtersOpen || residentFilters.length > 0 ? "active" : ""}`}
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
              {residentFilters.length > 0 && <i />}
            </button>
          )}
          <span>
            {allCompanies
              ? `Kaikki taloyhtiöt · ${visibleResidents.length === residents.length
                ? `${residents.length} asukasta`
                : `${visibleResidents.length} / ${residents.length} asukasta`}`
              : `${companyName} · ${residents.length} asukasta`}
          </span>
          {residentFilters.map(filter => (
            <span className="filter-chip" key={filter.key}>
              <small>{filter.label}</small>
              {filter.value}
              <button onClick={filter.clear} title="Poista suodatin" aria-label={`Poista suodatin ${filter.label}`}>×</button>
            </span>
          ))}
        </div>
        <div className="toolbar-actions">
          <button className="secondary" onClick={() => setImporting(true)}>Tuo asukkaita</button>
          <button className="secondary" onClick={() => openForm(null)}>Lisää asukas</button>
        </div>
      </div>

      {!loading && !loadError && residents.length > 0 && (
        <div className={`ticket-row-header resident-row-header ${allCompanies ? "with-company" : ""}`}>
          {residentColumns.map(column => {
            const active = residentSort?.key === column.key;
            return (
              <button
                key={column.key}
                className={active ? "active" : ""}
                onClick={() => setResidentSort(current => current?.key === column.key
                  ? { key: column.key, descending: !current.descending }
                  : { key: column.key, descending: false })}
                title={`Järjestä sarakkeen ${column.label} mukaan`}
                aria-sort={active ? (residentSort.descending ? "descending" : "ascending") : undefined}
              >
                {column.label}
                <svg
                  className={active && !residentSort.descending ? "up" : ""}
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
          })}
        </div>
      )}

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <div className="empty">Asukkaiden lataus epäonnistui. Tarkista, että palvelin on käynnistetty uudelleen.</div>
        : visibleResidents.length === 0
          ? <div className="empty">{residents.length === 0 ? "Ei asukkaita." : "Ei suodattimia vastaavia asukkaita."}</div>
        : pagedResidents.items.map(resident => (
          <article
            className={`resident-row clickable ${allCompanies ? "with-company" : ""}`}
            key={resident.id}
            title="Avaa asukkaan tiedot"
            role="button"
            tabIndex={0}
            onClick={() => openForm(resident)}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openForm(resident);
              }
            }}
          >
            <strong>{resident.name}</strong>
            <span>{resident.email || "Ei sähköpostia"}</span>
            {allCompanies && <span>{resident.company_name}</span>}
            <span>{resident.address}</span>
            <span className="type">{resident.apartment_number}</span>
          </article>
        ))}
      {!loading && !loadError && pagedResidents.pager}

      {importing && (
        <ResidentImport
          companies={companies}
          // Yhden yhtiön näkymässä yhtiö on lukittu; koko tietokannassa se valitaan lomakkeella.
          lockedCompanyId={allCompanies ? null : companyId}
          defaultCompanyId={companyFilter !== "all" ? companyFilter : companyId}
          onClose={() => setImporting(false)}
          onImported={async () => {
            await loadResidents();
            await onChanged();
          }}
        />
      )}

      {adding && (
        <div className="overlay" onClick={closeForm}>
          <aside className="drawer form-drawer resident-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={closeForm}>×</button>
            <h2>{editing ? editing.name : "Lisää asukas"}</h2>
            <p className="muted">
              {editing
                ? `Asukkaan tiedot · ${editing.company_name ?? companyName}`
                : allCompanies ? "Valitse taloyhtiö, johon asukas lisätään." : `Asukas lisätään taloyhtiöön ${companyName}.`}
            </p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              {allCompanies && !editing && (
                <label>
                  <span>Taloyhtiö</span>
                  <select value={formCompanyId} onChange={event => setFormCompanyId(event.target.value)}>
                    {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
                  </select>
                </label>
              )}

              <label>
                <span>Nimi</span>
                <input value={name} onChange={event => setName(event.target.value)} placeholder="Esim. Matti Meikäläinen" />
              </label>

              <label>
                <span>Sähköposti</span>
                <input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="Valinnainen" />
              </label>

              <label>
                <span>Osoite</span>
                <input value={address} onChange={event => setAddress(event.target.value)} placeholder="Esim. Koivikkotie 10" />
              </label>

              <label>
                <span>Asunto</span>
                <input value={apartmentNumber} onChange={event => setApartmentNumber(event.target.value)} placeholder="Esim. A 12" />
              </label>

              {isAdmin() && (
                <label>
                  <span>{editing?.has_password ? "Uusi salasana" : "Salasana"}</span>
                  <input
                    type="password"
                    value={residentPassword}
                    onChange={event => setResidentPassword(event.target.value)}
                    placeholder={editing?.has_password ? "Jätä tyhjäksi, jos salasanaa ei vaihdeta" : "Valinnainen, vähintään 8 merkkiä"}
                    autoComplete="new-password"
                  />
                </label>
              )}
              <p className="reply-hint">
                {editing?.has_password
                  ? "Asukkaalla on salasana, ja hän voi kirjautua sähköpostillaan asukasportaaliin."
                  : "Salasanan asettamisen jälkeen asukas voi kirjautua sähköpostillaan ja nähdä omat yhteydenottonsa ja vuoronsa."}
                {!isAdmin() && " Salasanan voi asettaa tai vaihtaa vain pääkäyttäjä."}
              </p>

              {formError && <p className="send-error">{formError}</p>}

              <div className="drawer-actions compact-actions">
                <button type="button" onClick={closeForm}>Peruuta</button>
                <button
                  className="primary"
                  type="submit"
                  disabled={submitting || !name.trim() || !address.trim() || !apartmentNumber.trim()}
                >
                  {editing
                    ? submitting ? "Tallennetaan…" : "Tallenna muutokset"
                    : submitting ? "Lisätään…" : "Lisää asukas"}
                </button>
              </div>

              {editing && isManager() && (
                <div className="privacy-actions">
                  <h3>Tietosuoja</h3>
                  <p className="reply-hint">
                    Vie asukkaasta tallennetut tiedot tiedostona tai poista henkilötiedot pysyvästi asukkaan pyynnöstä.
                  </p>
                  <div className="drawer-actions compact-actions">
                    <button type="button" disabled={submitting} onClick={() => exportResident(editing)}>Vie tiedot</button>
                    <button type="button" className="danger" disabled={submitting} onClick={() => eraseResident(editing)}>
                      Poista henkilötiedot
                    </button>
                  </div>
                </div>
              )}
            </form>
          </aside>
        </div>
      )}
    </section>
  );
}

const LANGUAGES = [
  { value: "fi", label: "Suomi" },
  { value: "sv", label: "Svenska" },
  { value: "en", label: "English" }
];
const LANGUAGE_KEY = "kotilo.language";

// Asetukset: jokaisella käyttäjällä omat asetuksensa, pääkäyttäjällä lisäksi toimiston tiedot.
function Settings(props: { company?: Company; onSaved: () => Promise<void> }) {
  const admin = isAdmin();
  const [tab, setTab] = useState<"user" | "office">("user");

  return (
    <>
      <div className="card-tabs settings-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "user"} className={tab === "user" ? "active" : ""} onClick={() => setTab("user")}>
          Käyttäjän asetukset
        </button>
        {admin && (
          <button role="tab" aria-selected={tab === "office"} className={tab === "office" ? "active" : ""} onClick={() => setTab("office")}>
            Isännöitsijätoimiston tiedot
          </button>
        )}
      </div>
      {tab === "office" && admin ? <OfficeSettings {...props} /> : <UserSettings />}
    </>
  );
}

// Kirjautuneen käyttäjän omat tiedot, salasana ja kieli.
function UserSettings() {
  const user = session?.user;
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [language, setLanguage] = useState(() => {
    try {
      return localStorage.getItem(LANGUAGE_KEY) || "fi";
    } catch {
      return "fi";
    }
  });

  function changeLanguage(value: string) {
    setLanguage(value);
    try {
      localStorage.setItem(LANGUAGE_KEY, value);
    } catch {
      // Selaimen tallennustila ei ole käytössä; valinta säilyy vain tämän käynnin ajan.
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!user || !session) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const updated = await api<OfficeUser>(`/users/${encodeURIComponent(user.id)}`, {
        method: "PUT",
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password: password || undefined })
      });
      // Muutos näkyy heti myös sivupalkissa.
      setSession({ ...session, user: updated });
      setPassword("");
      setSaved(true);
    } catch (submitError) {
      setError(errorMessage(submitError, "Tietojen tallennus epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="content settings">
      <form className="settings-card ticket-form" onSubmit={handleSubmit}>
        <h2>Omat tiedot</h2>
        <p className="muted">{MANAGEMENT_OFFICE.name} · {user?.role}</p>

        <label>
          <span>Nimi</span>
          <input value={name} onChange={event => { setName(event.target.value); setSaved(false); }} />
        </label>

        <label>
          <span>Sähköposti (käytetään kirjautumiseen)</span>
          <input type="email" value={email} onChange={event => { setEmail(event.target.value); setSaved(false); }} />
        </label>

        <label>
          <span>Uusi salasana</span>
          <input
            type="password"
            value={password}
            onChange={event => { setPassword(event.target.value); setSaved(false); }}
            placeholder="Jätä tyhjäksi, jos salasanaa ei vaihdeta"
            autoComplete="new-password"
          />
        </label>
        <p className="reply-hint">Vähintään 8 merkkiä. Vaihto kirjaa sinut ulos muilta laitteilta.</p>

        {error && <p className="send-error">{error}</p>}

        <div className="draft-actions">
          <button
            className="primary"
            type="submit"
            disabled={saving || !name.trim() || !email.trim() || (password.length > 0 && password.length < 8)}
          >
            {saving ? "Tallennetaan…" : "Tallenna tiedot"}
          </button>
          {saved && <span className="saved-indicator">Tallennettu</span>}
        </div>
      </form>

      <div className="settings-card ticket-form">
        <h2>Kieli</h2>
        <Dropdown label="Käyttöliittymän kieli" value={language} options={LANGUAGES} onChange={changeLanguage} />
        <p className="reply-hint">Kielivalinta tallentuu tähän selaimeen. Käyttöliittymä on toistaiseksi vain suomeksi.</p>
      </div>
    </section>
  );
}

// reminderEmails: 1 = käsittelijöille lähetetään muistutuskooste. retentionMonths: 0 = tietoja ei poisteta.
type OfficeInfo = {
  name: string; businessId: string; address: string; phone: string;
  reminderEmails?: number; retentionMonths?: number;
};

// Gmail-tili, jolla posti lähtee ja saapuu. target "office" = toimiston tili, muuten taloyhtiön tunniste.
// Tilin vaihto avaa Googlen kirjautumisen uuteen välilehteen; vain pääkäyttäjä voi vaihtaa tilin.
function GmailAccountCard({ target }: { target: string }) {
  const office = target === "office";
  const [status, setStatus] = useState<(GmailStatus & { own?: boolean }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");

  async function loadStatus() {
    try {
      setStatus(await api<GmailStatus & { own?: boolean }>(office ? "/gmail/status" : `/gmail/status?companyId=${encodeURIComponent(target)}`));
    } catch {
      setStatus({ connected: false });
    }
  }

  useEffect(() => {
    setWaiting(false);
    setError("");
    void loadStatus();
    // Kun käyttäjä palaa Googlen kirjautumisesta tähän välilehteen, tila luetaan uudelleen.
    const onFocus = () => void loadStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [target]);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const { url } = await api<{ url: string }>("/gmail/connect", { method: "POST", body: JSON.stringify({ target }) });
      window.open(url, "_blank", "noopener");
      setWaiting(true);
    } catch (connectError) {
      setError(errorMessage(connectError, "Gmail-kirjautumisen aloitus epäonnistui."));
    } finally {
      setBusy(false);
    }
  }

  async function removeOwn() {
    if (!window.confirm("Poistetaanko taloyhtiön oma Gmail-tili? Taloyhtiön posti kulkee sen jälkeen toimiston tilin kautta.")) return;
    setBusy(true);
    setError("");
    try {
      await api(`/gmail/accounts/${encodeURIComponent(target)}`, { method: "DELETE" });
      await loadStatus();
    } catch (removeError) {
      setError(errorMessage(removeError, "Tilin poistaminen epäonnistui."));
    } finally {
      setBusy(false);
    }
  }

  const admin = isAdmin();
  const own = office || Boolean(status?.own);

  return (
    <div className="settings-card gmail-card">
      <h2>{office ? "Toimiston Gmail-tili" : "Taloyhtiön Gmail-tili"}</h2>
      {!status ? <p className="muted">Tarkistetaan…</p> : status.connected ? (
        <>
          <p><strong>{status.emailAddress}</strong>{!own && <span className="gmail-shared"> · toimiston yhteinen tili</span>}</p>
          <p className="muted">
            {office
              ? "Kotilo lukee saapuvat viestit tämän tilin postilaatikosta ja lähettää vastaukset siitä. Taloyhtiö, jolla on oma tili, käyttää omaansa."
              : own
                ? "Tämän taloyhtiön viestit saapuvat tähän postilaatikkoon ja lähtevät siitä."
                : "Taloyhtiöllä ei ole omaa tiliä, joten sen posti kulkee toimiston tilin kautta. Voit yhdistää taloyhtiölle oman Gmail-tilin."}
            {status.canSend ? "" : " Tililtä puuttuu lähetysoikeus: yhdistä tili uudelleen."}
          </p>
        </>
      ) : (
        <p className="send-error">Gmail-tiliä ei ole yhdistetty tai yhteys on katkennut. Yhdistä tili uudelleen.</p>
      )}
      {admin ? (
        <div className="draft-actions">
          <button className="secondary" onClick={() => void connect()} disabled={busy}>
            {own && status?.connected ? "Vaihda Gmail-tili" : office ? "Yhdistä Gmail-tili" : "Yhdistä oma Gmail-tili"}
          </button>
          {!office && status?.own && <button className="danger" onClick={() => void removeOwn()} disabled={busy}>Poista oma tili</button>}
          {waiting && <button onClick={() => void loadStatus()}>Tarkista yhteys</button>}
        </div>
      ) : (
        <p className="reply-hint">Vain pääkäyttäjä voi vaihtaa Gmail-tilin.</p>
      )}
      {waiting && <p className="reply-hint">Kirjaudu Googlen avaamassa välilehdessä ja hyväksy oikeudet. Palaa sitten tähän välilehteen.</p>}
      {error && <p className="send-error">{error}</p>}
    </div>
  );
}

function OfficeSettings({
  company,
  onSaved
}: {
  company?: Company;
  onSaved: () => Promise<void>;
}) {
  // Toimiston omat tiedot; taloyhtiöstä tällä lomakkeella muutetaan vain tehtävien vastaanotto-osoitetta.
  const [name, setName] = useState(MANAGEMENT_OFFICE.name);
  const [businessId, setBusinessId] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [reminderEmails, setReminderEmails] = useState(false);
  const [retentionMonths, setRetentionMonths] = useState(0);
  // Viimeksi tallennettu säilytysaika; lyhentäminen varmistetaan, koska se poistaa tietoja pysyvästi.
  const [storedRetention, setStoredRetention] = useState(0);

  useEffect(() => {
    api<OfficeInfo>("/office")
      .then(office => {
        setName(office.name);
        setBusinessId(office.businessId);
        setAddress(office.address);
        setPhone(office.phone);
        setReminderEmails(Boolean(office.reminderEmails));
        setRetentionMonths(office.retentionMonths ?? 0);
        setStoredRetention(office.retentionMonths ?? 0);
      })
      .catch(() => setError("Toimiston tietojen lataus epäonnistui."));
  }, []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [gmail, setGmail] = useState<GmailStatus | null>(null);

  useEffect(() => {
    setEmailAddress(company?.email_address ?? "");
    setSaved(false);
    setError("");
  }, [company?.id]);

  useEffect(() => {
    api<GmailStatus>("/gmail/status")
      .then(setGmail)
      .catch(() => setGmail({ connected: false }));
  }, []);

  if (!company) return <div className="empty">Yhtiötä ei ole valittu.</div>;
  const companyId = company.id;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const shortens = retentionMonths > 0 && (storedRetention === 0 || retentionMonths < storedRetention);
    if (shortens && !window.confirm(
      `Säilytysajaksi tulee ${retentionMonths} kk. Tätä kauemmin suljettuna olleet tehtävät viesteineen ja liitteineen `
      + "sekä tätä vanhemmat lokimerkinnät poistetaan pysyvästi. Jatketaanko?"
    )) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const office = await api<OfficeInfo>("/office", {
        method: "PUT",
        body: JSON.stringify({ name, businessId, address, phone, reminderEmails, retentionMonths })
      });
      MANAGEMENT_OFFICE.name = office.name;
      setStoredRetention(office.retentionMonths ?? 0);
      // Taloyhtiön omat tiedot säilyvät; vain vastaanotto-osoite päivitetään.
      if (company && emailAddress.trim() !== (company.email_address ?? "")) {
        await api(`/companies/${encodeURIComponent(companyId)}`, {
          method: "PUT",
          body: JSON.stringify({
            name: company.name,
            businessId: company.business_id ?? "",
            address: company.address ?? "",
            phone: company.phone ?? "",
            emailAddress
          })
        });
      }
      await onSaved();
      setSaved(true);
    } catch (caught) {
      let message = "Asetusten tallennus epäonnistui.";
      try {
        message = JSON.parse((caught as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  const addressMismatch = Boolean(
    gmail?.connected && gmail.emailAddress && emailAddress.trim()
    && gmail.emailAddress.toLowerCase() !== emailAddress.trim().toLowerCase()
  );

  return (
    <section className="settings-layout">
      <div className="content settings">
      <form className="settings-card ticket-form" onSubmit={handleSubmit}>
        <h2>Isännöitsijätoimiston tiedot</h2>

        <label>
          <span>Toimiston nimi</span>
          <input value={name} onChange={event => { setName(event.target.value); setSaved(false); }} />
        </label>

        <label>
          <span>Y-tunnus</span>
          <input value={businessId} onChange={event => { setBusinessId(event.target.value); setSaved(false); }} placeholder="Valinnainen" />
        </label>

        <label>
          <span>Osoite</span>
          <input value={address} onChange={event => { setAddress(event.target.value); setSaved(false); }} placeholder="Valinnainen" />
        </label>

        <label>
          <span>Puhelin</span>
          <input value={phone} onChange={event => { setPhone(event.target.value); setSaved(false); }} placeholder="Valinnainen" />
        </label>

        <h2>Tehtävien vastaanotto</h2>

        <label>
          <span>Sähköposti, johon tehtävät saapuvat ({company.name})</span>
          <input
            type="email"
            value={emailAddress}
            onChange={event => { setEmailAddress(event.target.value); setSaved(false); }}
            placeholder="esim. asiakaspalvelu@yritys.fi"
          />
        </label>
        <p className="reply-hint">
          Tähän osoitteeseen lähetetyt viestit ohjataan tämän yhtiön tehtäviksi.
        </p>

        <h2>Muistutukset</h2>

        <label className="switch-row">
          <span>
            <strong>Muistutus sähköpostilla</strong>
            <small>Käsittelijä saa enintään kerran päivässä koosteen myöhässä olevista tehtävistään.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={reminderEmails}
            onChange={event => { setReminderEmails(event.target.checked); setSaved(false); }}
          />
          <i aria-hidden="true" />
        </label>
        <p className="reply-hint">
          Koosteessa ovat tehtävät, joiden määräaika on mennyt tai joissa asukkaan viesti on odottanut vastausta
          yli kaksi päivää. Viesti lähtee toimiston Gmail-tililtä käyttäjän kirjautumisosoitteeseen. Myöhässä
          olevat tehtävät näkyvät sovelluksessa aina.
        </p>

        <h2>Tietojen säilytys</h2>

        <label>
          <span>Säilytysaika</span>
          <select
            value={retentionMonths}
            onChange={event => { setRetentionMonths(Number(event.target.value)); setSaved(false); }}
          >
            <option value={0}>Säilytetään toistaiseksi</option>
            {[12, 24, 36, 60, 120].map(months => (
              <option key={months} value={months}>{months / 12} {months === 12 ? "vuosi" : "vuotta"}</option>
            ))}
            {retentionMonths > 0 && ![12, 24, 36, 60, 120].includes(retentionMonths) && (
              <option value={retentionMonths}>{retentionMonths} kk</option>
            )}
          </select>
        </label>
        <p className="reply-hint">
          Tätä kauemmin suljettuna olleet tehtävät poistetaan pysyvästi viesteineen ja liitteineen, samoin tätä
          vanhemmat lokimerkinnät. Poisto tehdään automaattisesti tunnin sisällä tallennuksesta eikä sitä voi perua.
        </p>

        {error && <p className="send-error">{error}</p>}

        <div className="draft-actions">
          <button className="primary" type="submit" disabled={saving || !name.trim()}>
            {saving ? "Tallennetaan…" : "Tallenna asetukset"}
          </button>
          {saved && <span className="saved-indicator">Tallennettu</span>}
        </div>
      </form>

      <BookingSettings defaultCompanyId={company?.id ?? ""} />

      <a className="settings-card settings-link" href="#/log">
        <div>
          <h2>Loki</h2>
          <p className="muted">Kaikki tehtäviin tehdyt muutokset, päätökset ja lähetetyt sähköpostit.</p>
        </div>
        <span aria-hidden="true">→</span>
      </a>

      <GmailAccountCard target="office" />
      </div>

      <OfficeUsers />
    </section>
  );
}

type Booking = {
  id: string;
  starts_at: string;
  ends_at: string;
  // Henkilökunnan näkymän tiedot; asukasportaalissa näistä kerrotaan vain "mine".
  resident_id?: string | null;
  note?: string;
  created_by?: string;
  resident_name?: string | null;
  apartment_number?: string | null;
  mine?: boolean;
  // Viikoittaisen varauksen vuoroilla on yhteinen sarjatunniste.
  series_id?: string | null;
};

// Taloyhtiön asetukset: mitä vuorotyyppejä kuhunkin tilaan saa varata.
// weeklyWeeks = kuinka monelle viikolle viikoittainen vuoro varataan kerralla.
// singlePrice = yhden vuoron hinta, monthlyPrice = viikoittaisen vuoron hinta kuukaudessa (euroa).
type BookingRule = { single: boolean; weekly: boolean; weeklyWeeks: number; singlePrice: number; monthlyPrice: number };
type BookingRules = Record<"sauna" | "laundry", BookingRule>;

const DEFAULT_BOOKING_RULES: BookingRules = {
  sauna: { single: true, weekly: true, weeklyWeeks: 12, singlePrice: 0, monthlyPrice: 0 },
  laundry: { single: true, weekly: true, weeklyWeeks: 12, singlePrice: 0, monthlyPrice: 0 }
};

function formatEuros(amount: number) {
  return amount.toLocaleString("fi-FI", { style: "currency", currency: "EUR" });
}

// Asetuksissa valittavat viikoittaisen vuoron kestot.
const WEEKLY_DURATION_OPTIONS = [
  { weeks: 4, label: "4 viikkoa (noin 1 kk)" },
  { weeks: 8, label: "8 viikkoa (noin 2 kk)" },
  { weeks: 12, label: "12 viikkoa (noin 3 kk)" },
  { weeks: 26, label: "26 viikkoa (puoli vuotta)" }
];

// Asetuksen kesto, jos se on jokin valittavista; muuten oletus 12 viikkoa.
function weeklyWeeksOf(rule: { weeklyWeeks?: number } | undefined) {
  return WEEKLY_DURATION_OPTIONS.some(option => option.weeks === rule?.weeklyWeeks) ? rule!.weeklyWeeks! : 12;
}

// Tilakohtaiset asetukset: varattavat tunnit ja yhden vuoron pituus tunteina.
const BOOKING_RESOURCES: Record<"sauna" | "laundry", { name: string; firstHour: number; lastHour: number; slotHours: number }> = {
  sauna: { name: "Sauna", firstHour: 15, lastHour: 22, slotHours: 1 },
  laundry: { name: "Pyykkitupa", firstHour: 7, lastHour: 21, slotHours: 1 }
};

function startOfWeek(date: Date) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

// Viikkokalenteri yhteistilan vuoroille. Sama komponentti saunalle ja pyykkituvalle;
// erot (tunnit, vuoron pituus) tulevat BOOKING_RESOURCES-asetuksista.
function BookingCalendar({
  resource,
  companyId,
  companies,
  onCompanyChange,
  portalResident,
  embedded = false
}: {
  // embedded = näytetään taloyhtiön tietueen sisällä, jolloin yhtiö on jo valittu.
  embedded?: boolean;
  resource: "sauna" | "laundry";
  companyId: string;
  companies: Company[];
  onCompanyChange: (companyId: string) => void;
  // Asukasportaali: asukas varaa vain itselleen oman yhtiönsä vuoroja eikä näe muiden nimiä.
  portalResident?: ResidentAccount;
}) {
  const portal = Boolean(portalResident);
  // Asukkaan varaus täyttyy hänen omilla tiedoillaan.
  const residentFacts = portalResident && (
    <dl className="ticket-facts">
      <div>
        <dt>Varaaja</dt>
        <dd>{portalResident.name}</dd>
      </div>
      <div>
        <dt>Asunto</dt>
        <dd>{portalResident.apartmentNumber}</dd>
      </div>
      <div>
        <dt>Taloyhtiö</dt>
        <dd>{portalResident.companyName}</dd>
      </div>
      <div>
        <dt>Sähköposti</dt>
        <dd>{portalResident.email || "–"}</dd>
      </div>
    </dl>
  );
  const config = BOOKING_RESOURCES[resource];
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [residents, setResidents] = useState<Resident[]>([]);
  const [loadError, setLoadError] = useState(false);
  // Avoin vuoro: joko vapaa aika (uusi varaus) tai olemassa oleva varaus.
  const [slot, setSlot] = useState<{ start: Date; booking: Booking | null } | null>(null);
  const [residentId, setResidentId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [repeat, setRepeat] = useState<"once" | "weekly">("once");
  // Suodattimet: näytettävä kellonaikaväli ja se, näytetäänkö vapaat, varatut vai kaikki vuorot.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fromHour, setFromHour] = useState(config.firstHour);
  const [toHour, setToHour] = useState(config.lastHour);
  const [show, setShow] = useState<"all" | "free" | "booked">("all");
  const calendarFiltered = fromHour !== config.firstHour || toHour !== config.lastHour || show !== "all";
  // Viikoittaisen varauksen tulos: montako vuoroa varattiin ja montako viikkoa ohitettiin.
  const [bookingNotice, setBookingNotice] = useState("");
  const [rules, setRules] = useState(DEFAULT_BOOKING_RULES[resource]);
  const bookingDisabled = !rules.single && !rules.weekly;

  useEffect(() => {
    api<BookingRules>(portal ? "/portal/booking-settings" : `/companies/${encodeURIComponent(companyId)}/booking-settings`)
      .then(all => setRules(all[resource]))
      .catch(() => setRules(DEFAULT_BOOKING_RULES[resource]));
  }, [companyId, resource, portal]);

  const days = Array.from({ length: 7 }, (_, index) =>
    new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + index));
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
  const hours: number[] = [];
  for (let hour = config.firstHour; hour + config.slotHours <= config.lastHour; hour += config.slotHours) hours.push(hour);
  const visibleHours = hours.filter(hour => hour >= fromHour && hour + config.slotHours <= toHour);
  const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}.00`;

  async function loadBookings() {
    try {
      const query = `resource=${resource}&from=${encodeURIComponent(weekStart.toISOString())}&to=${encodeURIComponent(weekEnd.toISOString())}`;
      setBookings(await api<Booking[]>(portal
        ? `/portal/bookings?${query}`
        : `/companies/${encodeURIComponent(companyId)}/bookings?${query}`));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }

  useEffect(() => {
    void loadBookings();
  }, [companyId, resource, weekStart.getTime()]);

  useEffect(() => {
    if (portal) return;
    api<Resident[]>(`/companies/${encodeURIComponent(companyId)}/residents`)
      .then(setResidents)
      .catch(() => setResidents([]));
  }, [companyId, portal]);

  function shiftWeek(weeks: number) {
    setWeekStart(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + weeks * 7));
  }

  function openSlot(start: Date, booking: Booking | null) {
    setSlot({ start, booking });
    setResidentId("");
    setNote("");
    setFormError("");
    // Oletuksena kertaluontoinen; jos se on kytketty pois, viikoittainen.
    setRepeat(rules.single ? "once" : "weekly");
  }

  const slotEnd = (start: Date) => new Date(start.getTime() + config.slotHours * 60 * 60 * 1000);
  const timeLabel = (date: Date) => date.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
  const now = Date.now();
  const today = new Date().toDateString();

  async function handleBook(event: FormEvent) {
    event.preventDefault();
    if (!slot) return;
    setSaving(true);
    setFormError("");
    try {
      // Sama viikonpäivä ja kellonaika seuraavina viikkoina, paikallisessa ajassa.
      const repeats = repeat === "weekly"
        ? Array.from({ length: weeklyWeeksOf(rules) - 1 }, (_, index) => {
            const start = new Date(slot.start);
            start.setDate(start.getDate() + (index + 1) * 7);
            return { startsAt: start.toISOString(), endsAt: slotEnd(start).toISOString() };
          })
        : [];
      const result = await api<{ created: number; skipped: string[] }>(
        portal ? "/portal/bookings" : `/companies/${encodeURIComponent(companyId)}/bookings`,
        {
          method: "POST",
          body: JSON.stringify({
            resource,
            startsAt: slot.start.toISOString(),
            endsAt: slotEnd(slot.start).toISOString(),
            repeats,
            ...(portal ? {} : { residentId: residentId || undefined, note })
          })
        }
      );
      setBookingNotice(repeat === "weekly"
        ? `Viikoittainen varaus tehty: ${result.created} vuoroa varattu`
          + (result.skipped.length > 0
            ? `, ${result.skipped.length} viikkoa ohitettiin, koska vuoro oli jo varattu: `
              + result.skipped.map(time => new Date(time).toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" })).join(", ") + "."
            : ".")
        : "");
      setSlot(null);
      await loadBookings();
    } catch (error) {
      setFormError(errorMessage(error, "Varauksen tallennus epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(wholeSeries = false) {
    if (!slot?.booking) return;
    setSaving(true);
    setFormError("");
    try {
      await api(
        `${portal ? "/portal" : ""}/bookings/${encodeURIComponent(slot.booking.id)}${wholeSeries ? "?series=1" : ""}`,
        { method: "DELETE" }
      );
      setBookingNotice("");
      setSlot(null);
      await loadBookings();
    } catch (error) {
      setFormError(errorMessage(error, "Varauksen poistaminen epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="content">
      {!portal && !embedded && <a className="back-link" href="#/companies">← Taloyhtiöt</a>}

      {filtersOpen && (
        <div className="ticket-filters">
          {!portal && !embedded && (
            <Dropdown
              label="Taloyhtiö"
              value={companyId}
              options={companies.map(company => ({ value: company.id, label: company.name }))}
              onChange={onCompanyChange}
            />
          )}
          <Dropdown
            label="Kellonaika alkaen"
            value={String(fromHour)}
            options={hours.filter(hour => hour < toHour).map(hour => ({ value: String(hour), label: hourLabel(hour) }))}
            onChange={value => setFromHour(Number(value))}
          />
          <Dropdown
            label="Kellonaika asti"
            value={String(toHour)}
            options={hours.map(hour => hour + config.slotHours).filter(hour => hour > fromHour)
              .map(hour => ({ value: String(hour), label: hourLabel(hour) }))}
            onChange={value => setToHour(Number(value))}
          />
          <Dropdown
            label="Näytä"
            value={show}
            options={[
              { value: "all", label: "Kaikki vuorot" },
              { value: "free", label: "Vain vapaat" },
              { value: "booked", label: "Vain varatut" }
            ]}
            onChange={value => setShow(value as typeof show)}
          />
          {calendarFiltered && (
            <button className="clear-filters" onClick={() => {
              setFromHour(config.firstHour);
              setToHour(config.lastHour);
              setShow("all");
            }}>Tyhjennä suodattimet</button>
          )}
        </div>
      )}

      <div className="calendar-toolbar">
        <button
          className={`filter-toggle ${filtersOpen || calendarFiltered ? "active" : ""}`}
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
          {calendarFiltered && <i />}
        </button>
        {!portal && !embedded && <strong className="calendar-company">{companies.find(company => company.id === companyId)?.name}</strong>}
        <div className="calendar-week">
          <button onClick={() => shiftWeek(-1)} aria-label="Edellinen viikko">←</button>
          <strong>
            {days[0].toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" })}–
            {days[6].toLocaleDateString("fi-FI", { day: "numeric", month: "numeric", year: "numeric" })}
          </strong>
          <button onClick={() => shiftWeek(1)} aria-label="Seuraava viikko">→</button>
          <button className="calendar-today" onClick={() => setWeekStart(startOfWeek(new Date()))}>Tämä viikko</button>
        </div>
        <span className="calendar-count">
          {portal
            ? `${bookings.filter(item => item.mine).length} omaa varausta tällä viikolla`
            : `${bookings.length} varausta tällä viikolla`}
        </span>
      </div>

      {loadError && <div className="empty">Varausten lataus epäonnistui.</div>}
      {bookingNotice && <p className="ai-reason created booking-notice">{bookingNotice}</p>}
      {bookingDisabled && (
        <p className="ai-reason missing booking-notice">
          {config.name}vuorojen varaaminen on kytketty pois tämän taloyhtiön asetuksista.
        </p>
      )}

      <div className="calendar">
        <div className="calendar-corner" />
        {days.map(day => (
          <div key={day.getTime()} className={`calendar-day ${day.toDateString() === today ? "today" : ""}`}>
            <strong>{day.toLocaleDateString("fi-FI", { weekday: "short" })}</strong>
            <span>{day.toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" })}</span>
          </div>
        ))}
        {visibleHours.map(hour => (
          <div className="calendar-row" key={hour}>
            <div className="calendar-time">
              {String(hour).padStart(2, "0")}–{String(hour + config.slotHours).padStart(2, "0")}
            </div>
            {days.map(day => {
              const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
              const end = slotEnd(start);
              const booking = bookings.find(item =>
                Date.parse(item.starts_at) < end.getTime() && Date.parse(item.ends_at) > start.getTime()) ?? null;
              const past = end.getTime() <= now;
              // Suodatettu pois: ruutu jää tyhjäksi, jotta viikon rakenne säilyy.
              if ((show === "free" && booking) || (show === "booked" && !booking)) {
                return <div key={start.getTime()} className="calendar-slot hidden-slot" />;
              }
              return booking ? (
                <button
                  key={start.getTime()}
                  className={`calendar-slot booked ${past ? "past" : ""} ${portal && !booking.mine ? "other" : ""}`}
                  onClick={() => openSlot(start, booking)}
                  // Asukas voi avata vain oman varauksensa.
                  disabled={portal && !booking.mine}
                  title={portal && !booking.mine ? "Vuoro on varattu" : "Avaa varaus"}
                >
                  <strong>
                    {portal ? (booking.mine ? "Oma varaus" : "Varattu") : booking.resident_name || booking.note || "Varattu"}
                  </strong>
                  {!portal && booking.apartment_number && <span>{booking.apartment_number}</span>}
                </button>
              ) : (
                <button
                  key={start.getTime()}
                  className="calendar-slot free"
                  onClick={() => openSlot(start, null)}
                  disabled={past || bookingDisabled}
                  title={past ? "Aika on jo mennyt" : bookingDisabled ? "Varaaminen ei ole käytössä" : "Varaa vuoro"}
                >
                  {past || bookingDisabled ? "" : "+ Varaa"}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {slot && (
        <div className="overlay" onClick={() => setSlot(null)}>
          <aside className="drawer form-drawer resident-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={() => setSlot(null)}>×</button>
            <h2>{slot.booking ? "Varaus" : "Uusi varaus"}</h2>
            <p className="muted">
              {config.name} · {portalResident?.companyName ?? companies.find(company => company.id === companyId)?.name ?? ""}{" "}·{" "}
              {slot.start.toLocaleDateString("fi-FI", { weekday: "long", day: "numeric", month: "numeric", year: "numeric" })}{" "}
              klo {timeLabel(slot.start)}–{timeLabel(slotEnd(slot.start))}
            </p>

            {slot.booking && portal ? (
              <>
                <p className="topic-text">Tämä on oma varauksesi.</p>
                {residentFacts}
                {formError && <p className="send-error">{formError}</p>}
                <div className="drawer-actions compact-actions">
                  <button type="button" onClick={() => setSlot(null)}>Sulje</button>
                  {slot.booking.series_id && (
                    <button className="danger" type="button" onClick={() => handleDelete(true)} disabled={saving}>
                      Peru tämä ja tulevat viikot
                    </button>
                  )}
                  <button className="danger" type="button" onClick={() => handleDelete()} disabled={saving}>
                    {saving ? "Perutaan…" : slot.booking.series_id ? "Peru vain tämä vuoro" : "Peru varaus"}
                  </button>
                </div>
              </>
            ) : slot.booking ? (
              <>
                <dl className="ticket-facts">
                  <div>
                    <dt>Varaaja</dt>
                    <dd>{slot.booking.resident_name || "–"}</dd>
                  </div>
                  <div>
                    <dt>Asunto</dt>
                    <dd>{slot.booking.apartment_number || "–"}</dd>
                  </div>
                  <div>
                    <dt>Lisätieto</dt>
                    <dd>{slot.booking.note || "–"}</dd>
                  </div>
                  <div>
                    <dt>Varauksen teki</dt>
                    <dd>{slot.booking.created_by}</dd>
                  </div>
                </dl>
                {formError && <p className="send-error">{formError}</p>}
                <div className="drawer-actions compact-actions">
                  <button type="button" onClick={() => setSlot(null)}>Sulje</button>
                  {slot.booking.series_id && (
                    <button className="danger" type="button" onClick={() => handleDelete(true)} disabled={saving}>
                      Poista tämä ja tulevat viikot
                    </button>
                  )}
                  <button className="danger" type="button" onClick={() => handleDelete()} disabled={saving}>
                    {saving ? "Poistetaan…" : slot.booking.series_id ? "Poista vain tämä vuoro" : "Poista varaus"}
                  </button>
                </div>
              </>
            ) : (
              <form className="ticket-form" onSubmit={handleBook}>
                {portal && (
                  <>
                    <p className="topic-text">Varaus tehdään alla olevilla tiedoillasi. Vahvista vuoro.</p>
                    {residentFacts}
                  </>
                )}
                {!portal && (
                <>
                <label>
                  <span>Asukas</span>
                  <select value={residentId} onChange={event => setResidentId(event.target.value)}>
                    <option value="">Ei asukasta (esim. huolto tai yleinen varaus)</option>
                    {residents.map(resident => (
                      <option key={resident.id} value={resident.id}>
                        {[resident.name, resident.apartment_number].filter(Boolean).join(" · ")}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Lisätieto</span>
                  <input value={note} onChange={event => setNote(event.target.value)} placeholder="Valinnainen, esim. Huoltokatko" />
                </label>
                </>
                )}

                <fieldset className="repeat-choice">
                  <legend>Onko varaus kertaluontoinen vai viikoittainen?</legend>
                  <label>
                    <input type="radio" name="repeat" checked={repeat === "once"} onChange={() => setRepeat("once")} disabled={!rules.single} />
                    <span>
                      <strong>Kertaluontoinen</strong>
                      <small>{rules.single ? "Vain tämä vuoro." : "Ei käytössä tässä taloyhtiössä."}</small>
                    </span>
                  </label>
                  <label>
                    <input type="radio" name="repeat" checked={repeat === "weekly"} onChange={() => setRepeat("weekly")} disabled={!rules.weekly} />
                    <span>
                      <strong>Viikoittainen</strong>
                      <small>
                        {rules.weekly
                          ? `Sama vuoro joka viikko, seuraavat ${weeklyWeeksOf(rules)} viikkoa.`
                          : "Ei käytössä tässä taloyhtiössä."}
                      </small>
                    </span>
                  </label>
                </fieldset>

                {formError && <p className="send-error">{formError}</p>}

                <div className="drawer-actions compact-actions">
                  <button type="button" onClick={() => setSlot(null)}>Peruuta</button>
                  <button className="primary" type="submit" disabled={saving || (!portal && !residentId && !note.trim())}>
                    {saving ? "Varataan…" : "Varaa vuoro"}
                  </button>
                </div>
              </form>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

// Asukasportaali: asukas näkee vain oman taloyhtiönsä sauna- ja pyykkitupavuorot.
function ResidentPortal({ resident }: { resident: ResidentAccount }) {
  const [view, setView] = useState<"announcements" | "sauna" | "laundry" | "tickets" | "waitlist" | "moves">("announcements");

  return (
    <div className="portal">
      <header className="portal-header">
        <img src="/kotilo-logo.svg" alt="Kotilo" />
        <nav>
          <button className={view === "announcements" ? "active" : ""} onClick={() => setView("announcements")}>Tiedotteet</button>
          <button className={view === "sauna" ? "active" : ""} onClick={() => setView("sauna")}>Saunavuorot</button>
          <button className={view === "laundry" ? "active" : ""} onClick={() => setView("laundry")}>Pyykkitupavuorot</button>
          <button className={view === "tickets" ? "active" : ""} onClick={() => setView("tickets")}>Tehtävät</button>
          <button className={view === "waitlist" ? "active" : ""} onClick={() => setView("waitlist")}>Jonot</button>
          <button className={view === "moves" ? "active" : ""} onClick={() => setView("moves")}>Muuttoilmoitus</button>
        </nav>
        <div className="portal-user">
          <strong>{resident.name}</strong>
          <span>{resident.companyName} · {resident.apartmentNumber}</span>
          <button
            onClick={logout}
          >
            Kirjaudu ulos
          </button>
        </div>
      </header>

      <main className="portal-main">
        <div>
          <h1>{view === "announcements" ? "Tiedotteet" : view === "sauna" ? "Saunavuorot" : view === "laundry" ? "Pyykkitupavuorot" : view === "waitlist" ? "Jonot" : view === "moves" ? "Muuttoilmoitus" : "Tehtävät"}</h1>
          <p className="muted">{resident.companyName}</p>
        </div>
        {view === "announcements" ? <PortalAnnouncements />
          : view === "tickets" ? <PortalTickets resident={resident} />
          : view === "waitlist" ? <PortalWaitlist />
          : view === "moves" ? <PortalMoves resident={resident} />
          : (
          <BookingCalendar
            key={view}
            portalResident={resident}
            resource={view}
            companyId={resident.companyId}
            companies={[]}
            onCompanyChange={() => undefined}
          />
        )}
      </main>
    </div>
  );
}

type PortalTicket = {
  id: string;
  ticket_number?: number;
  subject: string;
  type: string;
  status: string;
  created_at: string;
  updated_at?: string;
};

const PORTAL_TICKET_TYPES = ["Vikailmoitus", "Kysymys", "Ilmoitus", "Pyyntö", "Muu"];

// Asukkaan tehtävät: uuden tehtävän luonti isännöitsijälle ja lista omista tehtävistä tiloineen.
// Asukkaan liitevalinta: kuvat ja PDF:t, enintään viisi.
function PortalFilePicker({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  return (
    <div className="reply-attachments">
      <label className="attach-button">
        Liitä kuva
        <input
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,image/heic,application/pdf"
          onChange={event => {
            const picked = [...(event.target.files ?? [])];
            event.target.value = "";
            onChange([...files, ...picked].slice(0, 5));
          }}
        />
      </label>
      {files.map((file, index) => (
        <span className="reply-file" key={`${file.name}-${index}`}>
          {file.name} <small>{formatFileSize(file.size)}</small>
          <button type="button" onClick={() => onChange(files.filter((_, position) => position !== index))} aria-label={`Poista liite ${file.name}`}>×</button>
        </span>
      ))}
    </div>
  );
}

async function portalAttachments(files: File[]) {
  return Promise.all(files.map(async file => ({ filename: file.name, mimeType: file.type, data: await fileToBase64(file) })));
}

type PortalThread = {
  ticket: PortalTicket;
  messages: { id: string; direction: string; body: string; created_at: string }[];
  attachments: { id: string; filename: string; size: number; created_at: string; direction: string }[];
};

// Asukkaan näkymä yhteen tehtävään: viestiketju isännöitsijän kanssa, liitteet ja uusi viesti.
function PortalTicketThread({ ticketId, onBack }: { ticketId: string; onBack: () => void }) {
  const [thread, setThread] = useState<PortalThread | null>(null);
  const [failed, setFailed] = useState(false);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function loadThread() {
    try {
      setThread(await api<PortalThread>(`/portal/tickets/${encodeURIComponent(ticketId)}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    void loadThread();
  }, [ticketId]);

  async function send(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError("");
    try {
      await api(`/portal/tickets/${encodeURIComponent(ticketId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: body.trim(), attachments: await portalAttachments(files) })
      });
      setBody("");
      setFiles([]);
      await loadThread();
    } catch (sendError) {
      setError(errorMessage(sendError, "Viestin lähetys epäonnistui. Yritä uudelleen."));
    } finally {
      setSending(false);
    }
  }

  if (failed) return <p className="send-error">Tehtävän lataus epäonnistui.</p>;
  if (!thread) return <div className="empty">Ladataan…</div>;
  const closed = thread.ticket.status === "closed";

  return (
    <div className="portal-thread">
      <button className="back-link" onClick={onBack}>← Kaikki tehtävät</button>
      <div className="portal-thread-head">
        <h2>{thread.ticket.subject}</h2>
        <p className="muted">
          #{formatTicketNumber(thread.ticket.ticket_number)} · {thread.ticket.type} · {closed ? "Suljettu" : "Käsittelyssä"} · luotu {formatDate(thread.ticket.created_at)}
        </p>
      </div>

      <div className="portal-messages">
        {thread.messages.map(message => (
          <div key={message.id} className={`portal-message ${message.direction === "inbound" ? "mine" : "theirs"}`}>
            <small>{message.direction === "inbound" ? "Sinä" : "Isännöitsijä"} · {formatDate(message.created_at)}</small>
            <p>{message.direction === "inbound" ? splitQuotedReply(message.body).text : message.body}</p>
          </div>
        ))}
        {thread.messages.length === 0 && <p className="muted">Ei viestejä.</p>}
      </div>

      {thread.attachments.length > 0 && (
        <div className="portal-thread-files">
          <strong>Liitteet</strong>
          {thread.attachments.map(attachment => (
            <a key={attachment.id} href={fileUrl(`/portal/attachments/${attachment.id}`)} download={attachment.filename}>
              {attachment.filename} <small>{attachment.direction === "portal" ? "sinulta" : "isännöitsijältä"} · {formatFileSize(attachment.size)}</small>
            </a>
          ))}
        </div>
      )}

      <form className="ticket-form portal-ticket-form" onSubmit={send}>
        <label>
          <span>{closed ? "Uusi viesti (avaa tehtävän uudelleen)" : "Uusi viesti isännöitsijälle"}</span>
          <textarea value={body} onChange={event => setBody(event.target.value)} rows={4} maxLength={5000} required />
        </label>
        <PortalFilePicker files={files} onChange={setFiles} />
        {error && <p className="send-error">{error}</p>}
        <div className="portal-ticket-actions">
          <button type="submit" className="portal-new" disabled={sending || !body.trim()}>{sending ? "Lähetetään…" : "Lähetä viesti"}</button>
        </div>
      </form>
    </div>
  );
}

function PortalTickets({ resident }: { resident: ResidentAccount }) {
  const [tickets, setTickets] = useState<PortalTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState(PORTAL_TICKET_TYPES[0]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [sent, setSent] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  // Avattu tehtävä näyttää viestiketjun listan tilalla.
  const [openId, setOpenId] = useState<string | null>(null);

  async function loadTickets() {
    try {
      setTickets(await api<PortalTicket[]>("/portal/tickets"));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTickets();
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (subject.trim().length < 3 || description.trim().length < 5) {
      setFormError("Kirjoita otsikko ja kuvaus.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const created = await api<{ attachmentError?: string | null }>("/portal/tickets", {
        method: "POST",
        body: JSON.stringify({ subject: subject.trim(), description: description.trim(), type, attachments: await portalAttachments(files) })
      });
      if (created.attachmentError) setFormError(`Tehtävä lähetettiin, mutta liitteitä ei tallennettu: ${created.attachmentError}`);
      setFiles([]);
      setSubject("");
      setDescription("");
      setType(PORTAL_TICKET_TYPES[0]);
      setCreating(false);
      setSent(true);
      await loadTickets();
    } catch {
      setFormError("Tehtävän lähetys epäonnistui. Yritä uudelleen.");
    } finally {
      setSaving(false);
    }
  }

  if (openId) {
    return <PortalTicketThread ticketId={openId} onBack={() => { setOpenId(null); void loadTickets(); }} />;
  }

  return (
    <>
      <div className="portal-tickets-head">
        <p className="muted">
          Vikailmoitukset, kysymykset ja pyynnöt isännöitsijälle. Kiireellisessä hätätilanteessa soita huoltoyhtiön päivystykseen.
        </p>
        {!creating && (
          <button className="portal-new" onClick={() => { setCreating(true); setSent(false); }}>Luo tehtävä</button>
        )}
      </div>

      {sent && !creating && <p className="portal-sent">Tehtävä on lähetetty isännöitsijälle.</p>}
      {formError && !creating && <p className="send-error">{formError}</p>}

      {creating && (
        <form className="ticket-form portal-ticket-form" onSubmit={handleSubmit}>
          <dl className="ticket-facts">
            <div>
              <dt>Ilmoittaja</dt>
              <dd>{resident.name}</dd>
            </div>
            <div>
              <dt>Asunto</dt>
              <dd>{resident.apartmentNumber || "–"}</dd>
            </div>
          </dl>

          <label>
            <span>Tyyppi</span>
            <select value={type} onChange={event => setType(event.target.value)}>
              {PORTAL_TICKET_TYPES.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>

          <label>
            <span>Otsikko</span>
            <input
              value={subject}
              onChange={event => setSubject(event.target.value)}
              maxLength={150}
              placeholder="Esim. Keittiön hana vuotaa"
              required
              autoFocus
            />
          </label>

          <label>
            <span>Kuvaus</span>
            <textarea
              value={description}
              onChange={event => setDescription(event.target.value)}
              maxLength={5000}
              rows={6}
              placeholder="Kerro, mitä on tapahtunut ja missä."
              required
            />
          </label>

          <PortalFilePicker files={files} onChange={setFiles} />

          {formError && <p className="send-error">{formError}</p>}

          <div className="portal-ticket-actions">
            <button type="button" className="secondary" onClick={() => setCreating(false)} disabled={saving}>Peruuta</button>
            <button type="submit" className="portal-new" disabled={saving}>{saving ? "Lähetetään…" : "Lähetä tehtävä"}</button>
          </div>
        </form>
      )}

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <p className="send-error">Tehtävien lataus epäonnistui.</p>
        : tickets.length === 0 ? <div className="empty">Et ole vielä luonut tehtäviä.</div>
        : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Numero</th>
                  <th>Otsikko</th>
                  <th>Tyyppi</th>
                  <th>Tila</th>
                  <th>Luotu</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map(ticket => (
                  <tr
                    key={ticket.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title="Avaa viestiketju"
                    onClick={() => setOpenId(ticket.id)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenId(ticket.id);
                      }
                    }}
                  >
                    <td>#{formatTicketNumber(ticket.ticket_number)}</td>
                    <td><strong>{ticket.subject}</strong></td>
                    <td>{ticket.type}</td>
                    <td>{ticket.status === "closed" ? "Suljettu" : "Käsittelyssä"}</td>
                    <td>{formatDate(ticket.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </>
  );
}

// Asetukset: saako taloyhtiön saunaan ja pyykkitupaan varata yksittäisiä ja viikoittaisia vuoroja.
function BookingSettings({ defaultCompanyId }: { defaultCompanyId: string }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const [rules, setRules] = useState<BookingRules | null>(null);
  const [parkingPrices, setParkingPrices] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState("");
  const readOnly = !isAdmin();
  // Tiivistetyt osiot ("card" = koko kortti). Osiot ovat kiinni aina, kun asetukset avataan.
  const [collapsed, setCollapsed] = useState<string[]>(["sauna", "laundry", "parking"]);

  function toggleCollapsed(key: string) {
    setCollapsed(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key]);
  }

  useEffect(() => {
    api<Company[]>("/companies")
      .then(list => {
        setCompanies(list);
        setCompanyId(current => current || list[0]?.id || "");
      })
      .catch(() => setError("Taloyhtiöiden lataus epäonnistui."));
  }, []);

  useEffect(() => {
    if (!companyId) return;
    setRules(null);
    setParkingPrices(null);
    api<BookingRules>(`/companies/${encodeURIComponent(companyId)}/booking-settings`)
      .then(setRules)
      .catch(() => setError("Asetusten lataus epäonnistui."));
    api<Record<string, number>>(`/companies/${encodeURIComponent(companyId)}/parking-prices`)
      .then(setParkingPrices)
      .catch(() => setError("Asetusten lataus epäonnistui."));
  }, [companyId]);

  function setParkingPrice(type: string, value: string) {
    if (!parkingPrices) return;
    setParkingPrices({ ...parkingPrices, [type]: Math.max(0, Number(value.replace(",", ".")) || 0) });
  }

  async function saveParkingPrices() {
    if (!parkingPrices) return;
    setError("");
    try {
      setParkingPrices(await api<Record<string, number>>(`/companies/${encodeURIComponent(companyId)}/parking-prices`, {
        method: "PUT",
        body: JSON.stringify(parkingPrices)
      }));
    } catch {
      setError("Asetuksen tallennus epäonnistui.");
    }
  }

  // Muutos tallentuu heti; jos tallennus epäonnistuu, palataan edelliseen tilaan.
  async function toggle(resource: "sauna" | "laundry", kind: "single" | "weekly") {
    if (!rules) return;
    await save({ ...rules, [resource]: { ...rules[resource], [kind]: !rules[resource][kind] } });
  }

  async function setWeeklyWeeks(resource: "sauna" | "laundry", weeks: number) {
    if (!rules) return;
    await save({ ...rules, [resource]: { ...rules[resource], weeklyWeeks: weeks } });
  }

  // Hinta päivittyy kenttään kirjoittaessa ja tallennetaan, kun kentästä poistutaan.
  function setPrice(resource: "sauna" | "laundry", key: "singlePrice" | "monthlyPrice", value: string) {
    if (!rules) return;
    const amount = Math.max(0, Number(value.replace(",", ".")) || 0);
    setRules({ ...rules, [resource]: { ...rules[resource], [key]: amount } });
  }

  async function save(next: BookingRules) {
    const previous = rules;
    setRules(next);
    setError("");
    try {
      setRules(await api<BookingRules>(`/companies/${encodeURIComponent(companyId)}/booking-settings`, {
        method: "PUT",
        body: JSON.stringify(next)
      }));
    } catch {
      setRules(previous);
      setError("Asetuksen tallennus epäonnistui.");
    }
  }

  const sections: { resource: "sauna" | "laundry"; title: string; shift: string }[] = [
    { resource: "sauna", title: "Saunavuorot", shift: "saunavuoron" },
    { resource: "laundry", title: "Pyykkitupavuorot", shift: "pyykkitupavuoron" }
  ];

  // Otsikko, jota painamalla osio tiivistyy tai avautuu.
  function collapseHead(key: string, title: string, level: "h2" | "h3") {
    const open = !collapsed.includes(key);
    const Heading = level;
    return (
      <Heading className="collapse-heading">
        <button
          type="button"
          className="collapse-head"
          onClick={() => toggleCollapsed(key)}
          aria-expanded={open}
          title={open ? "Tiivistä osio" : "Näytä osio"}
        >
          <span>{title}</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </Heading>
    );
  }

  if (collapsed.includes("card")) {
    return (
      <div className="settings-card booking-settings">
        {collapseHead("card", "Vuorovaraukset ja autopaikat", "h2")}
      </div>
    );
  }

  return (
    <div className="settings-card booking-settings">
      {collapseHead("card", "Vuorovaraukset ja autopaikat", "h2")}
      <p className="muted">Valitse taloyhtiökohtaisesti, millaisia vuoroja saa varata ja mitä vuorot ja autopaikat maksavat. Pois kytkettyä vuorotyyppiä ei voi varata asukas eikä isännöitsijä.</p>
      {readOnly && <p className="reply-hint">Vain pääkäyttäjä voi muuttaa näitä asetuksia.</p>}

      <label className="booking-settings-company">
        <span>Taloyhtiö</span>
        <select value={companyId} onChange={event => setCompanyId(event.target.value)}>
          {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
        </select>
      </label>

      {sections.map(section => (
        <div className="booking-settings-section" key={section.resource}>
          {collapseHead(section.resource, section.title, "h3")}
          {!collapsed.includes(section.resource) && (
          <>
          {(["single", "weekly"] as const).map(kind => (
            <label className="switch-row" key={kind}>
              <span>
                <strong>{kind === "single" ? "Yksittäiset vuorot" : "Viikoittaiset vuorot"}</strong>
                <small>
                  {kind === "single" ? "Kertaluontoinen varaus yhdelle vuorolle." : "Sama vuoro joka viikko."}
                </small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={rules?.[section.resource][kind] ?? true}
                disabled={!rules || readOnly}
                onChange={() => void toggle(section.resource, kind)}
              />
              <i aria-hidden="true" />
            </label>
          ))}
          <label className="booking-settings-duration">
            <span>
              <strong>Viikoittaisen vuoron kesto</strong>
              <small>Kuinka pitkäksi ajaksi vuoro varataan, kun valitaan viikoittainen.</small>
            </span>
            <select
              value={weeklyWeeksOf(rules?.[section.resource])}
              disabled={!rules || readOnly || !rules[section.resource].weekly}
              onChange={event => void setWeeklyWeeks(section.resource, Number(event.target.value))}
            >
              {WEEKLY_DURATION_OPTIONS.map(option => <option key={option.weeks} value={option.weeks}>{option.label}</option>)}
            </select>
          </label>
          <label className="booking-settings-duration">
            <span>
              <strong>Yhden {section.shift} hinta</strong>
              <small>Laskutetaan jokaisesta yksittäisestä vuorosta.</small>
            </span>
            <span className="price-input">
              <input
                type="number"
                min="0"
                step="0.5"
                value={rules?.[section.resource].singlePrice ?? 0}
                disabled={!rules || readOnly}
                onChange={event => setPrice(section.resource, "singlePrice", event.target.value)}
                onBlur={() => rules && void save(rules)}
              />
              €
            </span>
          </label>
          <label className="booking-settings-duration">
            <span>
              <strong>Viikoittaisen {section.shift} kuukausihinta</strong>
              <small>Laskutetaan kerran kuukaudessa jokaisesta viikkovuorosta.</small>
            </span>
            <span className="price-input">
              <input
                type="number"
                min="0"
                step="0.5"
                value={rules?.[section.resource].monthlyPrice ?? 0}
                disabled={!rules || readOnly}
                onChange={event => setPrice(section.resource, "monthlyPrice", event.target.value)}
                onBlur={() => rules && void save(rules)}
              />
              €
            </span>
          </label>
          </>
          )}
        </div>
      ))}

      <div className="booking-settings-section">
        {collapseHead("parking", "Autopaikat", "h3")}
        {!collapsed.includes("parking") && PARKING_TYPES.map(type => (
          <label className="booking-settings-duration" key={type}>
            <span>
              <strong>{type}</strong>
              <small>Paikan hinta kuukaudessa.</small>
            </span>
            <span className="price-input">
              <input
                type="number"
                min="0"
                step="0.5"
                value={parkingPrices?.[type] ?? 0}
                disabled={!parkingPrices || readOnly}
                onChange={event => setParkingPrice(type, event.target.value)}
                onBlur={() => void saveParkingPrices()}
              />
              €/kk
            </span>
          </label>
        ))}
      </div>

      {error && <p className="send-error">{error}</p>}
    </div>
  );
}

// Raportti laskutusta varten: valitun kuukauden saunavuorot asukkaittain. Yksittäiset vuorot
// laskutetaan kappalehinnalla ja viikoittaiset vuorot kuukausihinnalla taloyhtiön asetuksista.
function SaunaBilling({ companyId, tabs }: { companyId: string; tabs: ReactNode }) {
  const [kind, setKind] = useState<"all" | "single" | "weekly">("all");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [prices, setPrices] = useState(DEFAULT_BOOKING_RULES.sauna);
  const [failed, setFailed] = useState(false);
  // 0 = kuluva kuukausi, -1 = edellinen ja niin edelleen.
  const [monthOffset, setMonthOffset] = useState(0);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1);
  const monthName = monthStart.toLocaleDateString("fi-FI", { month: "long", year: "numeric" });

  useEffect(() => {
    setFailed(false);
    const query = `resource=sauna&from=${encodeURIComponent(monthStart.toISOString())}&to=${encodeURIComponent(monthEnd.toISOString())}`;
    api<Booking[]>(`/companies/${encodeURIComponent(companyId)}/bookings?${query}`)
      // Mukaan vain valitussa kuussa alkavat vuorot.
      .then(list => setBookings(list.filter(item =>
        Date.parse(item.starts_at) >= monthStart.getTime() && Date.parse(item.starts_at) < monthEnd.getTime())))
      .catch(() => setFailed(true));
  }, [companyId, monthStart.getTime()]);

  useEffect(() => {
    api<BookingRules>(`/companies/${encodeURIComponent(companyId)}/booking-settings`)
      .then(all => setPrices(all.sauna))
      .catch(() => setPrices(DEFAULT_BOOKING_RULES.sauna));
  }, [companyId]);

  const withResident = bookings.filter(item => item.resident_id);
  const withoutResident = bookings.length - withResident.length;
  // Rajaus: kaikki vuorot, vain yksittäiset tai vain viikkovuorot.
  const billable = withResident.filter(item => kind === "all" || (kind === "weekly") === Boolean(item.series_id));

  type Row = { name: string; apartment: string; singles: Booking[]; series: Set<string> };
  const byResident = new Map<string, Row>();
  for (const booking of billable) {
    const row = byResident.get(booking.resident_id!) ?? {
      name: booking.resident_name || "Tuntematon asukas",
      apartment: booking.apartment_number || "–",
      singles: [],
      series: new Set<string>()
    };
    // Viikkovuoro laskutetaan kerran kuukaudessa sarjaa kohden, ei jokaisesta vuorosta.
    if (booking.series_id) row.series.add(booking.series_id);
    else row.singles.push(booking);
    byResident.set(booking.resident_id!, row);
  }
  const rows = [...byResident.values()]
    .map(row => ({ ...row, total: row.singles.length * prices.singlePrice + row.series.size * prices.monthlyPrice }))
    .sort((a, b) => a.name.localeCompare(b.name, "fi"));
  const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const pricesMissing = prices.singlePrice === 0 && prices.monthlyPrice === 0;
  const monthKey = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
  const billing = useBillingPeriod(companyId, "sauna", monthKey);
  // Laskutetuksi merkitään aina koko kuukausi, ei rajattua näkymää. Merkinnän tekee isännöitsijä tai pääkäyttäjä.
  const markButton = (
    <button
      className="secondary"
      disabled={billing.busy || rows.length === 0 || kind !== "all" || !isManager()}
      title={kind !== "all" ? "Valitse Kaikki vuorot, niin koko kuukausi merkitään laskutetuksi." : undefined}
      onClick={() => void billing.mark({
        total: grandTotal,
        prices: { "Yksittäinen vuoro": prices.singlePrice, "Viikkovuoro / kk": prices.monthlyPrice },
        rows: rows.map(row => ({
          name: row.name,
          apartment: row.apartment,
          detail: [
            row.singles.length > 0
              ? `${row.singles.length} yksittäistä (${row.singles.map(shift => new Date(shift.starts_at).toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" })).join(", ")})`
              : "",
            row.series.size > 0 ? `${row.series.size} viikkovuoroa` : ""
          ].filter(Boolean).join(" · "),
          total: row.total
        }))
      })}
    >
      Merkitse laskutetuksi
    </button>
  );

  function downloadCsv() {
    const lines = [
      ["Asukas", "Asunto", "Yksittäisiä vuoroja", "Viikkovuoroja", "Summa (EUR)", "Yksittäisten vuorojen päivät"],
      ...rows.map(row => [
        row.name,
        row.apartment,
        String(row.singles.length),
        String(row.series.size),
        row.total.toFixed(2).replace(".", ","),
        row.singles.map(shift => new Date(shift.starts_at).toLocaleDateString("fi-FI")).join(", ")
      ]),
      ["Yhteensä", "", "", "", grandTotal.toFixed(2).replace(".", ","), ""]
    ];
    const csv = lines.map(cells => cells.map(cell => `"${cell.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    // BOM, jotta Excel avaa ääkköset oikein.
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    const suffix = kind === "single" ? "-yksittaiset" : kind === "weekly" ? "-viikkovuorot" : "";
    link.download = `saunavuorot${suffix}-${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (billing.period) {
    return (
      <BilledPeriodView
        tabs={tabs}
        title="Saunavuorojen laskutus"
        monthName={monthName}
        monthOffset={monthOffset}
        onMonth={setMonthOffset}
        period={billing.period}
        fileName={`saunavuorot-${monthKey}-laskutettu.csv`}
        busy={billing.busy}
        error={billing.error}
        onUnmark={() => void billing.unmark()}
      />
    );
  }

  return (
    <div className="report-card">
      {tabs}
      {billing.error && <p className="send-error">{billing.error}</p>}
      <div className="suggest-header report-ai-head">
        <h2>Saunavuorojen laskutus</h2>
        <div className="calendar-week">
          <button onClick={() => setMonthOffset(monthOffset - 1)} aria-label="Edellinen kuukausi">←</button>
          <strong>{monthName}</strong>
          <button onClick={() => setMonthOffset(monthOffset + 1)} disabled={monthOffset >= 0} aria-label="Seuraava kuukausi">→</button>
          <button className="secondary" onClick={downloadCsv} disabled={rows.length === 0}>Lataa CSV</button>
          {markButton}
        </div>
      </div>
      <p className="muted">
        Yksittäinen vuoro {formatEuros(prices.singlePrice)} / vuoro, viikoittainen vuoro {formatEuros(prices.monthlyPrice)} / kk.
        {withoutResident > 0 && ` ${withoutResident} varausta ilman asukasta (esim. huolto) on jätetty pois.`}
      </p>
      <div className="card-tabs billing-filter" role="group" aria-label="Näytettävät vuorot">
        {([["all", "Kaikki vuorot"], ["single", "Yksittäiset"], ["weekly", "Viikkovuorot"]] as const).map(([key, label]) => (
          <button key={key} className={kind === key ? "active" : ""} aria-pressed={kind === key} onClick={() => setKind(key)}>
            {label}
          </button>
        ))}
      </div>
      {pricesMissing && (
        <p className="send-error">Hintoja ei ole asetettu. Aseta saunavuorojen hinnat Asetuksista, niin summat lasketaan.</p>
      )}
      {failed ? <p className="send-error">Saunavuorojen lataus epäonnistui.</p>
        : rows.length === 0 ? <p className="muted">Valitulla kuukaudella ei ole laskutettavia saunavuoroja.</p>
        : (
          <div className="table-card">
            <table className="data-table report-topics">
              <thead>
                <tr>
                  <th>Asukas</th>
                  <th>Asunto</th>
                  <th>Yksittäisiä vuoroja</th>
                  <th>Viikkovuoroja</th>
                  <th>Summa</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.name + row.apartment}>
                    <td><strong>{row.name}</strong></td>
                    <td>{row.apartment}</td>
                    <td>
                      {row.singles.length}
                      {row.singles.length > 0 && (
                        <span>
                          {row.singles
                            .map(shift => new Date(shift.starts_at).toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" }))
                            .join(", ")}
                        </span>
                      )}
                    </td>
                    <td>{row.series.size}</td>
                    <td><strong>{formatEuros(row.total)}</strong></td>
                  </tr>
                ))}
                <tr>
                  <td><strong>Yhteensä</strong></td>
                  <td />
                  <td><strong>{rows.reduce((sum, row) => sum + row.singles.length, 0)}</strong></td>
                  <td><strong>{rows.reduce((sum, row) => sum + row.series.size, 0)}</strong></td>
                  <td><strong>{formatEuros(grandTotal)}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// Haltijajakso, joka oli voimassa laskutettavan kuukauden aikana.
type ParkingBillingRow = {
  id: string;
  label: string;
  type: string;
  resident_id: string;
  resident_name: string | null;
  apartment_number: string | null;
  start_date: string;
  end_date: string | null;
};

// Autopaikkojen laskutus: valitun kuukauden aikana paikkaa hallinneet asukkaat ja tyypin kuukausihinta.
// Haltijahistoria tallentuu aina, kun paikan haltija vaihtuu, joten myös menneet kuukaudet näkyvät.
function ParkingBilling({ companyId, tabs }: { companyId: string; tabs: ReactNode }) {
  const [spaces, setSpaces] = useState<ParkingBillingRow[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  // 0 = kuluva kuukausi, -1 = edellinen ja niin edelleen.
  const [monthOffset, setMonthOffset] = useState(0);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const monthKey = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
  const monthName = monthStart.toLocaleDateString("fi-FI", { month: "long", year: "numeric" });

  useEffect(() => {
    if (!companyId) return;
    setFailed(false);
    Promise.all([
      api<ParkingBillingRow[]>(`/companies/${encodeURIComponent(companyId)}/parking-billing?month=${monthKey}`),
      api<Record<string, number>>(`/companies/${encodeURIComponent(companyId)}/parking-prices`)
    ])
      .then(([spaceList, priceList]) => {
        setSpaces(spaceList);
        setPrices(priceList);
      })
      .catch(() => setFailed(true));
  }, [companyId, monthKey]);

  const priceOf = (type: string) => prices[type] ?? 0;
  const taken = spaces.filter(space => typeFilter === "all" || space.type === typeFilter);

  type Row = { name: string; apartment: string; spaces: ParkingBillingRow[]; total: number };
  const byResident = new Map<string, Row>();
  for (const space of taken) {
    const row = byResident.get(space.resident_id!) ?? {
      name: space.resident_name || "Tuntematon asukas",
      apartment: space.apartment_number || "–",
      spaces: [],
      total: 0
    };
    row.spaces.push(space);
    row.total += priceOf(space.type);
    byResident.set(space.resident_id!, row);
  }
  const rows = [...byResident.values()].sort((a, b) => a.name.localeCompare(b.name, "fi"));
  const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const pricesMissing = PARKING_TYPES.every(type => priceOf(type) === 0);
  const billing = useBillingPeriod(companyId, "parking", monthKey);
  // Laskutetuksi merkitään aina koko kuukausi, ei rajattua näkymää.
  const markButton = (
    <button
      className="secondary"
      disabled={billing.busy || rows.length === 0 || typeFilter !== "all" || !isManager()}
      title={typeFilter !== "all" ? "Valitse Kaikki tyypit, niin koko kuukausi merkitään laskutetuksi." : undefined}
      onClick={() => void billing.mark({
        total: grandTotal,
        prices: Object.fromEntries(PARKING_TYPES.map(type => [type, priceOf(type)])),
        rows: rows.map(row => ({
          name: row.name,
          apartment: row.apartment,
          detail: row.spaces.map(space => `${space.label} (${space.type})`).join(", "),
          total: row.total
        }))
      })}
    >
      Merkitse laskutetuksi
    </button>
  );

  function downloadCsv() {
    const lines = [
      ["Asukas", "Asunto", "Paikka", "Tyyppi", "Hinta / kk (EUR)"],
      ...rows.flatMap(row => row.spaces.map(space => [
        row.name,
        row.apartment,
        space.label,
        space.type,
        priceOf(space.type).toFixed(2).replace(".", ",")
      ])),
      ["Yhteensä", "", "", "", grandTotal.toFixed(2).replace(".", ",")]
    ];
    const csv = lines.map(cells => cells.map(cell => `"${cell.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    // BOM, jotta Excel avaa ääkköset oikein.
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `autopaikat-${monthKey}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (billing.period) {
    return (
      <BilledPeriodView
        tabs={tabs}
        title="Autopaikkojen laskutus"
        monthName={monthName}
        monthOffset={monthOffset}
        onMonth={setMonthOffset}
        period={billing.period}
        fileName={`autopaikat-${monthKey}-laskutettu.csv`}
        busy={billing.busy}
        error={billing.error}
        onUnmark={() => void billing.unmark()}
      />
    );
  }

  return (
    <div className="report-card">
      {tabs}
      {billing.error && <p className="send-error">{billing.error}</p>}
      <div className="suggest-header report-ai-head">
        <h2>Autopaikkojen laskutus</h2>
        <div className="calendar-week">
          <button onClick={() => setMonthOffset(monthOffset - 1)} aria-label="Edellinen kuukausi">←</button>
          <strong>{monthName}</strong>
          <button onClick={() => setMonthOffset(monthOffset + 1)} disabled={monthOffset >= 0} aria-label="Seuraava kuukausi">→</button>
          <button className="secondary" onClick={downloadCsv} disabled={rows.length === 0}>Lataa CSV</button>
          {markButton}
        </div>
      </div>
      <p className="muted">
        {PARKING_TYPES.map(type => `${type} ${formatEuros(priceOf(type))} / kk`).join(", ")}.
        {" "}Mukana ovat asukkaat, joilla paikka oli kuukauden aikana; koko kuukausi laskutetaan, vaikka paikka olisi ollut vain osan kuusta.
      </p>
      <div className="card-tabs billing-filter" role="group" aria-label="Näytettävät paikkatyypit">
        {["all", ...PARKING_TYPES].map(option => (
          <button
            key={option}
            className={typeFilter === option ? "active" : ""}
            aria-pressed={typeFilter === option}
            onClick={() => setTypeFilter(option)}
          >
            {option === "all" ? "Kaikki tyypit" : option}
          </button>
        ))}
      </div>
      {pricesMissing && (
        <p className="send-error">Hintoja ei ole asetettu. Aseta autopaikkojen hinnat Asetuksista, niin summat lasketaan.</p>
      )}
      {failed ? <p className="send-error">Autopaikkojen lataus epäonnistui.</p>
        : rows.length === 0 ? <p className="muted">Valitulla kuukaudella ei ole laskutettavia autopaikkoja.</p>
        : (
          <div className="table-card">
            <table className="data-table report-topics">
              <thead>
                <tr>
                  <th>Asukas</th>
                  <th>Asunto</th>
                  <th>Paikat</th>
                  <th>Summa / kk</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.name + row.apartment}>
                    <td><strong>{row.name}</strong></td>
                    <td>{row.apartment}</td>
                    <td>
                      {row.spaces.length}
                      <span>{row.spaces.map(space => `${space.label} (${space.type})`).join(", ")}</span>
                    </td>
                    <td><strong>{formatEuros(row.total)}</strong></td>
                  </tr>
                ))}
                <tr>
                  <td><strong>Yhteensä</strong></td>
                  <td />
                  <td><strong>{taken.length}</strong></td>
                  <td><strong>{formatEuros(grandTotal)}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// Keston esitys: alle vuorokausi tunteina, muuten päivinä ja tunteina.
function formatDuration(milliseconds: number) {
  const hours = Math.max(0, Math.round(milliseconds / 3_600_000));
  if (hours < 1) return "alle 1 h";
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} pv` : `${days} pv ${hours % 24} h`;
}

// Tehtävän työtilaukset: tilaus huoltoyhtiölle ja sen kuittaus tehdyksi.
function TicketWorkOrders({ detail, onChanged }: { detail: TicketDetail; onChanged: () => Promise<void> }) {
  const contractor = detail.contractor;
  const contractorEmail = contractor?.email?.trim() ?? "";
  const [ordering, setOrdering] = useState(false);
  const [description, setDescription] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [sendEmail, setSendEmail] = useState(Boolean(contractorEmail));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Viesti huoltoyhtiölle: avoinna olevan työtilauksen tunniste, teksti ja mukaan valitut liitteet.
  const [messageOrderId, setMessageOrderId] = useState<string | null>(null);
  const [messageBody, setMessageBody] = useState("");
  const [messageAttachmentIds, setMessageAttachmentIds] = useState<string[]>([]);
  const [messageSentTo, setMessageSentTo] = useState("");

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!messageOrderId) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<{ to: string }>(`/work-orders/${encodeURIComponent(messageOrderId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: messageBody.trim(), attachmentIds: messageAttachmentIds })
      });
      setMessageOrderId(null);
      setMessageBody("");
      setMessageAttachmentIds([]);
      setMessageSentTo(result.to);
      await onChanged();
    } catch (sendError) {
      setError(errorMessage(sendError, "Viestin lähetys huoltoyhtiölle epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  function openForm() {
    // Kuvaus pohjautuu tehtävän otsikkoon ja tiivistelmään; käsittelijä muokkaa sen tilaukseksi.
    setDescription([detail.ticket.subject, detail.ticket.summary].filter(Boolean).join("\n\n"));
    setAttachmentIds([]);
    setSendEmail(Boolean(contractorEmail));
    setError("");
    setOrdering(true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/tickets/${encodeURIComponent(detail.ticket.id)}/work-orders`, {
        method: "POST",
        body: JSON.stringify({ description: description.trim(), attachmentIds: sendEmail ? attachmentIds : [], sendEmail })
      });
      setOrdering(false);
      await onChanged();
    } catch (submitError) {
      setError(errorMessage(submitError, "Työtilauksen tekeminen epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  async function markDone(order: WorkOrder) {
    setSaving(true);
    setError("");
    try {
      await api(`/work-orders/${encodeURIComponent(order.id)}/done`, { method: "POST" });
      await onChanged();
    } catch (doneError) {
      setError(errorMessage(doneError, "Kuittaus epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="drawer-section work-orders">
      <div className="suggest-header">
        <h3>Työtilaukset</h3>
        {!ordering && <button className="secondary" onClick={openForm}>Tilaa huolto</button>}
      </div>

      {detail.workOrders.length === 0 && !ordering && <p className="muted">Tehtävältä ei ole tehty työtilauksia.</p>}

      {detail.workOrders.map(order => (
        <div className={`work-order ${order.status}`} key={order.id}>
          <div className="work-order-top">
            <strong>{order.contractor_name}</strong>
            <span className={`work-order-status ${order.status}`}>{order.status === "done" ? "Tehty" : "Tilattu"}</span>
          </div>
          <p>{order.description}</p>
          <small>
            Tilattu {formatDate(order.ordered_at)} · {order.ordered_by}
            {order.email_sent ? ` · lähetetty: ${order.contractor_email}` : " · kirjattu ilman sähköpostia"}
          </small>
          {order.status === "done" && order.done_at ? (
            <small>
              Kuitattu tehdyksi {formatDate(order.done_at)} · {order.done_by} · kesto{" "}
              {formatDuration(Date.parse(order.done_at) - Date.parse(order.ordered_at))}
            </small>
          ) : (
            <div className="work-order-buttons">
              <button className="secondary" onClick={() => void markDone(order)} disabled={saving}>Kuittaa tehdyksi</button>
              <button
                className="secondary"
                disabled={saving || !(order.contractor_email || contractorEmail)}
                title={order.contractor_email || contractorEmail ? undefined : "Huoltoyhtiöllä ei ole sähköpostiosoitetta."}
                onClick={() => {
                  setMessageOrderId(messageOrderId === order.id ? null : order.id);
                  setMessageBody("");
                  setMessageAttachmentIds([]);
                  setMessageSentTo("");
                  setError("");
                }}
              >
                Lähetä viesti huoltoyhtiölle
              </button>
            </div>
          )}
          {messageOrderId === order.id && (
            <form className="ticket-form work-order-form" onSubmit={sendMessage}>
              <label>
                <span>Viesti · {order.contractor_email || contractorEmail}</span>
                <textarea value={messageBody} onChange={event => setMessageBody(event.target.value)} rows={4} maxLength={4000} required autoFocus />
              </label>
              {detail.attachments.length > 0 && (
                <fieldset className="work-order-files">
                  <legend>Mukaan lähetettävät liitteet</legend>
                  {detail.attachments.map(attachment => (
                    <label key={attachment.id}>
                      <input
                        type="checkbox"
                        checked={messageAttachmentIds.includes(attachment.id)}
                        onChange={() => setMessageAttachmentIds(current => current.includes(attachment.id)
                          ? current.filter(item => item !== attachment.id)
                          : [...current, attachment.id])}
                      />
                      {attachment.filename}
                    </label>
                  ))}
                </fieldset>
              )}
              <div className="draft-actions">
                <button className="primary" type="submit" disabled={saving || !messageBody.trim()}>
                  {saving ? "Lähetetään…" : "Lähetä"}
                </button>
                <button type="button" onClick={() => setMessageOrderId(null)} disabled={saving}>Peruuta</button>
              </div>
            </form>
          )}
        </div>
      ))}
      {messageSentTo && <p className="portal-sent">Viesti lähetetty: {messageSentTo}</p>}

      {ordering && (
        <form className="ticket-form work-order-form" onSubmit={handleSubmit}>
          <p className="reply-hint">
            Huoltoyhtiö: <strong>{contractor?.name || "ei nimeä"}</strong>
            {contractorEmail ? ` · ${contractorEmail}` : " · sähköpostia ei ole tallennettu taloyhtiön tietoihin"}
            {contractor?.phone ? ` · ${contractor.phone}` : ""}
          </p>
          <label>
            <span>Työn kuvaus</span>
            <textarea value={description} onChange={event => setDescription(event.target.value)} rows={6} maxLength={4000} required />
          </label>
          <label className="switch-row">
            <span>
              <strong>Lähetä sähköpostilla huoltoyhtiölle</strong>
              <small>
                {contractorEmail
                  ? "Viestiin lisätään taloyhtiö, osoite, asunto ja tehtävän numero."
                  : "Ei käytettävissä: lisää huoltoyhtiön sähköposti taloyhtiön tietoihin."}
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={sendEmail}
              disabled={!contractorEmail}
              onChange={() => setSendEmail(!sendEmail)}
            />
            <i aria-hidden="true" />
          </label>
          {sendEmail && detail.attachments.length > 0 && (
            <fieldset className="work-order-files">
              <legend>Mukaan lähetettävät liitteet</legend>
              {detail.attachments.map(attachment => (
                <label key={attachment.id}>
                  <input
                    type="checkbox"
                    checked={attachmentIds.includes(attachment.id)}
                    onChange={() => setAttachmentIds(current => current.includes(attachment.id)
                      ? current.filter(item => item !== attachment.id)
                      : [...current, attachment.id])}
                  />
                  {attachment.filename}
                </label>
              ))}
            </fieldset>
          )}
          <div className="draft-actions">
            <button className="primary" type="submit" disabled={saving || description.trim().length < 3}>
              {saving ? "Tilataan…" : sendEmail ? "Lähetä työtilaus" : "Kirjaa työtilaus"}
            </button>
            <button type="button" onClick={() => setOrdering(false)} disabled={saving}>Peruuta</button>
          </div>
        </form>
      )}
      {error && <p className="send-error">{error}</p>}
    </section>
  );
}

// Raportti: työtilaukset huoltoyhtiöittäin, läpimenoaika ja avoimet tilaukset.
function WorkOrderReport({ companyId, tabs }: { companyId: string; tabs: ReactNode }) {
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    setFailed(false);
    api<WorkOrder[]>(`/companies/${encodeURIComponent(companyId)}/work-orders`)
      .then(setOrders)
      .catch(() => setFailed(true));
  }, [companyId]);

  const nowTime = Date.now();
  const contractors = [...new Set(orders.map(order => order.contractor_name))].sort((a, b) => a.localeCompare(b, "fi"));
  const rows = contractors.map(name => {
    const own = orders.filter(order => order.contractor_name === name);
    const done = own.filter(order => order.status === "done" && order.done_at);
    const open = own.filter(order => order.status !== "done");
    const average = done.length
      ? done.reduce((sum, order) => sum + (Date.parse(order.done_at!) - Date.parse(order.ordered_at)), 0) / done.length
      : null;
    const oldestOpen = open.length ? Math.min(...open.map(order => Date.parse(order.ordered_at))) : null;
    return { name, total: own.length, done: done.length, open: open.length, average, oldestOpen };
  });
  const openOrders = orders
    .filter(order => order.status !== "done")
    .sort((a, b) => Date.parse(a.ordered_at) - Date.parse(b.ordered_at));

  return (
    <div className="report-card">
      {tabs}
      <h2>Työtilaukset huoltoyhtiöittäin</h2>
      <p className="muted">Kaikki taloyhtiön työtilaukset. Läpimenoaika lasketaan tilauksesta tehdyksi kuittaukseen.</p>
      {failed ? <p className="send-error">Työtilausten lataus epäonnistui.</p>
        : orders.length === 0 ? <p className="muted">Taloyhtiölle ei ole tehty työtilauksia.</p>
        : (
          <>
            <div className="table-card">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Huoltoyhtiö</th>
                    <th>Tilauksia</th>
                    <th>Avoinna</th>
                    <th>Tehty</th>
                    <th>Läpimenoaika keskimäärin</th>
                    <th>Vanhin avoin</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.name}>
                      <td><strong>{row.name}</strong></td>
                      <td>{row.total}</td>
                      <td>{row.open}</td>
                      <td>{row.done}</td>
                      <td>{row.average === null ? "–" : formatDuration(row.average)}</td>
                      <td>{row.oldestOpen === null ? "–" : formatDuration(nowTime - row.oldestOpen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2 className="report-subhead">Avoimet työtilaukset</h2>
            {openOrders.length === 0 ? <p className="muted">Ei avoimia työtilauksia.</p> : (
              <div className="table-card">
                <table className="data-table report-topics">
                  <thead>
                    <tr>
                      <th>Tehtävä</th>
                      <th>Huoltoyhtiö</th>
                      <th>Tilattu</th>
                      <th>Odottanut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openOrders.map(order => (
                      <tr key={order.id}>
                        <td>
                          <a href={`#/tickets/${encodeURIComponent(order.ticket_id)}`}>
                            <strong>#{formatTicketNumber(order.ticket_number)} {order.ticket_subject}</strong>
                          </a>
                          <span>{order.description}</span>
                        </td>
                        <td>{order.contractor_name}</td>
                        <td>{formatDate(order.ordered_at)}</td>
                        <td>{formatDuration(nowTime - Date.parse(order.ordered_at))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
    </div>
  );
}

type Announcement = {
  id: string;
  company_id: string;
  stairwell: string;
  title: string;
  body: string;
  emailed_count: number;
  created_by: string;
  created_at: string;
};

type AnnouncementAudience = {
  all: { residents: number; emails: number };
  stairwells: { stairwell: string; residents: number; emails: number }[];
};

// Tiedotteet: isännöitsijän viestit taloyhtiön tai yhden rapun asukkaille.
function Announcements({ companies, defaultCompanyId }: { companies: Company[]; defaultCompanyId: string }) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState<Announcement | null>(null);
  const [creating, setCreating] = useState(false);
  const [formCompany, setFormCompany] = useState(defaultCompanyId);
  const [audience, setAudience] = useState<AnnouncementAudience | null>(null);
  const [stairwell, setStairwell] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";
  const targetLabel = (item: { stairwell: string }) => item.stairwell ? `Rappu ${item.stairwell}` : "Koko taloyhtiö";

  async function loadAnnouncements() {
    try {
      const lists = await Promise.all(companies.map(company =>
        api<Announcement[]>(`/companies/${encodeURIComponent(company.id)}/announcements`)));
      setAnnouncements(lists.flat().sort((a, b) => b.created_at.localeCompare(a.created_at)));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAnnouncements();
  }, [companies.length]);

  // Vastaanottajien määrä ja raput lomakkeen taloyhtiölle.
  useEffect(() => {
    if (!creating || !formCompany) return;
    setAudience(null);
    setStairwell("");
    api<AnnouncementAudience>(`/companies/${encodeURIComponent(formCompany)}/announcement-audience`)
      .then(setAudience)
      .catch(() => setAudience(null));
  }, [creating, formCompany]);

  const target = stairwell ? audience?.stairwells.find(item => item.stairwell === stairwell) : audience?.all;

  function openForm() {
    setFormCompany(defaultCompanyId || companies[0]?.id || "");
    setTitle("");
    setBody("");
    setSendEmail(true);
    setFormError("");
    setCreating(true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      const result = await api<{ emailed: number; emailFailed: boolean }>(
        `/companies/${encodeURIComponent(formCompany)}/announcements`,
        { method: "POST", body: JSON.stringify({ title: title.trim(), body: body.trim(), stairwell, sendEmail }) }
      );
      setCreating(false);
      setNotice(result.emailFailed
        ? `Tiedote julkaistiin portaalissa, mutta sähköpostin lähetys epäonnistui (${result.emailed} lähti).`
        : sendEmail
          ? `Tiedote julkaistu ja lähetetty ${result.emailed} sähköpostiosoitteeseen.`
          : "Tiedote julkaistu asukasportaalissa.");
      await loadAnnouncements();
    } catch (submitError) {
      setFormError(errorMessage(submitError, "Tiedotteen julkaisu epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(item: Announcement) {
    if (!window.confirm("Poistetaanko tiedote asukasportaalista? Lähetettyjä sähköposteja ei voi perua.")) return;
    try {
      await api(`/announcements/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      setOpen(null);
      await loadAnnouncements();
    } catch {
      setNotice("Tiedotteen poistaminen epäonnistui.");
    }
  }

  const paged = usePaged(announcements, "");

  return (
    <section className="content">
      <a className="back-link" href="#/companies">← Taloyhtiöt</a>

      <div className="residents-toolbar">
        <span>{announcements.length} tiedotetta</span>
        {isManager() && <button className="secondary" onClick={openForm}>Uusi tiedote</button>}
      </div>

      {notice && <p className="portal-sent">{notice}</p>}

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <p className="send-error">Tiedotteiden lataus epäonnistui.</p>
        : announcements.length === 0 ? <div className="empty">Ei tiedotteita.</div>
        : (
          <div className="table-card">
            <table className="data-table report-topics">
              <thead>
                <tr>
                  <th>Tiedote</th>
                  <th>Taloyhtiö</th>
                  <th>Kohde</th>
                  <th>Sähköposteja</th>
                  <th>Julkaisija</th>
                  <th>Julkaistu</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(item => (
                  <tr
                    key={item.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title="Avaa tiedote"
                    onClick={() => setOpen(item)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpen(item);
                      }
                    }}
                  >
                    <td>
                      <strong>{item.title}</strong>
                      <span>{item.body.length > 110 ? `${item.body.slice(0, 110)}…` : item.body}</span>
                    </td>
                    <td>{companyName(item.company_id)}</td>
                    <td>{targetLabel(item)}</td>
                    <td>{item.emailed_count || "–"}</td>
                    <td>{item.created_by}</td>
                    <td>{formatDate(item.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {paged.pager}

      {open && (
        <div className="overlay" onClick={() => setOpen(null)}>
          <aside className="drawer form-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={() => setOpen(null)}>×</button>
            <h2>{open.title}</h2>
            <p className="muted">
              {companyName(open.company_id)} · {targetLabel(open)} · {formatDate(open.created_at)} · {open.created_by}
              {open.emailed_count ? ` · lähetetty ${open.emailed_count} sähköpostiosoitteeseen` : " · vain asukasportaalissa"}
            </p>
            <p className="announcement-body">{open.body}</p>
            {isManager() && (
              <div className="draft-actions">
                <button className="danger" onClick={() => void handleDelete(open)}>Poista tiedote</button>
              </div>
            )}
          </aside>
        </div>
      )}

      {creating && (
        <div className="overlay" onClick={() => !saving && setCreating(false)}>
          <aside className="drawer form-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={() => setCreating(false)} disabled={saving}>×</button>
            <h2>Uusi tiedote</h2>
            <p className="muted">Tiedote näkyy asukkaille asukasportaalissa ja lähtee haluttaessa sähköpostilla.</p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              <Dropdown
                label="Taloyhtiö"
                value={formCompany}
                options={companies.map(company => ({ value: company.id, label: company.name }))}
                onChange={setFormCompany}
              />
              <Dropdown
                label="Kohde"
                value={stairwell}
                options={[
                  { value: "", label: "Koko taloyhtiö" },
                  ...(audience?.stairwells ?? []).map(item => ({ value: item.stairwell, label: `Rappu ${item.stairwell}` }))
                ]}
                onChange={setStairwell}
              />
              <label>
                <span>Otsikko</span>
                <input value={title} onChange={event => setTitle(event.target.value)} maxLength={150} placeholder="Esim. Vesikatko ti 20.10. klo 9–12" required />
              </label>
              <label>
                <span>Teksti</span>
                <textarea value={body} onChange={event => setBody(event.target.value)} rows={9} maxLength={8000} required />
              </label>
              <label className="switch-row">
                <span>
                  <strong>Lähetä myös sähköpostilla</strong>
                  <small>
                    {target
                      ? `${target.residents} asukasta, joista ${target.emails} sähköpostiosoitetta. Osoitteet ovat piilokopiona.`
                      : "Vastaanottajien määrää ei saatu ladattua."}
                  </small>
                </span>
                <input type="checkbox" role="switch" checked={sendEmail} onChange={() => setSendEmail(!sendEmail)} />
                <i aria-hidden="true" />
              </label>

              {formError && <p className="send-error">{formError}</p>}

              <div className="draft-actions">
                <button className="primary" type="submit" disabled={saving || title.trim().length < 3 || body.trim().length < 5}>
                  {saving ? "Julkaistaan…" : sendEmail ? "Julkaise ja lähetä" : "Julkaise"}
                </button>
                <button type="button" onClick={() => setCreating(false)} disabled={saving}>Peruuta</button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </section>
  );
}

// Asukkaan näkymä taloyhtiön tiedotteisiin.
function PortalAnnouncements() {
  const [items, setItems] = useState<Pick<Announcement, "id" | "title" | "body" | "stairwell" | "created_at">[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<typeof items>("/portal/announcements")
      .then(setItems)
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="empty">Ladataan…</div>;
  if (failed) return <p className="send-error">Tiedotteiden lataus epäonnistui.</p>;
  if (items.length === 0) return <div className="empty">Ei tiedotteita.</div>;
  return (
    <div className="portal-announcements">
      {items.map(item => (
        <article key={item.id}>
          <small>{formatDate(item.created_at)}{item.stairwell ? ` · Rappu ${item.stairwell}` : ""}</small>
          <h2>{item.title}</h2>
          <p>{item.body}</p>
        </article>
      ))}
    </div>
  );
}

type MoveNotice = {
  id: string;
  company_id: string;
  move_date: string;
  moves_out: number;
  // JSON-lista uusista asukkaista: [{ name, email }].
  new_residents: string;
  door_name: string;
  note: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  result?: string | null;
  resident_name?: string | null;
  apartment_number?: string | null;
  address?: string | null;
};

type MoveResult = { movedOut: number; parkingReleased: string[]; bookingsRemoved: number; added: string[]; skipped: string[] };

const moveStatusLabels: Record<MoveNotice["status"], string> = { pending: "Odottaa käsittelyä", approved: "Hyväksytty", rejected: "Hylätty" };

function newResidentsOf(notice: MoveNotice): { name: string; email: string }[] {
  try {
    return JSON.parse(notice.new_residents);
  } catch {
    return [];
  }
}

// Muuttoilmoituksen sisältö yhdellä rivillä.
function moveSummary(notice: MoveNotice) {
  const incoming = newResidentsOf(notice).length;
  return [
    notice.moves_out ? "Nykyiset asukkaat muuttavat pois" : "",
    incoming ? `${incoming} uutta asukasta` : "",
    notice.door_name ? `nimi oveen: ${notice.door_name}` : ""
  ].filter(Boolean).join(" · ");
}

// Toimiston näkymä: asukkaiden muuttoilmoitukset, jotka hyväksytään tai hylätään.
function MoveNotices({ companies }: { companies: Company[] }) {
  const [notices, setNotices] = useState<MoveNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";

  async function loadNotices() {
    try {
      const lists = await Promise.all(companies.map(company =>
        api<MoveNotice[]>(`/companies/${encodeURIComponent(company.id)}/moves`)));
      setNotices(lists.flat().sort((a, b) =>
        Number(b.status === "pending") - Number(a.status === "pending") || b.created_at.localeCompare(a.created_at)));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadNotices();
  }, [companies.length]);

  async function decide(notice: MoveNotice, decision: "approve" | "reject") {
    setSaving(true);
    setError("");
    try {
      await api(`/moves/${encodeURIComponent(notice.id)}/${decision}`, { method: "POST" });
      await loadNotices();
    } catch (decisionError) {
      setError(errorMessage(decisionError, "Muuttoilmoituksen käsittely epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  const paged = usePaged(notices, "");
  const open = notices.find(notice => notice.id === openId) ?? null;
  const pendingCount = notices.filter(notice => notice.status === "pending").length;
  let result: MoveResult | null = null;
  try {
    result = open?.result ? JSON.parse(open.result) : null;
  } catch {
    result = null;
  }

  return (
    <section className="content">
      <a className="back-link" href="#/companies">← Taloyhtiöt</a>

      <div className="residents-toolbar">
        <span>{notices.length} muuttoilmoitusta · {pendingCount} odottaa käsittelyä</span>
      </div>

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <p className="send-error">Muuttoilmoitusten lataus epäonnistui.</p>
        : notices.length === 0 ? <div className="empty">Ei muuttoilmoituksia. Asukas tekee ilmoituksen asukasportaalissa.</div>
        : (
          <div className="table-card">
            <table className="data-table report-topics">
              <thead>
                <tr>
                  <th>Ilmoittaja</th>
                  <th>Taloyhtiö</th>
                  <th>Asunto</th>
                  <th>Muuttopäivä</th>
                  <th>Tila</th>
                  <th>Ilmoitettu</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(notice => (
                  <tr
                    key={notice.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title="Avaa muuttoilmoitus"
                    onClick={() => { setOpenId(notice.id); setError(""); }}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenId(notice.id);
                        setError("");
                      }
                    }}
                  >
                    <td>
                      <strong>{notice.resident_name || "Tuntematon asukas"}</strong>
                      <span>{moveSummary(notice)}</span>
                    </td>
                    <td>{companyName(notice.company_id)}</td>
                    <td>{notice.apartment_number || "–"}</td>
                    <td>{formatDay(notice.move_date)}</td>
                    <td><span className={`work-order-status ${notice.status === "pending" ? "" : "done"}`}>{moveStatusLabels[notice.status]}</span></td>
                    <td>{formatDate(notice.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {paged.pager}

      {open && (
        <div className="overlay" onClick={() => !saving && setOpenId(null)}>
          <aside className="drawer form-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={() => setOpenId(null)} disabled={saving}>×</button>
            <h2>Muuttoilmoitus</h2>
            <p className="muted">
              {open.resident_name || "Tuntematon asukas"} · {companyName(open.company_id)} · {open.apartment_number || "–"}
              {open.address ? `, ${open.address}` : ""} · ilmoitettu {formatDate(open.created_at)}
            </p>

            <dl className="ticket-facts">
              <div>
                <dt>Muuttopäivä</dt>
                <dd>{formatDay(open.move_date)}</dd>
              </div>
              <div>
                <dt>Tila</dt>
                <dd>{moveStatusLabels[open.status]}{open.decided_by ? ` · ${open.decided_by}` : ""}</dd>
              </div>
              <div>
                <dt>Poismuutto</dt>
                <dd>{open.moves_out ? "Asunnon nykyiset asukkaat muuttavat pois" : "Ei"}</dd>
              </div>
              <div>
                <dt>Nimi oveen</dt>
                <dd>{open.door_name || "–"}</dd>
              </div>
            </dl>

            <h3>Uudet asukkaat</h3>
            {newResidentsOf(open).length === 0 ? <p className="muted">Ei uusia asukkaita.</p> : (
              <ul className="move-people">
                {newResidentsOf(open).map((person, index) => (
                  <li key={index}><strong>{person.name}</strong>{person.email ? ` · ${person.email}` : ""}</li>
                ))}
              </ul>
            )}
            {open.note && (
              <>
                <h3>Lisätiedot</h3>
                <p className="announcement-body">{open.note}</p>
              </>
            )}

            {open.status === "pending" && !isManager() && (
              <p className="reply-hint">Muuttoilmoituksen voi hyväksyä tai hylätä isännöitsijä tai pääkäyttäjä.</p>
            )}
            {open.status === "pending" && isManager() && (
              <>
                <p className="reply-hint">
                  Hyväksyntä päivittää asukastietokannan: lähtijät poistuvat asukaslistalta muuttopäivänä, heidän
                  autopaikkansa vapautuvat ja vuoronsa poistuvat muuttopäivästä alkaen, ja uudet asukkaat lisätään asuntoon.
                </p>
                <div className="draft-actions">
                  <button className="primary" onClick={() => void decide(open, "approve")} disabled={saving}>
                    {saving ? "Käsitellään…" : "Hyväksy"}
                  </button>
                  <button onClick={() => void decide(open, "reject")} disabled={saving}>Hylkää</button>
                </div>
              </>
            )}
            {open.status === "approved" && result && (
              <p className="portal-sent">
                Hyväksytty: {result.movedOut} asukasta merkitty muuttaneeksi, {result.added.length} lisätty
                {result.parkingReleased.length > 0 && `, autopaikat vapautuvat: ${result.parkingReleased.join(", ")}`}
                {result.bookingsRemoved > 0 && `, ${result.bookingsRemoved} vuoroa poistettu`}.
                {result.skipped.length > 0 && ` Lisäämättä jäi: ${result.skipped.join(", ")}.`}
              </p>
            )}
            {error && <p className="send-error">{error}</p>}
          </aside>
        </div>
      )}
    </section>
  );
}

type WaitlistEntry = {
  id: string;
  company_id: string;
  resource: "parking" | "sauna";
  parking_type: string;
  note: string;
  status: "waiting" | "offered";
  created_at: string;
  position: number;
  resident_id?: string;
  resident_name?: string | null;
  resident_email?: string | null;
  apartment_number?: string | null;
  offered_at?: string | null;
  offered_by?: string | null;
};

function waitlistLabel(entry: Pick<WaitlistEntry, "resource" | "parking_type">) {
  if (entry.resource === "sauna") return "Saunavuoro";
  return entry.parking_type ? `Autopaikka · ${entry.parking_type}` : "Autopaikka";
}

// Toimiston näkymä: jonot ilmoittautumisjärjestyksessä. Vapaan autopaikan voi antaa suoraan jonottajalle.
function Waitlists({ companies }: { companies: Company[] }) {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [freeSpaces, setFreeSpaces] = useState<ParkingSpace[]>([]);
  const [parkingId, setParkingId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";

  async function loadEntries() {
    try {
      const lists = await Promise.all(companies.map(company =>
        api<WaitlistEntry[]>(`/companies/${encodeURIComponent(company.id)}/waitlist`)));
      setEntries(lists.flat());
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadEntries();
  }, [companies.length]);

  const open = entries.find(entry => entry.id === openId) ?? null;

  // Autopaikkajonottajalle haetaan taloyhtiön vapaat paikat, toivotun tyypin mukaan rajattuna.
  useEffect(() => {
    setFreeSpaces([]);
    setParkingId("");
    if (!open || open.resource !== "parking") return;
    api<ParkingSpace[]>(`/companies/${encodeURIComponent(open.company_id)}/parking`)
      .then(spaces => setFreeSpaces(spaces.filter(space =>
        !space.resident_id && (!open.parking_type || space.type === open.parking_type))))
      .catch(() => setFreeSpaces([]));
  }, [openId]);

  async function act(path: string, body?: unknown, close = true) {
    setSaving(true);
    setError("");
    try {
      await api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
      if (close) setOpenId(null);
      await loadEntries();
    } catch (actionError) {
      setError(errorMessage(actionError, "Toiminto epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  const paged = usePaged(entries, "");

  return (
    <section className="content">
      <a className="back-link" href="#/companies">← Taloyhtiöt</a>

      <div className="residents-toolbar">
        <span>{entries.length} jonottajaa</span>
      </div>

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <p className="send-error">Jonojen lataus epäonnistui.</p>
        : entries.length === 0 ? <div className="empty">Jonoissa ei ole ketään. Asukas ilmoittautuu jonoon asukasportaalissa.</div>
        : (
          <div className="table-card">
            <table className="data-table report-topics">
              <thead>
                <tr>
                  <th>Sija</th>
                  <th>Asukas</th>
                  <th>Asunto</th>
                  <th>Taloyhtiö</th>
                  <th>Jono</th>
                  <th>Jonossa alkaen</th>
                  <th>Tila</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(entry => (
                  <tr
                    key={entry.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title="Avaa jonottajan tiedot"
                    onClick={() => { setOpenId(entry.id); setError(""); }}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenId(entry.id);
                        setError("");
                      }
                    }}
                  >
                    <td><strong>{entry.position}.</strong></td>
                    <td>
                      <strong>{entry.resident_name || "Tuntematon asukas"}</strong>
                      {entry.note && <span>{entry.note}</span>}
                    </td>
                    <td>{entry.apartment_number || "–"}</td>
                    <td>{companyName(entry.company_id)}</td>
                    <td>{waitlistLabel(entry)}</td>
                    <td>{formatDate(entry.created_at)}</td>
                    <td><span className={`work-order-status ${entry.status === "offered" ? "done" : ""}`}>{entry.status === "offered" ? "Tarjottu" : "Jonossa"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {paged.pager}

      {open && (
        <div className="overlay" onClick={() => !saving && setOpenId(null)}>
          <aside className="drawer form-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={() => setOpenId(null)} disabled={saving}>×</button>
            <h2>{open.resident_name || "Tuntematon asukas"}</h2>
            <p className="muted">
              {waitlistLabel(open)} · sija {open.position} · {companyName(open.company_id)} · {open.apartment_number || "–"}
              {open.resident_email ? ` · ${open.resident_email}` : ""}
            </p>
            {open.note && <p className="announcement-body">{open.note}</p>}
            {open.status === "offered" && (
              <p className="reply-hint">Tarjottu {open.offered_at ? formatDate(open.offered_at) : ""}{open.offered_by ? ` · ${open.offered_by}` : ""}</p>
            )}

            {open.resource === "parking" && (
              <div className="ticket-form">
                {freeSpaces.length === 0 ? (
                  <p className="muted">
                    Taloyhtiössä ei ole vapaata {open.parking_type ? `paikkaa tyyppiä ${open.parking_type}` : "autopaikkaa"}.
                  </p>
                ) : (
                  <>
                    <Dropdown
                      label="Vapaa autopaikka"
                      value={parkingId}
                      options={[
                        { value: "", label: "Valitse paikka" },
                        ...freeSpaces.map(space => ({ value: space.id, label: `${space.label} · ${space.type}` }))
                      ]}
                      onChange={setParkingId}
                    />
                    <div className="draft-actions">
                      <button
                        className="primary"
                        disabled={saving || !parkingId}
                        onClick={() => void act(`/waitlist/${encodeURIComponent(open.id)}/assign-parking`, { parkingId })}
                      >
                        Anna paikka jonottajalle
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="draft-actions">
              {open.status === "waiting" && (
                <button onClick={() => void act(`/waitlist/${encodeURIComponent(open.id)}/offer`, undefined, false)} disabled={saving}>
                  Merkitse tarjotuksi
                </button>
              )}
              {open.resource === "sauna" && (
                <button onClick={() => void act(`/waitlist/${encodeURIComponent(open.id)}/close`, { outcome: "done" })} disabled={saving}>
                  Vuoro annettu
                </button>
              )}
              <button className="danger" onClick={() => void act(`/waitlist/${encodeURIComponent(open.id)}/close`, { outcome: "cancelled" })} disabled={saving}>
                Poista jonosta
              </button>
            </div>
            {error && <p className="send-error">{error}</p>}
          </aside>
        </div>
      )}
    </section>
  );
}

// Asukkaan jonot: ilmoittautuminen autopaikka- ja saunavuorojonoon sekä oma sija.
function PortalWaitlist() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [parkingType, setParkingType] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({ parking: "", sauna: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function loadEntries() {
    try {
      setEntries(await api<WaitlistEntry[]>("/portal/waitlist"));
    } catch {
      setError("Jonotietojen lataus epäonnistui.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadEntries();
  }, []);

  async function join(resource: "parking" | "sauna") {
    setSaving(true);
    setError("");
    try {
      await api("/portal/waitlist", {
        method: "POST",
        body: JSON.stringify({ resource, parkingType: resource === "parking" ? parkingType : "", note: notes[resource].trim() })
      });
      setNotes(current => ({ ...current, [resource]: "" }));
      await loadEntries();
    } catch (joinError) {
      setError(errorMessage(joinError, "Jonoon ilmoittautuminen epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  async function leave(entry: WaitlistEntry) {
    setSaving(true);
    setError("");
    try {
      await api(`/portal/waitlist/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      await loadEntries();
    } catch {
      setError("Jonosta poistuminen epäonnistui.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty">Ladataan…</div>;

  const queues: { resource: "parking" | "sauna"; title: string; hint: string }[] = [
    { resource: "parking", title: "Autopaikkajono", hint: "Vapautuva autopaikka tarjotaan jonossa ensimmäisenä olevalle." },
    { resource: "sauna", title: "Saunavuorojono", hint: "Vapautuva vakiovuoro tarjotaan jonossa ensimmäisenä olevalle." }
  ];

  return (
    <div className="portal-queues">
      {queues.map(queue => {
        const entry = entries.find(item => item.resource === queue.resource);
        return (
          <article key={queue.resource}>
            <h2>{queue.title}</h2>
            <p className="muted">{queue.hint}</p>
            {entry ? (
              <>
                <p className="portal-queue-position">
                  Olet jonossa sijalla <strong>{entry.position}</strong>
                  {entry.status === "offered" && " · isännöitsijä on tarjonnut sinulle paikkaa"}
                </p>
                <p className="muted">
                  {waitlistLabel(entry)} · ilmoittauduttu {formatDate(entry.created_at)}{entry.note ? ` · ${entry.note}` : ""}
                </p>
                <button className="secondary" onClick={() => void leave(entry)} disabled={saving}>Poistu jonosta</button>
              </>
            ) : (
              <div className="ticket-form">
                {queue.resource === "parking" && (
                  <label>
                    <span>Toivottu paikkatyyppi</span>
                    <select value={parkingType} onChange={event => setParkingType(event.target.value)}>
                      <option value="">Mikä tahansa</option>
                      {PARKING_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                    </select>
                  </label>
                )}
                <label>
                  <span>Toive (valinnainen)</span>
                  <input
                    value={notes[queue.resource]}
                    onChange={event => setNotes(current => ({ ...current, [queue.resource]: event.target.value }))}
                    maxLength={300}
                    placeholder={queue.resource === "parking" ? "Esim. sähköauton latausmahdollisuus" : "Esim. perjantai-ilta"}
                  />
                </label>
                <div className="portal-ticket-actions">
                  <button className="portal-new" onClick={() => void join(queue.resource)} disabled={saving}>Ilmoittaudu jonoon</button>
                </div>
              </div>
            )}
          </article>
        );
      })}
      {error && <p className="send-error">{error}</p>}
    </div>
  );
}

// Asukkaan muuttoilmoitus: muuttopäivä, poismuutto, uudet asukkaat ja oveen tuleva nimi.
function PortalMoves({ resident }: { resident: ResidentAccount }) {
  const [notices, setNotices] = useState<MoveNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [moveDate, setMoveDate] = useState("");
  const [movesOut, setMovesOut] = useState(false);
  const [people, setPeople] = useState<{ name: string; email: string }[]>([]);
  const [doorName, setDoorName] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function loadNotices() {
    try {
      setNotices(await api<MoveNotice[]>("/portal/moves"));
    } catch {
      setError("Muuttoilmoitusten lataus epäonnistui.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadNotices();
  }, []);

  const pending = notices.some(notice => notice.status === "pending");
  const filledPeople = people.filter(person => person.name.trim());

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!movesOut && filledPeople.length === 0 && !doorName.trim()) {
      setError("Ilmoita poismuutto, uudet asukkaat tai oveen tuleva nimi.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api("/portal/moves", {
        method: "POST",
        body: JSON.stringify({
          moveDate,
          movesOut,
          newResidents: filledPeople.map(person => ({ name: person.name.trim(), email: person.email.trim() })),
          doorName: doorName.trim(),
          note: note.trim()
        })
      });
      setMoveDate("");
      setMovesOut(false);
      setPeople([]);
      setDoorName("");
      setNote("");
      setSent(true);
      await loadNotices();
    } catch (submitError) {
      setError(errorMessage(submitError, "Muuttoilmoituksen lähetys epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty">Ladataan…</div>;

  return (
    <>
      {sent && <p className="portal-sent">Muuttoilmoitus on lähetetty isännöitsijälle.</p>}

      {pending ? (
        <p className="muted">Sinulla on käsittelyä odottava muuttoilmoitus. Uuden voi tehdä, kun se on käsitelty.</p>
      ) : (
        <form className="ticket-form portal-ticket-form" onSubmit={handleSubmit}>
          <dl className="ticket-facts">
            <div>
              <dt>Ilmoittaja</dt>
              <dd>{resident.name}</dd>
            </div>
            <div>
              <dt>Asunto</dt>
              <dd>{resident.apartmentNumber || "–"}</dd>
            </div>
          </dl>

          <label>
            <span>Muuttopäivä</span>
            <input type="date" value={moveDate} onChange={event => setMoveDate(event.target.value)} required />
          </label>

          <label className="switch-row">
            <span>
              <strong>Asunnon nykyiset asukkaat muuttavat pois</strong>
              <small>Autopaikka ja varatut vuorot päättyvät muuttopäivänä.</small>
            </span>
            <input type="checkbox" role="switch" checked={movesOut} onChange={() => setMovesOut(!movesOut)} />
            <i aria-hidden="true" />
          </label>

          <fieldset className="move-new-residents">
            <legend>Asuntoon muuttavat uudet asukkaat</legend>
            {people.map((person, index) => (
              <div className="move-person" key={index}>
                <input
                  value={person.name}
                  onChange={event => setPeople(current => current.map((item, position) => position === index ? { ...item, name: event.target.value } : item))}
                  placeholder="Nimi"
                  maxLength={100}
                  aria-label={`Uuden asukkaan ${index + 1} nimi`}
                />
                <input
                  type="email"
                  value={person.email}
                  onChange={event => setPeople(current => current.map((item, position) => position === index ? { ...item, email: event.target.value } : item))}
                  placeholder="Sähköposti (valinnainen)"
                  aria-label={`Uuden asukkaan ${index + 1} sähköposti`}
                />
                <button type="button" onClick={() => setPeople(current => current.filter((_, position) => position !== index))} aria-label="Poista asukas">×</button>
              </div>
            ))}
            {people.length < 8 && (
              <button type="button" className="secondary" onClick={() => setPeople(current => [...current, { name: "", email: "" }])}>
                Lisää asukas
              </button>
            )}
          </fieldset>

          <label>
            <span>Nimi oveen (valinnainen)</span>
            <input value={doorName} onChange={event => setDoorName(event.target.value)} maxLength={60} placeholder="Esim. Virtanen" />
          </label>

          <label>
            <span>Lisätiedot (valinnainen)</span>
            <textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={1000} />
          </label>

          {error && <p className="send-error">{error}</p>}

          <div className="portal-ticket-actions">
            <button type="submit" className="portal-new" disabled={saving || !moveDate}>{saving ? "Lähetetään…" : "Lähetä muuttoilmoitus"}</button>
          </div>
        </form>
      )}

      {notices.length > 0 && (
        <div className="table-card">
          <table className="data-table report-topics">
            <thead>
              <tr>
                <th>Muuttopäivä</th>
                <th>Sisältö</th>
                <th>Tila</th>
                <th>Ilmoitettu</th>
              </tr>
            </thead>
            <tbody>
              {notices.map(notice => (
                <tr key={notice.id}>
                  <td><strong>{formatDay(notice.move_date)}</strong></td>
                  <td>{moveSummary(notice) || "–"}</td>
                  <td>{moveStatusLabels[notice.status]}</td>
                  <td>{formatDate(notice.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// Laskutetuksi merkitty kuukausi: rivit ja hinnat sellaisina kuin ne olivat merkintähetkellä.
type BillingPeriod = {
  billedAt: string;
  billedBy: string;
  total: number;
  prices: Record<string, number>;
  rows: { name: string; apartment: string; detail: string; total: number }[];
};

function useBillingPeriod(companyId: string, kind: "sauna" | "parking", month: string) {
  const [period, setPeriod] = useState<BillingPeriod | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = `/companies/${encodeURIComponent(companyId)}/billing-periods`;

  async function load() {
    try {
      setPeriod(await api<BillingPeriod | null>(`${base}?kind=${kind}&month=${month}`));
    } catch {
      setPeriod(null);
    }
  }

  useEffect(() => {
    setError("");
    if (companyId) void load();
  }, [companyId, kind, month]);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (actionError) {
      setError(errorMessage(actionError, fallback));
    } finally {
      setBusy(false);
    }
  }

  return {
    period,
    busy,
    error,
    mark: (payload: Pick<BillingPeriod, "total" | "prices" | "rows">) => run(
      () => api(base, { method: "POST", body: JSON.stringify({ kind, month, ...payload }) }),
      "Laskutetuksi merkitseminen epäonnistui."
    ),
    unmark: () => run(
      () => api(`${base}?kind=${kind}&month=${month}`, { method: "DELETE" }),
      "Laskutusmerkinnän poistaminen epäonnistui."
    )
  };
}

// Laskutetun kuukauden näkymä: lukittu taulukko tallennetuista riveistä.
function BilledPeriodView({
  tabs, title, monthName, monthOffset, onMonth, period, fileName, busy, error, onUnmark
}: {
  tabs: ReactNode;
  title: string;
  monthName: string;
  monthOffset: number;
  onMonth: (offset: number) => void;
  period: BillingPeriod;
  fileName: string;
  busy: boolean;
  error: string;
  onUnmark: () => void;
}) {
  function downloadCsv() {
    const lines = [
      ["Asukas", "Asunto", "Erittely", "Summa (EUR)"],
      ...period.rows.map(row => [row.name, row.apartment, row.detail, row.total.toFixed(2).replace(".", ",")]),
      ["Yhteensä", "", "", period.total.toFixed(2).replace(".", ",")]
    ];
    const csv = lines.map(cells => cells.map(cell => `"${cell.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="report-card">
      {tabs}
      <div className="suggest-header report-ai-head">
        <h2>{title}</h2>
        <div className="calendar-week">
          <button onClick={() => onMonth(monthOffset - 1)} aria-label="Edellinen kuukausi">←</button>
          <strong>{monthName}</strong>
          <button onClick={() => onMonth(monthOffset + 1)} disabled={monthOffset >= 0} aria-label="Seuraava kuukausi">→</button>
          <button className="secondary" onClick={downloadCsv}>Lataa CSV</button>
        </div>
      </div>
      <p className="portal-sent">
        Laskutettu {formatDate(period.billedAt)} · {period.billedBy}. Rivit ja hinnat on lukittu merkintähetken mukaisiksi
        ({Object.entries(period.prices).map(([name, price]) => `${name} ${formatEuros(price)}`).join(", ")}).
      </p>
      <div className="table-card">
        <table className="data-table report-topics">
          <thead>
            <tr>
              <th>Asukas</th>
              <th>Asunto</th>
              <th>Erittely</th>
              <th>Summa</th>
            </tr>
          </thead>
          <tbody>
            {period.rows.map((row, index) => (
              <tr key={index}>
                <td><strong>{row.name}</strong></td>
                <td>{row.apartment}</td>
                <td>{row.detail}</td>
                <td><strong>{formatEuros(row.total)}</strong></td>
              </tr>
            ))}
            <tr>
              <td><strong>Yhteensä</strong></td>
              <td />
              <td />
              <td><strong>{formatEuros(period.total)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      {isAdmin() && (
        <div className="draft-actions">
          <button className="danger" onClick={onUnmark} disabled={busy}>Poista laskutusmerkintä</button>
        </div>
      )}
      {error && <p className="send-error">{error}</p>}
    </div>
  );
}

// Laskutusraportit: saunavuorot ja autopaikat välilehtinä samassa kortissa.
function BillingReports({ companyId }: { companyId: string }) {
  const [tab, setTab] = useState<"sauna" | "parking">("sauna");
  const tabs = (
    <div className="billing-tabs-head">
      <h2>Laskutusraportit</h2>
      <div className="billing-tabs" role="tablist">
        {([["sauna", "Saunavuorot"], ["parking", "Autopaikat"]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
  return tab === "sauna"
    ? <SaunaBilling companyId={companyId} tabs={tabs} />
    : <ParkingBilling companyId={companyId} tabs={tabs} />;
}

type ParkingSpace = {
  id: string;
  company_id: string;
  label: string;
  type: string;
  resident_id: string | null;
  note: string;
  resident_name: string | null;
  apartment_number: string | null;
};

const PARKING_TYPES = ["Autotalli", "Ulkopaikka", "Hallipaikka"];

// Autopaikat: kaikkien taloyhtiöiden paikat yhdessä taulukossa. Riviä klikkaamalla paikkaa voi muokata.
function ParkingSpaces({
  companies,
  defaultCompanyId,
  embedded = false
}: {
  companies: Company[];
  defaultCompanyId: string;
  // embedded = näytetään taloyhtiön tietueen sisällä, jolloin yhtiö on jo valittu.
  embedded?: boolean;
}) {
  const [spaces, setSpaces] = useState<ParkingSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Lomake: editing = muokattava paikka, creating = uusi paikka.
  const [editing, setEditing] = useState<ParkingSpace | null>(null);
  const [creating, setCreating] = useState(false);
  const [formCompany, setFormCompany] = useState(defaultCompanyId);
  const [label, setLabel] = useState("");
  const [type, setType] = useState(PARKING_TYPES[0]);
  const [residentId, setResidentId] = useState("");
  const [note, setNote] = useState("");
  const [residents, setResidents] = useState<Resident[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";

  async function loadSpaces() {
    try {
      const lists = await Promise.all(companies.map(company =>
        api<ParkingSpace[]>(`/companies/${encodeURIComponent(company.id)}/parking`)));
      setSpaces(lists.flat());
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSpaces();
  }, [companies.length]);

  // Haltijaksi voi valita lomakkeen taloyhtiön asukkaan.
  const formOpen = creating || Boolean(editing);
  useEffect(() => {
    if (!formOpen || !formCompany) return;
    api<Resident[]>(`/companies/${encodeURIComponent(formCompany)}/residents`)
      .then(setResidents)
      .catch(() => setResidents([]));
  }, [formOpen, formCompany]);

  function openForm(space: ParkingSpace | null) {
    setEditing(space);
    setCreating(!space);
    setFormCompany(space?.company_id ?? (companyFilter !== "all" ? companyFilter : defaultCompanyId));
    setLabel(space?.label ?? "");
    setType(space?.type ?? PARKING_TYPES[0]);
    setResidentId(space?.resident_id ?? "");
    setNote(space?.note ?? "");
    setFormError("");
  }

  function closeForm() {
    setEditing(null);
    setCreating(false);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      await api(editing ? `/parking/${encodeURIComponent(editing.id)}` : `/companies/${encodeURIComponent(formCompany)}/parking`, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({ label, type, residentId: residentId || null, note })
      });
      closeForm();
      await loadSpaces();
    } catch (error) {
      setFormError(errorMessage(error, "Autopaikan tallennus epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editing || !window.confirm(`Poistetaanko autopaikka ${editing.label}?`)) return;
    setSaving(true);
    try {
      await api(`/parking/${encodeURIComponent(editing.id)}`, { method: "DELETE" });
      closeForm();
      await loadSpaces();
    } catch (error) {
      setFormError(errorMessage(error, "Autopaikan poistaminen epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  const visible = spaces
    .filter(space => (typeFilter === "all" || space.type === typeFilter)
      && (companyFilter === "all" || space.company_id === companyFilter)
      && (statusFilter === "all" || (statusFilter === "free") === !space.resident_id))
    .sort((a, b) => companyName(a.company_id).localeCompare(companyName(b.company_id), "fi")
      || a.label.localeCompare(b.label, "fi", { numeric: true }));
  const paged = usePaged(visible, `${typeFilter}|${companyFilter}|${statusFilter}`);
  const free = visible.filter(space => !space.resident_id).length;
  const parkingFilters: { key: string; label: string; value: string; clear: () => void }[] = [
    ...(companyFilter !== "all"
      ? [{ key: "company", label: "Taloyhtiö", value: companyName(companyFilter), clear: () => setCompanyFilter("all") }]
      : []),
    ...(typeFilter !== "all" ? [{ key: "type", label: "Tyyppi", value: typeFilter, clear: () => setTypeFilter("all") }] : []),
    ...(statusFilter !== "all"
      ? [{ key: "status", label: "Tila", value: statusFilter === "free" ? "Vapaat" : "Varatut", clear: () => setStatusFilter("all") }]
      : [])
  ];

  return (
    <section className="content">
      {!embedded && <a className="back-link" href="#/companies">← Taloyhtiöt</a>}

      {filtersOpen && (
        <div className="ticket-filters">
          {!embedded && (
            <Dropdown
              label="Taloyhtiö"
              value={companyFilter}
              options={[{ value: "all", label: "Kaikki" }, ...companies.map(company => ({ value: company.id, label: company.name }))]}
              onChange={setCompanyFilter}
            />
          )}
          <Dropdown
            label="Tyyppi"
            value={typeFilter}
            options={[{ value: "all", label: "Kaikki" }, ...PARKING_TYPES.map(option => ({ value: option, label: option }))]}
            onChange={setTypeFilter}
          />
          <Dropdown
            label="Tila"
            value={statusFilter}
            options={[
              { value: "all", label: "Kaikki" },
              { value: "free", label: "Vapaat" },
              { value: "taken", label: "Varatut" }
            ]}
            onChange={setStatusFilter}
          />
          {parkingFilters.length > 0 && (
            <button className="clear-filters" onClick={() => {
              setCompanyFilter("all");
              setTypeFilter("all");
              setStatusFilter("all");
            }}>Tyhjennä suodattimet</button>
          )}
        </div>
      )}

      <div className="residents-toolbar">
        <div className="filter-chips">
          <button
            className={`filter-toggle ${filtersOpen || parkingFilters.length > 0 ? "active" : ""}`}
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
            {parkingFilters.length > 0 && <i />}
          </button>
          <span>{visible.length} autopaikkaa · {free} vapaana</span>
          {parkingFilters.map(filter => (
            <span className="filter-chip" key={filter.key}>
              <small>{filter.label}</small>
              {filter.value}
              <button onClick={filter.clear} title="Poista suodatin" aria-label={`Poista suodatin ${filter.label}`}>×</button>
            </span>
          ))}
        </div>
        <button className="secondary" onClick={() => openForm(null)}>Lisää autopaikka</button>
      </div>

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <div className="empty">Autopaikkojen lataus epäonnistui.</div>
        : visible.length === 0 ? <div className="empty">{spaces.length === 0 ? "Ei autopaikkoja." : "Ei suodattimia vastaavia autopaikkoja."}</div>
        : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Paikka</th>
                  <th>Tyyppi</th>
                  {!embedded && <th>Taloyhtiö</th>}
                  <th>Haltija</th>
                  <th>Asunto</th>
                  <th>Lisätieto</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(space => (
                  <tr
                    key={space.id}
                    className="clickable"
                    title="Muokkaa autopaikkaa"
                    role="button"
                    tabIndex={0}
                    onClick={() => openForm(space)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openForm(space);
                      }
                    }}
                  >
                    <td><strong>{space.label}</strong></td>
                    <td><span className="type">{space.type}</span></td>
                    {!embedded && <td>{companyName(space.company_id)}</td>}
                    <td>{space.resident_name || <span className="muted">Vapaa</span>}</td>
                    <td>{space.apartment_number || "–"}</td>
                    <td>{space.note || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {!loading && !loadError && paged.pager}

      {formOpen && (
        <div className="overlay" onClick={closeForm}>
          <aside className="drawer form-drawer resident-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={closeForm}>×</button>
            <h2>{editing ? `Autopaikka ${editing.label}` : "Lisää autopaikka"}</h2>
            <p className="muted">{editing ? companyName(editing.company_id) : "Valitse taloyhtiö ja anna paikan tiedot."}</p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              {!editing && !embedded && (
                <Dropdown
                  label="Taloyhtiö"
                  value={formCompany}
                  options={companies.map(company => ({ value: company.id, label: company.name }))}
                  onChange={value => { setFormCompany(value); setResidentId(""); }}
                />
              )}

              <label>
                <span>Paikan tunnus</span>
                <input value={label} onChange={event => setLabel(event.target.value)} placeholder="Esim. 14 tai AT 3" />
              </label>

              <Dropdown
                label="Tyyppi"
                value={type}
                options={(PARKING_TYPES.includes(type) ? PARKING_TYPES : [type, ...PARKING_TYPES])
                  .map(option => ({ value: option, label: option }))}
                onChange={setType}
              />

              <Dropdown
                label="Haltija"
                value={residentId}
                options={[
                  { value: "", label: "Vapaa (ei haltijaa)" },
                  ...residents.map(resident => ({
                    value: resident.id,
                    label: [resident.name, resident.apartment_number].filter(Boolean).join(" · ")
                  }))
                ]}
                onChange={setResidentId}
              />

              <label>
                <span>Lisätieto</span>
                <input value={note} onChange={event => setNote(event.target.value)} placeholder="Valinnainen, esim. lämmitystolppa" />
              </label>

              {formError && <p className="send-error">{formError}</p>}

              <div className="drawer-actions compact-actions">
                {editing && (
                  <button className="danger" type="button" onClick={handleDelete} disabled={saving}>Poista</button>
                )}
                <button type="button" onClick={closeForm}>Peruuta</button>
                <button className="primary" type="submit" disabled={saving || !label.trim()}>
                  {saving ? "Tallennetaan…" : editing ? "Tallenna muutokset" : "Lisää autopaikka"}
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </section>
  );
}

type AuditEntry = {
  id: string;
  // Tehtävän tiedot puuttuvat merkinnöiltä, jotka eivät liity tehtävään.
  ticket_id: string | null;
  actor: string;
  action: string;
  details: string;
  created_at: string;
  ticket_number?: number | null;
  ticket_subject: string | null;
  company_name: string | null;
  email_body?: string | null;
};

// Koko alustan loki: kaikkien tehtävien muutokset, päätökset ja lähetetyt sähköpostit uusimmasta alkaen.
function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<AuditEntry[]>("/audit")
      .then(setEntries)
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  const rows = entries.map(entry => {
    let details: { to?: string; subject?: string } = {};
    try {
      details = JSON.parse(entry.details || "{}");
    } catch {
      // Vanhassa merkinnässä ei ole JSON-tietoja.
    }
    const email = entry.action === "reply_sent"
      ? { to: details.to || "vastaanottaja ei tiedossa", subject: details.subject || "", body: entry.email_body || "" }
      : null;
    return { entry, email, label: email ? `Sähköposti lähetetty: ${email.to}` : actionLabel(entry.action) };
  });

  const searchText = search.trim().toLowerCase();
  const visible = searchText
    ? rows.filter(({ entry, label }) =>
        [label, actorLabel(entry.actor), entry.ticket_subject, entry.company_name, `#${formatTicketNumber(entry.ticket_number)}`]
          .some(value => (value ?? "").toLowerCase().includes(searchText)))
    : rows;
  const paged = usePaged(visible, searchText);

  return (
    <section className="content">
      <a className="back-link" href="#/settings">← Asetukset</a>
      <label className="log-search">
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
        <input
          type="search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Hae lokista: tapahtuma, tekijä, tehtävä tai taloyhtiö"
          aria-label="Hae lokista"
        />
      </label>

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <div className="empty">Lokin lataus epäonnistui.</div>
        : visible.length === 0 ? <div className="empty">{entries.length === 0 ? "Ei tapahtumia." : "Ei hakua vastaavia tapahtumia."}</div>
        : (
          <div className="table-card">
            <table className="data-table log-table">
              <thead>
                <tr>
                  <th>Aika</th>
                  <th>Tapahtuma</th>
                  <th>Tekijä</th>
                  <th>Tehtävä</th>
                  <th>Taloyhtiö</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(({ entry, email, label }) => (
                  <tr key={entry.id}>
                    <td>{formatDate(entry.created_at)}</td>
                    <td>
                      <strong>{label}</strong>
                      {email && (
                        <details className="audit-email">
                          <summary>{email.subject || "Näytä viesti"}</summary>
                          <p>{email.body || "Viestin sisältöä ei ole tallennettu."}</p>
                        </details>
                      )}
                    </td>
                    <td>{actorLabel(entry.actor)}</td>
                    <td>
                      {/* Käyttäjän tai asukkaan poisto ja säilytysajan poistot eivät liity tehtävään. */}
                      {entry.ticket_id ? (
                        <a href={`#/tickets/${encodeURIComponent(entry.ticket_id)}`} title="Avaa tehtävä">
                          #{formatTicketNumber(entry.ticket_number)} {entry.ticket_subject}
                        </a>
                      ) : "–"}
                    </td>
                    <td>{entry.company_name ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {!loading && !loadError && paged.pager}
    </section>
  );
}

type ResidentSortKey = "name" | "email" | "company" | "address" | "apartment";

type ImportRow = { line: number; name: string; email: string; address: string; apartmentNumber: string };

// Sarakeotsikot, joista CSV:n sarakkeet tunnistetaan (pienaakkosin, ilman välejä).
const CSV_COLUMNS: Record<keyof Omit<ImportRow, "line">, string[]> = {
  name: ["nimi", "name", "asukas"],
  email: ["sähköposti", "sahkoposti", "email", "e-mail", "sposti"],
  address: ["osoite", "address", "katuosoite"],
  apartmentNumber: ["asunto", "huoneisto", "asuntonumero", "apartment"]
};

// Jäsentää CSV-tekstin riveiksi. Erotin (; , tai sarkain) päätellään otsikkoriviltä, ja
// lainausmerkeissä oleva kenttä saa sisältää erottimen ja rivinvaihdon.
function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [";", ",", "\t"].reduce((best, candidate) =>
    firstLine.split(candidate).length > firstLine.split(best).length ? candidate : best, ";");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (quoted) {
      if (char === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(cells => cells.some(cell => cell.trim()));
}

// Muuntaa taulukon (otsikkorivi + rivit) tuotaviksi asukkaiksi; sama CSV:lle ja Excelille.
function tableToResidents(table: string[][]): { rows: ImportRow[]; missing: string[] } {
  if (table.length === 0) return { rows: [], missing: [] };

  const header = table[0].map(cell => cell.trim().toLowerCase().replace(/\s+/g, ""));
  const index = (key: keyof typeof CSV_COLUMNS) => header.findIndex(cell => CSV_COLUMNS[key].includes(cell));
  const columns = { name: index("name"), email: index("email"), address: index("address"), apartmentNumber: index("apartmentNumber") };

  const missing = [
    columns.name < 0 ? "nimi" : "",
    columns.address < 0 ? "osoite" : "",
    columns.apartmentNumber < 0 ? "asunto" : ""
  ].filter(Boolean);
  if (missing.length > 0) return { rows: [], missing };

  return {
    missing: [],
    rows: table.slice(1).map((cells, rowIndex) => ({
      // Rivinumero sellaisena kuin se näkyy taulukkolaskennassa (otsikko on rivi 1).
      line: rowIndex + 2,
      name: (cells[columns.name] ?? "").trim(),
      email: columns.email >= 0 ? (cells[columns.email] ?? "").trim() : "",
      address: (cells[columns.address] ?? "").trim(),
      apartmentNumber: (cells[columns.apartmentNumber] ?? "").trim()
    }))
  };
}

function ResidentImport({
  companies,
  lockedCompanyId,
  defaultCompanyId,
  onClose,
  onImported
}: {
  companies: Company[];
  lockedCompanyId: string | null;
  defaultCompanyId: string;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [targetCompany, setTargetCompany] = useState(lockedCompanyId ?? defaultCompanyId);
  const [format, setFormat] = useState<"csv" | "excel">("csv");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ added: number; skipped: { line: number; name: string; reason: string }[] } | null>(null);

  async function readFile(file: File | undefined) {
    setRows([]);
    setResult(null);
    setError("");
    setFileName(file?.name ?? "");
    if (!file) return;

    let table: string[][];
    if (format === "excel") {
      try {
        // Excel-lukija ladataan vasta tarvittaessa. Luetaan työkirjan ensimmäinen välilehti.
        const { readSheet } = await import("read-excel-file/browser");
        table = (await readSheet(file))
          .map(cells => cells.map(cell => cell == null ? "" : String(cell)))
          .filter(cells => cells.some(cell => cell.trim()));
      } catch {
        setError("Excel-tiedoston lukeminen epäonnistui. Tiedoston pitää olla .xlsx-muodossa.");
        return;
      }
    } else {
      const buffer = await file.arrayBuffer();
      let text = new TextDecoder("utf-8").decode(buffer);
      // Excelin tallentama CSV on usein Windows-merkistössä, jolloin ääkköset eivät aukea UTF-8:na.
      if (text.includes("\uFFFD")) text = new TextDecoder("windows-1252").decode(buffer);
      table = parseCsv(text);
    }

    const parsed = tableToResidents(table);
    if (parsed.missing.length > 0) {
      setError(`Tiedostosta puuttuu sarake: ${parsed.missing.join(", ")}. Tarkista otsikkorivi.`);
    } else if (parsed.rows.length === 0) {
      setError("Tiedostossa ei ole otsikkorivin lisäksi yhtään riviä.");
    } else {
      setRows(parsed.rows);
    }
  }

  async function handleImport() {
    setSubmitting(true);
    setError("");
    try {
      const imported = await api<NonNullable<typeof result>>(
        `/companies/${encodeURIComponent(targetCompany)}/residents/import`,
        { method: "POST", body: JSON.stringify({ rows }) }
      );
      setResult(imported);
      setRows([]);
      if (imported.added > 0) await onImported();
    } catch (importError) {
      setError(errorMessage(importError, "Asukkaiden tuonti epäonnistui."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer form-drawer resident-drawer" onClick={event => event.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        <h2>Tuo asukkaita</h2>
        <div className="card-tabs import-format">
          {(["csv", "excel"] as const).map(option => (
            <button
              key={option}
              className={format === option ? "active" : ""}
              onClick={() => {
                setFormat(option);
                setRows([]);
                setResult(null);
                setError("");
                setFileName("");
              }}
            >
              {option === "csv" ? "CSV" : "Excel"}
            </button>
          ))}
        </div>
        <p className="muted">
          Ensimmäisen rivin pitää olla otsikkorivi, jossa on sarakkeet <strong>nimi</strong>, <strong>osoite</strong> ja{" "}
          <strong>asunto</strong>. Sarake <strong>sähköposti</strong> on valinnainen.{" "}
          {format === "csv"
            ? "Erottimena käy puolipiste tai pilkku."
            : "Tiedoston pitää olla .xlsx-muodossa, ja asukkaat luetaan ensimmäiseltä välilehdeltä."}
        </p>
        {format === "csv" ? (
          <pre className="csv-example">nimi;sähköposti;osoite;asunto{"\n"}Matti Meikäläinen;matti@example.com;Koivikkotie 10;A 12</pre>
        ) : (
          <div className="table-card import-example">
            <table className="data-table">
              <thead>
                <tr><th>nimi</th><th>sähköposti</th><th>osoite</th><th>asunto</th></tr>
              </thead>
              <tbody>
                <tr><td>Matti Meikäläinen</td><td>matti@example.com</td><td>Koivikkotie 10</td><td>A 12</td></tr>
              </tbody>
            </table>
          </div>
        )}

        <div className="ticket-form">
          {!lockedCompanyId && (
            <label>
              <span>Taloyhtiö, johon asukkaat tuodaan</span>
              <select value={targetCompany} onChange={event => setTargetCompany(event.target.value)}>
                {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            </label>
          )}

          <label>
            <span>{format === "csv" ? "CSV-tiedosto" : "Excel-tiedosto (.xlsx)"}</span>
            <input
              // Muodon vaihto tyhjentää valitun tiedoston.
              key={format}
              type="file"
              accept={format === "csv"
                ? ".csv,text/csv"
                : ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
              onChange={event => void readFile(event.target.files?.[0])}
            />
          </label>

          {rows.length > 0 && (
            <>
              <p className="reply-hint">{fileName}: {rows.length} riviä. Esikatselu ensimmäisistä riveistä:</p>
              <div className="table-card">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Nimi</th>
                      <th>Sähköposti</th>
                      <th>Osoite</th>
                      <th>Asunto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map(row => (
                      <tr key={row.line}>
                        <td>{row.name || "–"}</td>
                        <td>{row.email || "–"}</td>
                        <td>{row.address || "–"}</td>
                        <td>{row.apartmentNumber || "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {result && (
            <div className={`ai-reason ${result.skipped.length === 0 ? "created" : "found"}`}>
              Lisätty {result.added} asukasta{result.skipped.length > 0 ? `, ohitettu ${result.skipped.length} riviä.` : "."}
            </div>
          )}
          {result && result.skipped.length > 0 && (
            <ul className="import-skipped">
              {result.skipped.map(skip => (
                <li key={skip.line}>
                  <strong>Rivi {skip.line}{skip.name ? ` (${skip.name})` : ""}:</strong> {skip.reason}
                </li>
              ))}
            </ul>
          )}

          {error && <p className="send-error">{error}</p>}

          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>{result ? "Sulje" : "Peruuta"}</button>
            {!result && (
              <button className="primary" type="button" onClick={handleImport} disabled={submitting || rows.length === 0}>
                {submitting ? "Tuodaan…" : rows.length > 0 ? `Tuo ${rows.length} asukasta` : "Tuo asukkaat"}
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function OfficeUsers() {
  const [users, setUsers] = useState<OfficeUser[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<OfficeUser | null>(null);
  // Lomake on auki joko muokkausta (editing) tai uuden käyttäjän luontia (creating) varten.
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const pagedUsers = usePaged(users, "");
  const admin = isAdmin();
  // Muut kuin pääkäyttäjä voivat muokata vain omia tietojaan.
  const canEdit = (user: OfficeUser) => admin || session?.user.id === user.id;

  async function loadUsers() {
    try {
      setUsers(await api<OfficeUser[]>("/users"));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  function openNewUser() {
    setEditing(null);
    setCreating(true);
    setName("");
    setEmail("");
    setRole("Isännöitsijä");
    setPassword("");
    setFormError("");
  }

  function closeForm() {
    setEditing(null);
    setCreating(false);
  }

  function openUser(user: OfficeUser) {
    setCreating(false);
    setEditing(user);
    setName(user.name);
    setEmail(user.email);
    setRole(user.role);
    setPassword("");
    setFormError("");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!editing && !creating) return;
    setSaving(true);
    setFormError("");
    try {
      if (editing) {
        const updated = await api<OfficeUser>(`/users/${encodeURIComponent(editing.id)}`, {
          method: "PUT",
          body: JSON.stringify({ name, email, role: admin ? role : undefined, password: password || undefined })
        });
        // Omien tietojen muutos näkyy heti myös sivupalkissa.
        if (session && session.user.id === updated.id) setSession({ ...session, user: updated });
      } else {
        await api<OfficeUser>("/users", {
          method: "POST",
          body: JSON.stringify({ name, email, role, password })
        });
      }
      closeForm();
      await loadUsers();
    } catch (error) {
      setFormError(errorMessage(error, editing
        ? "Käyttäjän tietojen tallennus epäonnistui."
        : "Käyttäjän lisääminen epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  // Poistaa käyttäjän; hänen keskeneräiset tehtävänsä siirtyvät vastuuisännöitsijälle tai poistajalle.
  async function deleteUser(user: OfficeUser) {
    if (!window.confirm(
      `Poistetaanko käyttäjä ${user.name}?\n\n`
      + "Hän ei voi enää kirjautua. Keskeneräiset tehtävät siirtyvät taloyhtiön vastuuisännöitsijälle tai sinulle."
    )) return;
    setSaving(true);
    setFormError("");
    try {
      await api(`/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      closeForm();
      await loadUsers();
    } catch (error) {
      setFormError(errorMessage(error, "Käyttäjän poisto epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="settings-card settings-users">
      <div className="settings-users-head">
        <h2>Käyttäjät</h2>
        {admin && <button className="secondary" onClick={openNewUser}>Lisää käyttäjä</button>}
      </div>
      <p className="muted">
        {MANAGEMENT_OFFICE.name} · {users.length} käyttäjää
      </p>
      {loadError && <p className="send-error">Käyttäjien lataus epäonnistui.</p>}
      <ul>
        {pagedUsers.items.map(user => (
          <li
            key={user.id}
            className={canEdit(user) ? "clickable" : ""}
            title={canEdit(user) ? "Muokkaa käyttäjän tietoja" : "Vain pääkäyttäjä voi muokata muita käyttäjiä"}
            role={canEdit(user) ? "button" : undefined}
            tabIndex={canEdit(user) ? 0 : undefined}
            onClick={() => canEdit(user) && openUser(user)}
            onKeyDown={event => {
              if (canEdit(user) && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                openUser(user);
              }
            }}
          >
            <span className="user-avatar">
              {user.name.split(" ").map(part => part[0]).join("").slice(0, 2)}
            </span>
            <div>
              <strong>{user.name}{session?.user.id === user.id ? " (sinä)" : ""}</strong>
              <span>{user.email}</span>
            </div>
            <em>{user.role}</em>
          </li>
        ))}
      </ul>
      {pagedUsers.pager}

      {(editing || creating) && (
        <div className="overlay" onClick={closeForm}>
          <aside className="drawer form-drawer resident-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={closeForm}>×</button>
            <h2>{editing ? editing.name : "Lisää käyttäjä"}</h2>
            <p className="muted">
              {editing ? "Käyttäjän tiedot" : "Uusi käyttäjä"} · {MANAGEMENT_OFFICE.name}
            </p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              <label>
                <span>Nimi</span>
                <input value={name} onChange={event => setName(event.target.value)} />
              </label>

              <label>
                <span>Sähköposti (käytetään kirjautumiseen)</span>
                <input type="email" value={email} onChange={event => setEmail(event.target.value)} />
              </label>

              <label>
                <span>Rooli</span>
                <select value={role} onChange={event => setRole(event.target.value)} disabled={!admin}>
                  {USER_ROLES.map(option => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>

              <label>
                <span>{editing ? "Uusi salasana" : "Salasana"}</span>
                <input
                  type="password"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  placeholder={editing ? "Jätä tyhjäksi, jos salasanaa ei vaihdeta" : "Vähintään 8 merkkiä"}
                  autoComplete="new-password"
                />
              </label>
              <p className="reply-hint">
                {editing
                  ? "Vähintään 8 merkkiä. Vaihto kirjaa käyttäjän ulos muilta laitteilta."
                  : "Käyttäjä kirjautuu tällä sähköpostilla ja salasanalla ja voi vaihtaa salasanan myöhemmin."}
              </p>

              {formError && <p className="send-error">{formError}</p>}

              <div className="drawer-actions compact-actions">
                {editing && admin && session?.user.id !== editing.id && (
                  <button type="button" className="danger" disabled={saving} onClick={() => deleteUser(editing)}>
                    Poista käyttäjä
                  </button>
                )}
                <button type="button" onClick={closeForm}>Peruuta</button>
                <button
                  className="primary"
                  type="submit"
                  disabled={saving || !name.trim() || !email.trim() || (creating && password.length < 8)}
                >
                  {editing
                    ? saving ? "Tallennetaan…" : "Tallenna muutokset"
                    : saving ? "Lisätään…" : "Lisää käyttäjä"}
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </aside>
  );
}

function errorMessage(error: unknown, fallback: string) {
  try {
    return JSON.parse((error as Error).message).error || fallback;
  } catch {
    return fallback;
  }
}

function knowledgeStateLabel(state: string) {
  return {
    in_use: "AI:n käytössä",
    expired: "Vanhentunut – ei AI:n käytössä",
    upcoming: "Ei vielä voimassa – ei AI:n käytössä",
    unreadable: "Tekstiä ei saatu luettua – ei AI:n käytössä",
    replaced: "Korvattu uudella versiolla",
    deleted: "Poistettu"
  }[state] || state;
}

function formatDay(value?: string | null) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${Number(day)}.${Number(month)}.${year}`;
}

function validityLabel(entry: KnowledgeEntry) {
  if (entry.valid_from && entry.valid_until) return `Voimassa ${formatDay(entry.valid_from)}–${formatDay(entry.valid_until)}`;
  if (entry.valid_from) return `Voimassa ${formatDay(entry.valid_from)} alkaen`;
  if (entry.valid_until) return `Voimassa ${formatDay(entry.valid_until)} asti`;
  return "Voimassa toistaiseksi";
}

type KnowledgeFormState =
  | { mode: "fact" | "document"; replaces?: KnowledgeEntry }
  | { mode: "validity"; entry: KnowledgeEntry };

function Knowledge({
  companyId,
  companies,
  initialEntryId,
  onCompanyChange
}: {
  companyId: string;
  companies: Company[];
  initialEntryId: string | null;
  onCompanyChange: (companyId: string) => void;
}) {
  return (
    <section className="content">
      <div className="ticket-filters">
        <label>
          <span>Taloyhtiö</span>
          <select value={companyId} onChange={event => onCompanyChange(event.target.value)}>
            {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </label>
      </div>
      <KnowledgeBase companyId={companyId} initialEntryId={initialEntryId} />
    </section>
  );
}

function KnowledgeBase({ companyId, initialEntryId = null }: { companyId: string; initialEntryId?: string | null }) {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [form, setForm] = useState<KnowledgeFormState | null>(null);
  const [openEntryId, setOpenEntryId] = useState<string | null>(initialEntryId);
  const pagedEntries = usePaged(entries, companyId);
  const [notice, setNotice] = useState("");
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<KnowledgeEntry[]>([]);
  const [question, setQuestion] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { found: boolean; answer?: string; source?: { id: string; title: string } } | null
  >(null);

  async function loadEntries() {
    try {
      setEntries(await api<KnowledgeEntry[]>(`/companies/${encodeURIComponent(companyId)}/knowledge`));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setHistoryFor(null);
    setTestResult(null);
    setQuestion("");
    setNotice("");
    void loadEntries();
  }, [companyId]);

  async function toggleHistory(entry: KnowledgeEntry) {
    if (historyFor === entry.id) {
      setHistoryFor(null);
      return;
    }
    setHistory(await api<KnowledgeEntry[]>(`/knowledge/${entry.id}/history`));
    setHistoryFor(entry.id);
  }

  async function removeEntry(entry: KnowledgeEntry) {
    if (!window.confirm(`Poistetaanko "${entry.title}"? Se poistuu AI:n käytöstä.`)) return;
    await api(`/knowledge/${entry.id}`, { method: "DELETE" });
    setNotice("");
    await loadEntries();
  }

  async function runTest(event: FormEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    setTesting(true);
    try {
      setTestResult(await api(`/companies/${encodeURIComponent(companyId)}/knowledge/test`, {
        method: "POST",
        body: JSON.stringify({ question })
      }));
    } catch {
      setTestResult(null);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="knowledge-base">
      <p className="muted knowledge-intro">
        Yhtiön dokumentit ja vakiotiedot, joiden pohjalta AI tekee luonnokset. AI ei käytä muita lähteitä
        yhtiön tiedoista, eikä näitä tietoja käytetä muiden yhtiöiden luonnoksissa.
      </p>

      <div className="residents-toolbar">
        <span>{entries.length} tietuetta</span>
        {isManager() && (
          <div className="toolbar-actions">
            <button className="secondary" onClick={() => setForm({ mode: "document" })}>Lataa dokumentti</button>
            <button className="secondary" onClick={() => setForm({ mode: "fact" })}>Lisää vakiotieto</button>
          </div>
        )}
      </div>

      <form className="settings-card knowledge-test" onSubmit={runTest}>
        <h2>Testaa</h2>
        <p className="muted">Kysy kysymys ja näe, minkä vastauksen ja lähteen AI käyttäisi.</p>
        <div className="reporter-link">
          <input
            value={question}
            onChange={event => { setQuestion(event.target.value); setTestResult(null); }}
            placeholder="Esim. Miten saunavuoro varataan?"
          />
          <button type="submit" disabled={testing || !question.trim()}>
            {testing ? "Haetaan…" : "Testaa"}
          </button>
        </div>
        {testResult && (testResult.found ? (
          <div className="test-result">
            <p>{testResult.answer}</p>
            <span className="source-pill">Lähde: {testResult.source?.title}</span>
          </div>
        ) : (
          <p className="test-result muted">
            AI ei löytänyt vastausta tämän yhtiön tiedoista. Asia siirtyisi isännöitsijälle.
          </p>
        ))}
      </form>

      {notice && <p className="send-error">{notice}</p>}

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <div className="empty">Tietojen lataus epäonnistui.</div>
        : entries.length === 0 ? <div className="empty">Tällä taloyhtiöllä ei ole vielä dokumentteja tai vakiotietoja.</div>
        : pagedEntries.items.map(entry => (
          <article
            className="knowledge-entry clickable"
            key={entry.id}
            title="Avaa tietokortti"
            onClick={() => setOpenEntryId(entry.id)}
            onKeyDown={event => {
              if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                setOpenEntryId(entry.id);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div className="knowledge-entry-top">
              <span className="type">{entry.kind === "document" ? "Dokumentti" : "Vakiotieto"}</span>
              <span className={`knowledge-state ${entry.state}`}>{knowledgeStateLabel(entry.state)}</span>
              <span className="date">{validityLabel(entry)} · versio {entry.version}</span>
            </div>
            <h2>{entry.title}</h2>
            {entry.tags && (
              <div className="knowledge-tags">
                {entry.tags.split(",").map(tag => tag.trim()).filter(Boolean).map(tag => <span key={tag}>{tag}</span>)}
              </div>
            )}
            {entry.kind === "document" && entry.file_name && (
              <a
                className="knowledge-file"
                href={fileUrl(`/knowledge/${entry.id}/file`)}
                download={entry.file_name}
                onClick={event => event.stopPropagation()}
              >
                {entry.file_name}
              </a>
            )}
            <p>
              {entry.content || "Ei luettua tekstiä."}
              {entry.content_length > entry.content.length ? "…" : ""}
            </p>
            <div className="knowledge-entry-actions" onClick={event => event.stopPropagation()}>
              {isManager() && <button onClick={() => setForm({ mode: "validity", entry })}>Voimassaoloaika</button>}
              {isManager() && <button onClick={() => setForm({ mode: entry.kind, replaces: entry })}>Korvaa</button>}
              <button onClick={() => toggleHistory(entry)}>
                {historyFor === entry.id ? "Piilota historia" : "Historia"}
              </button>
              {isManager() && <button className="danger" onClick={() => removeEntry(entry)}>Poista</button>}
            </div>
            {historyFor === entry.id && (
              <div className="knowledge-history" onClick={event => event.stopPropagation()}>
                {history.map(version => (
                  <div className="audit" key={version.id}>
                    <strong>Versio {version.version}: {version.title}</strong>
                    <span>
                      {version.id === entry.id ? "Nykyinen" : knowledgeStateLabel(version.state)} · {formatDate(version.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}

      {!loading && !loadError && pagedEntries.pager}

      {openEntryId && !form && (
        <KnowledgeDetailDrawer
          entryId={openEntryId}
          onOpenVersion={setOpenEntryId}
          onClose={() => setOpenEntryId(null)}
          onEdit={(mode, entry) => setForm(mode === "validity" ? { mode, entry } : { mode: entry.kind, replaces: entry })}
          onRemove={async entry => {
            await removeEntry(entry);
            setOpenEntryId(null);
          }}
        />
      )}

      {form && (
        <KnowledgeFormModal
          companyId={companyId}
          form={form}
          onClose={() => setForm(null)}
          onDone={async message => {
            setForm(null);
            setOpenEntryId(null);
            setHistoryFor(null);
            setNotice(message);
            await loadEntries();
          }}
        />
      )}
    </div>
  );
}

function KnowledgeDetailDrawer({
  entryId,
  onOpenVersion,
  onClose,
  onEdit,
  onRemove
}: {
  entryId: string;
  onOpenVersion: (entryId: string) => void;
  onClose: () => void;
  onEdit: (mode: "validity" | "replace", entry: KnowledgeEntry) => void;
  onRemove: (entry: KnowledgeEntry) => Promise<void>;
}) {
  const [detail, setDetail] = useState<KnowledgeDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setDetail(null);
    setFailed(false);
    api<KnowledgeDetail>(`/knowledge/${entryId}`)
      .then(setDetail)
      .catch(() => setFailed(true));
  }, [entryId]);

  const isCurrent = detail?.status === "active";

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer" onClick={event => event.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        {failed ? <p className="send-error">Tietojen lataus epäonnistui.</p>
          : !detail ? <p className="muted">Ladataan…</p> : (
          <>
            <span className="type">{detail.kind === "document" ? "Dokumentti" : "Vakiotieto"}</span>
            <h2>{detail.title}</h2>

            <dl className="ticket-facts">
              <div>
                <dt>Taloyhtiö</dt>
                <dd>{detail.company_name || "-"}</dd>
              </div>
              <div>
                <dt>Tila</dt>
                <dd><span className={`knowledge-state ${detail.state}`}>{knowledgeStateLabel(detail.state)}</span></dd>
              </div>
              <div>
                <dt>Voimassaolo</dt>
                <dd>{validityLabel(detail)}</dd>
              </div>
              <div>
                <dt>Versio</dt>
                <dd>{detail.version} / {detail.versions.length}</dd>
              </div>
              <div>
                <dt>Lisätty</dt>
                <dd>{formatDate(detail.created_at)}</dd>
              </div>
              {detail.kind === "document" && (
                <div>
                  <dt>Tiedosto</dt>
                  <dd>
                    {detail.file_name ? (
                      <a className="knowledge-file" href={fileUrl(`/knowledge/${detail.id}/file`)} download={detail.file_name}>
                        {detail.file_name}
                      </a>
                    ) : "-"}
                  </dd>
                </div>
              )}
              {detail.kind === "document" && (
                <div>
                  <dt>Luettu teksti</dt>
                  <dd>{detail.content_length.toLocaleString("fi-FI")} merkkiä</dd>
                </div>
              )}
            </dl>

            {isCurrent && isManager() && (
              <div className="knowledge-entry-actions">
                <button onClick={() => onEdit("validity", detail)}>Voimassaoloaika</button>
                <button onClick={() => onEdit("replace", detail)}>Korvaa</button>
                <button className="danger" onClick={() => onRemove(detail)}>Poista</button>
              </div>
            )}

            <section className="drawer-section">
              <h3>{detail.kind === "document" ? "Dokumentista luettu teksti" : "Vastaus"}</h3>
              <p className="knowledge-content">
                {detail.content || "Tekstiä ei saatu luettua, joten AI ei voi käyttää tätä dokumenttia."}
              </p>
            </section>

            <section className="drawer-section">
              <h3>Versiohistoria</h3>
              {detail.versions.map(version => (
                <div className="audit" key={version.id}>
                  {version.id === detail.id
                    ? <strong>Versio {version.version}: {version.title} (tämä)</strong>
                    : (
                      <button className="back-link" onClick={() => onOpenVersion(version.id)}>
                        Versio {version.version}: {version.title}
                      </button>
                    )}
                  <span>{knowledgeStateLabel(version.state)} · {formatDate(version.created_at)}</span>
                </div>
              ))}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

function KnowledgeFormModal({
  companyId,
  form,
  onClose,
  onDone
}: {
  companyId: string;
  form: KnowledgeFormState;
  onClose: () => void;
  onDone: (notice: string) => Promise<void>;
}) {
  const current = form.mode === "validity" ? form.entry : form.replaces;
  const [title, setTitle] = useState(current?.title ?? "");
  const [answer, setAnswer] = useState(form.mode === "fact" ? current?.content ?? "" : "");
  const [file, setFile] = useState<File | null>(null);
  const [validFrom, setValidFrom] = useState(current?.valid_from ?? "");
  const [validUntil, setValidUntil] = useState(current?.valid_until ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const heading = form.mode === "validity" ? "Merkitse voimassaoloaika"
    : form.mode === "document" ? (form.replaces ? "Korvaa dokumentti" : "Lataa dokumentti")
    : (form.replaces ? "Korvaa vakiotieto" : "Lisää vakiotieto");

  const canSubmit = form.mode === "validity" ? true
    : form.mode === "document" ? Boolean(file)
    : Boolean(title.trim() && answer.trim());

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (form.mode === "validity") {
        await api(`/knowledge/${form.entry.id}/validity`, {
          method: "PUT",
          body: JSON.stringify({ validFrom, validUntil })
        });
        await onDone("");
      } else if (form.mode === "fact") {
        await api(`/companies/${encodeURIComponent(companyId)}/knowledge/facts`, {
          method: "POST",
          body: JSON.stringify({ question: title, answer, validFrom, validUntil, replaces: form.replaces?.id })
        });
        await onDone("");
      } else if (file) {
        const params = new URLSearchParams({ fileName: file.name, mimeType: file.type, title, validFrom, validUntil });
        if (form.replaces) params.set("replaces", form.replaces.id);
        const response = await fetch(
          `${API}/companies/${encodeURIComponent(companyId)}/knowledge/documents?${params}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              ...(session ? { Authorization: `Bearer ${session.token}` } : {})
            },
            body: file
          }
        );
        if (!response.ok) throw new Error(await response.text());
        const result = await response.json() as { extractionOk: boolean };
        await onDone(result.extractionOk
          ? ""
          : `Dokumentti "${file.name}" tallennettiin, mutta sen tekstiä ei saatu luettua. Se ei ole AI:n käytössä.`);
      }
    } catch (caught) {
      setError(errorMessage(caught, "Tallennus epäonnistui."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer form-drawer" onClick={event => event.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        <h2>{heading}</h2>
        <p className="muted">
          {form.mode === "validity"
            ? `${form.entry.title}. Vanhentunut tietue poistuu AI:n käytöstä.`
            : form.replaces
            ? "Uusi versio korvaa vanhan. Vanha versio säilyy historiassa."
            : form.mode === "document"
            ? "PDF, Word (.docx) tai kuva. Teksti luetaan automaattisesti."
            : "Lyhyt kysymys–vastaus-pari, esim. ”saunavuorot varataan huoltoyhtiöltä”."}
        </p>

        <form className="ticket-form" onSubmit={handleSubmit}>
          {form.mode === "document" && (
            <>
              <label>
                <span>Tiedosto</span>
                <input
                  type="file"
                  accept=".pdf,.docx,.txt,image/*"
                  onChange={event => setFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <label>
                <span>Otsikko</span>
                <input value={title} onChange={event => setTitle(event.target.value)} placeholder="Esim. Järjestyssäännöt (oletuksena tiedoston nimi)" />
              </label>
            </>
          )}

          {form.mode === "fact" && (
            <>
              <label>
                <span>Kysymys tai aihe</span>
                <input value={title} onChange={event => setTitle(event.target.value)} placeholder="Esim. Miten saunavuoro varataan?" />
              </label>
              <label>
                <span>Vastaus</span>
                <textarea value={answer} onChange={event => setAnswer(event.target.value)} rows={5} placeholder="Esim. Saunavuorot varataan huoltoyhtiöltä." />
              </label>
            </>
          )}

          <div className="form-columns">
            <label>
              <span>Voimassa alkaen</span>
              <input type="date" value={validFrom} onChange={event => setValidFrom(event.target.value)} />
            </label>
            <label>
              <span>Voimassa asti</span>
              <input type="date" value={validUntil} onChange={event => setValidUntil(event.target.value)} />
            </label>
          </div>
          <p className="reply-hint">Jätä tyhjäksi, jos tieto on voimassa toistaiseksi.</p>

          {error && <p className="send-error">{error}</p>}

          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>Peruuta</button>
            <button className="primary" type="submit" disabled={submitting || !canSubmit}>
              {submitting ? (form.mode === "document" ? "Luetaan tekstiä…" : "Tallennetaan…") : "Tallenna"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
