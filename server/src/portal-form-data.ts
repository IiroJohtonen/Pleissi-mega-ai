import { db } from "./db.js";

// Asukasportaalin lomakkeet ja niistä syntyvien tehtävien tyypit.
export const FORM_TYPES = {
  service: "Huoltotyötilaus",
  disturbance: "Häiriöilmoitus",
  termination: "Irtisanomisilmoitus",
  application: "Asuntohakemus"
} as const;

export type FormKey = keyof typeof FORM_TYPES;
export type FormField = { label: string; value: string };

// Tehtävän lomaketiedot isännöitsijälle; null, jos tehtävä ei tullut lomakkeelta.
export function ticketForm(ticketId: string) {
  const row = db.prepare("SELECT form, fields, created_at FROM portal_forms WHERE ticket_id = ?").get(ticketId) as
    | { form: FormKey; fields: string; created_at: string }
    | undefined;
  if (!row) return null;
  return { form: row.form, title: FORM_TYPES[row.form] ?? row.form, fields: JSON.parse(row.fields) as FormField[], createdAt: row.created_at };
}
