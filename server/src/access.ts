import { AsyncLocalStorage } from "node:async_hooks";
import type { User } from "./auth.js";
import { db } from "./db.js";

// Kirjautunut henkilökunnan käyttäjä pyynnön ajan, jotta yhtiörajaus toimii kaikissa tarkistuksissa.
// Asukkaan ja palvelimen omissa kutsuissa käyttäjää ei ole.
export const requestUser = new AsyncLocalStorage<User | undefined>();
export const DEFAULT_COMPANY_ID = process.env.DEFAULT_COMPANY_ID || "demo-company";
export const AUTHORIZED_COMPANY_IDS = new Set(
  (process.env.AUTHORIZED_COMPANY_IDS || DEFAULT_COMPANY_ID)
    .split(",")
    .map(companyId => companyId.trim())
    .filter(Boolean)
);

for (const company of db.prepare("SELECT id FROM companies WHERE managed = 1").all() as { id: string }[]) {
  AUTHORIZED_COMPANY_IDS.add(company.id);
}

// Yhtiöt, jotka pyynnön tekijä näkee. Isännöitsijä näkee yhtiöt, joissa hän on vastuuisännöitsijä tai
// muu isännöitsijä, sekä yhtiöt, joilla ei ole vastuuisännöitsijää. Pääkäyttäjä ja asiakaspalvelu
// näkevät kaikki.
export function visibleCompanyIds(): string[] {
  const companyIds = [...AUTHORIZED_COMPANY_IDS];
  const user = requestUser.getStore();
  if (!user || user.role !== "Isännöitsijä") return companyIds;
  const own = new Set((db.prepare(`
    SELECT id FROM companies
    WHERE manager_id IS NULL OR manager_id = ?
       OR id IN (SELECT company_id FROM company_managers WHERE user_id = ?)
  `).all(user.id, user.id) as { id: string }[]).map(company => company.id));
  return companyIds.filter(companyId => own.has(companyId));
}

export function companyIdFromContext(requestedCompanyId?: unknown) {
  const companyId = typeof requestedCompanyId === "string" && requestedCompanyId
    ? requestedCompanyId
    : DEFAULT_COMPANY_ID;
  return visibleCompanyIds().includes(companyId) ? companyId : null;
}

// Saapuva sähköposti ohjataan yhtiölle, jonka vastaanotto-osoitteeseen se on lähetetty.
export function companyIdForRecipients(recipientEmails: string[] = []) {
  const recipients = new Set(recipientEmails.map(email => email.trim().toLowerCase()));
  if (recipients.size === 0) return null;
  const companies = db.prepare("SELECT id, email_address FROM companies").all() as
    { id: string; email_address: string }[];
  const match = companies.find(company =>
    AUTHORIZED_COMPANY_IDS.has(company.id)
    && recipients.has(company.email_address.trim().toLowerCase())
  );
  return match?.id ?? null;
}

// Arkaluonteisen tehtävän (terveys ym. erityiset tietoryhmät) sisällön näkevät vain sen käsittelijä,
// taloyhtiön vastuuisännöitsijä ja pääkäyttäjät. Palvelimen omissa kutsuissa (posti, ajastetut työt)
// käyttäjää ei ole, ja ne näkevät kaiken.
export function canSeeSensitiveTicket(ticket: { sensitive?: number | null; assignee_id?: string | null; company_id: string }) {
  if (!ticket.sensitive) return true;
  const user = requestUser.getStore();
  if (!user || user.role === "Pääkäyttäjä") return true;
  if (ticket.assignee_id && ticket.assignee_id === user.id) return true;
  const company = db.prepare("SELECT manager_id FROM companies WHERE id = ?").get(ticket.company_id) as
    { manager_id: string | null } | undefined;
  return company?.manager_id === user.id;
}

export const RESTRICTED_SUBJECT = "Arkaluonteinen tehtävä";

// Listoissa rajattu tehtävä näkyy ilman sisältöä ja asukkaan nimeä, jotta se ei katoa jonosta.
export function redactRestrictedTicket<T extends { sensitive?: number | null; assignee_id?: string | null; company_id: string }>(row: T) {
  if (canSeeSensitiveTicket(row)) return row;
  return {
    ...row,
    subject: RESTRICTED_SUBJECT, summary: "", draft: "", ai_reason: "", resident_name: null,
    knowledge_source_title: null, restricted: true
  };
}

type TicketRow = { id: string; company_id: string; sensitive?: number | null; assignee_id?: string | null } & Record<string, unknown>;

export function getAuthorizedTicket(ticketId: string) {
  const companyIds = visibleCompanyIds();
  const placeholders = companyIds.map(() => "?").join(", ");
  const ticket = db.prepare(`
    SELECT *
    FROM tickets
    WHERE id = ? AND company_id IN (${placeholders})
  `).get(ticketId, ...companyIds) as TicketRow | undefined;
  return ticket && canSeeSensitiveTicket(ticket) ? ticket : undefined;
}

// Tehtävä on yhtiössä, jonka käyttäjä näkee, mutta arkaluonteisena rajattu häneltä.
export function isRestrictedTicket(ticketId: string) {
  const companyIds = visibleCompanyIds();
  const ticket = db.prepare(`
    SELECT company_id, sensitive, assignee_id FROM tickets WHERE id = ? AND company_id IN (${companyIds.map(() => "?").join(", ")})
  `).get(ticketId, ...companyIds) as TicketRow | undefined;
  return Boolean(ticket && !canSeeSensitiveTicket(ticket));
}
