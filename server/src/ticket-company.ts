import { visibleCompanyIds } from "./access.js";
import { db } from "./db.js";
import { id, now } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Tehtävän taloyhtiö: Taloyhtiö tunnistamatta -jonon tehtävälle valitaan yhtiö, ja väärään yhtiöön
// mennyt tehtävä siirretään oikeaan. Siirto vaihtaa tehtävänumeron uuden yhtiön numerointiin ja antaa
// tehtävän uuden yhtiön vastuuisännöitsijälle.
// ---------------------------------------------------------------------------------------------

type TicketRow = { id: string; company_id: string; ticket_number: number | null; assignee_id: string | null; company_pending: number; mail_account_id: string | null };

function senderEmail(ticketId: string) {
  const first = db.prepare("SELECT sender FROM messages WHERE ticket_id = ? AND direction = 'inbound' ORDER BY created_at LIMIT 1")
    .get(ticketId) as { sender: string } | undefined;
  return first?.sender.match(/<([^>]+@[^>]+)>/)?.[1] ?? (first?.sender.includes("@") ? first.sender.trim() : null);
}

// Todennäköinen taloyhtiö tunnistamattomalle tehtävälle. Ehdotus on vain apu: yhtiön valitsee ihminen.
export function suggestCompany(ticketId: string): { companyId: string; companyName: string; reason: string } | null {
  const companyIds = visibleCompanyIds();
  if (companyIds.length === 0) return null;
  const inCompanies = `(${companyIds.map(() => "?").join(", ")})`;
  const name = (companyId: string) => (db.prepare("SELECT name FROM companies WHERE id = ?").get(companyId) as { name: string }).name;
  const email = senderEmail(ticketId);

  if (email) {
    const residents = db.prepare(`
      SELECT DISTINCT company_id FROM residents WHERE lower(email) = lower(?) AND erased_at IS NULL AND company_id IN ${inCompanies}
    `).all(email, ...companyIds) as { company_id: string }[];
    if (residents.length === 1) {
      return { companyId: residents[0].company_id, companyName: name(residents[0].company_id), reason: "Lähettäjä on yhtiön asukasrekisterissä." };
    }
    const earlier = db.prepare(`
      SELECT t.company_id FROM messages m JOIN tickets t ON t.id = m.ticket_id
      WHERE m.direction = 'inbound' AND lower(m.sender) LIKE lower(?) AND t.id != ? AND t.company_pending = 0
        AND t.company_id IN ${inCompanies}
      ORDER BY m.created_at DESC LIMIT 1
    `).get(`%${email}%`, ticketId, ...companyIds) as { company_id: string } | undefined;
    if (earlier) {
      return { companyId: earlier.company_id, companyName: name(earlier.company_id), reason: "Lähettäjän aiemmat viestit ovat koskeneet tätä yhtiötä." };
    }
  }

  // Viestissä mainittu yhtiön nimi tai osoite.
  const text = (db.prepare(`
    SELECT t.subject || ' ' || COALESCE((SELECT group_concat(m.body, ' ') FROM messages m WHERE m.ticket_id = t.id), '') AS text
    FROM tickets t WHERE t.id = ?
  `).get(ticketId) as { text: string }).text.toLowerCase();
  const companies = db.prepare(`SELECT id, name, address FROM companies WHERE id IN ${inCompanies}`).all(...companyIds) as
    { id: string; name: string; address: string | null }[];
  // Taivutettu muoto osuu vartaloon: "Männikön" ~ "Männikkö", "Koivikkotiellä" ~ "Koivikkotie".
  const words = text.match(/[a-zåäö0-9]+/g) ?? [];
  const mentions = (phrase: string) => {
    const parts = phrase.toLowerCase().match(/[a-zåäö0-9]+/g) ?? [];
    const significant = parts.filter(part => part.length >= 4);
    return significant.length > 0 && significant.every(part => {
      const stem = part.slice(0, Math.max(4, part.length - 2));
      return words.some(word => word.startsWith(stem));
    });
  };
  const mentioned = companies.filter(company => {
    const bareName = company.name.toLowerCase().replace(/^(as oy|asunto oy|kiinteistö oy|koy)\s+/, "").trim();
    const street = (company.address ?? "").split(",")[0].replace(/\d+.*$/, "").trim();
    return mentions(bareName) || (street.length >= 5 && mentions(street));
  });
  if (mentioned.length === 1) {
    return { companyId: mentioned[0].id, companyName: mentioned[0].name, reason: "Viestissä mainitaan yhtiön nimi tai osoite." };
  }
  return null;
}

// Siirtää tehtävän taloyhtiöön. assigneeId: valittu käsittelijä; puuttuessa uuden yhtiön
// vastuuisännöitsijä tai, jos sellaista ei ole, nykyinen käsittelijä (tunnistamattomalla tehtävällä ei kukaan).
export function moveTicketToCompany(ticket: TicketRow, companyId: string, assigneeId: string | null | undefined, actor: string) {
  const company = db.prepare("SELECT id, name, manager_id FROM companies WHERE id = ?").get(companyId) as
    { id: string; name: string; manager_id: string | null };
  const timestamp = now();
  const email = senderEmail(ticket.id);
  const resident = email
    ? db.prepare(`
        SELECT id, apartment_id FROM residents WHERE company_id = ? AND lower(email) = lower(?) AND erased_at IS NULL
        ORDER BY (moved_out_at IS NOT NULL) LIMIT 1
      `).get(companyId, email) as { id: string; apartment_id: string } | undefined
    : undefined;
  const assignee = assigneeId !== undefined
    ? assigneeId
    : company.manager_id ?? (ticket.company_pending ? null : ticket.assignee_id);
  const fromCompany = ticket.company_pending ? null : (db.prepare("SELECT name FROM companies WHERE id = ?").get(ticket.company_id) as { name: string }).name;

  db.transaction(() => {
    const { next } = db.prepare("SELECT COALESCE(MAX(ticket_number), 0) + 1 AS next FROM tickets WHERE company_id = ?").get(companyId) as { next: number };
    db.prepare(`
      UPDATE tickets SET company_id = ?, company_pending = 0, ticket_number = ?, resident_id = ?, apartment_id = ?,
        assignee_id = ?, updated_at = ?,
        -- Edellisen yhtiön oma postitili ei enää ole tehtävän vastaustili.
        mail_account_id = CASE WHEN mail_account_id = ? THEN NULL ELSE mail_account_id END
      WHERE id = ?
    `).run(companyId, next, resident?.id ?? null, resident?.apartment_id ?? null, assignee, timestamp, ticket.company_id, ticket.id);
    // Muiden yhtiöiden asukkaat eivät ole tämän tehtävän ilmoittajia.
    db.prepare(`
      DELETE FROM ticket_reporters WHERE ticket_id = ? AND resident_id IN (SELECT id FROM residents WHERE company_id != ?)
    `).run(ticket.id, companyId);
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), ticket.id, actor, ticket.company_pending ? "company_assigned" : "company_changed",
      JSON.stringify({ from: fromCompany, to: company.name, previous_number: ticket.ticket_number, number: next }), timestamp
    );
  })();
}
