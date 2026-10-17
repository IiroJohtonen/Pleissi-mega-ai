import { db } from "./db.js";

// Asukasportaalin lomakkeet ja niistä syntyvien tehtävien tyypit.
export const FORM_TYPES = {
  service: "Huoltotyötilaus",
  disturbance: "Häiriöilmoitus",
  termination: "Irtisanomisilmoitus",
  application: "Asuntohakemus",
  // Vain verkkosivun lomakkeista sähköpostilla tulevat; portaalissa näillä on omat näkymänsä.
  meter: "Mittarilukemailmoitus",
  move: "Muuttoilmoitus",
  heating: "Auton lämmityspaikka"
} as const;

export type FormKey = keyof typeof FORM_TYPES;
export type FormField = { label: string; value: string };

// Tehtävän lomaketiedot isännöitsijälle; null, jos tehtävä ei tullut lomakkeelta.
export function ticketForm(ticketId: string) {
  const row = db.prepare("SELECT form, fields, source, created_at FROM portal_forms WHERE ticket_id = ?").get(ticketId) as
    | { form: FormKey; fields: string; source: string; created_at: string }
    | undefined;
  if (!row) return null;
  return {
    form: row.form, title: FORM_TYPES[row.form] ?? row.form, fields: JSON.parse(row.fields) as FormField[],
    source: row.source, createdAt: row.created_at
  };
}

// Lomake tuli joko asukasportaalista ('portal') tai verkkosivun lomakkeelta sähköpostina ('email').
const formColumns = db.prepare("PRAGMA table_info(portal_forms)").all() as { name: string }[];
if (!formColumns.some(column => column.name === "source")) {
  db.exec("ALTER TABLE portal_forms ADD COLUMN source TEXT NOT NULL DEFAULT 'portal'");
}
