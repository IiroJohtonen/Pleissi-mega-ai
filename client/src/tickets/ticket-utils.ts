import { formatDate, formatTicketNumber, priorityLabel, statusLabel } from "../format";
import { api, isAdmin, type OfficeUser, session } from "../session";
import type { Company, Ticket, TicketDetail } from "../types";
import { t } from "../i18n";

export async function fetchTicketDetail(id: string): Promise<TicketDetail> {
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
    contractor: detail.contractor ?? null,
    replyAccounts: detail.replyAccounts ?? [],
    signature: detail.signature ?? ""
  };
}

export type TicketSortKey = "number" | "subject" | "priority" | "type" | "contact" | "assignee" | "status" | "created" | "updated";
export type TicketSort = { key: TicketSortKey; descending: boolean };

// Tehtävälistan sarakkeet samassa järjestyksessä kuin rivin kentät.
export const ticketColumns: { key: TicketSortKey; label: string }[] = [
  { key: "number", label: t("Numero") },
  { key: "subject", label: t("Aihe") },
  { key: "priority", label: t("Prioriteetti") },
  { key: "type", label: t("Tyyppi") },
  { key: "contact", label: t("Yhteyshenkilö") },
  { key: "assignee", label: t("Käsittelijä") },
  { key: "status", label: t("Tila") },
  { key: "created", label: t("Luotu") },
  { key: "updated", label: t("Muokattu") }
];

const priorityRank: Record<string, number> = { emergency: 0, urgent: 1, normal: 2, low: 3 };

// Tehtävä on myöhässä, kun se on kesken ja määräaika on mennyt.
export function isOverdue(ticket: Ticket) {
  return ticket.status !== "closed" && Boolean(ticket.due_date)
    && (ticket.due_date as string) < new Date().toLocaleDateString("sv-SE");
}

// Työtilauksen valmis kuvaus tehtävän otsikosta ja tiivistelmästä. Sama teksti tulee vain kerran:
// lyhyen viestin tiivistelmä on usein sama kuin otsikko tai sisältää sen.
export function workOrderDescription(subject: string, summary: string): string {
  const title = subject.trim();
  const body = summary.trim();
  const normalize = (text: string) => text.toLowerCase().replace(/[\s.!?:]+/g, " ").trim();
  if (!body || normalize(title).includes(normalize(body))) return title;
  if (!title || normalize(body).includes(normalize(title))) return body;
  return `${title}\n\n${body}`;
}

export type ReminderSettings = { replyDays: number; dueDays: number };
export type TicketReminder = { kind: "overdue" | "due" | "waiting"; text: string };

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(day: string, days: number) {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString("sv-SE");
}

// Syyt, joiden vuoksi keskeneräinen tehtävä nostetaan päätösjonon kärkeen: määräaika on mennyt tai
// lähestyy, tai asukas on odottanut vastausta asetetun ajan.
export function ticketReminders(ticket: Ticket, settings: ReminderSettings, now = new Date()): TicketReminder[] {
  if (ticket.status === "closed") return [];
  const day = now.toLocaleDateString("sv-SE");
  const reminders: TicketReminder[] = [];
  const due = ticket.due_date ?? "";
  if (due && due < day) {
    reminders.push({ kind: "overdue", text: t("Määräaika ylittynyt {0}", formatDay(due)) });
  } else if (due && due <= addDays(day, settings.dueDays)) {
    reminders.push({
      kind: "due",
      text: due === day ? t("Määräaika tänään") : due === addDays(day, 1) ? t("Määräaika huomenna") : t("Määräaika {0}", formatDay(due))
    });
  }
  if (ticket.waiting_since) {
    const days = Math.floor((now.getTime() - new Date(ticket.waiting_since).getTime()) / DAY_MS);
    if (days >= settings.replyDays) {
      reminders.push({ kind: "waiting", text: days === 1 ? t("Asukas odottanut 1 päivän") : t("Asukas odottanut {0} päivää", days) });
    }
  }
  return reminders;
}

function formatDay(day: string) {
  const [year, month, date] = day.split("-");
  return `${Number(date)}.${Number(month)}.${year}`;
}

export function compareTickets(a: Ticket, b: Ticket, key: TicketSortKey) {
  switch (key) {
    case "number": return (a.ticket_number ?? 0) - (b.ticket_number ?? 0);
    case "subject": return a.subject.localeCompare(b.subject, "fi");
    case "priority": return (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
    case "type": return a.type.localeCompare(b.type, "fi");
    case "contact":
      return (a.resident_name || a.apartment_number || "").localeCompare(b.resident_name || b.apartment_number || "", "fi");
    // Tehtävät ilman käsittelijää järjestyvät viimeisiksi.
    case "assignee": return (a.assignee_name || "\uffff").localeCompare(b.assignee_name || "\uffff", "fi");
    case "status": return statusLabel(a.status).localeCompare(statusLabel(b.status), "fi");
    case "created": return Date.parse(a.created_at) - Date.parse(b.created_at);
    case "updated":
      return Date.parse(a.updated_at || a.created_at) - Date.parse(b.updated_at || b.created_at);
  }
}

// Päätösjonon järjestys. Tasatilanteessa vanhempi tehtävä on ensin; määräajattomat ovat viimeisinä.
export function compareQueue(a: Ticket, b: Ticket, sort: "oldest" | "newest" | "priority" | "due") {
  const oldest = compareTickets(a, b, "created");
  switch (sort) {
    case "oldest": return oldest;
    case "newest": return -oldest;
    case "priority": return compareTickets(a, b, "priority") || oldest;
    case "due": return (a.due_date || "\uffff").localeCompare(b.due_date || "\uffff") || oldest;
  }
}

// Sarakkeessa näkyvä teksti, josta sarakekohtainen haku etsii.
export function ticketColumnText(ticket: Ticket, key: TicketSortKey) {
  switch (key) {
    case "number": return `#${formatTicketNumber(ticket.ticket_number)}`;
    case "subject": return `${ticket.subject} ${ticket.summary}`;
    case "priority": return priorityLabel(ticket.priority);
    case "type": return ticket.type;
    case "contact": return ticket.resident_name || ticket.apartment_number || t("Ei yhteyshenkilöä");
    case "assignee": return ticket.assignee_name || t("Ei käsittelijää");
    case "status": return statusLabel(ticket.status);
    case "created": return formatDate(ticket.created_at);
    case "updated": return formatDate(ticket.updated_at || ticket.created_at);
  }
}

// Tehtävän voi osoittaa isännöitsijälle tai pääkäyttäjälle.
export function isManagerRole(user: OfficeUser) {
  return user.role === "Isännöitsijä" || user.role === "Pääkäyttäjä";
}

// Kenelle taloyhtiön tehtävän voi antaa: vastuuisännöitsijälle ja taloyhtiön muille isännöitsijöille.
// Jos taloyhtiölle ei ole valittu muita isännöitsijöitä, valittavana ovat kaikki toimiston isännöitsijät.
export function assignableUsers(company: Company | undefined, users: OfficeUser[]) {
  const others = company?.manager_ids ?? [];
  if (others.length === 0) return users.filter(isManagerRole);
  return users.filter(user => user.id === company?.manager_id || others.includes(user.id));
}

// Tehtävän saa antaa toiselle taloyhtiön vastuuisännöitsijä tai pääkäyttäjä; palvelin tarkistaa saman.
// Ilman vastuuisännöitsijää jakaminen on sallittu kaikille.
export function canAssignTickets(company: Company | undefined) {
  return isAdmin() || !company?.manager_id || company.manager_id === session?.user.id;
}

// Erottaa sähköpostivastauksesta lainatun aiemman viestin ("… kirjoitti:" ja >-rivit), jotta
// aikajanalla näkyy vain lähettäjän uusi teksti. Palauttaa uuden tekstin ja lainatun osan erikseen.
export function splitQuotedReply(body: string): { text: string; quoted: string } {
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
