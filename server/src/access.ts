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

// Saapuva sähköposti ohjataan yhtiölle, jonka vastaanotto-osoitteeseen se on lähetetty. Osoite kertoo
// yhtiön vain, jos se on täsmälleen yhden yhtiön osoite: toimiston yhteinen osoite tai usean yhtiön
// käyttämä osoite ei kerro yhtiötä, jolloin viesti menee Tunnistamattomat-jonoon (ellei lähettäjä ole asukas).
export function companyIdForRecipients(recipientEmails: string[] = []) {
  const normalize = (email: string) => email.trim().toLowerCase();
  const recipients = new Set(recipientEmails.map(normalize));
  if (recipients.size === 0) return null;
  const office = db.prepare("SELECT email FROM gmail_accounts WHERE id = 'office'").get() as { email: string } | undefined;
  const officeEmail = normalize(office?.email ?? "");
  const companies = db.prepare("SELECT id, email_address FROM companies").all() as
    { id: string; email_address: string }[];
  const matches = companies.filter(company => {
    const address = normalize(company.email_address ?? "");
    return AUTHORIZED_COMPANY_IDS.has(company.id) && address && address !== officeEmail && recipients.has(address);
  });
  // Osoite, jota käyttää useampi yhtiö, ei ole minkään yhtiön oma.
  const sharedAddresses = new Set(companies
    .map(company => normalize(company.email_address ?? ""))
    .filter((address, index, all) => address && all.indexOf(address) !== index));
  const unique = [...new Set(matches.filter(company => !sharedAddresses.has(normalize(company.email_address))).map(company => company.id))];
  return unique.length === 1 ? unique[0] : null;
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

type TicketAccessRow = {
  sensitive?: number | null; assignee_id?: string | null; company_id: string; company_pending?: number | null;
};

function jsonList(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// Taloyhtiö tunnistamatta -jonon käsittelijät: toimiston asetuksissa valitut roolit ja käyttäjät.
// Pääkäyttäjä käsittelee jonoa aina.
export function unidentifiedQueueSettings() {
  const row = db.prepare("SELECT unidentified_queue_roles AS roles, unidentified_queue_users AS users FROM office_settings WHERE id = 1")
    .get() as { roles: string; users: string } | undefined;
  return { roles: jsonList(row?.roles), users: jsonList(row?.users) };
}

export function isQueueHandler(user = requestUser.getStore()) {
  if (!user) return true;
  if (user.role === "Pääkäyttäjä") return true;
  const settings = unidentifiedQueueSettings();
  return settings.roles.includes(user.role) || settings.users.includes(user.id);
}

// Näkeekö pyynnön tekijä tehtävän. Tunnistamattoman yhtiön tehtävän näkevät jonon käsittelijät ja
// tehtävän käsittelijä; muuten ratkaisee arkaluonteisuus.
export function canSeeTicket(ticket: TicketAccessRow) {
  if (ticket.company_pending) {
    const user = requestUser.getStore();
    return !user || Boolean(ticket.assignee_id && ticket.assignee_id === user.id) || isQueueHandler(user);
  }
  return canSeeSensitiveTicket(ticket);
}

// Listan rivit pyynnön tekijälle: tunnistamattoman yhtiön tehtävät jäävät pois muilta kuin jonon
// käsittelijöiltä, ja rajattu arkaluonteinen tehtävä näkyy ilman sisältöä.
export function visibleTicketRows<T extends TicketAccessRow>(rows: T[]) {
  return rows.filter(row => !row.company_pending || canSeeTicket(row)).map(redactRestrictedTicket);
}

export const RESTRICTED_SUBJECT = "Arkaluonteinen tehtävä";

// Listoissa rajattu tehtävä näkyy ilman sisältöä ja asukkaan nimeä, jotta se ei katoa jonosta.
export function redactRestrictedTicket<T extends TicketAccessRow>(row: T) {
  if (canSeeTicket(row)) return row;
  return {
    ...row,
    subject: RESTRICTED_SUBJECT, summary: "", draft: "", ai_reason: "", resident_name: null,
    knowledge_source_title: null, restricted: true
  };
}

type TicketRow = { id: string } & TicketAccessRow & Record<string, unknown>;

export function getAuthorizedTicket(ticketId: string) {
  const companyIds = visibleCompanyIds();
  const placeholders = companyIds.map(() => "?").join(", ");
  const ticket = db.prepare(`
    SELECT *
    FROM tickets
    WHERE id = ? AND company_id IN (${placeholders})
  `).get(ticketId, ...companyIds) as TicketRow | undefined;
  return ticket && canSeeTicket(ticket) ? ticket : undefined;
}

// Tehtävä on yhtiössä, jonka käyttäjä näkee, mutta arkaluonteisena rajattu häneltä.
export function isRestrictedTicket(ticketId: string) {
  const companyIds = visibleCompanyIds();
  const ticket = db.prepare(`
    SELECT id, company_id, sensitive, assignee_id, company_pending FROM tickets
    WHERE id = ? AND company_id IN (${companyIds.map(() => "?").join(", ")})
  `).get(ticketId, ...companyIds) as TicketRow | undefined;
  return Boolean(ticket && !ticket.company_pending && !canSeeTicket(ticket));
}
