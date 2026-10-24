import express, { type Router } from "express";
import { requestUser, visibleCompanyIds } from "../access.js";
import { db } from "../db.js";
import { roleTables } from "../roles.js";

export const dataRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Data-osio: jokainen taloyhtiön taulu suodattamattomana. Rivit tulevat kaikista käyttäjälle näkyvistä
// taloyhtiöistä, ja mukana ovat myös päättyneet (poismuuttaneet asukkaat, palautetut jonot, vanhat
// dokumenttiversiot). Taulun näkee, jos roolilla on pääsy saman nimiseen tauluun (Asetukset › Roolit).
// Taloyhtiöiden oma lista on Taloyhtiöt-näkymässä. Kyselyt saavat yhtiörajauksen ?-paikkoina; jokaisella rivillä on company_id ja company_name.
// ---------------------------------------------------------------------------------------------

const COMPANY = "(SELECT c.name FROM companies c WHERE c.id = x.company_id) AS company_name";

function knowledgeQuery(audience: string) {
  return `
    SELECT x.id, x.company_id, ${COMPANY}, x.doc_number, x.title, x.kind, x.audience, x.status, x.version,
           x.tags, x.valid_from, x.valid_until, x.file_name, x.created_at
    FROM knowledge x
    WHERE x.company_id IN (__COMPANIES__) ${audience}
    ORDER BY company_name, x.title COLLATE NOCASE, x.version DESC`;
}

function bookingQuery(resource: string) {
  return `
    SELECT x.id, x.company_id, ${COMPANY}, x.starts_at, x.ends_at, r.name AS resident_name, a.apartment_number,
           x.note, x.created_by, x.created_at
    FROM bookings x
    LEFT JOIN residents r ON r.id = x.resident_id
    LEFT JOIN apartments a ON a.id = r.apartment_id
    WHERE x.company_id IN (__COMPANIES__) AND x.resource = '${resource}'
    ORDER BY x.starts_at DESC`;
}

const DATA_QUERIES: Record<string, string> = {
  knowledge: knowledgeQuery(""),
  "knowledge-ai": knowledgeQuery("AND x.audience = 'ai'"),
  "knowledge-internal": knowledgeQuery("AND x.audience = 'internal'"),
  residents: `
    SELECT x.id, x.company_id, ${COMPANY}, x.name, x.email, x.roles, a.apartment_number, a.address, a.staircase,
           x.moved_out_at, x.erased_at
    FROM residents x
    LEFT JOIN apartments a ON a.id = x.apartment_id
    WHERE x.company_id IN (__COMPANIES__)
    ORDER BY company_name, x.name COLLATE NOCASE`,
  apartments: `
    SELECT x.id, x.company_id, ${COMPANY}, x.apartment_number, x.staircase, x.address,
           (SELECT COUNT(*) FROM residents r WHERE r.apartment_id = x.id) AS resident_count
    FROM apartments x
    WHERE x.company_id IN (__COMPANIES__)
    ORDER BY company_name, x.staircase COLLATE NOCASE, x.apartment_number COLLATE NOCASE`,
  waitlist: `
    SELECT x.id, x.company_id, ${COMPANY}, x.resource, x.parking_type, r.name AS resident_name, a.apartment_number,
           x.status, x.note, x.created_at, x.offered_at
    FROM waitlist x
    LEFT JOIN residents r ON r.id = x.resident_id
    LEFT JOIN apartments a ON a.id = r.apartment_id
    WHERE x.company_id IN (__COMPANIES__)
    ORDER BY company_name, x.created_at DESC`,
  keys: `
    SELECT x.id, x.company_id, ${COMPANY}, x.code, x.type, a.apartment_number, x.status, x.note,
           l.holder_name, l.handed_at, l.due_date, x.created_at
    FROM building_keys x
    LEFT JOIN apartments a ON a.id = x.apartment_id
    LEFT JOIN key_loans l ON l.key_id = x.id AND l.returned_at IS NULL
    WHERE x.company_id IN (__COMPANIES__)
    ORDER BY company_name, x.code COLLATE NOCASE`,
  sauna: bookingQuery("sauna"),
  laundry: bookingQuery("laundry"),
  parking: `
    SELECT x.id, x.company_id, ${COMPANY}, x.label, x.type, r.name AS resident_name, a.apartment_number, x.note, x.created_at
    FROM parking_spaces x
    LEFT JOIN residents r ON r.id = x.resident_id
    LEFT JOIN apartments a ON a.id = r.apartment_id
    WHERE x.company_id IN (__COMPANIES__)
    ORDER BY company_name, x.label COLLATE NOCASE`,
  announcements: `
    SELECT x.id, x.company_id, ${COMPANY}, x.title, x.stairwell, x.emailed_count, x.created_by, x.created_at
    FROM announcements x
    WHERE x.company_id IN (__COMPANIES__)
    ORDER BY x.created_at DESC`,
  moves: `
    SELECT x.id, x.company_id, ${COMPANY}, x.move_date, x.moves_out, r.name AS resident_name, a.apartment_number,
           a.address, x.status, x.note, x.created_at, x.decided_by, x.decided_at
    FROM move_notices x
    LEFT JOIN residents r ON r.id = x.resident_id
    LEFT JOIN apartments a ON a.id = x.apartment_id
    WHERE x.company_id IN (__COMPANIES__)
    ORDER BY x.created_at DESC`,
  renovations: `
    SELECT x.id, x.company_id, ${COMPANY}, x.work_type, x.start_date, x.end_date,
           COALESCE(r.name, NULLIF(x.reporter_name, '')) AS resident_name, a.apartment_number, x.contractor, x.status,
           x.created_at, x.decided_by, x.decided_at
    FROM renovation_notices x
    LEFT JOIN residents r ON r.id = x.resident_id
    LEFT JOIN apartments a ON a.id = x.apartment_id
    WHERE x.company_id IN (__COMPANIES__)
    ORDER BY x.created_at DESC`,
  meters: `
    SELECT x.id, x.company_id, ${COMPANY}, x.reading_date, x.meter_type, x.value, a.apartment_number,
           r.name AS resident_name, x.source, x.recorded_by, x.note, x.created_at
    FROM meter_readings x
    LEFT JOIN apartments a ON a.id = x.apartment_id
    LEFT JOIN residents r ON r.id = x.resident_id
    WHERE x.company_id IN (__COMPANIES__)
    ORDER BY x.reading_date DESC, x.created_at DESC`
};

dataRouter.get("/data/:table", (req, res) => {
  const query = Object.hasOwn(DATA_QUERIES, req.params.table) ? DATA_QUERIES[req.params.table] : undefined;
  if (!query) return res.status(404).json({ error: "Taulua ei ole." });
  const user = requestUser.getStore();
  const tables = user ? roleTables(user.role) : null;
  if (tables !== null && !tables.includes(req.params.table)) return res.status(403).json({ error: "Roolilla ei ole pääsyä tauluun." });
  const companyIds = visibleCompanyIds();
  if (companyIds.length === 0) return res.json([]);
  res.json(db.prepare(query.replace("__COMPANIES__", companyIds.map(() => "?").join(", "))).all(...companyIds));
});
