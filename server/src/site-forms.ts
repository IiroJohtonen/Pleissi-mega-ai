import { z } from "zod";
import { AUTHORIZED_COMPANY_IDS } from "./access.js";
import { db } from "./db.js";
import { findApartment } from "./email-forms.js";
import type { FormField } from "./portal-form-data.js";
import { findResident } from "./routes/residents.js";
import { id, now, today } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Verkkosivun lomakkeet, jotka eivät ole tehtäviä vaan taloyhtiön tietueita: mittarilukemailmoitus
// (Lukemat), muuttoilmoitus (Muutot) ja auton lämmityspaikka (Autopaikat). Tietueella on samat kentät
// kuin sivun lomakkeella; ne tallentuvat details-sarakkeeseen ja ovat muokattavissa.
// ---------------------------------------------------------------------------------------------
export type SiteForm = "meter" | "move" | "heating";

type FieldDef = {
  key: string;
  label: string;
  type?: "text" | "tel" | "email" | "select";
  options?: string[];
  // Verkkosivun lomakkeen kentän otsikko ja monesko samanniminen kenttä se on.
  source?: [string, number];
};

const contact = (heading = ""): FieldDef[] => [
  { key: "name", label: heading ? `${heading}: nimi` : "Etu- ja sukunimi", source: ["Etu- ja Sukunimi", 1] },
  { key: "phone", label: "Puhelinnumero", type: "tel", source: ["Puhelinnumero", 1] },
  { key: "email", label: "Sähköposti", type: "email", source: ["Sähköposti", 1] }
];

export const SITE_FORM_FIELDS: Record<SiteForm, FieldDef[]> = {
  meter: [
    ...contact(),
    { key: "address", label: "Osoite", source: ["Osoite", 1] },
    { key: "apartment", label: "Huoneistonumero", source: ["Huoneistonumero", 1] }
  ],
  move: [
    {
      key: "kind", label: "Muutto", type: "select", source: ["Muutto", 1],
      options: ["Sisäänmuuttoilmoitus", "Poismuuttoilmoitus", "Uusi asukas (lisätään huoneiston asukkaisiin)"]
    },
    { key: "name", label: "Muuttajan nimi", source: ["Etu- ja Sukunimi", 1] },
    { key: "phone", label: "Puhelinnumero", type: "tel", source: ["Puhelinnumero", 1] },
    { key: "email", label: "Sähköposti", type: "email", source: ["Sähköposti", 1] },
    { key: "birthDate", label: "Syntymäaika", source: ["Syntymäaika", 1] },
    { key: "currentAddress", label: "Nykyisen asunnon katuosoite", source: ["Nykyisen asunnon katuosoite", 1] },
    { key: "currentApartment", label: "Nykyisen asunnon numero", source: ["Nykyisen asunnon numero", 1] },
    { key: "currentPostalCode", label: "Nykyinen postinumero", source: ["Nykyinen postinumero", 1] },
    { key: "currentCity", label: "Nykyinen kaupunki", source: ["Nykyinen kaupunki", 1] },
    { key: "with1Name", label: "Mukana muuttava 1", source: ["Etu- ja Sukunimi", 2] },
    { key: "with1Birth", label: "Mukana muuttava 1: syntymäaika", source: ["Syntymäaika", 2] },
    { key: "with2Name", label: "Mukana muuttava 2", source: ["Etu- ja Sukunimi", 3] },
    { key: "with2Birth", label: "Mukana muuttava 2: syntymäaika", source: ["Syntymäaika", 3] },
    { key: "with3Name", label: "Mukana muuttava 3", source: ["Etu- ja Sukunimi", 4] },
    { key: "with3Birth", label: "Mukana muuttava 3: syntymäaika", source: ["Syntymäaika", 4] },
    { key: "newAddress", label: "Uuden asunnon katuosoite", source: ["Uuden asunnon katuosoite", 1] },
    { key: "newApartment", label: "Uuden asunnon numero", source: ["Asunnon numero", 1] },
    { key: "town", label: "Paikkakunta", source: ["Paikkakunta", 1] },
    { key: "role", label: "Olen", type: "select", options: ["Vuokralainen", "Osakas", "Vuokralainen, Osakas"], source: ["Olen", 1] },
    { key: "waterPersons", label: "Vesimaksu henkilöistä", source: ["Maksun suoritus", 1] },
    { key: "waterByMeter", label: "Vesimaksu mittarin mukaan", type: "select", options: ["Mittarin mukaan"], source: ["Tai", 1] },
    {
      key: "waterPayment", label: "Maksu suoritetaan", type: "select", source: ["Maksu suoritetaan", 1],
      options: ["Taloyhtiölle erillisellä laskulla", "Omistajalle vuokran yhteydessä"]
    }
  ],
  heating: [
    { key: "address", label: "Kohteen osoite", source: ["Osoite", 1] },
    { key: "spot", label: "Tilaan", type: "select", options: ["Lämmitystolppapaikan", "Paikan katoksesta / tallista"], source: ["Tilaan", 1] },
    {
      key: "orderType", label: "Tilaustyyppi", type: "select", options: ["Toistaiseksi voimassa oleva", "Määräaikainen"],
      source: ["Tilaustyyppi", 1]
    },
    { key: "name", label: "Tilaajan nimi", source: ["Etu- ja Sukunimi", 1] },
    { key: "phone", label: "Puhelinnumero", type: "tel", source: ["Puhelinnumero", 1] },
    { key: "email", label: "Sähköposti", type: "email", source: ["Sähköposti", 1] },
    { key: "ordererAddress", label: "Tilaajan osoite", source: ["Osoite", 2] },
    { key: "city", label: "Kaupunki", source: ["Kaupunki", 1] },
    { key: "postalCode", label: "Postinumero", source: ["Postinumero", 1] }
  ]
};

export type Details = Record<string, string>;

// Lomakkeen kentät luettelona otsikoineen ja tyyppeineen; käyttöliittymä näyttää ja muokkaa näitä.
export function detailList(form: SiteForm, raw: string | Details | null | undefined) {
  const details = typeof raw === "string" ? parseDetails(raw) : raw ?? {};
  return SITE_FORM_FIELDS[form].map(field => ({
    key: field.key, label: field.label, type: field.type ?? "text", options: field.options ?? [], value: details[field.key] ?? ""
  }));
}

export function parseDetails(raw: string | null | undefined): Details {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Muokkauksessa hyväksytään vain lomakkeen kentät.
export function detailsSchema(form: SiteForm) {
  return z.object(Object.fromEntries(SITE_FORM_FIELDS[form].map(field => [field.key, z.string().trim().max(500).optional()])))
    .transform(values => Object.fromEntries(Object.entries(values).filter(([, value]) => value)) as Details);
}

// Sähköpostin kentät tietueen kentiksi. Samannimiset kentät (esim. mukana muuttavien nimet) erotetaan järjestyksestä.
function detailsFromFields(form: SiteForm, fields: FormField[]): Details {
  const details: Details = {};
  for (const def of SITE_FORM_FIELDS[form]) {
    if (!def.source) continue;
    const [label, occurrence] = def.source;
    const value = fields.filter(field => field.label === label)[occurrence - 1]?.value;
    if (value) details[def.key] = value;
  }
  return details;
}

const value = (fields: FormField[], label: string) => fields.find(field => field.label === label)?.value ?? "";

// "15.10.2026" tai "2026-10-15" → "2026-10-15"; muuten null.
export function isoDate(input: string) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (iso) return input.trim();
  const fi = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(input.trim());
  if (!fi) return null;
  return `${fi[3]}-${fi[2].padStart(2, "0")}-${fi[1].padStart(2, "0")}`;
}

const reading = (input: string) => {
  const number = Number(input.replace(/\s/g, "").replace(",", "."));
  return input.trim() && Number.isFinite(number) && number >= 0 ? number : null;
};

// Tallentaa verkkosivun lomakkeen tietueeksi. Palauttaa null, jos lomakkeesta puuttuu olennainen tieto
// (esim. lukema), jolloin viesti käsitellään tavallisena tehtävänä.
export function importSiteForm(form: SiteForm, fields: FormField[], fallbackCompanyId: string, sender: string) {
  const companies = [...AUTHORIZED_COMPANY_IDS];
  const details = detailsFromFields(form, fields);
  const timestamp = now();

  if (form === "meter") {
    const values = [["cold_water", reading(value(fields, "Kylmä vesi"))], ["hot_water", reading(value(fields, "Lämmin vesi"))]]
      .filter((entry): entry is [string, number] => entry[1] !== null);
    if (values.length === 0) return null;
    const place = findApartment(details.address ?? "", details.apartment ?? "", companies);
    const companyId = place?.companyId ?? fallbackCompanyId;
    const resident = findResident(companyId, details.email || undefined, details.name || undefined);
    const apartmentId = place?.apartmentId ?? resident?.apartment_id ?? null;
    const ids = values.map(([meterType, number]) => {
      const readingId = id("reading");
      db.prepare(`
        INSERT INTO meter_readings
          (id, company_id, apartment_id, resident_id, meter_type, reading_date, value, source, recorded_by, note, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'email', ?, '', ?, ?)
      `).run(readingId, companyId, apartmentId, resident?.id ?? null, meterType, today(), number,
        details.name || sender, JSON.stringify(details), timestamp);
      return readingId;
    });
    return { kind: "meter-readings", ids, companyId };
  }

  if (form === "move") {
    const moveDate = isoDate(value(fields, "Muuttopäivä"));
    if (!moveDate) return null;
    const kind = details.kind ?? "";
    const movesOut = /poismuutto/i.test(kind);
    // Poismuutossa kohde on nykyinen asunto, muuten uusi asunto.
    const target = movesOut
      ? findApartment(details.currentAddress ?? "", details.currentApartment ?? "", companies)
      : findApartment(details.newAddress ?? "", details.newApartment ?? "", companies)
        ?? findApartment(details.currentAddress ?? "", details.currentApartment ?? "", companies);
    const companyId = target?.companyId ?? fallbackCompanyId;
    const resident = findResident(companyId, details.email || undefined, details.name || undefined);
    const newResidents = movesOut ? [] : [
      ...(details.name ? [{ name: details.name, email: details.email ?? "" }] : []),
      ...[1, 2, 3].map(index => details[`with${index}Name`]).filter(Boolean).map(name => ({ name, email: "" }))
    ];
    const moveId = id("move");
    db.prepare(`
      INSERT INTO move_notices (id, company_id, apartment_id, resident_id, move_date, moves_out, new_residents, door_name, note, details, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, 'email', ?)
    `).run(moveId, companyId, target?.apartmentId ?? (movesOut ? resident?.apartment_id : null) ?? null, resident?.id ?? null,
      moveDate, movesOut ? 1 : 0, JSON.stringify(newResidents), JSON.stringify(details), timestamp);
    return { kind: "moves", ids: [moveId], companyId };
  }

  const place = findApartment(details.address ?? "", "", companies);
  const companyId = place?.companyId ?? fallbackCompanyId;
  const resident = findResident(companyId, details.email || undefined, details.name || undefined);
  const orderId = id("heating");
  db.prepare(`
    INSERT INTO heating_orders (id, company_id, apartment_id, resident_id, start_date, end_date, details, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'email', ?, ?)
  `).run(orderId, companyId, place?.apartmentId ?? resident?.apartment_id ?? null, resident?.id ?? null,
    isoDate(value(fields, "Tarve lämmityspaikalle alkaen")), isoDate(value(fields, "Mikäli määräaikainen, loppumispäivä")),
    JSON.stringify(details), timestamp, timestamp);
  return { kind: "heating-orders", ids: [orderId], companyId };
}
