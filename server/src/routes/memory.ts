import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext, getAuthorizedTicket, visibleCompanyIds } from "../access.js";
import { requireManager } from "../auth.js";
import { db } from "../db.js";
import { deleteEmbedding } from "../embedding.js";
import { RESOLUTION_MAX, setResolution, ticketHistory, trends } from "../history.js";
import { isTopic } from "../incidents.js";
import { type MemoryNote, MemoryUnavailableError, proposeCompanyMemory } from "../memory.js";
import { SENDER_TYPES, setSenderType } from "../sender-types.js";
import { confirmTargetApartment, mergeSuggestion, mergeTickets, targetHistory } from "../ticket-links.js";
import { id, now } from "../util.js";

export const memoryRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Vikahistoria, trendit ja taloyhtiön muisti (ks. history.ts ja memory.ts).
// ---------------------------------------------------------------------------------------------

// Mikä ratkaisi asian. Voidaan kirjata sulkemisen yhteydessä tai myöhemmin tehtävältä.
memoryRouter.put("/tickets/:id/resolution", (req, res) => {
  const parsed = z.object({ resolution: z.string().max(RESOLUTION_MAX) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: `Kirjoita ratkaisu enintään ${RESOLUTION_MAX} merkillä.` });
  if (!getAuthorizedTicket(req.params.id)) return res.status(404).json({ error: "Ticket not found" });
  setResolution(req.params.id, parsed.data.resolution, res.locals.user?.name ?? "Isännöitsijä");
  res.json({ ok: true });
});

memoryRouter.get("/tickets/:id/history", (req, res) => {
  if (!getAuthorizedTicket(req.params.id)) return res.status(404).json({ error: "Ticket not found" });
  // Kohdeasunnon häiriöhistoria kaikilta ilmoittajilta (vain henkilökunta; tämä reitti ei ole asukkaille).
  res.json({ ...ticketHistory(req.params.id), target: targetHistory(req.params.id) });
});

// Yhdistämisehdotus: saman asukkaan avoin samanaiheinen tehtävä 14 päivän sisällä.
memoryRouter.get("/tickets/:id/merge-suggestion", async (req, res) => {
  if (!getAuthorizedTicket(req.params.id)) return res.status(404).json({ error: "Ticket not found" });
  const candidate = await mergeSuggestion(req.params.id);
  res.json({ candidate: candidate && getAuthorizedTicket(candidate.id)
    ? { id: candidate.id, ticketNumber: candidate.ticket_number, subject: candidate.subject, createdAt: candidate.created_at }
    : null });
});

// Liittää tehtävän aiempaan tehtävään (käsittelijän päätös, ei automaattinen).
memoryRouter.post("/tickets/:id/merge", (req, res) => {
  const parsed = z.object({ intoTicketId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valitse tehtävä, johon yhdistetään." });
  const source = getAuthorizedTicket(req.params.id) as { id: string; company_id: string; merged_into?: string | null } | null;
  const target = getAuthorizedTicket(parsed.data.intoTicketId) as { id: string; company_id: string; merged_into?: string | null } | null;
  if (!source || !target || source.id === target.id) return res.status(404).json({ error: "Tehtävää ei löytynyt." });
  if (source.company_id !== target.company_id) return res.status(400).json({ error: "Tehtävät ovat eri taloyhtiöistä." });
  if (source.merged_into || target.merged_into) return res.status(409).json({ error: "Tehtävä on jo yhdistetty." });
  mergeTickets(source.id, target.id, res.locals.user?.name ?? "Käsittelijä");
  res.json({ ok: true, ticketId: target.id });
});

// Kohdeasunnon vahvistus (häiriö- ja turvallisuusilmoitukset).
memoryRouter.put("/tickets/:id/target-apartment", (req, res) => {
  const ticket = getAuthorizedTicket(req.params.id) as { id: string; company_id: string } | null;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  const parsed = z.object({ apartmentId: z.string().nullable() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valitse asunto." });
  if (parsed.data.apartmentId && !db.prepare("SELECT 1 FROM apartments WHERE id = ? AND company_id = ?").get(parsed.data.apartmentId, ticket.company_id)) {
    return res.status(400).json({ error: "Asunto ei kuulu tehtävän taloyhtiöön." });
  }
  confirmTargetApartment(ticket.id, parsed.data.apartmentId, res.locals.user?.name ?? "Käsittelijä");
  res.json({ ok: true });
});

// Käsittelijä korjaa lähettäjätyypin (AI:n tai domainlistan arvio).
memoryRouter.put("/tickets/:id/sender-type", (req, res) => {
  const ticket = getAuthorizedTicket(req.params.id) as { id: string } | null;
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  const parsed = z.object({ senderType: z.enum(SENDER_TYPES) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valitse lähettäjän tyyppi." });
  setSenderType(ticket.id, parsed.data.senderType, res.locals.user?.name ?? "Käsittelijä");
  res.json({ ok: true });
});

memoryRouter.get("/reports/trends", (req, res) => {
  const months = [3, 6, 12, 24].includes(Number(req.query.months)) ? Number(req.query.months) : 12;
  const requested = typeof req.query.companyId === "string" && req.query.companyId !== "all" ? req.query.companyId : null;
  const companyIds = requested ? [companyIdFromContext(requested)].filter((value): value is string => Boolean(value)) : visibleCompanyIds();
  if (requested && !companyIds.length) return res.status(403).json({ error: "Company not authorized" });
  res.json(trends(companyIds, months));
});

const view = (row: MemoryNote) => ({
  id: row.id, companyId: row.company_id, topic: row.topic, stairwell: row.stairwell, text: row.text,
  sources: (JSON.parse(row.sources || "[]") as string[]).map(ticketId => {
    const ticket = db.prepare("SELECT id, ticket_number, subject, sensitive FROM tickets WHERE id = ?").get(ticketId) as
      { id: string; ticket_number: number | null; subject: string; sensitive: number } | undefined;
    return ticket ? { id: ticket.id, ticketNumber: ticket.ticket_number, subject: ticket.sensitive ? "Arkaluonteinen tehtävä" : ticket.subject } : null;
  }).filter(Boolean),
  status: row.status, validUntil: row.valid_until, origin: row.origin, createdAt: row.created_at,
  decidedBy: row.decided_by, decidedAt: row.decided_at, updatedAt: row.updated_at
});

memoryRouter.get("/companies/:companyId/memory", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const rows = db.prepare(`
    SELECT * FROM company_memory WHERE company_id = ? AND (status != 'rejected' OR decided_at >= ?)
    ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, updated_at DESC
  `).all(companyId, new Date(Date.now() - 30 * 86_400_000).toISOString()) as MemoryNote[];
  const company = db.prepare("SELECT memory_scanned_at FROM companies WHERE id = ?").get(companyId) as { memory_scanned_at: string | null };
  // Uudet ratkaistut tehtävät edellisen haun jälkeen: kertoo, kannattaako ehdotuksia hakea.
  const since = company.memory_scanned_at ?? new Date(Date.now() - 180 * 86_400_000).toISOString();
  const pending = (db.prepare(`
    SELECT COUNT(*) AS count FROM tickets WHERE company_id = ? AND resolution IS NOT NULL AND sensitive = 0 AND resolution_at >= ?
  `).get(companyId, since) as { count: number }).count + (db.prepare(`
    SELECT COUNT(*) AS count FROM incidents WHERE company_id = ? AND resolution IS NOT NULL AND handled_at >= ?
  `).get(companyId, since) as { count: number }).count;
  res.json({ notes: rows.map(view), scannedAt: company.memory_scanned_at, newCases: pending });
});

memoryRouter.post("/companies/:companyId/memory/propose", requireManager, async (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  try {
    res.json(await proposeCompanyMemory(companyId));
  } catch (error: any) {
    if (error instanceof MemoryUnavailableError) return res.status(error.status).json({ error: error.message });
    console.error("Muistiehdotusten haku epäonnistui:", error?.message ?? error);
    res.status(502).json({ error: "Ehdotusten haku epäonnistui. Yritä uudelleen." });
  }
});

const noteSchema = z.object({
  text: z.string().trim().min(5).max(500),
  topic: z.string().nullable().refine(topic => topic === null || isTopic(topic)),
  stairwell: z.string().trim().toUpperCase().max(3).regex(/^[A-ZÅÄÖ]*$/),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()
});

// Isännöitsijän itse kirjoittama tieto hyväksytään suoraan.
memoryRouter.post("/companies/:companyId/memory", requireManager, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita tieto (5–500 merkkiä) ja tarkista porras." });
  const actor = res.locals.user?.name ?? "Isännöitsijä";
  const noteId = id("memory");
  db.prepare(`
    INSERT INTO company_memory (id, company_id, topic, stairwell, text, sources, status, valid_until, origin, created_at, decided_by, decided_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '[]', 'approved', ?, 'manual', ?, ?, ?, ?)
  `).run(noteId, companyId, parsed.data.topic, parsed.data.stairwell, parsed.data.text, parsed.data.validUntil, now(), actor, now(), now());
  res.status(201).json(view(db.prepare("SELECT * FROM company_memory WHERE id = ?").get(noteId) as MemoryNote));
});

function loadNote(noteId: string) {
  const note = db.prepare("SELECT * FROM company_memory WHERE id = ?").get(noteId) as MemoryNote | undefined;
  return note && companyIdFromContext(note.company_id) ? note : null;
}

// Hyväksyntä, hylkäys ja muokkaus. Muokattu ehdotus hyväksytään samalla.
memoryRouter.put("/memory/:id", requireManager, (req, res) => {
  const note = loadNote(req.params.id);
  if (!note) return res.status(404).json({ error: "Tietoa ei löytynyt." });
  const parsed = noteSchema.extend({ status: z.enum(["approved", "rejected"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita tieto (5–500 merkkiä) ja tarkista porras." });
  const actor = res.locals.user?.name ?? "Isännöitsijä";
  db.transaction(() => {
    db.prepare(`
      UPDATE company_memory SET text = ?, topic = ?, stairwell = ?, valid_until = ?, status = ?, decided_by = ?, decided_at = ?, updated_at = ?
      WHERE id = ?
    `).run(parsed.data.text, parsed.data.topic, parsed.data.stairwell, parsed.data.validUntil, parsed.data.status, actor, now(), now(), note.id);
    // Hylätyn tiedon vektori poistetaan; hyväksytyn muuttunut teksti lasketaan taustalla uudelleen.
    if (parsed.data.status !== "approved") deleteEmbedding("memory", note.id);
  })();
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), null, actor, `memory_${parsed.data.status}`, JSON.stringify({ memory: note.id, company: note.company_id }), now()
  );
  res.json(view(loadNote(note.id)!));
});

memoryRouter.delete("/memory/:id", requireManager, (req, res) => {
  const note = loadNote(req.params.id);
  if (!note) return res.status(404).json({ error: "Tietoa ei löytynyt." });
  db.transaction(() => {
    db.prepare("DELETE FROM company_memory WHERE id = ?").run(note.id);
    deleteEmbedding("memory", note.id);
  })();
  res.json({ ok: true });
});
