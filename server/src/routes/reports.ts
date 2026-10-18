import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext, visibleCompanyIds } from "../access.js";
import { aiAvailable, analyzeRecurringTopics, type CoveredTopic, type RecurringTopic, type TopicTicket } from "../ai.js";
import { aiBudgetExhausted } from "../ai-budget.js";
import { db } from "../db.js";
import { isAdmin, type User } from "../auth.js";
import { id, now, TICKET_STATUSES, today } from "../util.js";
import { getKnowledge } from "./knowledge.js";
import { sensitiveMatches } from "../privacy-filter.js";

export const reportsRouter: Router = express.Router();

const REPORT_PERIODS = ["week", "month", "year"] as const;
const MAX_TOPIC_TICKETS = 400;

function storedTopicReport(companyId: string, period: string) {
  const row = db.prepare(
    "SELECT generated_at, generated_by, ticket_count, topics, covered FROM topic_reports WHERE company_id = ? AND period = ?"
  ).get(companyId, period) as
    | { generated_at: string; generated_by: string; ticket_count: number; topics: string; covered: string }
    | undefined;
  return row
    ? {
        generatedAt: row.generated_at,
        generatedBy: row.generated_by,
        ticketCount: row.ticket_count,
        topics: JSON.parse(row.topics),
        covered: JSON.parse(row.covered || "[]")
      }
    : null;
}

// Viimeksi luotu AI-raportti toistuvista aiheista; null, jos jaksolle ei ole vielä luotu raporttia.
reportsRouter.get("/companies/:companyId/reports/topics", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const period = z.enum(REPORT_PERIODS).safeParse(req.query.period);
  if (!period.success) return res.status(400).json({ error: "Tuntematon jakso." });

  res.json({ report: storedTopicReport(companyId, period.data), aiAvailable: aiAvailable() });
});

// Luo tai päivittää toistuvien aiheiden raportin AI:lla jakson tehtävistä.
reportsRouter.post("/companies/:companyId/reports/topics", async (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = z.object({
    period: z.enum(REPORT_PERIODS),
    since: z.iso.datetime()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista jakso." });

  if (!aiAvailable()) {
    return res.status(503).json({
      error: aiBudgetExhausted()
        ? "AI-kulujen kuukausiraja on täynnä. Pääkäyttäjä voi nostaa rajaa asetuksista."
        : "AI ei ole käytössä. Lisää ANTHROPIC_API_KEY palvelimen .env-tiedostoon."
    });
  }

  const tickets = (db.prepare(`
    SELECT t.id, t.ticket_number, t.type, t.subject, t.summary,
           (SELECT m.body FROM messages m
            WHERE m.ticket_id = t.id AND m.direction = 'outbound'
            ORDER BY m.created_at LIMIT 1) AS reply
    FROM tickets t
    WHERE t.company_id = ? AND t.created_at >= ? AND t.sensitive = 0 AND t.company_pending = 0
    ORDER BY created_at DESC
    LIMIT ?
  `).all(companyId, parsed.data.since, MAX_TOPIC_TICKETS) as TopicTicket[])
    // Arkaluonteiset tehtävät eivät mene AI:lle, myöskään merkitsemättömät, joiden teksti osuu sanalistaan.
    .filter(ticket => sensitiveMatches(`${ticket.subject}\n${ticket.summary}`).length === 0);

  let topics: RecurringTopic[] = [];
  let covered: CoveredTopic[] = [];
  if (tickets.length >= 2) {
    try {
      // Mukaan annetaan AI:n käytössä oleva dokumentaatio, jotta jo dokumentoituja aiheita ei ehdoteta uudelleen.
      ({ topics, covered } = await analyzeRecurringTopics(tickets, getKnowledge(companyId)));
    } catch (error) {
      console.error("Toistuvien aiheiden analyysi epäonnistui:", error);
      return res.status(502).json({ error: "AI-analyysi epäonnistui. Yritä uudelleen." });
    }
  }

  db.prepare(`
    INSERT OR REPLACE INTO topic_reports
      (company_id, period, generated_at, generated_by, ticket_count, topics, covered)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    companyId, parsed.data.period, now(), res.locals.user?.name ?? "Tuntematon", tickets.length,
    JSON.stringify(topics), JSON.stringify(covered)
  );

  res.json({ report: storedTopicReport(companyId, parsed.data.period), aiAvailable: true });
});

// ---------------------------------------------------------------------------------------------
// Mittarit ja omat raportit. Raportti lasketaan valitun aikavälin aikana saapuneista tehtävistä
// käyttäjälle näkyvissä yhtiöissä, ryhmiteltynä valitun ominaisuuden mukaan. Mittarit:
//   total = saapuneet, open = vielä kesken, closed = suljetut, answered = vastattu vähintään kerran,
//   overdue = määräaika ylittynyt (kesken ja määräaika mennyt, tai suljettu määräajan jälkeen),
//   avgFirstResponseHours = keskimääräinen aika ensimmäiseen vastaukseen,
//   avgResolutionHours = keskimääräinen aika saapumisesta sulkemiseen.
// ---------------------------------------------------------------------------------------------
export const REPORT_GROUPS = ["company", "type", "status", "priority", "assignee", "channel", "month", "week"] as const;

const reportQuerySchema = z.object({
  companyIds: z.array(z.string()).max(500).optional(),
  from: z.iso.date(),
  // Päättymispäivä mukaan lukien.
  to: z.iso.date(),
  groupBy: z.enum(REPORT_GROUPS).default("company"),
  types: z.array(z.string().max(80)).max(50).optional(),
  statuses: z.array(z.enum(TICKET_STATUSES)).max(10).optional(),
  priorities: z.array(z.string().max(30)).max(10).optional()
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

type ReportTicket = {
  company_id: string; company_name: string; type: string; status: string; priority: string; channel: string;
  assignee_id: string | null; assignee_name: string | null; created_at: string; closed_at: string | null;
  due_date: string | null; first_reply_at: string | null;
};

const HOUR_MS = 60 * 60 * 1000;
const round1 = (value: number) => Math.round(value * 10) / 10;

// Viikon tunniste ISO-viikkona (esim. 2026-W07).
function isoWeek(timestamp: string) {
  const date = new Date(timestamp);
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function groupKey(ticket: ReportTicket, groupBy: ReportQuery["groupBy"]): { key: string; label: string } {
  switch (groupBy) {
    case "company": return { key: ticket.company_id, label: ticket.company_name };
    case "type": return { key: ticket.type, label: ticket.type };
    case "status": return { key: ticket.status, label: ticket.status };
    case "priority": return { key: ticket.priority, label: ticket.priority };
    case "assignee": return { key: ticket.assignee_id ?? "", label: ticket.assignee_name ?? "" };
    case "channel": return { key: ticket.channel, label: ticket.channel };
    case "month": {
      const month = new Date(ticket.created_at).toLocaleDateString("sv-SE").slice(0, 7);
      return { key: month, label: month };
    }
    case "week": {
      const week = isoWeek(ticket.created_at);
      return { key: week, label: week };
    }
  }
}

function summarize(tickets: ReportTicket[], day: string) {
  const replied = tickets.filter(ticket => ticket.first_reply_at);
  const closed = tickets.filter(ticket => ticket.status === "closed");
  const overdue = tickets.filter(ticket => ticket.due_date && (
    ticket.status === "closed"
      ? Boolean(ticket.closed_at) && new Date(ticket.closed_at as string).toLocaleDateString("sv-SE") > ticket.due_date
      : ticket.due_date < day
  ));
  const hours = (list: ReportTicket[], end: (ticket: ReportTicket) => string | null) => {
    const values = list.flatMap(ticket => {
      const ended = end(ticket);
      const diff = ended ? (Date.parse(ended) - Date.parse(ticket.created_at)) / HOUR_MS : NaN;
      return Number.isFinite(diff) && diff >= 0 ? [diff] : [];
    });
    return values.length ? round1(values.reduce((total, value) => total + value, 0) / values.length) : null;
  };
  return {
    total: tickets.length,
    open: tickets.length - closed.length,
    closed: closed.length,
    answered: replied.length,
    overdue: overdue.length,
    avgFirstResponseHours: hours(replied, ticket => ticket.first_reply_at),
    avgResolutionHours: hours(closed, ticket => ticket.closed_at)
  };
}

export function runReport(query: ReportQuery, visible: string[]) {
  const companyIds = query.companyIds?.length ? query.companyIds.filter(companyId => visible.includes(companyId)) : visible;
  const empty = { rows: [], totals: summarize([], today()), companyCount: companyIds.length };
  if (companyIds.length === 0) return empty;

  // Aikaväli paikallisina päivinä: alku päivän alusta, loppu seuraavan päivän alkuun.
  const start = new Date(`${query.from}T00:00:00`);
  const end = new Date(`${query.to}T00:00:00`);
  end.setDate(end.getDate() + 1);

  const filters: string[] = [];
  const params: unknown[] = [...companyIds, start.toISOString(), end.toISOString()];
  for (const [column, values] of [["t.type", query.types], ["t.status", query.statuses], ["t.priority", query.priorities]] as const) {
    if (!values?.length) continue;
    filters.push(`AND ${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  }

  const tickets = db.prepare(`
    SELECT t.company_id, c.name AS company_name, t.type, t.status, t.priority, t.source_channel AS channel,
           t.assignee_id, u.name AS assignee_name, t.created_at, t.closed_at, t.due_date,
           (SELECT MIN(m.created_at) FROM messages m WHERE m.ticket_id = t.id AND m.direction = 'outbound') AS first_reply_at
    FROM tickets t
    JOIN companies c ON c.id = t.company_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.company_id IN (${companyIds.map(() => "?").join(", ")})
      -- Tunnistamattoman yhtiön tehtävä ei vielä kuulu millekään yhtiölle.
      AND t.company_pending = 0
      AND t.created_at >= ? AND t.created_at < ?
      ${filters.join(" ")}
  `).all(...params) as ReportTicket[];

  const day = today();
  const groups = new Map<string, { label: string; tickets: ReportTicket[] }>();
  for (const ticket of tickets) {
    const { key, label } = groupKey(ticket, query.groupBy);
    const group = groups.get(key) ?? { label, tickets: [] };
    group.tickets.push(ticket);
    groups.set(key, group);
  }
  // Aikaryhmät aikajärjestyksessä, muut suurimmasta pienimpään.
  const timeGroup = query.groupBy === "month" || query.groupBy === "week";
  const rows = [...groups.entries()]
    .map(([key, group]) => ({ key, label: group.label, ...summarize(group.tickets, day) }))
    .sort((a, b) => timeGroup ? a.key.localeCompare(b.key) : b.total - a.total || a.label.localeCompare(b.label, "fi"));
  return { rows, totals: summarize(tickets, day), companyCount: companyIds.length };
}

reportsRouter.post("/reports/query", (req, res) => {
  const parsed = reportQuerySchema.safeParse(req.body);
  if (!parsed.success || parsed.data.from > parsed.data.to) return res.status(400).json({ error: "Tarkista raportin aikaväli ja valinnat." });
  res.json(runReport(parsed.data, visibleCompanyIds()));
});

// Tallennetut omat raportit näkyvät koko toimistolle; poistaa ja muokata saa tekijä tai pääkäyttäjä.
db.exec(`
CREATE TABLE IF NOT EXISTS saved_reports (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

const savedReportSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Raportin valinnat: aikaväli suhteellisena (viimeiset N päivää) tai kiinteänä, ryhmittely, suodattimet ja sarakkeet.
  config: z.object({
    range: z.enum(["7d", "30d", "90d", "365d", "month", "lastMonth", "year", "custom"]),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    groupBy: z.enum(REPORT_GROUPS),
    companyIds: z.array(z.string()).max(500).default([]),
    types: z.array(z.string().max(80)).max(50).default([]),
    statuses: z.array(z.enum(TICKET_STATUSES)).max(10).default([]),
    priorities: z.array(z.string().max(30)).max(10).default([]),
    metrics: z.array(z.string().max(40)).min(1).max(10)
  })
});

type SavedReportRow = { id: string; name: string; config: string; created_by: string; created_by_name: string; created_at: string; updated_at: string };
const savedReport = (row: SavedReportRow) => ({
  id: row.id, name: row.name, config: JSON.parse(row.config), createdBy: row.created_by,
  createdByName: row.created_by_name, createdAt: row.created_at, updatedAt: row.updated_at
});

reportsRouter.get("/reports/saved", (_req, res) => {
  res.json((db.prepare("SELECT * FROM saved_reports ORDER BY name COLLATE NOCASE").all() as SavedReportRow[]).map(savedReport));
});

reportsRouter.post("/reports/saved", (req, res) => {
  const parsed = savedReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Anna raportille nimi ja valitse vähintään yksi mittari." });
  const user = res.locals.user as User;
  const reportId = id("report");
  const timestamp = now();
  db.prepare("INSERT INTO saved_reports VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    reportId, parsed.data.name, JSON.stringify(parsed.data.config), user.id, user.name, timestamp, timestamp
  );
  res.status(201).json(savedReport(db.prepare("SELECT * FROM saved_reports WHERE id = ?").get(reportId) as SavedReportRow));
});

function editableReport(res: express.Response, reportId: string): SavedReportRow | null {
  const row = db.prepare("SELECT * FROM saved_reports WHERE id = ?").get(reportId) as SavedReportRow | undefined;
  if (!row) {
    res.status(404).json({ error: "Raporttia ei löytynyt." });
    return null;
  }
  if (row.created_by !== (res.locals.user as User).id && !isAdmin(res)) {
    res.status(403).json({ error: "Vain raportin tekijä tai pääkäyttäjä voi muuttaa raporttia." });
    return null;
  }
  return row;
}

reportsRouter.put("/reports/saved/:id", (req, res) => {
  const parsed = savedReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Anna raportille nimi ja valitse vähintään yksi mittari." });
  const row = editableReport(res, String(req.params.id));
  if (!row) return;
  db.prepare("UPDATE saved_reports SET name = ?, config = ?, updated_at = ? WHERE id = ?")
    .run(parsed.data.name, JSON.stringify(parsed.data.config), now(), row.id);
  res.json(savedReport(db.prepare("SELECT * FROM saved_reports WHERE id = ?").get(row.id) as SavedReportRow));
});

reportsRouter.delete("/reports/saved/:id", (req, res) => {
  const row = editableReport(res, String(req.params.id));
  if (!row) return;
  db.prepare("DELETE FROM saved_reports WHERE id = ?").run(row.id);
  res.json({ ok: true });
});
