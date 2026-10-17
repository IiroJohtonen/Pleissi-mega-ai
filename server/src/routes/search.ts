import express, { type Router } from "express";
import { z } from "zod";
import { canSeeSensitiveTicket, visibleCompanyIds } from "../access.js";
import { db } from "../db.js";
import { ACTIVE_RESIDENT } from "../util.js";

export const searchRouter: Router = express.Router();

const LIMIT = 30;

// Vertailu ilman kirjainkokoa; toLocaleLowerCase käsittelee myös ä:n ja ö:n, toisin kuin SQLiten lower().
const fold = (text: string) => text.toLocaleLowerCase("fi");

// Hakusanat: välilyönnein erotetut sanat, jotka kaikkien pitää löytyä. #123 etsii tehtävänumeroa.
function searchTerms(query: string) {
  return [...new Set(fold(query).split(/\s+/).map(word => word.trim()).filter(Boolean))];
}

function matches(haystack: string, terms: string[]) {
  const text = fold(haystack);
  return terms.every(term => text.includes(term));
}

// Lyhyt ote ensimmäisen osuman ympäriltä, jotta tuloksesta näkee, mistä haku löytyi.
function snippet(text: string, terms: string[], width = 70) {
  const plain = text.replace(/\s+/g, " ").trim();
  const folded = fold(plain);
  const at = Math.min(...terms.map(term => folded.indexOf(term)).filter(index => index >= 0));
  if (!Number.isFinite(at)) return plain.slice(0, width * 2);
  const start = Math.max(0, at - width);
  const end = Math.min(plain.length, at + width);
  return `${start > 0 ? "…" : ""}${plain.slice(start, end)}${end < plain.length ? "…" : ""}`;
}

// Hakee kaikista käyttäjälle näkyvien yhtiöiden tiedoista: tehtävät (viestit, muistiinpanot ja
// työtilaukset mukaan lukien), dokumentaatio, asukkaat ja tiedotteet.
searchRouter.get("/search", (req, res) => {
  const parsed = z.object({ q: z.string().trim().min(1).max(200) }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita hakusana." });

  const companyIds = visibleCompanyIds();
  const empty = {
    query: parsed.data.q, tickets: [], ticketCount: 0, knowledge: [], knowledgeCount: 0,
    residents: [], residentCount: 0, announcements: [], announcementCount: 0
  };
  if (companyIds.length === 0) return res.json(empty);
  const inCompanies = `(${companyIds.map(() => "?").join(", ")})`;

  // Pelkkä numero tai #numero etsii tehtävää numerolla; muuten numero on tavallinen hakusana.
  const numberQuery = parsed.data.q.match(/^#\s*(\d+)$/) ?? parsed.data.q.match(/^(\d+)$/);
  const ticketNumber = numberQuery ? Number(numberQuery[1]) : null;
  const terms = searchTerms(parsed.data.q.replace(/^#\s*(?=\d+$)/, ""));

  const tickets = (db.prepare(`
    SELECT t.id, t.ticket_number, t.subject, t.status, t.priority, t.created_at, t.company_id, c.name AS company_name,
           t.sensitive, t.assignee_id,
           r.name AS resident_name, a.apartment_number,
           t.subject || ' ' || t.summary || ' ' || COALESCE(r.name, '') || ' ' || COALESCE(r.email, '') || ' '
             || COALESCE(a.apartment_number, '') || ' ' || COALESCE(a.address, '') || ' ' || t.type || ' '
             || COALESCE((SELECT group_concat(m.sender || ' ' || m.body, ' ') FROM messages m WHERE m.ticket_id = t.id), '') || ' '
             || COALESCE((SELECT group_concat(n.body, ' ') FROM ticket_notes n WHERE n.ticket_id = t.id), '') || ' '
             || COALESCE((SELECT group_concat(w.contractor_name || ' ' || w.description, ' ') FROM work_orders w WHERE w.ticket_id = t.id), '')
             AS haystack
    FROM tickets t
    JOIN companies c ON c.id = t.company_id
    LEFT JOIN residents r ON r.id = t.resident_id
    LEFT JOIN apartments a ON a.id = t.apartment_id
    WHERE t.company_id IN ${inCompanies}
    ORDER BY t.created_at DESC
  `).all(...companyIds) as (Record<string, unknown> & {
    haystack: string; ticket_number: number | null; company_id: string; sensitive: number; assignee_id: string | null;
  })[])
    // Arkaluonteinen tehtävä ei löydy haulla käyttäjältä, jolta se on rajattu.
    .filter(ticket => canSeeSensitiveTicket(ticket))
    .filter(ticket => (ticketNumber !== null && ticket.ticket_number === ticketNumber) || matches(ticket.haystack, terms))
    // Numerolla löytynyt tehtävä ensin, sitten uusimmat.
    .sort((a, b) => Number(b.ticket_number === ticketNumber) - Number(a.ticket_number === ticketNumber));

  const knowledge = (db.prepare(`
    SELECT k.id, k.title, k.content, k.tags, k.audience, k.company_id, c.name AS company_name
    FROM knowledge k
    JOIN companies c ON c.id = k.company_id
    WHERE k.company_id IN ${inCompanies} AND k.status = 'active'
    ORDER BY k.title
  `).all(...companyIds) as { title: string; content: string; tags: string }[])
    .filter(item => matches(`${item.title} ${item.tags} ${item.content}`, terms));

  const residents = (db.prepare(`
    SELECT r.id, r.name, r.email, a.apartment_number, a.address, r.company_id, c.name AS company_name
    FROM residents r
    JOIN apartments a ON a.id = r.apartment_id
    JOIN companies c ON c.id = r.company_id
    WHERE r.company_id IN ${inCompanies} AND ${ACTIVE_RESIDENT}
    ORDER BY r.name
  `).all(...companyIds) as { name: string; email: string | null; apartment_number: string; address: string }[])
    .filter(resident => matches(`${resident.name} ${resident.email ?? ""} ${resident.apartment_number} ${resident.address}`, terms));

  const announcements = (db.prepare(`
    SELECT n.id, n.title, n.body, n.created_at, n.company_id, c.name AS company_name
    FROM announcements n
    JOIN companies c ON c.id = n.company_id
    WHERE n.company_id IN ${inCompanies}
    ORDER BY n.created_at DESC
  `).all(...companyIds) as { title: string; body: string }[])
    .filter(item => matches(`${item.title} ${item.body}`, terms));

  res.json({
    query: parsed.data.q,
    tickets: tickets.slice(0, LIMIT).map(({ haystack, ...ticket }) => ({ ...ticket, snippet: snippet(haystack, terms) })),
    ticketCount: tickets.length,
    knowledge: knowledge.slice(0, LIMIT).map(({ content, tags, ...item }) => ({ ...item, snippet: snippet(`${content} ${tags}`, terms) })),
    knowledgeCount: knowledge.length,
    residents: residents.slice(0, LIMIT),
    residentCount: residents.length,
    announcements: announcements.slice(0, LIMIT).map(({ body, ...item }) => ({ ...item, snippet: snippet(body, terms) })),
    announcementCount: announcements.length
  });
});
