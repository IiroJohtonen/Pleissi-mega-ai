import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { aiAvailable, analyzeRecurringTopics, type RecurringTopic, type TopicTicket } from "../ai.js";
import { db } from "../db.js";
import { now } from "../util.js";

export const reportsRouter: Router = express.Router();

const REPORT_PERIODS = ["week", "month", "year"] as const;
const MAX_TOPIC_TICKETS = 400;

function storedTopicReport(companyId: string, period: string) {
  const row = db.prepare(
    "SELECT generated_at, generated_by, ticket_count, topics FROM topic_reports WHERE company_id = ? AND period = ?"
  ).get(companyId, period) as
    | { generated_at: string; generated_by: string; ticket_count: number; topics: string }
    | undefined;
  return row
    ? {
        generatedAt: row.generated_at,
        generatedBy: row.generated_by,
        ticketCount: row.ticket_count,
        topics: JSON.parse(row.topics)
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
    return res.status(503).json({ error: "AI ei ole käytössä. Lisää ANTHROPIC_API_KEY palvelimen .env-tiedostoon." });
  }

  const tickets = db.prepare(`
    SELECT t.id, t.ticket_number, t.type, t.subject, t.summary,
           (SELECT m.body FROM messages m
            WHERE m.ticket_id = t.id AND m.direction = 'outbound'
            ORDER BY m.created_at LIMIT 1) AS reply
    FROM tickets t
    WHERE t.company_id = ? AND t.created_at >= ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(companyId, parsed.data.since, MAX_TOPIC_TICKETS) as TopicTicket[];

  let topics: RecurringTopic[] = [];
  if (tickets.length >= 2) {
    try {
      topics = await analyzeRecurringTopics(tickets);
    } catch (error) {
      console.error("Toistuvien aiheiden analyysi epäonnistui:", error);
      return res.status(502).json({ error: "AI-analyysi epäonnistui. Yritä uudelleen." });
    }
  }

  db.prepare(`
    INSERT OR REPLACE INTO topic_reports
      (company_id, period, generated_at, generated_by, ticket_count, topics)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(companyId, parsed.data.period, now(), res.locals.user?.name ?? "Tuntematon", tickets.length, JSON.stringify(topics));

  res.json({ report: storedTopicReport(companyId, parsed.data.period), aiAvailable: true });
});
