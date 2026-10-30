import { db } from "./db.js";
import { FORM_TYPES, type FormField, type FormKey } from "./portal-form-data.js";

// ---------------------------------------------------------------------------------------------
// Isännöitsijäyrityksen verkkosivun lomakkeet sähköpostina. Sivun lomake (esim. Huoltotyötilaus)
// lähettää täytetyt tiedot toimiston postiin; otsikosta tunnistetaan lomake, ja viestin rivit
// "Kenttä: arvo" luetaan lomakkeen kentiksi. Tunnettujen kenttien otsikot ovat sivun lomakkeista,
// joten myös taulukkomuotoinen viesti ("Kenttä    arvo" samalla rivillä) luetaan oikein.
// ---------------------------------------------------------------------------------------------

// Tunnistus otsikosta. Järjestys ratkaisee, jos otsikossa on useampi sana (esim. "Muuttoilmoitus").
const SUBJECT_PATTERNS: [FormKey, RegExp][] = [
  ["termination", /irtisano/i],
  ["application", /asuntohakemus/i],
  ["heating", /lämmity(spaik|stolp)/i],
  ["meter", /mittarilukem/i],
  ["move", /muuttoilmoitus/i],
  ["service", /huolto(työ|pyyntö)|huoltotyötilaus/i],
  ["disturbance", /häiriöilmoitus/i]
];

// Verkkosivun lomakkeiden kenttien otsikot.
const KNOWN_LABELS: Record<FormKey, string[]> = {
  meter: ["Etu- ja Sukunimi", "Puhelinnumero", "Sähköposti", "Osoite", "Huoneistonumero", "Kylmä vesi", "Lämmin vesi"],
  move: [
    "Muutto", "Etu- ja Sukunimi", "Puhelinnumero", "Sähköposti", "Syntymäaika", "Nykyisen asunnon katuosoite",
    "Nykyisen asunnon numero", "Nykyinen postinumero", "Nykyinen kaupunki", "Muuttopäivä", "Uuden asunnon katuosoite",
    "Asunnon numero", "Paikkakunta", "Olen", "Maksun suoritus", "Tai", "Maksu suoritetaan"
  ],
  service: [
    "Etu- ja Sukunimi", "Puhelinnumero", "Sähköposti", "Osoite", "Huoneistonumero", "Paikkakunta", "Huoltotyö",
    "Huoneistoon pääsemiseksi saa käyttää yleisavainta", "Asunnossa on lemmikkieläimiä"
  ],
  heating: [
    "Osoite", "Tilaan", "Tilaustyyppi", "Tarve lämmityspaikalle alkaen", "Mikäli määräaikainen, loppumispäivä",
    "Etu- ja Sukunimi", "Puhelinnumero", "Sähköposti", "Kaupunki", "Postinumero"
  ],
  application: [
    "Hakijan nimi", "Henkilötunnus", "Osoite", "Postinumero", "Postitoimipaikka", "Puhelinnumero", "Sähköposti",
    "Arvo tai ammatti", "Toisen hakijan nimi", "Toisen hakijan henkilötunnus", "Henkilö 1 - Nimi", "Henkilö 1 - Syntymäaika",
    "Henkilö 2 - Nimi", "Henkilö 2 - Syntymäaika", "Henkilö 3 - Nimi", "Henkilö 3 - Syntymäaika", "Kaupunki",
    "Kaupunginosa tai kylä (Valinnainen)", "Kaupunginosa tai kylä", "Huoneet / tilat", "Huoneiston koko (m²)", "Talotyyppi",
    "Muita toivomuksia", "Muuton syy", "Jos muu, mikä?", "Asunnon tarve alkaen",
    "Nykyisen asunnon hallintasuhteen päättymisen syy", "Lisätietoja"
  ],
  disturbance: ["Osoite", "Ilmoittajan nimi", "Puhelinnumero", "Sähköposti", "Pvm.", "Ajankohta", "Häiriön laatu", "Asunnon numero"],
  termination: [
    "Vuokralaisen nimi", "Vuokralaisen puhelinnumero", "Irtisanottavan asunnon katuosoite", "Postitoimipaikka",
    "Pankkitilinumero", "Onko uusi osoite tiedossa?", "Uusi katuosoite", "Uusi postitoimipaikka", "Irtisanomisen syy (valinnainen)",
    "Irtisanomisen syy", "Vahvistus"
  ]
};

// Lomakkeen teknisiä arvoja (esim. irtisanomislomakkeen valinnat) käyttäjän kielelle.
const VALUE_NAMES: Record<string, string> = { uusi_kylla: "Kyllä", uusi_ei: "Ei", vahvistus: "Vahvistettu" };

// Kentät, joista ilmoittaja, yhteystiedot ja kohde luetaan.
const NAME_LABELS = ["Etu- ja Sukunimi", "Hakijan nimi", "Ilmoittajan nimi", "Vuokralaisen nimi"];
const EMAIL_LABELS = ["Sähköposti"];
const PHONE_LABELS = ["Puhelinnumero", "Puhelin"];
const ADDRESS_LABELS = ["Osoite", "Irtisanottavan asunnon katuosoite", "Nykyisen asunnon katuosoite"];
const APARTMENT_LABELS = ["Huoneistonumero", "Nykyisen asunnon numero"];

export { KNOWN_LABELS };

export function detectEmailForm(subject: string): FormKey | null {
  return SUBJECT_PATTERNS.find(([, pattern]) => pattern.test(subject))?.[0] ?? null;
}

// Lomakepalvelun viestin loppuun lisäämät tekniset tiedot, joita ei näytetä lomakkeen kenttinä.
const METADATA_LABELS = /^(date|time|page url|user agent|remote ip|powered by|päivämäärä|aika|sivun url|sivun osoite|käyttäjäagentti|ip-osoite|lähetetty)$/i;

const cleanLabel = (label: string) => label.replace(/\s*\*\s*$/, "").replace(/:$/, "").trim();
const cleanValue = (value: string) => {
  const trimmed = value.trim();
  // Lomakkeen päivämäärä (vvvv-kk-pp) suomalaiseen muotoon.
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (date) return `${Number(date[3])}.${Number(date[2])}.${date[1]}`;
  return VALUE_NAMES[trimmed] ?? trimmed;
};

// Lukee viestin rivit kentiksi. Tunnetut otsikot tunnistetaan sekä muodossa "Kenttä: arvo" että
// "Kenttä   arvo"; muut "Otsikko: arvo" -rivit otetaan mukaan sellaisinaan. Arvo voi jatkua seuraaville
// riveille (esim. huoltotyön kuvaus), kunnes tulee seuraava kenttä.
export function parseFormFields(form: FormKey, body: string): FormField[] {
  const known = [...KNOWN_LABELS[form]].sort((a, b) => b.length - a.length);
  const fields: FormField[] = [];
  let current: FormField | null = null;

  for (const raw of body.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line || /^-{2,}$/.test(line)) {
      current = null;
      continue;
    }
    const label = known.find(item => {
      const lower = line.toLowerCase();
      const prefix = item.toLowerCase();
      if (!lower.startsWith(prefix)) return false;
      const rest = line.slice(item.length);
      return rest === "" || /^\s*\*?\s*[:\t]/.test(rest) || /^\s{2,}\S/.test(rest) || /^\s*\*?\s*$/.test(rest);
    });
    if (label) {
      const value = line.slice(label.length).replace(/^\s*\*?\s*:?\s*/, "");
      current = { label, value: cleanValue(value) };
      fields.push(current);
      continue;
    }
    const generic = /^([^:]{2,60}):\s*(.*)$/.exec(line);
    if (generic && !/^https?$/i.test(generic[1])) {
      if (METADATA_LABELS.test(cleanLabel(generic[1]))) {
        current = null;
        continue;
      }
      current = { label: cleanLabel(generic[1]), value: cleanValue(generic[2]) };
      fields.push(current);
      continue;
    }
    // Jatkorivi edelliselle kentälle tai arvo otsikkonsa alla omalla rivillään.
    if (current) current.value = current.value ? `${current.value}\n${line}` : cleanValue(line);
  }
  // Tyhjiä valinnaisia kenttiä ei näytetä.
  return fields.filter(field => field.value.trim() !== "");
}

export const first = (fields: FormField[], labels: string[]) => fields.find(field => labels.includes(field.label))?.value ?? "";

// Ilmoittajan nimi ja sähköposti lomakkeen kentistä; lähettäjä on usein verkkosivun oma osoite.
export function formContact(fields: FormField[]) {
  return { name: first(fields, NAME_LABELS), email: first(fields, EMAIL_LABELS), phone: first(fields, PHONE_LABELS) };
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9åäö]/g, "");

// Taloyhtiö ja asunto lomakkeen osoitteesta: katuosoite verrataan asuntojen osoitteisiin ja
// huoneistonumero asunnon numeroon. Palauttaa null, jos osoitetta ei tunnisteta.
export function apartmentForForm(fields: FormField[], companyIds: string[]) {
  return findApartment(first(fields, ADDRESS_LABELS), first(fields, APARTMENT_LABELS), companyIds);
}

// Asunto katuosoitteen ja huoneistonumeron perusteella. Osoitteessa voi olla myös huoneisto
// ("Koivikkotie 10 B 34"). Palauttaa taloyhtiön, vaikka huoneistoa ei tunnistettaisi.
export function findApartment(address: string, apartment: string, companyIds: string[]) {
  if (!address.trim() || companyIds.length === 0) return null;
  const apartmentNumber = normalize(apartment);
  const street = normalize(address.split(",")[0]);
  const rows = db.prepare(`
    SELECT id, company_id, apartment_number, address FROM apartments
    WHERE company_id IN (${companyIds.map(() => "?").join(", ")})
  `).all(...companyIds) as { id: string; company_id: string; apartment_number: string; address: string }[];
  // Sama katu ja numero: "koivikkotie10" ei saa vastata osoitetta "koivikkotie1".
  const sameStreet = rows.filter(row => {
    const candidate = normalize(row.address);
    return candidate && street.startsWith(candidate) && !/\d/.test(street.charAt(candidate.length));
  });
  if (sameStreet.length === 0) return null;
  const exact = sameStreet.find(row => {
    const number = normalize(row.apartment_number);
    return (apartmentNumber && (number === apartmentNumber || apartmentNumber.endsWith(number))) || street.endsWith(number);
  });
  return { companyId: (exact ?? sameStreet[0]).company_id, apartmentId: exact?.id ?? null };
}

// Tehtävän otsikko: lomakkeen nimi ja kohde, esim. "Huoltotyötilaus: Koivikkotie 10, B 34".
export function formSubject(form: FormKey, fields: FormField[], fallback: string) {
  const place = [first(fields, ADDRESS_LABELS), first(fields, APARTMENT_LABELS)].filter(Boolean).join(", ");
  const who = first(fields, NAME_LABELS);
  const detail = place || who || fallback;
  return `${FORM_TYPES[form]}: ${detail}`.slice(0, 150);
}
