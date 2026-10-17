import express, { type Router } from "express";
import { z } from "zod";
import type { ResidentAccount } from "../auth.js";
import { db } from "../db.js";
import { FORM_TYPES, type FormField, type FormKey } from "../portal-form-data.js";
import { now, today } from "../util.js";
import { createPortalTicket, portalAttachmentsSchema, portalResident } from "./portal.js";

// ---------------------------------------------------------------------------------------------
// Asukasportaalin lomakkeet: huoltotyötilaus, häiriöilmoitus, irtisanomisilmoitus ja asuntohakemus.
// Jokainen lomake luo tavallisen tehtävän (päätösjono, käsittelijä, viestit ja tilapäivitykset), ja
// lomakkeen kentät tallennetaan otsikoineen, jotta isännöitsijä näkee ne tehtävällä selkeästi.
// ---------------------------------------------------------------------------------------------

export const SERVICE_TARGETS = ["Oma asunto", "Porraskäytävä tai yhteiset tilat", "Piha tai ulkoalueet", "Autopaikka tai autotalli"] as const;
export const SERVICE_ENTRY = ["Huolto saa mennä asuntoon yleisavaimella", "Sovitaan käyntiaika ensin"] as const;
export const DISTURBANCE_TYPES = ["Melu", "Tupakointi", "Järjestyssääntöjen rikkominen", "Roskaaminen tai sotkeminen", "Lemmikit", "Muu häiriö"] as const;
export const APARTMENT_SIZES = ["Yksiö", "Kaksio", "Kolmio", "Neljä huonetta tai enemmän"] as const;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)));
const optionalText = (max: number) => z.string().trim().max(max).default("");
const phone = optionalText(40);

const schemas: Record<FormKey, z.ZodTypeAny> = {
  service: z.object({
    target: z.enum(SERVICE_TARGETS),
    location: optionalText(120),
    description: z.string().trim().min(5).max(3000),
    entry: z.union([z.literal(""), z.enum(SERVICE_ENTRY)]).default(""),
    pets: z.boolean().default(false),
    phone,
    attachments: portalAttachmentsSchema
  }),
  disturbance: z.object({
    category: z.enum(DISTURBANCE_TYPES),
    source: optionalText(120),
    date,
    time: optionalText(40),
    recurring: z.boolean().default(false),
    description: z.string().trim().min(5).max(3000),
    discussed: z.boolean().default(false),
    nameAllowed: z.boolean().default(false),
    attachments: portalAttachmentsSchema
  }),
  termination: z.object({
    endDate: date,
    tenants: z.string().trim().min(2).max(300),
    newAddress: optionalText(200),
    phone,
    note: optionalText(2000),
    confirm: z.literal(true)
  }),
  application: z.object({
    sizes: z.array(z.enum(APARTMENT_SIZES)).min(1).max(APARTMENT_SIZES.length),
    area: optionalText(200),
    maxRent: z.number().min(0).max(100000).nullable().default(null),
    moveDate: z.union([z.literal(""), date]).default(""),
    adults: z.number().int().min(1).max(20),
    children: z.number().int().min(0).max(20).default(0),
    pets: z.boolean().default(false),
    reason: optionalText(2000),
    phone
  })
};


const yesNo = (value: boolean) => (value ? "Kyllä" : "Ei");
export const finnishDate = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return `${day}.${month}.${year}`;
};

// Vuokralaisen irtisanomisaika on yksi kuukausi, ja se lasketaan sen kalenterikuukauden viimeisestä
// päivästä, jona irtisanominen tehdään: vuokrasuhde voi päättyä aikaisintaan seuraavan kuun lopussa.
export function earliestTerminationDate(from = today()) {
  const [year, month] = from.split("-").map(Number);
  const last = new Date(Date.UTC(year, month + 1, 0));
  return last.toISOString().slice(0, 10);
}

// Lomakkeen otsikko tehtävälle ja kentät otsikoineen. Tyhjät valinnaiset kentät jätetään pois.
function describe(form: FormKey, data: any, resident: ResidentAccount): { subject: string; fields: FormField[] } {
  const fields: FormField[] = [];
  const add = (label: string, value: string) => {
    if (value.trim()) fields.push({ label, value: value.trim() });
  };

  if (form === "service") {
    add("Kohde", data.target);
    add("Tarkempi paikka", data.location);
    add("Kuvaus", data.description);
    if (data.target === "Oma asunto") {
      add("Asuntoon pääsy", data.entry || "Ei valittu");
      add("Asunnossa on lemmikki", yesNo(data.pets));
    }
    add("Puhelin", data.phone);
    return { subject: `Huoltotyötilaus: ${data.target}${data.location ? ` – ${data.location}` : ""}`, fields };
  }

  if (form === "disturbance") {
    add("Häiriön laji", data.category);
    add("Mistä häiriö tulee", data.source);
    add("Ajankohta", `${finnishDate(data.date)}${data.time ? ` klo ${data.time}` : ""}`);
    add("Häiriö toistuu", yesNo(data.recurring));
    add("Kuvaus", data.description);
    add("Asiasta puhuttu häiritsijän kanssa", yesNo(data.discussed));
    add("Ilmoittajan nimen saa kertoa häiritsijälle", yesNo(data.nameAllowed));
    return { subject: `Häiriöilmoitus: ${data.category}${data.source ? ` – ${data.source}` : ""}`, fields };
  }

  if (form === "termination") {
    const earliest = earliestTerminationDate();
    add("Asunto", resident.apartmentNumber);
    add("Vuokrasuhde päättyy", finnishDate(data.endDate));
    if (data.endDate < earliest) {
      add("Huomio", `Päättymispäivä on ennen irtisanomisajan päättymistä (aikaisintaan ${finnishDate(earliest)}).`);
    }
    add("Vuokralaiset", data.tenants);
    add("Uusi osoite", data.newAddress);
    add("Puhelin", data.phone);
    add("Lisätiedot", data.note);
    add("Irtisanominen vahvistettu", `Kyllä, ${finnishDate(today())}`);
    return { subject: `Irtisanomisilmoitus: asunto ${resident.apartmentNumber}, päättyy ${finnishDate(data.endDate)}`, fields };
  }

  add("Haettava asunto", data.sizes.join(", "));
  add("Toivottu alue tai taloyhtiö", data.area);
  if (data.maxRent !== null) add("Vuokra enintään", `${data.maxRent} €/kk`);
  if (data.moveDate) add("Toivottu muuttopäivä", finnishDate(data.moveDate));
  add("Aikuisia", String(data.adults));
  add("Lapsia", String(data.children));
  add("Lemmikkejä", yesNo(data.pets));
  add("Hakemuksen syy ja lisätiedot", data.reason);
  add("Puhelin", data.phone);
  add("Nykyinen asunto", `${resident.companyName}, ${resident.apartmentNumber}`);
  return { subject: `Asuntohakemus: ${data.sizes.join(", ")}`, fields };
}

const formErrors: Record<FormKey, string> = {
  service: "Valitse kohde ja kirjoita vian kuvaus.",
  disturbance: "Valitse häiriön laji, päivä ja kirjoita kuvaus.",
  termination: "Anna päättymispäivä, vuokralaisten nimet ja vahvista irtisanominen.",
  application: "Valitse vähintään yksi asuntotyyppi ja kerro aikuisten määrä."
};

export const portalFormsRouter: Router = express.Router();

portalFormsRouter.post("/portal/forms/:form", async (req, res) => {
  const form = req.params.form as FormKey;
  if (!Object.hasOwn(schemas, form)) return res.status(404).json({ error: "Lomaketta ei löytynyt." });
  const resident = portalResident(res);
  const parsed = schemas[form].safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: formErrors[form] });

  const data = parsed.data as any;
  const { subject, fields } = describe(form, data, resident);
  const description = fields.map(field => `${field.label}: ${field.value}`).join("\n");
  const { ticketId, attachmentError } = await createPortalTicket(
    resident,
    { subject: subject.slice(0, 150), description, type: FORM_TYPES[form], attachments: data.attachments ?? [] },
    created => {
      db.prepare("INSERT INTO portal_forms (ticket_id, form, resident_id, fields, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(created, form, resident.id, JSON.stringify(fields), now());
    }
  );
  res.status(201).json({ ok: true, ticketId, attachmentError });
});
