import express, { type Router } from "express";
import { z } from "zod";
import { AUTHORIZED_COMPANY_IDS, companyIdFromContext, visibleCompanyIds } from "../access.js";
import { isAdmin, isManagerRole, requireManager } from "../auth.js";
import { db } from "../db.js";
import { id } from "../util.js";

export const companiesRouter: Router = express.Router();

companiesRouter.get("/companies", (_req, res) => {
  const companyIds = visibleCompanyIds();
  const placeholders = companyIds.map(() => "?").join(", ");
  const companies = db.prepare(`
    SELECT id, name, email_address, business_id, address, phone,
      maintenance_name, maintenance_phone, maintenance_email, maintenance_emergency_phone,
      manager_id, (SELECT u.name FROM users u WHERE u.id = companies.manager_id) AS manager_name,
      (SELECT group_concat(cm.user_id) FROM company_managers cm WHERE cm.company_id = companies.id) AS manager_ids_csv,
      (SELECT COUNT(*) FROM residents r WHERE r.company_id = companies.id) AS resident_count
    FROM companies
    WHERE id IN (${placeholders})
    ORDER BY name
  `).all(...companyIds) as ({ manager_ids_csv: string | null } & Record<string, unknown>)[];
  // manager_ids = taloyhtiön muut isännöitsijät (ilman vastuuisännöitsijää).
  res.json(companies.map(({ manager_ids_csv, ...company }) => ({
    ...company,
    manager_ids: manager_ids_csv ? manager_ids_csv.split(",") : []
  })));
});

const companySchema = z.object({
  name: z.string().trim().min(1),
  emailAddress: z.string().trim().pipe(z.union([z.literal(""), z.email()])).default(""),
  businessId: z.string().trim().default(""),
  address: z.string().trim().default(""),
  phone: z.string().trim().default(""),
  // Vastuuisännöitsijä: käyttäjän tunniste, null = ei valittu. Puuttuessaan kenttää ei muuteta.
  managerId: z.string().nullable().optional(),
  // Taloyhtiön muut isännöitsijät. Puuttuessaan listaa ei muuteta.
  managerIds: z.array(z.string()).max(50).optional(),
  // Huoltoyhtiön tiedot päivitetään vain, kun ne ovat pyynnössä mukana.
  maintenance: z.object({
    name: z.string().trim().default(""),
    phone: z.string().trim().default(""),
    email: z.string().trim().pipe(z.union([z.literal(""), z.email()])).default(""),
    emergencyPhone: z.string().trim().default("")
  }).optional()
});

function companyEmailInUse(emailAddress: string, exceptCompanyId = "") {
  if (!emailAddress) return false;
  return Boolean(db.prepare(
    "SELECT id FROM companies WHERE id != ? AND lower(email_address) = lower(?)"
  ).get(exceptCompanyId, emailAddress));
}

companiesRouter.post("/companies", requireManager, (req, res) => {
  const parsed = companySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Tarkista taloyhtiön nimi ja sähköpostiosoite." });
  }
  if (companyEmailInUse(parsed.data.emailAddress)) {
    return res.status(409).json({ error: "Sähköpostiosoite on jo toisen yhtiön käytössä." });
  }

  const companyId = id("company");
  db.prepare(`
    INSERT INTO companies (id, name, email_address, business_id, address, phone, managed)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(
    companyId,
    parsed.data.name,
    parsed.data.emailAddress,
    parsed.data.businessId,
    parsed.data.address,
    parsed.data.phone
  );
  AUTHORIZED_COMPANY_IDS.add(companyId);

  res.status(201).json({ ok: true, companyId });
});

companiesRouter.put("/companies/:companyId", requireManager, (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

  const parsed = companySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Tarkista nimi ja sähköpostiosoitteet." });
  }

  if (companyEmailInUse(parsed.data.emailAddress, companyId)) {
    return res.status(409).json({ error: "Sähköpostiosoite on jo toisen yhtiön käytössä." });
  }

  // Vastuuisännöitsijän ja lisäisännöitsijöiden vaihto on pääkäyttäjän oikeus: muuten isännöitsijä voisi
  // nimetä itsensä vastuuisännöitsijäksi ja saada näin arkaluonteiset tehtävät näkyviin.
  const changesManagers = parsed.data.managerId !== undefined || parsed.data.managerIds !== undefined;
  if (changesManagers && !isAdmin(res)) {
    return res.status(403).json({ error: "Vain pääkäyttäjä voi vaihtaa taloyhtiön isännöitsijöitä." });
  }

  // Vastuuisännöitsijäksi kelpaa isännöitsijä tai pääkäyttäjä.
  const managerId = parsed.data.managerId === undefined ? undefined : parsed.data.managerId || null;
  if (managerId) {
    const manager = db.prepare("SELECT role FROM users WHERE id = ?").get(managerId) as { role: string } | undefined;
    if (!manager || !isManagerRole(manager.role)) {
      return res.status(400).json({ error: "Vastuuisännöitsijän pitää olla isännöitsijä-käyttäjä." });
    }
  }

  const result = db.prepare(`
    UPDATE companies
    SET name = ?, email_address = ?, business_id = ?, address = ?, phone = ?
    WHERE id = ?
  `).run(
    parsed.data.name,
    parsed.data.emailAddress,
    parsed.data.businessId,
    parsed.data.address,
    parsed.data.phone,
    companyId
  );
  if (result.changes === 0) return res.status(404).json({ error: "Company not found" });
  if (parsed.data.managerIds !== undefined) {
    const responsible = managerId !== undefined
      ? managerId
      : (db.prepare("SELECT manager_id FROM companies WHERE id = ?").get(companyId) as { manager_id: string | null }).manager_id;
    // Vastuuisännöitsijää ei tallenneta toiseen kertaan muiden joukkoon.
    const others = [...new Set(parsed.data.managerIds)].filter(userId => userId !== responsible);
    for (const userId of others) {
      const user = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined;
      if (!user || !isManagerRole(user.role)) {
        return res.status(400).json({ error: "Taloyhtiön isännöitsijäksi voi valita vain isännöitsijä-käyttäjän." });
      }
    }
    db.transaction(() => {
      db.prepare("DELETE FROM company_managers WHERE company_id = ?").run(companyId);
      for (const userId of others) db.prepare("INSERT INTO company_managers (company_id, user_id) VALUES (?, ?)").run(companyId, userId);
    })();
  }
  if (managerId !== undefined) {
    db.prepare("DELETE FROM company_managers WHERE company_id = ? AND user_id = ?").run(companyId, managerId ?? "");
    db.prepare("UPDATE companies SET manager_id = ? WHERE id = ?").run(managerId, companyId);
    // Jonossa jo odottavat tehtävät, joilla ei ole käsittelijää, siirtyvät uudelle vastuuisännöitsijälle.
    if (managerId) {
      db.prepare("UPDATE tickets SET assignee_id = ? WHERE company_id = ? AND status = 'open' AND assignee_id IS NULL")
        .run(managerId, companyId);
    }
  }

  const maintenance = parsed.data.maintenance;
  if (maintenance) {
    db.prepare(`
      UPDATE companies
      SET maintenance_name = ?, maintenance_phone = ?, maintenance_email = ?,
          maintenance_emergency_phone = ?
      WHERE id = ?
    `).run(
      maintenance.name,
      maintenance.phone,
      maintenance.email,
      maintenance.emergencyPhone,
      companyId
    );
  }

  res.json({ ok: true });
});
