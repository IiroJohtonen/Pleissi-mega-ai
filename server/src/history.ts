import { db } from "./db.js";
import { TOPIC_RULES, type TopicKey } from "./incidents.js";
import { helsinkiParts, id, now, stairwellOf } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Taloyhtiön vikahistoria ja trendit. Kaikki on laskentaa tehtävistä, yhteisistä vioista ja
// työtilauksista; AI:ta ei käytetä. Sama historia annetaan AI:lle taustaksi yhteisen vian tulkinnassa.
// ---------------------------------------------------------------------------------------------

export const RESOLUTION_MAX = 500;

// Tallentaa, mikä ratkaisi asian. Tyhjä teksti poistaa merkinnän.
export function setResolution(ticketId: string, text: string, actor: string) {
  const resolution = text.trim().slice(0, RESOLUTION_MAX);
  const timestamp = now();
  db.prepare("UPDATE tickets SET resolution = ?, resolution_by = ?, resolution_at = ? WHERE id = ?")
    .run(resolution || null, resolution ? actor : null, resolution ? timestamp : null, ticketId);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), ticketId, actor, "resolution_set", JSON.stringify({ resolution: resolution || null }), timestamp
  );
}

// Tehtävän asunnon porras ("B"), tyhjä jos asuntoa tai porrasta ei ole.
export function ticketStairwell(ticketId: string) {
  const row = db.prepare(`
    SELECT a.apartment_number, a.staircase FROM tickets t LEFT JOIN apartments a ON a.id = t.apartment_id WHERE t.id = ?
  `).get(ticketId) as { apartment_number: string | null; staircase: string | null } | undefined;
  return row ? stairwellOf(row.apartment_number, row.staircase) : "";
}

type HistoryRow = {
  id: string; ticket_number: number | null; subject: string; topic: string | null; status: string; created_at: string;
  closed_at: string | null; resolution: string | null; sensitive: number; apartment_number: string | null; staircase: string | null;
};

export type HistoryItem = {
  id: string; ticketNumber: number | null; subject: string; topic: string | null; status: string; createdAt: string;
  closedAt: string | null; resolution: string | null; apartmentNumber: string | null; stairwell: string;
};

// Arkaluonteisen tehtävän otsikkoa ja ratkaisua ei näytetä historiassa.
const toItem = (row: HistoryRow): HistoryItem => ({
  id: row.id,
  ticketNumber: row.ticket_number,
  subject: row.sensitive ? "Arkaluonteinen tehtävä" : row.subject,
  topic: row.topic,
  status: row.status,
  createdAt: row.created_at,
  closedAt: row.closed_at,
  resolution: row.sensitive ? null : row.resolution,
  apartmentNumber: row.apartment_number,
  stairwell: stairwellOf(row.apartment_number, row.staircase)
});

const HISTORY_SELECT = `
  SELECT t.id, t.ticket_number, t.subject, t.topic, t.status, t.created_at, t.closed_at, t.resolution, t.sensitive,
         a.apartment_number, a.staircase
  FROM tickets t LEFT JOIN apartments a ON a.id = t.apartment_id
`;

const monthsAgo = (months: number) => {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString();
};

// Aiemmat viat: saman asunnon tehtävät (2 v) ja saman portaan samanaiheiset tehtävät (1 v) sekä
// taloyhtiön aiemmat samanaiheiset yhteiset viat ratkaisuineen.
export function ticketHistory(ticketId: string) {
  const ticket = db.prepare(`
    SELECT t.id, t.company_id, t.apartment_id, t.topic, a.apartment_number, a.staircase
    FROM tickets t LEFT JOIN apartments a ON a.id = t.apartment_id WHERE t.id = ?
  `).get(ticketId) as { id: string; company_id: string; apartment_id: string | null; topic: string | null;
    apartment_number: string | null; staircase: string | null } | undefined;
  if (!ticket) return null;

  const apartment = ticket.apartment_id
    ? (db.prepare(`${HISTORY_SELECT}
        WHERE t.apartment_id = ? AND t.id != ? AND t.kind = 'ticket' AND t.ai_action != 'filtered' AND t.created_at >= ?
        ORDER BY t.created_at DESC LIMIT 10`).all(ticket.apartment_id, ticket.id, monthsAgo(24)) as HistoryRow[]).map(toItem)
    : [];

  // Porras: samanaiheiset tehtävät muista saman portaan asunnoista. Aiheettomat ja muu-aihe jätetään pois.
  const stairwell = stairwellOf(ticket.apartment_number, ticket.staircase);
  const tracked = ticket.topic && ticket.topic !== "other" && ticket.topic !== "booking";
  const stair = tracked && stairwell
    ? (db.prepare(`${HISTORY_SELECT}
        WHERE t.company_id = ? AND t.topic = ? AND t.id != ? AND t.kind = 'ticket' AND t.ai_action != 'filtered'
          AND t.created_at >= ? AND (t.apartment_id IS NULL OR t.apartment_id != COALESCE(?, ''))
        ORDER BY t.created_at DESC LIMIT 40`).all(ticket.company_id, ticket.topic, ticket.id, monthsAgo(12), ticket.apartment_id) as HistoryRow[])
        .map(toItem).filter(item => item.stairwell === stairwell).slice(0, 10)
    : [];

  const incidents = tracked
    ? (db.prepare(`
        SELECT id, topic, stairwell, status, first_report_at, handled_at, resolution,
               (SELECT COUNT(*) FROM incident_tickets it WHERE it.incident_id = incidents.id) AS reports
        FROM incidents
        WHERE company_id = ? AND topic = ? AND first_report_at >= ?
          AND id NOT IN (SELECT incident_id FROM incident_tickets WHERE ticket_id = ?)
        ORDER BY first_report_at DESC LIMIT 5
      `).all(ticket.company_id, ticket.topic, monthsAgo(24), ticket.id) as {
        id: string; topic: string; stairwell: string; status: string; first_report_at: string; handled_at: string | null;
        resolution: string | null; reports: number;
      }[]).map(row => ({
        id: row.id, topic: row.topic, stairwell: row.stairwell, status: row.status, firstReportAt: row.first_report_at,
        handledAt: row.handled_at, resolution: row.resolution, reports: row.reports
      }))
    : [];

  return { stairwell, apartmentNumber: ticket.apartment_number, apartment, stair, incidents };
}

// Aiheen historia AI:lle (yhteisen vian tulkinta, muistiehdotukset): aiemmat ratkaisut tekstinä.
export function topicHistoryForAi(companyId: string, topic: string, excludeIncidentId?: string): string[] {
  const incidents = (db.prepare(`
    SELECT stairwell, first_report_at, resolution,
           (SELECT COUNT(*) FROM incident_tickets it WHERE it.incident_id = incidents.id) AS reports
    FROM incidents
    WHERE company_id = ? AND topic = ? AND id != COALESCE(?, '') AND first_report_at >= ?
    ORDER BY first_report_at DESC LIMIT 5
  `).all(companyId, topic, excludeIncidentId ?? null, monthsAgo(24)) as { stairwell: string; first_report_at: string; resolution: string | null; reports: number }[])
    .map(row => `Shared fault ${row.first_report_at.slice(0, 10)}, ${row.stairwell ? `staircase ${row.stairwell}` : "whole company"}, ` +
      `${row.reports} reports; resolution: ${row.resolution || "not recorded"}`);
  const tickets = (db.prepare(`${HISTORY_SELECT}
    WHERE t.company_id = ? AND t.topic = ? AND t.resolution IS NOT NULL AND t.sensitive = 0 AND t.created_at >= ?
    ORDER BY t.created_at DESC LIMIT 10`).all(companyId, topic, monthsAgo(24)) as HistoryRow[])
    .map(row => `${row.created_at.slice(0, 10)}, apartment ${row.apartment_number ?? "?"}: ${row.subject} – resolution: ${row.resolution}`);
  return [...incidents, ...tickets];
}

// ---------------------------------------------------------------------------------------------
// Trendiraportti
// ---------------------------------------------------------------------------------------------

const monthKey = (iso: string) => helsinkiParts(iso).day.slice(0, 7);
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const hoursBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;

export function trends(companyIds: string[], months: number) {
  if (!companyIds.length) return { months: [], topics: [], repeats: [], resolution: [], contractors: [], incidents: [] };
  const since = (() => {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - (months - 1));
    date.setHours(0, 0, 0, 0);
    return date.toISOString();
  })();
  const placeholders = companyIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT t.id, t.company_id, t.topic, t.created_at, t.closed_at, t.status, t.apartment_id, t.sensitive,
           a.apartment_number, a.staircase, c.name AS company_name
    FROM tickets t
    JOIN companies c ON c.id = t.company_id
    LEFT JOIN apartments a ON a.id = t.apartment_id
    WHERE t.company_id IN (${placeholders}) AND t.kind = 'ticket' AND t.ai_action != 'filtered'
      AND COALESCE(t.company_pending, 0) = 0 AND t.created_at >= ?
  `).all(...companyIds, since) as {
    id: string; company_id: string; topic: string | null; created_at: string; closed_at: string | null; status: string;
    apartment_id: string | null; sensitive: number; apartment_number: string | null; staircase: string | null; company_name: string;
  }[];

  // Kuukaudet vanhimmasta uusimpaan.
  const monthList: string[] = [];
  for (let index = months - 1; index >= 0; index--) {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - index);
    monthList.push(date.toLocaleDateString("sv-SE").slice(0, 7));
  }

  // Aiheet kuukausittain (vikojen aiheet; varaukset ja muu omina riveinään loppuun).
  const topicKey = (topic: string | null) => (topic && topic in TOPIC_RULES ? topic : "other");
  const byTopic = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const topic = topicKey(row.topic);
    const counts = byTopic.get(topic) ?? new Map<string, number>();
    counts.set(monthKey(row.created_at), (counts.get(monthKey(row.created_at)) ?? 0) + 1);
    byTopic.set(topic, counts);
  }
  const topics = [...byTopic.entries()].map(([topic, counts]) => {
    const series = monthList.map(month => counts.get(month) ?? 0);
    const last = series[series.length - 1];
    // Vertailu: viimeinen kuukausi edellisten kuukausien keskiarvoon.
    const earlier = series.slice(0, -1);
    const average = earlier.length ? earlier.reduce((sum, value) => sum + value, 0) / earlier.length : 0;
    return { topic, label: TOPIC_RULES[topic as TopicKey]?.label ?? topic, series, total: series.reduce((sum, value) => sum + value, 0),
      lastMonth: last, average: Number(average.toFixed(1)) };
  }).sort((a, b) => (a.topic === "other" ? 1 : 0) - (b.topic === "other" ? 1 : 0) || b.total - a.total);

  // Toistuvat viat: sama asunto ja aihe vähintään kahdesti 6 kk:ssa tai sama porras ja aihe vähintään kolmesti.
  const sixMonths = monthsAgo(6);
  const recent = rows.filter(row => row.created_at >= sixMonths && row.topic && row.topic !== "other" && row.topic !== "booking");
  const groups = new Map<string, typeof recent>();
  for (const row of recent) {
    const stair = stairwellOf(row.apartment_number, row.staircase);
    if (row.apartment_id) {
      const key = `apartment|${row.company_id}|${row.apartment_id}|${row.topic}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    if (stair) {
      const key = `stairwell|${row.company_id}|${stair}|${row.topic}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }
  const repeats = [...groups.entries()]
    .filter(([key, items]) => items.length >= (key.startsWith("apartment") ? 2 : 3))
    .map(([key, items]) => {
      const [kind, , place, topic] = key.split("|");
      const sorted = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
      return {
        kind: kind as "apartment" | "stairwell",
        companyId: sorted[0].company_id,
        companyName: sorted[0].company_name,
        place: kind === "apartment" ? sorted[0].apartment_number ?? "" : place,
        topic,
        label: TOPIC_RULES[topic as TopicKey]?.label ?? topic,
        count: items.length,
        firstAt: sorted[0].created_at,
        lastAt: sorted[sorted.length - 1].created_at,
        ticketIds: sorted.map(item => item.id)
      };
    })
    // Asunnon toistuva vika näytetään vain, jos portaan rivi ei jo kata samoja tehtäviä.
    .filter((item, _index, all) => item.kind === "stairwell" || !all.some(other => other.kind === "stairwell"
      && other.companyId === item.companyId && other.topic === item.topic && item.ticketIds.every(ticketId => other.ticketIds.includes(ticketId))))
    .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
    .slice(0, 30);

  // Hoitoaika aiheittain: luonnista sulkemiseen (mediaani tunteina).
  const durations = new Map<string, number[]>();
  for (const row of rows) {
    if (row.status !== "closed" || !row.closed_at) continue;
    const topic = topicKey(row.topic);
    durations.set(topic, [...(durations.get(topic) ?? []), hoursBetween(row.created_at, row.closed_at)]);
  }
  const resolution = [...durations.entries()].map(([topic, values]) => ({
    topic, label: TOPIC_RULES[topic as TopicKey]?.label ?? topic, closed: values.length,
    medianHours: Number((median(values) ?? 0).toFixed(1))
  })).sort((a, b) => b.closed - a.closed);

  // Huoltoyhtiöt: työtilaukset ja aika tilauksesta kuittaukseen.
  const contractors = (db.prepare(`
    SELECT contractor_name, status, ordered_at, done_at FROM work_orders
    WHERE company_id IN (${placeholders}) AND ordered_at >= ?
  `).all(...companyIds, since) as { contractor_name: string; status: string; ordered_at: string; done_at: string | null }[])
    .reduce((map, row) => {
      const item = map.get(row.contractor_name) ?? { name: row.contractor_name, orders: 0, open: 0, hours: [] as number[] };
      item.orders++;
      if (row.status !== "done" || !row.done_at) item.open++;
      else item.hours.push(hoursBetween(row.ordered_at, row.done_at));
      map.set(row.contractor_name, item);
      return map;
    }, new Map<string, { name: string; orders: number; open: number; hours: number[] }>());

  const incidentRows = db.prepare(`
    SELECT i.topic, i.stairwell, i.status, i.first_report_at, i.resolution, c.name AS company_name,
           (SELECT COUNT(*) FROM incident_tickets it WHERE it.incident_id = i.id) AS reports
    FROM incidents i JOIN companies c ON c.id = i.company_id
    WHERE i.company_id IN (${placeholders}) AND i.first_report_at >= ? AND i.status != 'dismissed'
    ORDER BY i.first_report_at DESC LIMIT 20
  `).all(...companyIds, since) as { topic: string; stairwell: string; status: string; first_report_at: string; resolution: string | null;
    company_name: string; reports: number }[];

  return {
    months: monthList,
    topics,
    repeats,
    resolution,
    contractors: [...contractors.values()].map(item => ({
      name: item.name, orders: item.orders, open: item.open, medianHours: item.hours.length ? Number(median(item.hours)!.toFixed(1)) : null
    })).sort((a, b) => b.orders - a.orders),
    incidents: incidentRows.map(row => ({
      topic: row.topic, label: TOPIC_RULES[row.topic as TopicKey]?.label ?? row.topic, stairwell: row.stairwell, status: row.status,
      firstReportAt: row.first_report_at, resolution: row.resolution, companyName: row.company_name, reports: row.reports
    }))
  };
}
