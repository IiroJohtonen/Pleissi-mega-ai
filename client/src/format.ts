import { language, locale, t } from "./i18n";
export const ticketPriorities = ["emergency", "urgent", "normal", "low"];
export const ticketTypeOptions = [
  "Kysymys", "Ilmoitus", "Pyyntö", "Toimenpide", "Vikailmoitus", "Huoltotyötilaus", "Häiriöilmoitus", "Irtisanomisilmoitus", "Asuntohakemus",
  "Muu"
];

export function priorityLabel(priority: string) {
  return {
    emergency: t("Hätä"),
    urgent: t("Kiireellinen"),
    normal: t("Normaali"),
    low: t("Matala")
  }[priority] || priority;
}

// Tehtävän tilat. open = Uusi (saapunut), active = Avoin, waiting_manager = Käsittelyssä,
// answered = Vastattu (toimisto on vastannut), waiting_third_party = Kolmannella osapuolella.
export const ticketStatuses = ["open", "active", "waiting_manager", "answered", "waiting_third_party", "closed"];
// Tilat, jotka käsittelijä voi valita itse tehtäväsivulla. Uusi-tila tulee vain saapuneelle tehtävälle.
export const manualTicketStatuses = ["active", "waiting_manager", "answered", "waiting_third_party", "closed"];
// Tilat, joissa tehtävä odottaa käsittelijän toimia päätösjonossa.
export const queueTicketStatuses = ["open", "active"];

export function statusLabel(status: string) {
  return {
    open: t("Uusi"),
    active: t("Avoin"),
    waiting_manager: t("Käsittelyssä"),
    answered: t("Vastattu"),
    waiting_third_party: t("Kolmannella osapuolella"),
    closed: t("Suljettu")
  }[status] || status;
}

export function channelLabel(channel?: string) {
  if (!channel) return t("Tuntematon kanava");
  return {
    email: t("Sähköposti"),
    portal: t("Portaali"),
    quick_note: t("Pikamuistio"),
    contractor: t("Huoltoyhtiö"),
    manual: t("Manuaalinen")
  }[channel] || channel;
}

export function actionLabel(action: string) {
  return {
    ticket_created: t("Tehtävä luotu"),
    ticket_created_manual: t("Tehtävä luotu käsin"),
    ticket_created_portal: t("Asukas loi tehtävän portaalissa"),
    ticket_assigned: t("Tehtävän käsittelijä vaihdettu"),
    work_order_created: t("Työtilaus tehty huoltoyhtiölle"),
    work_order_done: t("Työtilaus kuitattu tehdyksi"),
    work_order_message: t("Viesti lähetetty huoltoyhtiölle"),
    attachment_added: t("Liite lisätty tehtävälle"),
    triaged: t("AI luokitteli tehtävän"),
    ai_request: t("Lähetetty AI:lle"),
    emergency_routed: t("Ohjattu hätätapauksena"),
    ai_filtered: t("AI suodatti viestin: ei koske taloyhtiön asioita"),
    emergency_alert_sent: t("Hätätapauksesta lähetetty sähköposti vastuuisännöitsijälle"),
    emergency_alert_failed: t("Hätätapauksen sähköposti vastuuisännöitsijälle ei lähtenyt"),
    decision_ai: t("Päätös: AI hoitaa"),
    decision_human: t("Päätös: Osoitettu minulle"),
    decision_skip: t("Tehtävä suljettu"),
    draft_saved: t("Luonnos tallennettu"),
    ticket_updated: t("Tehtävän tietoja muutettu"),
    ai_suggested: t("AI laati vastausehdotuksen"),
    message_created: t("Viesti lisätty"),
    reply_sent: t("Vastaus lähetetty"),
    reply_received: t("Asukas vastasi sähköpostiin"),
    reply_received_reopened: t("Asukas vastasi, tehtävä avattu uudelleen"),
    portal_message: t("Asukas lähetti viestin portaalissa"),
    ticket_reopened: t("Tehtävä avattu uudelleen"),
    ticket_deleted: t("Tehtävä poistettu"),
    user_deleted: t("Käyttäjä poistettu"),
    role_created: t("Rooli lisätty"),
    role_updated: t("Roolia muutettu"),
    role_deleted: t("Rooli poistettu"),
    resident_notified: t("Asukkaalle lähetetty tilapäivitys"),
    board_member_created: t("Hallituksen tunnus luotu"),
    reporter_changed: t("Ilmoittaja vaihdettu"),
    board_member_deleted: t("Hallituksen tunnus poistettu"),
    resident_erased: t("Asukkaan henkilötiedot poistettu"),
    retention_purge: t("Säilytysajan ylittäneet tiedot poistettu"),
    master_data_updated: t("Perustietoja muutettu"),
    sensitive_marked: t("Merkitty arkaluonteiseksi"),
    sensitive_cleared: t("Arkaluonteisuusmerkintä poistettu"),
    sensitive_viewed: t("Avasi arkaluonteisen tehtävän"),
    company_unidentified: t("Taloyhtiötä ei tunnistettu"),
    company_assigned: t("Taloyhtiö valittu"),
    company_changed: t("Siirretty toiseen taloyhtiöön"),
    erasure_deferred: t("Poistopyyntö: tehtävä säilytetään"),
    erasure_completed: t("Säilytetty tehtävä anonymisoitu"),
    reporter_linked: t("Asukas linkitetty tehtävään"),
    renovation_reported: t("Remontti ilmoitettu"),
    renovation_updated: t("Remontti-ilmoituksen tietoja muutettu"),
    renovation_approved: t("Remontti hyväksytty"),
    renovation_rejected: t("Remontti hylätty"),
    renovation_started: t("Remontti aloitettu"),
    renovation_supervision: t("Valvontakäynti"),
    renovation_completed: t("Remontti valmis"),
    renovation_inspected: t("Remontti tarkastettu"),
    reporter_unlinked: t("Asukkaan linkitys poistettu"),
    ai_agent_booked: t("AI-agentti varasi vuoron asukkaalle"),
    ai_agent_waitlist: t("AI-agentti lisäsi asukkaan autopaikkajonoon"),
    ai_agent_replied: t("AI-agentti vastasi asukkaalle"),
    ai_agent_handover: t("AI-agentti jätti tehtävän henkilökunnalle")
  }[action] || action;
}

export function actorLabel(actor: string) {
  return {
    ai: "AI",
    system: t("Järjestelmä"),
    isannoitsija: t("Isännöitsijä")
  }[actor] || actor;
}

export const MAX_REPLY_ATTACHMENTS = 10;
export const MAX_REPLY_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// Lukee tiedoston base64-muotoon lähetettäväksi vastauksen liitteenä.
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return t("{0} t", bytes);
  if (bytes < 1024 * 1024) return t("{0} kt", Math.round(bytes / 1024));
  return t("{0} Mt", (bytes / (1024 * 1024)).toFixed(1));
}

export function formatDate(value?: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString(locale, {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// Päivä ilman kellonaikaa listoja varten.
export function formatDateOnly(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString(locale, { day: "numeric", month: "numeric", year: "numeric" });
}

// Ilmoituksen tilan väri: odottava on sininen (oletus), hyväksytty vihreä, hylätty punainen ja muut harmaita.
export function noticeStatusClass(status: string) {
  return status === "pending" ? "" : status === "approved" ? "approved" : status === "rejected" ? "rejected" : "done";
}

// Tehtävänumero muodossa T000123 (risuaita lisätään eteen näytettäessä).
export function formatTicketNumber(value?: number | null) {
  return typeof value === "number" ? `T${String(value).padStart(6, "0")}` : "T------";
}

export function ticketAge(createdAt: string, currentTime: number) {
  const createdAtTime = Date.parse(createdAt);
  if (Number.isNaN(createdAtTime)) return "—";
  const ageMinutes = Math.max(0, Math.floor((currentTime - createdAtTime) / 60_000));
  if (ageMinutes < 60) return `${ageMinutes} min`;
  const hours = Math.floor(ageMinutes / 60);
  if (hours < 24) return t("{0} h {1} min", hours, ageMinutes % 60);
  const days = Math.floor(hours / 24);
  return t("{0} pv {1} h", days, hours % 24);
}

export function formatEuros(amount: number) {
  return amount.toLocaleString(locale, { style: "currency", currency: "EUR" });
}

// Keston esitys: alle vuorokausi tunteina, muuten päivinä ja tunteina.
export function formatDuration(milliseconds: number) {
  const hours = Math.max(0, Math.round(milliseconds / 3_600_000));
  if (hours < 1) return t("alle 1 h");
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? t("{0} pv", days) : t("{0} pv {1} h", days, hours % 24);
}

export function formatDay(value?: string | null) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  // Englanniksi sama esitystapa kuin muissa päivämäärissä (pp/kk/vvvv).
  return language === "en" ? `${Number(day)}/${Number(month)}/${year}` : `${Number(day)}.${Number(month)}.${year}`;
}

// Dokumenttinumero muodossa K000123.
export function formatDocumentNumber(value?: number | null) {
  return typeof value === "number" ? `K${String(value).padStart(6, "0")}` : "";
}
