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

// ---------------------------------------------------------------------------------------------
// Tuonti ja vienti. Viedyssä tiedostossa on samat sarakkeet kuin tuonnissa, joten se kelpaa suoraan
// tuonnin pohjaksi. Lainassa-sarake on vain tiedoksi, eikä tuonti luo luovutuksia.
// ---------------------------------------------------------------------------------------------
export const KEY_FILE_COLUMNS = ["asunto", "avainnumero", "tyyppi", "huomio", "tila", "lainassa"] as const;
const STATE_LABELS = { active: "käytössä", lost: "kadonnut" } as const;

// Asunnon tunnus vertailuun: "A 12", "a12" ja "A12" ovat sama asunto.
const apartmentKey = (value: string) => value.toLowerCase().replace(/\s+/g, "");

const importRowSchema = z.object({
  line: z.number().int().min(1),
  apartment: z.string().trim().max(60).default(""),
  code: z.string().trim().max(60).default(""),
  type: z.string().trim().max(60).default(""),
  note: z.string().trim().max(300).default(""),
  state: z.string().trim().max(30).default("")
});
type ImportRow = z.infer<typeof importRowSchema>;
type PlannedKey = { line: number; code: string; type: string; apartmentId: string | null; apartment: string; note: string; status: "active" | "lost" };

// Jakaa tuotavat rivit uusiin, jo olemassa oleviin (ohitetaan) ja virheellisiin.
function planKeyImport(companyId: string, rows: ImportRow[]) {
  const apartments = new Map((db.prepare("SELECT id, apartment_number FROM apartments WHERE company_id = ?").all(companyId) as
    { id: string; apartment_number: string }[]).map(apartment => [apartmentKey(apartment.apartment_number), apartment]));
  const existingCodes = new Set((db.prepare("SELECT lower(code) AS code FROM building_keys WHERE company_id = ?").all(companyId) as
    { code: string }[]).map(row => row.code));
  const created: PlannedKey[] = [];
  const existing: { line: number; code: string; apartment: string }[] = [];
  const invalid: { line: number; code: string; apartment: string; reason: string }[] = [];

  for (const row of rows) {
    const fail = (reason: string) => invalid.push({ line: row.line, code: row.code, apartment: row.apartment, reason });
    if (!row.code) { fail("Avainnumero puuttuu."); continue; }
    const apartment = row.apartment ? apartments.get(apartmentKey(row.apartment)) : undefined;
    if (row.apartment && !apartment) { fail(`Asuntoa ${row.apartment} ei löydy taloyhtiöstä.`); continue; }
    const type = row.type
      ? KEY_TYPES.find(option => option.toLowerCase() === row.type.toLowerCase())
      : apartment ? "Asunto" : "Muu";
    if (!type) { fail(`Tuntematon tyyppi: ${row.type}.`); continue; }
    const state = row.state.toLowerCase();
    const status = !state || ["käytössä", "kaytossa", "active"].includes(state) ? "active"
      : ["kadonnut", "lost"].includes(state) ? "lost" : null;
    if (!status) { fail(`Tuntematon tila: ${row.state}.`); continue; }
    if (existingCodes.has(row.code.toLowerCase())) { existing.push({ line: row.line, code: row.code, apartment: row.apartment }); continue; }
    // Saman tiedoston toinen rivi samalla numerolla ohitetaan kuten jo olemassa oleva avain.
    existingCodes.add(row.code.toLowerCase());
    created.push({ line: row.line, code: row.code, type, apartmentId: apartment?.id ?? null, apartment: apartment?.apartment_number ?? "", note: row.note, status });
  }
  return { created, existing, invalid };
}

// commit = false palauttaa esikatselun tallentamatta mitään.
keysRouter.post("/companies/:companyId/keys/import", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = z.object({ rows: z.array(importRowSchema).min(1).max(5000), commit: z.boolean().default(false) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tiedostossa ei ole tuotavia rivejä." });

  const plan = planKeyImport(companyId, parsed.data.rows);
  if (parsed.data.commit) {
    const insert = db.prepare("INSERT INTO building_keys (id, company_id, code, type, apartment_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    db.transaction(() => {
      for (const key of plan.created) insert.run(id("key"), companyId, key.code, key.type, key.apartmentId, key.note, key.status, now());
    })();
  }
  res.json({ ...plan, added: parsed.data.commit ? plan.created.length : 0 });
});

function csvCell(value: string) {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Avainrekisteri CSV-tiedostona (puolipiste-erotin ja BOM, jotta Excel avaa ääkköset oikein).
keysRouter.get("/companies/:companyId/keys/export", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const keys = db.prepare(`${KEY_SELECT} WHERE k.company_id = ? ORDER BY a.apartment_number, k.code`).all(companyId) as
    { apartment_number: string | null; code: string; type: string; note: string; status: "active" | "lost"; holder_name: string | null }[];
  const lines = [
    KEY_FILE_COLUMNS.join(";"),
    ...keys.map(key => [key.apartment_number ?? "", key.code, key.type, key.note, STATE_LABELS[key.status] ?? key.status, key.holder_name ?? ""]
      .map(csvCell).join(";"))
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"avaimet.csv\"");
  res.send(`\uFEFF${lines.join("\r\n")}\r\n`);
});
