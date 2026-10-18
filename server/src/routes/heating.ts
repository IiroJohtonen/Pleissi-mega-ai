import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { db } from "../db.js";
import { detailList, detailsSchema, parseDetails } from "../site-forms.js";
import { id, now } from "../util.js";
import { portalResident } from "./portal.js";

export const heatingRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Autopaikkatilaukset Jonot ja tilaukset -sivulla. Tilaus tulee verkkosivun lomakkeelta sähköpostina,
// asukasportaalista tai toimiston kirjaamana; kentät ovat samat kuin sivun lomakkeella. Paikkatyyppi on
// jokin taloyhtiön autopaikkavaihtoehdoista.
// ---------------------------------------------------------------------------------------------
export const HEATING_STATUSES = ["pending", "approved", "rejected", "ended"] as const;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)));
const orderSchema = z.object({
  apartmentId: z.string().min(1).nullable().default(null),
  startDate: z.union([date, z.null()]).default(null),
  endDate: z.union([date, z.null()]).default(null),
  status: z.enum(HEATING_STATUSES).default("pending"),
  note: z.string().trim().max(1000).default(""),
  parkingType: z.string().trim().max(60).default(""),
  details: detailsSchema("heating").default({})
});

const ORDER_SELECT = `
  SELECT h.*, a.apartment_number, a.address, r.name AS resident_name, r.email AS resident_email
  FROM heating_orders h
  LEFT JOIN apartments a ON a.id = h.apartment_id
  LEFT JOIN residents r ON r.id = h.resident_id
`;

const withDetails = (row: Record<string, unknown> & { details: string }) => ({ ...row, details: detailList("heating", row.details) });

function apartmentError(apartmentId: string | null, companyId: string) {
  return apartmentId && !db.prepare("SELECT 1 FROM apartments WHERE id = ? AND company_id = ?").get(apartmentId, companyId)
    ? "Asuntoa ei löytynyt tästä taloyhtiöstä."
    : null;
}

heatingRouter.get("/companies/:companyId/heating-orders", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const rows = db.prepare(`${ORDER_SELECT} WHERE h.company_id = ? ORDER BY h.status = 'pending' DESC, h.created_at DESC`)
    .all(companyId) as (Record<string, unknown> & { details: string })[];
  res.json(rows.map(withDetails));
});

heatingRouter.post("/companies/:companyId/heating-orders", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = orderSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Tarkista tilauksen tiedot." });
  const error = apartmentError(parsed.data.apartmentId, companyId);
  if (error) return res.status(404).json({ error });
  const orderId = id("heating");
  const timestamp = now();
  db.prepare(`
    INSERT INTO heating_orders (id, company_id, apartment_id, start_date, end_date, status, note, parking_type, details, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'office', ?, ?)
  `).run(orderId, companyId, parsed.data.apartmentId, parsed.data.startDate, parsed.data.endDate, parsed.data.status,
    parsed.data.note, parsed.data.parkingType, JSON.stringify(parsed.data.details), timestamp, timestamp);
  res.status(201).json({ ok: true, orderId });
});

heatingRouter.put("/heating-orders/:id", (req, res) => {
  const order = db.prepare("SELECT id, company_id, details FROM heating_orders WHERE id = ?").get(req.params.id) as
    { id: string; company_id: string; details: string } | undefined;
  if (!order || !companyIdFromContext(order.company_id)) return res.status(404).json({ error: "Tilausta ei löytynyt." });
  const parsed = orderSchema.extend({ details: detailsSchema("heating").optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Tarkista tilauksen tiedot." });
  const error = apartmentError(parsed.data.apartmentId, order.company_id);
  if (error) return res.status(404).json({ error });
  db.prepare(`
    UPDATE heating_orders SET apartment_id = ?, start_date = ?, end_date = ?, status = ?, note = ?, parking_type = ?, details = ?, updated_at = ?
    WHERE id = ?
  `).run(parsed.data.apartmentId, parsed.data.startDate, parsed.data.endDate, parsed.data.status, parsed.data.note,
    parsed.data.parkingType, JSON.stringify(parsed.data.details ?? parseDetails(order.details)), now(), order.id);
  res.json({ ok: true });
});

heatingRouter.delete("/heating-orders/:id", (req, res) => {
  const order = db.prepare("SELECT id, company_id FROM heating_orders WHERE id = ?").get(req.params.id) as
    { id: string; company_id: string } | undefined;
  if (!order || !companyIdFromContext(order.company_id)) return res.status(404).json({ error: "Tilausta ei löytynyt." });
  db.prepare("DELETE FROM heating_orders WHERE id = ?").run(order.id);
  res.json({ ok: true });
});

// Asukasportaalin tilaus: kohde ja tilaaja tulevat kirjautumisesta, asukas valitsee paikan ja ajan.
heatingRouter.post("/portal/heating-orders", (req, res) => {
  const resident = portalResident(res);
  const parsed = z.object({
    spot: z.enum(["Lämmitystolppapaikan", "Paikan katoksesta / tallista"]),
    orderType: z.enum(["Toistaiseksi voimassa oleva", "Määräaikainen"]),
    startDate: date,
    endDate: z.union([z.literal(""), date]).default(""),
    phone: z.string().trim().max(40).default("")
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valitse paikka, tilaustyyppi ja aloituspäivä." });
  if (parsed.data.orderType === "Määräaikainen" && !parsed.data.endDate) {
    return res.status(400).json({ error: "Anna määräaikaiselle tilaukselle loppumispäivä." });
  }
  if (parsed.data.endDate && parsed.data.endDate < parsed.data.startDate) {
    return res.status(400).json({ error: "Loppumispäivä ei voi olla ennen aloituspäivää." });
  }
  const apartment = db.prepare("SELECT address FROM apartments WHERE id = ?").get(resident.apartmentId) as { address: string } | undefined;
  const details = {
    address: apartment?.address ?? "", spot: parsed.data.spot, orderType: parsed.data.orderType, name: resident.name,
    phone: parsed.data.phone, email: resident.email ?? "", ordererAddress: [apartment?.address, resident.apartmentNumber].filter(Boolean).join(" ")
  };
  const orderId = id("heating");
  const timestamp = now();
  db.prepare(`
    INSERT INTO heating_orders (id, company_id, apartment_id, resident_id, start_date, end_date, details, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'portal', ?, ?)
  `).run(orderId, resident.companyId, resident.apartmentId || null, resident.id, parsed.data.startDate, parsed.data.endDate || null,
    JSON.stringify(Object.fromEntries(Object.entries(details).filter(([, value]) => value))), timestamp, timestamp);
  res.status(201).json({ ok: true, orderId });
});

heatingRouter.get("/portal/heating-orders", (_req, res) => {
  res.json(db.prepare(`
    SELECT id, start_date, end_date, status, details, created_at FROM heating_orders WHERE resident_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(portalResident(res).id).map(row => withDetails(row as Record<string, unknown> & { details: string })));
});
