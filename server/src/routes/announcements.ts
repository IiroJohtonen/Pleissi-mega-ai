import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { requireManager } from "../auth.js";
import { db } from "../db.js";
import { sendEmail } from "../mail.js";
import { ACTIVE_RESIDENT, id, now, VALID_EMAIL } from "../util.js";
import { portalResident } from "./portal.js";

export const announcementsRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Tiedotteet: isännöitsijän viesti koko taloyhtiön tai yhden rapun asukkaille. Tiedote näkyy
// asukasportaalissa ja lähetetään haluttaessa sähköpostilla piilokopiona.
// ---------------------------------------------------------------------------------------------
// Rappu päätellään asunnon numeron alkukirjaimista ("B 34" -> "B"). Ilman kirjainta rappua ei ole.
function stairwellOf(apartmentNumber?: string | null) {
  return (apartmentNumber ?? "").trim().match(/^[A-Za-zÅÄÖåäö]+/)?.[0].toUpperCase() ?? "";
}

function announcementAudience(companyId: string) {
  const rows = db.prepare(`
    SELECT r.email, a.apartment_number
    FROM residents r LEFT JOIN apartments a ON a.id = r.apartment_id
    WHERE r.company_id = ? AND ${ACTIVE_RESIDENT}
  `).all(companyId) as { email: string | null; apartment_number: string | null }[];
  return rows.map(row => ({
    stairwell: stairwellOf(row.apartment_number),
    email: VALID_EMAIL.test((row.email ?? "").trim()) ? (row.email as string).trim() : ""
  }));
}

announcementsRouter.get("/companies/:companyId/announcement-audience", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const audience = announcementAudience(companyId);
  const stairwells = [...new Set(audience.map(item => item.stairwell).filter(Boolean))].sort();
  const count = (list: typeof audience) => ({ residents: list.length, emails: new Set(list.map(item => item.email).filter(Boolean)).size });
  res.json({
    all: count(audience),
    stairwells: stairwells.map(stairwell => ({ stairwell, ...count(audience.filter(item => item.stairwell === stairwell)) }))
  });
});

announcementsRouter.get("/companies/:companyId/announcements", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare("SELECT * FROM announcements WHERE company_id = ? ORDER BY created_at DESC").all(companyId));
});

announcementsRouter.post("/companies/:companyId/announcements", requireManager, async (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = z.object({
    title: z.string().trim().min(3).max(150),
    body: z.string().trim().min(5).max(8000),
    stairwell: z.string().trim().max(10).default(""),
    sendEmail: z.boolean().default(false)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Kirjoita tiedotteelle otsikko ja teksti." });

  const company = db.prepare("SELECT name FROM companies WHERE id = ?").get(companyId) as { name: string } | undefined;
  if (!company) return res.status(404).json({ error: "Company not found" });
  const stairwell = parsed.data.stairwell.toUpperCase();
  const audience = announcementAudience(companyId).filter(item => !stairwell || item.stairwell === stairwell);
  if (stairwell && audience.length === 0) return res.status(400).json({ error: "Rapussa ei ole asukkaita." });

  const actor = res.locals.user?.name ?? "Isännöitsijä";
  let emailed = 0;
  let emailFailed = false;
  if (parsed.data.sendEmail) {
    const emails = [...new Set(audience.map(item => item.email).filter(Boolean))];
    const text = `${parsed.data.body}\n\nYstävällisin terveisin\n${actor}\n${company.name}`;
    try {
      // Lähetetään erissä, jotta yhden viestin vastaanottajamäärä pysyy kohtuullisena.
      for (let start = 0; start < emails.length; start += 50) {
        const batch = emails.slice(start, start + 50);
        await sendEmail({ bcc: batch.join(", "), subject: `Tiedote: ${parsed.data.title} (${company.name})`, body: text, companyId });
        emailed += batch.length;
      }
    } catch (error: any) {
      console.error("Tiedotteen lähetys epäonnistui:", error?.message ?? error);
      emailFailed = true;
    }
  }

  const announcementId = id("announcement");
  db.prepare(`
    INSERT INTO announcements (id, company_id, stairwell, title, body, emailed_count, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(announcementId, companyId, stairwell, parsed.data.title, parsed.data.body, emailed, actor, now());
  res.status(201).json({ ok: true, announcementId, emailed, emailFailed });
});

announcementsRouter.delete("/announcements/:id", requireManager, (req, res) => {
  const row = db.prepare("SELECT id, company_id FROM announcements WHERE id = ?").get(req.params.id) as
    | { id: string; company_id: string }
    | undefined;
  if (!row || !companyIdFromContext(row.company_id)) return res.status(404).json({ error: "Tiedotetta ei löytynyt." });
  db.prepare("DELETE FROM announcements WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

// Asukas näkee oman taloyhtiönsä tiedotteet: koko yhtiön ja oman rappunsa.
announcementsRouter.get("/portal/announcements", (_req, res) => {
  const resident = portalResident(res);
  res.json(db.prepare(`
    SELECT id, title, body, stairwell, created_at
    FROM announcements
    WHERE company_id = ? AND (stairwell = '' OR stairwell = ?)
    ORDER BY created_at DESC
    LIMIT 100
  `).all(resident.companyId, stairwellOf(resident.apartmentNumber)));
});
