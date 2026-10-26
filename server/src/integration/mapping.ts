import type { Comment, Task } from "./canonical.js";

// ---------------------------------------------------------------------------------------------
// Pleissin tehtävä ja sen viestit kanoniseen muotoon. Muunnos tehdään kirjaushetkellä, joten sanoma
// kuvaa tehtävän tilaa juuri sillä hetkellä.
// ---------------------------------------------------------------------------------------------

// Tehtävärivin kentät, jotka triggeri antaa muunnokselle (tickets-taulun sarakkeet).
export type TaskRow = {
  id: string; company_id: string; apartment_id: string | null; resident_id: string | null;
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
  // "note" = sisäinen muistiinpano (ticket_notes), muuten viesti (messages).
  source: "message" | "note";
};

// Sama kuin AI-agentin AGENT_ACTOR (ai-agent.ts); testi varmistaa, että ne pysyvät samoina.
export const AI_AUTHOR = "Pleissi AI-agentti";
export const SENSITIVE_TITLE = "Arkaluonteinen tehtävä";

// Vain tavalliset tehtävät, joiden taloyhtiö on tunnistettu ja joita AI ei suodattanut pois.
export function taskEligible(row: Pick<TaskRow, "kind" | "company_pending" | "ai_action">) {
  return row.kind === "ticket" && !row.company_pending && row.ai_action !== "filtered";
}

const STATUS: Record<string, Task["status"]> = {
  open: "open", active: "open", waiting_manager: "in_progress", answered: "waiting_resident",
  waiting_third_party: "waiting_contractor", closed: "closed"
};
const PRIORITY: Record<string, Task["priority"]> = { emergency: "critical", urgent: "high", normal: "normal", low: "low" };
const CATEGORY: Record<string, Task["category"]> = {
  Vikailmoitus: "maintenance", "Häiriöilmoitus": "complaint", Valitus: "complaint", Kysymys: "question", Varaus: "booking"
};
const CHANNEL: Record<string, Task["channel"]> = { email: "email", portal: "web_form", phone: "phone", manual: "manual" };

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

function assignee(row: TaskRow, context: TaskContext): Task["assignee"] {
  if (row.ai_action === "ai") return { type: "ai", name: "Pleissi" };
  if (row.status === "waiting_third_party" && context.hasWorkOrder) return { type: "maintenance", name: context.maintenanceName || "Huoltoyhtiö" };
  const name = context.assigneeName || context.managerName;
  return name ? { type: "propertyManager", name } : null;
}

export function toTask(row: TaskRow, context: TaskContext): Task {
  const sensitive = Boolean(row.sensitive);
  return {
    id: row.id,
    externalRefs: { erp: context.erpRef },
    // Arkaluonteisen tehtävän sisältöä ei viedä ERP:hen.
    title: sensitive ? SENSITIVE_TITLE : row.subject,
    description: sensitive ? null : row.summary.trim() || null,
    category: row.topic === "booking" ? "booking" : CATEGORY[row.type] ?? "other",
    priority: PRIORITY[row.priority] ?? "normal",
    status: STATUS[row.status] ?? "open",
    channel: CHANNEL[row.source_channel] ?? "manual",
    housingCompanyId: row.company_id,
    apartmentId: row.apartment_id,
    residentId: row.resident_id,
    assignee: assignee(row, context),
    relatedBookingId: null,
    attachments: sensitive ? [] : (context.attachments ?? []).map(file => ({ fileName: file.fileName, url: null, contentType: file.contentType })),
    commentCount: sensitive ? 0 : context.commentCount,
    createdAt: withOffset(row.created_at),
    updatedAt: withOffset(row.updated_at)
  };
}

// Kentät, joiden muutos ei yksin synnytä task.updated-sanomaa.
const IGNORED_CHANGES = new Set(["externalRefs", "updatedAt", "commentCount"]);

// Muuttuneet kentät edelliseen kirjattuun tilaan verrattuna. Tyhjä = ERP:lle ei ole uutta.
export function changedFields(previous: Task, next: Task): string[] {
  return (Object.keys(next) as (keyof Task)[])
    .filter(key => !IGNORED_CHANGES.has(key) && JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}

// Viesti tai muistiinpano kommentiksi. Null = ei ERP:hen: huoltoyhtiön työtilausviestit, AI:n
// muistiinpanot (perustelut) ja arkaluonteisen tehtävän sisältö.
export function toComment(row: MessageRow, sensitive: boolean, erpRef: string | null = null): Comment | null {
  if (sensitive || row.channel === "contractor" || !row.body.trim()) return null;
  if (row.source === "note") {
    if (row.sender === AI_AUTHOR) return null;
    return base(row, erpRef, { type: "propertyManager", name: row.sender }, "internal");
  }
  const name = row.sender.replace(/\s*<[^>]*>\s*$/, "").trim() || row.sender;
  const author: Comment["author"] = row.direction === "inbound"
    ? { type: "resident", name }
    : { type: row.sender === AI_AUTHOR ? "ai" : "propertyManager", name };
  return base(row, erpRef, author, "public");
}

function base(row: MessageRow, erpRef: string | null, author: Comment["author"], visibility: Comment["visibility"]): Comment {
  return { id: row.id, externalRefs: { erp: erpRef }, taskId: row.ticket_id, author, visibility, text: row.body, createdAt: withOffset(row.created_at) };
}
