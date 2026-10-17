import express, { type Router } from "express";
import { canSeeSensitiveTicket, companyIdFromContext } from "../access.js";
import { db } from "../db.js";
import { formSummary } from "../email-forms.js";
import { FORM_TYPES, type FormField, type FormKey } from "../portal-form-data.js";

export const formsRouter: Router = express.Router();

// Lomakkeet-taulu: taloyhtiön lomakkeilta tulleet tehtävät (verkkosivun lomakkeet sähköpostina ja
// asukasportaalin lomakkeet) lomaketyypeittäin. Arkaluonteisen tehtävän tiedot näkyvät vain niille,
// jotka saavat avata tehtävän.
formsRouter.get("/companies/:companyId/forms", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const rows = db.prepare(`
    SELECT f.form, f.fields, f.source, f.created_at, t.id AS ticket_id, t.ticket_number, t.subject, t.status, t.sensitive,
           t.assignee_id, t.company_id, r.name AS resident_name, r.email AS resident_email, a.apartment_number,
           u.name AS assignee_name
    FROM portal_forms f
    JOIN tickets t ON t.id = f.ticket_id
    LEFT JOIN residents r ON r.id = t.resident_id
    LEFT JOIN apartments a ON a.id = t.apartment_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.company_id = ?
    ORDER BY f.created_at DESC
    LIMIT 1000
  `).all(companyId) as (Record<string, any> & { form: FormKey; fields: string })[];

  res.json(rows.map(row => {
    const visible = canSeeSensitiveTicket(row as any);
    const fields = JSON.parse(row.fields) as FormField[];
    const contactName = fields.find(field => /nimi$/i.test(field.label))?.value ?? "";
    return {
      ticketId: row.ticket_id,
      ticketNumber: row.ticket_number,
      form: row.form,
      title: FORM_TYPES[row.form] ?? row.form,
      source: row.source,
      status: row.status,
      createdAt: row.created_at,
      subject: visible ? row.subject : "",
      reporter: visible ? (row.resident_name ?? contactName) : "",
      reporterEmail: visible ? row.resident_email ?? "" : "",
      apartmentNumber: visible ? row.apartment_number ?? "" : "",
      linked: Boolean(row.resident_name),
      assigneeName: row.assignee_name ?? "",
      summary: visible ? formSummary(fields) : [],
      restricted: !visible
    };
  }));
});
