import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext, visibleCompanyIds } from "../access.js";
import { aiAvailable, interpretIncident, type IncidentInterpretation } from "../ai.js";
import { aiBudgetExhausted } from "../ai-budget.js";
import { withAiLog } from "../ai-log.js";
import { db } from "../db.js";
import {
  drafts, type Incident, incidentTickets, localSummary, processIncidents, replyFromIncident, TOPIC_RULES, type TopicKey
} from "../incidents.js";
import { RESOLUTION_MAX, setResolution, topicHistoryForAi } from "../history.js";
import { selectKnowledgeChunks } from "../knowledge-chunks.js";
import { memoryForAi } from "../memory.js";
import { ACTIVE_RESIDENT, helsinkiParts, id, now, stairwellOf } from "../util.js";

export const incidentsRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Mahdolliset yhteiset viat (ks. incidents.ts): päätösjonon lista, poikkeaman tiedot ja toiminnot.
// Toiminnot koskevat kaikkia poikkeamaan liitettyjä ilmoituksia kerralla.
// ---------------------------------------------------------------------------------------------

const ACTIVE_STATUSES = ["open", "ordered"];

function loadIncident(incidentId: string): Incident | null {
  const incident = db.prepare("SELECT * FROM incidents WHERE id = ?").get(incidentId) as Incident | undefined;
  return incident && companyIdFromContext(incident.company_id) ? incident : null;
}

function parseAi(incident: Incident): IncidentInterpretation | null {
  if (!incident.ai_summary) return null;
  try {
    return JSON.parse(incident.ai_summary) as IncidentInterpretation;
  } catch {
    return null;
  }
}

function view(incident: Incident) {
  const tickets = incidentTickets(incident.id);
  const company = db.prepare("SELECT name FROM companies WHERE id = ?").get(incident.company_id) as { name: string } | undefined;
  return {
    id: incident.id,
    companyId: incident.company_id,
    companyName: company?.name ?? "",
    topic: incident.topic,
    topicLabel: TOPIC_RULES[incident.topic as TopicKey]?.label ?? incident.topic,
    stairwell: incident.stairwell,
    status: incident.status,
    firstReportAt: incident.first_report_at,
    lastReportAt: incident.last_report_at,
    createdAt: incident.created_at,
    summary: localSummary(incident, tickets),
    ai: parseAi(incident),
    aiAt: incident.ai_summary_at,
    autoReply: Boolean(incident.auto_reply),
    replyMessage: incident.reply_message,
    announcedAt: incident.announced_at,
    orderedAt: incident.ordered_at,
    handledBy: incident.handled_by,
    handledAt: incident.handled_at,
    resolution: incident.resolution,
    drafts: drafts(incident, tickets),
    reporters: new Set(tickets.map(ticket => ticket.apartment_number ?? ticket.resident_name ?? ticket.id)).size,
    // Arkaluonteisen tehtävän otsikkoa ei näytetä poikkeaman listassa.
    tickets: tickets.map(ticket => ({
      id: ticket.id,
      ticketNumber: ticket.ticket_number,
      subject: ticket.sensitive ? "Arkaluonteinen tehtävä" : ticket.subject,
      status: ticket.status,
      createdAt: ticket.created_at,
      apartmentNumber: ticket.apartment_number,
      stairwell: stairwellOf(ticket.apartment_number, ticket.staircase),
      residentName: ticket.sensitive ? null : ticket.resident_name
    }))
  };
}

// Avoimet poikkeamat ja viimeisen viikon käsitellyt käyttäjän näkemistä taloyhtiöistä.
incidentsRouter.get("/incidents", (req, res) => {
  const companies = visibleCompanyIds();
  if (!companies.length) return res.json([]);
  const recent = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const all = req.query.all === "1";
  const rows = db.prepare(`
    SELECT * FROM incidents
    WHERE company_id IN (${companies.map(() => "?").join(", ")})
      AND (status IN ('open', 'ordered') ${all ? "OR updated_at >= ?" : ""})
    ORDER BY CASE WHEN status IN ('open', 'ordered') THEN 0 ELSE 1 END, last_report_at DESC
  `).all(...companies, ...(all ? [recent] : [])) as Incident[];
  res.json(rows.map(view));
});

incidentsRouter.get("/incidents/:id", (req, res) => {
  const incident = loadIncident(req.params.id);
  if (!incident) return res.status(404).json({ error: "Poikkeamaa ei löytynyt." });
  res.json(view(incident));
});

// Tehtävän poikkeama (tehtäväsivun ilmoitusta varten).
incidentsRouter.get("/tickets/:id/incident", (req, res) => {
  const row = db.prepare("SELECT incident_id FROM incident_tickets WHERE ticket_id = ?").get(req.params.id) as { incident_id: string } | undefined;
  const incident = row ? loadIncident(row.incident_id) : null;
  res.json(incident ? { id: incident.id, topic: incident.topic, topicLabel: TOPIC_RULES[incident.topic as TopicKey]?.label ?? incident.topic,
    stairwell: incident.stairwell, status: incident.status, reporters: view(incident).reporters } : null);
});

function setStatus(incident: Incident, status: string, actor: string, extra: "ordered_at" | "announced_at" | null = null) {
  const timestamp = now();
  const handled = status === "resolved" || status === "dismissed";
  db.prepare(`
    UPDATE incidents SET status = ?, updated_at = ?,
      handled_by = CASE WHEN ? THEN ? ELSE handled_by END, handled_at = CASE WHEN ? THEN ? ELSE handled_at END
      ${extra ? `, ${extra} = ?` : ""}
    WHERE id = ?
  `).run(status, timestamp, handled ? 1 : 0, actor, handled ? 1 : 0, timestamp, ...(extra ? [timestamp] : []), incident.id);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), null, actor, `incident_${status}`, JSON.stringify({ incident: incident.id, topic: incident.topic }), timestamp
  );
}

// Ei yhteinen vika: poikkeama suljetaan, ilmoitukset jäävät ennalleen omina tehtävinään.
incidentsRouter.post("/incidents/:id/dismiss", (req, res) => {
  const incident = loadIncident(req.params.id);
  if (!incident) return res.status(404).json({ error: "Poikkeamaa ei löytynyt." });
  setStatus(incident, "dismissed", res.locals.user?.name ?? "Isännöitsijä");
  res.json(view(loadIncident(incident.id)!));
});

// Työtilaus tehtiin tehtävän työtilauksena (ensimmäinen ilmoitus); poikkeama odottaa korjausta.
incidentsRouter.post("/incidents/:id/ordered", (req, res) => {
  const incident = loadIncident(req.params.id);
  if (!incident) return res.status(404).json({ error: "Poikkeamaa ei löytynyt." });
  setStatus(incident, incident.status === "open" ? "ordered" : incident.status, res.locals.user?.name ?? "Isännöitsijä", "ordered_at");
  res.json(view(loadIncident(incident.id)!));
});

incidentsRouter.post("/incidents/:id/announced", (req, res) => {
  const incident = loadIncident(req.params.id);
  if (!incident) return res.status(404).json({ error: "Poikkeamaa ei löytynyt." });
  db.prepare("UPDATE incidents SET announced_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), incident.id);
  res.json(view(loadIncident(incident.id)!));
});

// Vastaus asukkaille: viesti tallennetaan, ja sillä vastataan heti avoimiin ilmoituksiin (replyNow) ja
// halutessa automaattisesti uusiin samanaiheisiin ilmoituksiin (autoReply).
incidentsRouter.put("/incidents/:id/reply", async (req, res) => {
  const parsed = z.object({
    message: z.string().trim().min(10).max(4000),
    autoReply: z.boolean(),
    replyNow: z.boolean().default(false)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita asukkaille vastaus." });
  const incident = loadIncident(req.params.id);
  if (!incident) return res.status(404).json({ error: "Poikkeamaa ei löytynyt." });
  if (!ACTIVE_STATUSES.includes(incident.status)) return res.status(409).json({ error: "Poikkeama on jo käsitelty." });

  db.prepare("UPDATE incidents SET reply_message = ?, auto_reply = ?, updated_at = ? WHERE id = ?")
    .run(parsed.data.message, parsed.data.autoReply ? 1 : 0, now(), incident.id);
  const actor = res.locals.user?.name ?? "Isännöitsijä";
  const failed: string[] = [];
  let replied = 0;
  if (parsed.data.replyNow) {
    for (const ticket of incidentTickets(incident.id)) {
      // Vastataan vain ilmoituksiin, joihin toimisto ei ole vielä vastannut.
      const answered = db.prepare(`
        SELECT 1 FROM messages WHERE ticket_id = ? AND direction = 'outbound' AND channel != 'contractor' LIMIT 1
      `).get(ticket.id);
      if (ticket.status === "closed" || answered) continue;
      const result = await replyFromIncident(ticket.id, `${parsed.data.message}\n\nYstävällisin terveisin\n${actor}`, actor);
      if (!result.ok) {
        failed.push(`#${ticket.ticket_number ?? ""}: ${result.error}`);
        continue;
      }
      db.prepare("UPDATE tickets SET status = 'waiting_third_party', updated_at = ? WHERE id = ?").run(now(), ticket.id);
      db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), ticket.id, actor, "incident_replied", JSON.stringify({ incident: incident.id }), now());
      replied++;
    }
  }
  res.json({ incident: view(loadIncident(incident.id)!), replied, failed });
});

// Vika korjattu: kaikkiin avoimiin ilmoituksiin lähtee sama viesti ja ne suljetaan.
incidentsRouter.post("/incidents/:id/resolve", async (req, res) => {
  const parsed = z.object({
    message: z.string().trim().max(4000).default(""),
    // Mikä ratkaisi vian; kirjataan myös ilmoituksille, joilla ei ole omaa ratkaisua.
    resolution: z.string().trim().max(RESOLUTION_MAX).default("")
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista viesti." });
  const incident = loadIncident(req.params.id);
  if (!incident) return res.status(404).json({ error: "Poikkeamaa ei löytynyt." });
  if (!ACTIVE_STATUSES.includes(incident.status)) return res.status(409).json({ error: "Poikkeama on jo käsitelty." });

  const actor = res.locals.user?.name ?? "Isännöitsijä";
  const failed: string[] = [];
  let closed = 0;
  for (const ticket of incidentTickets(incident.id)) {
    if (ticket.status === "closed") continue;
    if (parsed.data.message) {
      const result = await replyFromIncident(ticket.id, `${parsed.data.message}\n\nYstävällisin terveisin\n${actor}`, actor);
      // Ilmoitus, johon vastaus ei mennyt perille, jää auki käsittelijälle.
      if (!result.ok) {
        failed.push(`#${ticket.ticket_number ?? ""}: ${result.error}`);
        continue;
      }
    }
    const timestamp = now();
    db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, ticket.id);
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), ticket.id, actor, "incident_closed", JSON.stringify({ incident: incident.id, replied: Boolean(parsed.data.message) }), timestamp
    );
    closed++;
  }
  if (parsed.data.resolution) {
    db.prepare("UPDATE incidents SET resolution = ? WHERE id = ?").run(parsed.data.resolution, incident.id);
    for (const ticket of incidentTickets(incident.id)) {
      const current = db.prepare("SELECT resolution FROM tickets WHERE id = ?").get(ticket.id) as { resolution: string | null };
      if (!current.resolution) setResolution(ticket.id, parsed.data.resolution, actor);
    }
  }
  setStatus(incident, "resolved", actor);
  res.json({ incident: view(loadIncident(incident.id)!), closed, failed });
});

// Ilmoitus ei kuulu poikkeamaan: se irrotetaan, eikä sitä liitetä uudelleen.
incidentsRouter.delete("/incidents/:id/tickets/:ticketId", (req, res) => {
  const incident = loadIncident(req.params.id);
  if (!incident) return res.status(404).json({ error: "Poikkeamaa ei löytynyt." });
  const removed = db.prepare("DELETE FROM incident_tickets WHERE incident_id = ? AND ticket_id = ?").run(incident.id, req.params.ticketId).changes;
  if (!removed) return res.status(404).json({ error: "Ilmoitus ei kuulu tähän poikkeamaan." });
  // Irrotettu tehtävä merkitään käsin muuksi aiheeksi, jotta tunnistus ei liitä sitä takaisin.
  db.prepare("UPDATE tickets SET topic = 'other', topic_source = 'manual' WHERE id = ?").run(req.params.ticketId);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), req.params.ticketId, res.locals.user?.name ?? "Isännöitsijä", "incident_unlinked", JSON.stringify({ incident: incident.id }), now()
  );
  res.json(view(loadIncident(incident.id)!));
});

// AI-tulkinta pyydetään poikkeamalta painikkeesta, jotta AI-kuluja syntyy vain tarvittaessa.
incidentsRouter.post("/incidents/:id/interpret", async (req, res) => {
  const incident = loadIncident(req.params.id);
  if (!incident) return res.status(404).json({ error: "Poikkeamaa ei löytynyt." });
  if (!aiAvailable() || aiBudgetExhausted()) return res.status(503).json({ error: "AI ei ole juuri nyt käytettävissä." });

  const company = db.prepare("SELECT name FROM companies WHERE id = ?").get(incident.company_id) as { name: string };
  const topicLabel = TOPIC_RULES[incident.topic as TopicKey]?.label ?? incident.topic;
  const reports = (db.prepare(`
    SELECT t.created_at, t.subject, t.sensitive, a.apartment_number, a.staircase,
           (SELECT m.body FROM messages m WHERE m.ticket_id = t.id AND m.direction = 'inbound' ORDER BY m.created_at LIMIT 1) AS body
    FROM incident_tickets it JOIN tickets t ON t.id = it.ticket_id LEFT JOIN apartments a ON a.id = t.apartment_id
    WHERE it.incident_id = ? ORDER BY t.created_at
  `).all(incident.id) as { created_at: string; subject: string; sensitive: number; apartment_number: string | null; staircase: string | null; body: string | null }[])
    .map(row => {
      const { day, hour, minute } = helsinkiParts(row.created_at);
      return {
        time: `${day} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        apartment: row.apartment_number ?? "",
        stairwell: stairwellOf(row.apartment_number, row.staircase),
        // Arkaluonteinen tehtävä lasketaan mukaan, mutta sen tekstiä ei lähetetä AI:lle.
        text: row.sensitive ? "(content not shown: sensitive)" : `${row.subject}\n${row.body ?? ""}`
      };
    });
  const stairs = new Map<string, number>();
  for (const row of db.prepare(`
    SELECT DISTINCT a.id, a.apartment_number, a.staircase FROM apartments a JOIN residents r ON r.apartment_id = a.id
    WHERE a.company_id = ? AND ${ACTIVE_RESIDENT}
  `).all(incident.company_id) as { apartment_number: string; staircase: string | null }[]) {
    const stair = stairwellOf(row.apartment_number, row.staircase);
    stairs.set(stair, (stairs.get(stair) ?? 0) + 1);
  }
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const workOrders = (db.prepare(`
    SELECT description, status, ordered_at FROM work_orders WHERE company_id = ? AND (status = 'ordered' OR ordered_at >= ?) ORDER BY ordered_at DESC LIMIT 10
  `).all(incident.company_id, since) as { description: string; status: string; ordered_at: string }[])
    .map(row => `${row.ordered_at.slice(0, 10)} (${row.status === "ordered" ? "open" : "done"}): ${row.description}`);
  const announcements = (db.prepare(`
    SELECT title, body, stairwell, created_at FROM announcements WHERE company_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 5
  `).all(incident.company_id, since) as { title: string; body: string; stairwell: string; created_at: string }[])
    .map(row => `${row.created_at.slice(0, 10)}${row.stairwell ? ` (staircase ${row.stairwell})` : ""}: ${row.title} – ${row.body}`);
  const chunks = selectKnowledgeChunks(incident.company_id, `${topicLabel} ${reports.map(report => report.text).join(" ").slice(0, 2000)}`, 4);

  try {
    const { result } = await withAiLog(undefined, () => interpretIncident({
      company: company.name, topic: topicLabel, stairwell: incident.stairwell, reports,
      stairwells: [...stairs.entries()].map(([stairwell, apartments]) => ({ stairwell, apartments })).sort((a, b) => a.stairwell.localeCompare(b.stairwell)),
      workOrders, announcements,
      history: topicHistoryForAi(incident.company_id, incident.topic, incident.id),
      memory: memoryForAi(incident.company_id, { topic: incident.topic, stairwell: incident.stairwell })
    }, chunks));
    db.prepare("UPDATE incidents SET ai_summary = ?, ai_summary_at = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(result), now(), now(), incident.id);
    res.json(view(loadIncident(incident.id)!));
  } catch (error: any) {
    console.error("Poikkeaman AI-tulkinta epäonnistui:", error?.message ?? error);
    res.status(502).json({ error: "AI-tulkinta epäonnistui. Yritä uudelleen." });
  }
});

// Tunnistuksen voi ajaa heti (esim. testauksessa) odottamatta taustan seuraavaa ajoa.
incidentsRouter.post("/incidents/detect", async (_req, res) => {
  await processIncidents();
  res.json({ ok: true });
});
