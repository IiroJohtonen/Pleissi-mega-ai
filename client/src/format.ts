

export const ticketPriorities = ["emergency", "urgent", "normal", "low"];
export const ticketTypeOptions = ["Kysymys", "Ilmoitus", "Pyyntö", "Toimenpide", "Vikailmoitus", "Muutto", "Muu"];

export function priorityLabel(priority: string) {
  return {
    emergency: "Hätä",
    urgent: "Kiireellinen",
    normal: "Normaali",
    low: "Matala"
  }[priority] || priority;
}

export const ticketStatuses = ["open", "waiting_manager", "waiting_third_party", "closed"];

export function statusLabel(status: string) {
  return {
    open: "Avoin",
    waiting_manager: "Odottaa isännöitsijää",
    waiting_third_party: "Odottaa kolmatta osapuolta",
    closed: "Suljettu"
  }[status] || status;
}

export function channelLabel(channel?: string) {
  if (!channel) return "Tuntematon kanava";
  return {
    email: "Sähköposti",
    portal: "Portaali",
    quick_note: "Pikamuistio",
    contractor: "Huoltoyhtiö",
    manual: "Manuaalinen"
  }[channel] || channel;
}

export function actionLabel(action: string) {
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

export function actorLabel(actor: string) {
  return {
    ai: "AI",
    system: "Järjestelmä",
    isannoitsija: "Isännöitsijä"
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
  if (bytes < 1024) return `${bytes} t`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kt`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mt`;
}

export function formatDate(value?: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString("fi-FI", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatTicketNumber(value?: number | null) {
  return typeof value === "number" ? String(value).padStart(4, "0") : "----";
}

export function ticketAge(createdAt: string, currentTime: number) {
  const createdAtTime = Date.parse(createdAt);
  if (Number.isNaN(createdAtTime)) return "—";
  const ageMinutes = Math.max(0, Math.floor((currentTime - createdAtTime) / 60_000));
  if (ageMinutes < 60) return `${ageMinutes} min`;
  const hours = Math.floor(ageMinutes / 60);
  if (hours < 24) return `${hours} h ${ageMinutes % 60} min`;
  const days = Math.floor(hours / 24);
  return `${days} pv ${hours % 24} h`;
}

export function formatEuros(amount: number) {
  return amount.toLocaleString("fi-FI", { style: "currency", currency: "EUR" });
}

// Keston esitys: alle vuorokausi tunteina, muuten päivinä ja tunteina.
export function formatDuration(milliseconds: number) {
  const hours = Math.max(0, Math.round(milliseconds / 3_600_000));
  if (hours < 1) return "alle 1 h";
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} pv` : `${days} pv ${hours % 24} h`;
}

export function formatDay(value?: string | null) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${Number(day)}.${Number(month)}.${year}`;
}
