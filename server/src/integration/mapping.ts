import type { Comment, FullTask, Task } from "./canonical.js";

// ---------------------------------------------------------------------------------------------
// Pleissin tehtävä ja sen viestit kanoniseen muotoon. Muunnos tehdään kirjaushetkellä, joten sanoma
// kuvaa tehtävän tilaa juuri sillä hetkellä.
// ---------------------------------------------------------------------------------------------

// Tehtävärivin kentät, jotka triggeri antaa muunnokselle (tickets-taulun sarakkeet).
export type TaskRow = {
  id: string; ticket_number: number | null; company_id: string; apartment_id: string | null; resident_id: string | null;
  type: string; priority: string; status: string; subject: string; summary: string;
  source_channel: string; ai_action: string; kind: string; company_pending: number | null; sensitive: number;
  topic: string | null; created_at: string; updated_at: string;
};

// Triggerin muista tauluista hakemat tiedot.
export type TaskContext = {
  erpRef: string | null;
  assigneeName: string | null;
  managerName: string | null;
  maintenanceName: string | null;
  hasWorkOrder: number;
  commentCount: number;
  attachments: { fileName: string; contentType: string }[] | null;
};

export type MessageRow = {
  id: string; ticket_id: string; direction: string; sender: string; body: string; created_at: string; channel: string | null;
};

// Sama kuin AI-agentin AGENT_ACTOR (ai-agent.ts); testi varmistaa, että ne pysyvät samoina.
export const AI_AUTHOR = "Pleissi AI-agentti";

// Vain tavalliset tehtävät, joiden taloyhtiö on tunnistettu ja joita AI ei suodattanut pois.
export function taskEligible(row: Pick<TaskRow, "kind" | "company_pending" | "ai_action">) {
  return row.kind === "ticket" && !row.company_pending && row.ai_action !== "filtered";
}

const STATUS: Record<string, Task["status"]> = {
  open: "open", active: "open", waiting_manager: "in_progress", answered: "waiting_resident",
  waiting_third_party: "waiting_contractor", closed: "closed"
};
const PRIORITY: Record<string, FullTask["priority"]> = { emergency: "critical", urgent: "high", normal: "normal", low: "low" };
const CATEGORY: Record<string, FullTask["category"]> = {
  Vikailmoitus: "maintenance", "Häiriöilmoitus": "complaint", Valitus: "complaint", Kysymys: "question", Varaus: "booking"
};
const CHANNEL: Record<string, FullTask["channel"]> = { email: "email", portal: "web_form", phone: "phone", manual: "manual" };

// UTC-aika Suomen ajan offsetilla: 2026-10-24T15:45:00.000Z → 2026-10-24T18:45:00+03:00.
export function withOffset(iso: string, timeZone = "Europe/Helsinki") {
  const date = new Date(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", timeZoneName: "longOffset"
  }).formatToParts(date).map(part => [part.type, part.value]));
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName.replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function assignee(row: TaskRow, context: TaskContext): FullTask["assignee"] {
  if (row.ai_action === "ai") return { type: "ai", name: "Pleissi" };
  if (row.status === "waiting_third_party" && context.hasWorkOrder) return { type: "maintenance", name: context.maintenanceName || "Huoltoyhtiö" };
  const name = context.assigneeName || context.managerName;
  return name ? { type: "propertyManager", name } : null;
}

export function toTask(row: TaskRow, context: TaskContext): Task {
  const identity = {
    id: row.id,
    externalRefs: { erp: context.erpRef },
    ticketNumber: row.ticket_number,
    title: row.subject,
    status: STATUS[row.status] ?? "open"
  };
  // Arkaluonteisesta tehtävästä vain tunnisteet, otsikko ja tila (docs/integraatiospec.md, Arkaluonteiset tehtävät).
  if (row.sensitive) return { ...identity, sensitive: true };
  return {
    ...identity,
    sensitive: false,
    description: row.summary.trim() || null,
    category: row.topic === "booking" ? "booking" : CATEGORY[row.type] ?? "other",
    priority: PRIORITY[row.priority] ?? "normal",
    channel: CHANNEL[row.source_channel] ?? "manual",
    housingCompanyId: row.company_id,
    apartmentId: row.apartment_id,
    residentId: row.resident_id,
    assignee: assignee(row, context),
    relatedBookingId: null,
    attachments: (context.attachments ?? []).map(file => ({ fileName: file.fileName, url: null, contentType: file.contentType })),
    commentCount: context.commentCount,
    createdAt: withOffset(row.created_at),
    updatedAt: withOffset(row.updated_at)
  };
}

// Kentät, joiden muutos ei yksin synnytä task.updated-sanomaa.
const IGNORED_CHANGES = new Set(["externalRefs", "updatedAt", "commentCount"]);

// Muuttuneet kentät edelliseen kirjattuun tilaan verrattuna. Tyhjä = ERP:lle ei ole uutta. Kun tehtävä
// merkitään arkaluonteiseksi tai merkintä poistetaan, puuttuvat kentät lasketaan muuttuneiksi.
export function changedFields(previous: Task, next: Task): string[] {
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  return [...new Set([...Object.keys(after), ...Object.keys(before)])]
    .filter(key => !IGNORED_CHANGES.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

// Viesti kommentiksi. Null = ei ERP:hen: huoltoyhtiön työtilausviestit ja arkaluonteisen tehtävän sisältö.
// Sisäiset muistiinpanot (ticket_notes) eivät tule tänne lainkaan.
export function toComment(row: MessageRow, sensitive: boolean, erpRef: string | null = null): Comment | null {
  if (sensitive || row.channel === "contractor" || !row.body.trim()) return null;
  const name = row.sender.replace(/\s*<[^>]*>\s*$/, "").trim() || row.sender;
  const author: Comment["author"] = row.direction === "inbound"
    ? { type: "resident", name }
    : { type: row.sender === AI_AUTHOR ? "ai" : "propertyManager", name };
  return { id: row.id, externalRefs: { erp: erpRef }, taskId: row.ticket_id, author, visibility: "public", text: row.body, createdAt: withOffset(row.created_at) };
}
