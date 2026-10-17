import express, { type Response, type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { type BoardAccount, hashPassword, MIN_PASSWORD_LENGTH, requireManager, setBoardPassword, type User } from "../auth.js";
import { db } from "../db.js";
import { id, now } from "../util.js";
import { runReport } from "./reports.js";

export const boardRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Hallituksen näkymä: taloyhtiön hallituksen jäsen näkee oman yhtiönsä tehtävien tilanteen, remontti-
// ilmoitukset ja tiedotteet, mutta ei voi muuttaa mitään. Tehtävistä näytetään vain otsikko, tyyppi,
// tila ja päivämäärät: asukkaiden nimet, viestit ja liitteet jäävät isännöitsijälle.
// Tunnukset luo ja poistaa isännöitsijä taloyhtiön tiedoista.
// ---------------------------------------------------------------------------------------------

type BoardMemberRow = { id: string; company_id: string; name: string; email: string; created_at: string; last_login_at: string | null };

const memberFields = "id, company_id, name, email, created_at, last_login_at";

function audit(actor: string, action: string, details: Record<string, string>) {
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), null, actor, action, JSON.stringify(details), now());
}

boardRouter.get("/companies/:companyId/board-members", requireManager, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare(`SELECT ${memberFields} FROM board_members WHERE company_id = ? ORDER BY name COLLATE NOCASE`).all(companyId));
});

const memberSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(200),
  // Uudelle jäsenelle pakollinen; muokatessa tyhjä = salasanaa ei vaihdeta.
  password: z.string().max(200).optional()
});

const passwordError = `Salasanassa pitää olla vähintään ${MIN_PASSWORD_LENGTH} merkkiä.`;

boardRouter.post("/companies/:companyId/board-members", requireManager, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = memberSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista nimi ja sähköposti." });
  if ((parsed.data.password ?? "").length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: passwordError });
  if (db.prepare("SELECT 1 FROM board_members WHERE company_id = ? AND email = ?").get(companyId, parsed.data.email)) {
    return res.status(409).json({ error: "Tällä sähköpostilla on jo tunnus tämän taloyhtiön hallituksen näkymään." });
  }
  const memberId = id("board");
  db.prepare("INSERT INTO board_members (id, company_id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(memberId, companyId, parsed.data.name, parsed.data.email, hashPassword(parsed.data.password as string), now());
  audit((res.locals.user as User).name, "board_member_created", { name: parsed.data.name, company_id: companyId });
  res.status(201).json(db.prepare(`SELECT ${memberFields} FROM board_members WHERE id = ?`).get(memberId));
});

function managedMember(res: Response, memberId: string): BoardMemberRow | null {
  const member = db.prepare(`SELECT ${memberFields} FROM board_members WHERE id = ?`).get(memberId) as BoardMemberRow | undefined;
  if (!member || !companyIdFromContext(member.company_id)) {
    res.status(404).json({ error: "Hallituksen jäsentä ei löytynyt." });
    return null;
  }
  return member;
}

boardRouter.put("/board-members/:id", requireManager, (req, res) => {
  const member = managedMember(res, String(req.params.id));
  if (!member) return;
  const parsed = memberSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista nimi ja sähköposti." });
  if (db.prepare("SELECT 1 FROM board_members WHERE company_id = ? AND email = ? AND id != ?").get(member.company_id, parsed.data.email, member.id)) {
    return res.status(409).json({ error: "Tällä sähköpostilla on jo tunnus tämän taloyhtiön hallituksen näkymään." });
  }
  if (parsed.data.password) {
    const error = setBoardPassword(member.id, parsed.data.password);
    if (error) return res.status(400).json({ error });
  }
  db.prepare("UPDATE board_members SET name = ?, email = ? WHERE id = ?").run(parsed.data.name, parsed.data.email, member.id);
  res.json(db.prepare(`SELECT ${memberFields} FROM board_members WHERE id = ?`).get(member.id));
});

boardRouter.delete("/board-members/:id", requireManager, (req, res) => {
  const member = managedMember(res, String(req.params.id));
  if (!member) return;
  db.transaction(() => {
    db.prepare("DELETE FROM board_sessions WHERE member_id = ?").run(member.id);
    db.prepare("DELETE FROM password_resets WHERE kind = 'board' AND subject_id = ?").run(member.id);
    db.prepare("DELETE FROM board_members WHERE id = ?").run(member.id);
  })();
  audit((res.locals.user as User).name, "board_member_deleted", { name: member.name, company_id: member.company_id });
  res.json({ ok: true });
});

const localDay = (date: Date) => date.toLocaleDateString("sv-SE");

// Hallituksen näkymän koko sisältö yhdellä kutsulla.
boardRouter.get("/board/overview", (_req, res) => {
  const member = res.locals.boardMember as BoardAccount;
  const companyId = member.companyId;

  const company = db.prepare(`
    SELECT c.name, c.address, c.business_id AS businessId, c.maintenance_name AS maintenanceName,
           c.maintenance_phone AS maintenancePhone, c.maintenance_emergency_phone AS maintenanceEmergencyPhone,
           u.name AS managerName, u.email AS managerEmail
    FROM companies c LEFT JOIN users u ON u.id = c.manager_id
    WHERE c.id = ?
  `).get(companyId);

  // Tunnusluvut: viimeiset 30 päivää ja vastausaika 90 päivän ajalta.
  const day = new Date();
  const daysAgo = (days: number) => {
    const date = new Date(day);
    date.setDate(date.getDate() - days);
    return localDay(date);
  };
  const month = runReport({ from: daysAgo(29), to: localDay(day), groupBy: "company" }, [companyId]).totals;
  const quarter = runReport({ from: daysAgo(89), to: localDay(day), groupBy: "company" }, [companyId]).totals;
  const open = (db.prepare(`
    SELECT COUNT(*) AS count FROM tickets WHERE company_id = ? AND status != 'closed' AND ai_action != 'filtered' AND company_pending = 0
  `).get(companyId) as { count: number }).count;

  // Roskapostiksi suodatetut viestit eivät ole taloyhtiön asioita, joten ne jätetään pois.
  const tickets = db.prepare(`
    SELECT ticket_number AS number,
           -- Arkaluonteisen tehtävän otsikko ei näy hallitukselle.
           CASE WHEN sensitive = 1 THEN 'Arkaluonteinen tehtävä' ELSE subject END AS subject,
           type, status, priority, created_at, closed_at, due_date
    FROM tickets
    WHERE company_id = ? AND ai_action != 'filtered' AND company_pending = 0 AND (status != 'closed' OR created_at >= ?)
    ORDER BY status = 'closed', created_at DESC
    LIMIT 300
  `).all(companyId, new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString());

  const renovations = db.prepare(`
    SELECT n.id, n.work_type, n.description, n.start_date, n.end_date, n.status, n.created_at, n.completed_at, a.apartment_number
    FROM renovation_notices n LEFT JOIN apartments a ON a.id = n.apartment_id
    WHERE n.company_id = ?
    ORDER BY n.status = 'pending' DESC, n.start_date DESC
    LIMIT 100
  `).all(companyId);

  const announcements = db.prepare(`
    SELECT id, title, body, stairwell, created_at FROM announcements WHERE company_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(companyId);

  res.json({
    member: { name: member.name, email: member.email },
    company,
    stats: {
      open,
      received30: month.total,
      closed30: month.closed,
      overdue30: month.overdue,
      avgFirstResponseHours: quarter.avgFirstResponseHours
    },
    tickets,
    renovations,
    announcements
  });
});
