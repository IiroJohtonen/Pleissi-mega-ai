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

export function getAuthorizedTicket(ticketId: string) {
  const companyIds = visibleCompanyIds();
  const placeholders = companyIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT *
    FROM tickets
    WHERE id = ? AND company_id IN (${placeholders})
  `).get(ticketId, ...companyIds);
}
