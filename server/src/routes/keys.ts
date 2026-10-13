import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { requireManager } from "../auth.js";
import { db } from "../db.js";
import { ACTIVE_RESIDENT, id, now } from "../util.js";

export const keysRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Avainhallinta: taloyhtiön avainrekisteri ja avainten luovutukset. Avaimen voi luovuttaa asukkaalle
// tai muulle nimetylle henkilölle (esim. urakoitsijalle), ja palautus kuitataan samalle riville.
// ---------------------------------------------------------------------------------------------
export const KEY_TYPES = ["Asunto", "Yleisavain", "Yleiset tilat", "Autotalli", "Tekninen tila", "Muu"] as const;

const KEY_SELECT = `
  SELECT k.*, a.apartment_number, a.address,
         l.id AS loan_id, l.holder_name, l.resident_id AS holder_resident_id, l.handed_at, l.due_date, l.note AS loan_note
  FROM building_keys k
  LEFT JOIN apartments a ON a.id = k.apartment_id
  LEFT JOIN key_loans l ON l.key_id = k.id AND l.returned_at IS NULL
`;

keysRouter.get("/companies/:companyId/keys", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare(`${KEY_SELECT} WHERE k.company_id = ? ORDER BY k.code`).all(companyId));
});

const keySchema = z.object({
  code: z.string().trim().min(1).max(60),
  type: z.enum(KEY_TYPES),
  apartmentId: z.string().nullable().default(null),
  note: z.string().trim().max(300).default(""),
  lost: z.boolean().default(false)
});

// Tarkistaa avaimen tiedot. Palauttaa virhetekstin tai null, kun tiedot kelpaavat.
function keyError(companyId: string, input: z.infer<typeof keySchema>, exceptKeyId = ""): string | null {
  if (input.apartmentId && !db.prepare("SELECT 1 FROM apartments WHERE id = ? AND company_id = ?").get(input.apartmentId, companyId)) {
    return "Asuntoa ei löytynyt tästä taloyhtiöstä.";
  }
  const duplicate = db.prepare("SELECT 1 FROM building_keys WHERE company_id = ? AND lower(code) = lower(?) AND id != ?")
    .get(companyId, input.code, exceptKeyId);
  return duplicate ? "Tällä tunnuksella on jo avain tässä taloyhtiössä." : null;
}

keysRouter.post("/companies/:companyId/keys", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = keySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista avaimen tunnus ja tyyppi." });
  const error = keyError(companyId, parsed.data);
  if (error) return res.status(409).json({ error });

  const keyId = id("key");
  db.prepare("INSERT INTO building_keys (id, company_id, code, type, apartment_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(keyId, companyId, parsed.data.code, parsed.data.type, parsed.data.apartmentId, parsed.data.note,
      parsed.data.lost ? "lost" : "active", now());
  res.status(201).json({ ok: true, keyId });
});

type BuildingKey = { id: string; company_id: string; code: string; status: string };

function authorizedKey(keyId: string) {
  const key = db.prepare("SELECT * FROM building_keys WHERE id = ?").get(keyId) as BuildingKey | undefined;
  return key && companyIdFromContext(key.company_id) ? key : null;
}

keysRouter.put("/keys/:id", (req, res) => {
  const key = authorizedKey(req.params.id);
  if (!key) return res.status(404).json({ error: "Avainta ei löytynyt." });
  const parsed = keySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista avaimen tunnus ja tyyppi." });
  const error = keyError(key.company_id, parsed.data, key.id);
  if (error) return res.status(409).json({ error });

  db.prepare("UPDATE building_keys SET code = ?, type = ?, apartment_id = ?, note = ?, status = ? WHERE id = ?")
    .run(parsed.data.code, parsed.data.type, parsed.data.apartmentId, parsed.data.note, parsed.data.lost ? "lost" : "active", key.id);
  res.json({ ok: true });
});

// Avaimen poisto vie mukanaan myös luovutushistorian, joten se kuuluu isännöitsijälle.
keysRouter.delete("/keys/:id", requireManager, (req, res) => {
  const key = authorizedKey(req.params.id);
  if (!key) return res.status(404).json({ error: "Avainta ei löytynyt." });
  db.transaction(() => {
    db.prepare("DELETE FROM key_loans WHERE key_id = ?").run(key.id);
    db.prepare("DELETE FROM building_keys WHERE id = ?").run(key.id);
  })();
  res.json({ ok: true });
});

keysRouter.get("/keys/:id/loans", (req, res) => {
  const key = authorizedKey(req.params.id);
  if (!key) return res.status(404).json({ error: "Avainta ei löytynyt." });
  res.json(db.prepare("SELECT * FROM key_loans WHERE key_id = ? ORDER BY handed_at DESC").all(key.id));
});

const handOverSchema = z.object({
  // Asukas valitaan tunnisteella; muu vastaanottaja annetaan nimellä.
  residentId: z.string().nullable().default(null),
  holderName: z.string().trim().max(120).default(""),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  note: z.string().trim().max(300).default("")
});

keysRouter.post("/keys/:id/hand-over", (req, res) => {
  const key = authorizedKey(req.params.id);
  if (!key) return res.status(404).json({ error: "Avainta ei löytynyt." });
  const parsed = handOverSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista vastaanottaja ja palautuspäivä." });
  if (key.status === "lost") return res.status(409).json({ error: "Kadonneeksi merkittyä avainta ei voi luovuttaa." });
  if (db.prepare("SELECT 1 FROM key_loans WHERE key_id = ? AND returned_at IS NULL").get(key.id)) {
    return res.status(409).json({ error: "Avain on jo luovutettu. Kuittaa se ensin palautetuksi." });
  }

  let holderName = parsed.data.holderName;
  if (parsed.data.residentId) {
    const resident = db.prepare(`SELECT r.name FROM residents r WHERE r.id = ? AND r.company_id = ? AND ${ACTIVE_RESIDENT}`)
      .get(parsed.data.residentId, key.company_id) as { name: string } | undefined;
    if (!resident) return res.status(404).json({ error: "Asukasta ei löytynyt tästä taloyhtiöstä." });
    holderName = resident.name;
  }
  if (!holderName) return res.status(400).json({ error: "Valitse asukas tai kirjoita vastaanottajan nimi." });

  db.prepare(`
    INSERT INTO key_loans (id, key_id, resident_id, holder_name, note, due_date, handed_at, handed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id("loan"), key.id, parsed.data.residentId, holderName, parsed.data.note, parsed.data.dueDate, now(),
    res.locals.user?.name ?? "Isännöitsijä");
  res.status(201).json({ ok: true });
});

keysRouter.post("/keys/:id/return", (req, res) => {
  const key = authorizedKey(req.params.id);
  if (!key) return res.status(404).json({ error: "Avainta ei löytynyt." });
  const returned = db.prepare("UPDATE key_loans SET returned_at = ?, received_by = ? WHERE key_id = ? AND returned_at IS NULL")
    .run(now(), res.locals.user?.name ?? "Isännöitsijä", key.id);
  if (returned.changes === 0) return res.status(409).json({ error: "Avainta ei ole luovutettu kenellekään." });
  res.json({ ok: true });
});
