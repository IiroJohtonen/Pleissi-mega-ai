import { formatDate, formatDateOnly } from "./format";
import { t } from "./i18n";
import type { TicketTab } from "./types";
import { meterLabel } from "./views/Meters";

// Data-osion taulut: taloyhtiön alasivujen tiedot kaikista taloyhtiöistä suodattamattomina.
// Taulun avain on sama kuin taloyhtiön alasivun näkymä, joten roolin pääsy tauluun koskee molempia.
export type DataRow = Record<string, unknown> & { id: string; company_id: string; company_name: string };
export type DataColumn = { key: string; label: string; format?: (value: unknown, row: DataRow) => string };

const statusLabels: Record<string, string> = {
  pending: t("Odottaa"),
  approved: t("Hyväksytty"),
  rejected: t("Hylätty"),
  completed: t("Valmis"),
  waiting: t("Jonossa"),
  offered: t("Tarjottu"),
  done: t("Valmis"),
  cancelled: t("Peruttu"),
  active: t("Voimassa"),
  archived: t("Arkistoitu"),
  lost: t("Kadonnut")
};

const text = (value: unknown) => value === null || value === undefined || value === "" ? "–" : String(value);
const status = (value: unknown) => statusLabels[String(value)] ?? text(value);
const date = (value: unknown) => value ? formatDateOnly(String(value)) : "–";
const dateTime = (value: unknown) => value ? formatDate(String(value)) : "–";
const yesNo = (value: unknown) => value ? t("Kyllä") : t("Ei");

const residentColumns: DataColumn[] = [
  { key: "resident_name", label: t("Asukas") },
  { key: "apartment_number", label: t("Asunto") }
];

const knowledgeColumns: DataColumn[] = [
  { key: "doc_number", label: t("Numero"), format: value => value ? `#K${String(value).padStart(6, "0")}` : "–" },
  { key: "title", label: t("Otsikko") },
  { key: "kind", label: t("Laji"), format: value => value === "document" ? t("Dokumentti") : t("Vakiotieto") },
  { key: "audience", label: t("Kohde"), format: value => value === "internal" ? t("Sisäinen") : t("AI") },
  { key: "status", label: t("Tila"), format: status },
  { key: "version", label: t("Versio") },
  { key: "valid_until", label: t("Voimassa asti"), format: date },
  { key: "created_at", label: t("Luotu"), format: dateTime }
];

const bookingColumns: DataColumn[] = [
  { key: "starts_at", label: t("Alkaa"), format: dateTime },
  { key: "ends_at", label: t("Päättyy"), format: dateTime },
  ...residentColumns,
  { key: "note", label: t("Huomio") },
  { key: "created_by", label: t("Varaaja") }
];

export const dataColumns: Partial<Record<TicketTab, DataColumn[]>> = {
  knowledge: knowledgeColumns,
  "knowledge-ai": knowledgeColumns,
  "knowledge-internal": knowledgeColumns,
  residents: [
    { key: "name", label: t("Nimi") },
    { key: "email", label: t("Sähköposti") },
    { key: "roles", label: t("Roolit") },
    { key: "apartment_number", label: t("Asunto") },
    { key: "address", label: t("Osoite") },
    { key: "moved_out_at", label: t("Muuttanut pois"), format: date },
    { key: "erased_at", label: t("Tiedot poistettu"), format: date }
  ],
  apartments: [
    { key: "apartment_number", label: t("Asunto") },
    { key: "staircase", label: t("Rappu") },
    { key: "address", label: t("Osoite") },
    { key: "resident_count", label: t("Henkilöt") }
  ],
  waitlist: [
    { key: "resource", label: t("Jono"), format: (value, row) => value === "parking" ? `${t("Autopaikka")}${row.parking_type ? ` (${String(row.parking_type)})` : ""}` : value === "sauna" ? t("Sauna") : text(value) },
    ...residentColumns,
    { key: "status", label: t("Tila"), format: status },
    { key: "created_at", label: t("Jonoon"), format: dateTime },
    { key: "offered_at", label: t("Tarjottu"), format: dateTime },
    { key: "note", label: t("Huomio") }
  ],
  keys: [
    { key: "code", label: t("Tunnus") },
    { key: "type", label: t("Tyyppi"), format: value => t(text(value)) },
    { key: "apartment_number", label: t("Asunto") },
    { key: "status", label: t("Tila"), format: status },
    { key: "holder_name", label: t("Haltija") },
    { key: "handed_at", label: t("Luovutettu"), format: date },
    { key: "due_date", label: t("Palautettava"), format: date },
    { key: "note", label: t("Huomio") }
  ],
  sauna: bookingColumns,
  laundry: bookingColumns,
  parking: [
    { key: "label", label: t("Paikka") },
    { key: "type", label: t("Tyyppi") },
    { key: "resident_name", label: t("Haltija") },
    { key: "apartment_number", label: t("Asunto") },
    { key: "note", label: t("Huomio") }
  ],
  announcements: [
    { key: "title", label: t("Otsikko") },
    { key: "stairwell", label: t("Rappu") },
    { key: "emailed_count", label: t("Sähköpostit") },
    { key: "created_by", label: t("Lähettäjä") },
    { key: "created_at", label: t("Julkaistu"), format: dateTime }
  ],
  moves: [
    { key: "move_date", label: t("Muuttopäivä"), format: date },
    { key: "moves_out", label: t("Poismuutto"), format: yesNo },
    ...residentColumns,
    { key: "address", label: t("Osoite") },
    { key: "status", label: t("Tila"), format: status },
    { key: "created_at", label: t("Ilmoitettu"), format: dateTime },
    { key: "decided_by", label: t("Käsittelijä") }
  ],
  renovations: [
    { key: "work_type", label: t("Työ") },
    { key: "start_date", label: t("Alkaa"), format: date },
    { key: "end_date", label: t("Päättyy"), format: date },
    ...residentColumns,
    { key: "contractor", label: t("Urakoitsija") },
    { key: "status", label: t("Tila"), format: status },
    { key: "created_at", label: t("Ilmoitettu"), format: dateTime }
  ],
  meters: [
    { key: "reading_date", label: t("Päivä"), format: date },
    { key: "meter_type", label: t("Mittari"), format: value => meterLabel(String(value)) },
    { key: "value", label: t("Lukema") },
    ...residentColumns,
    { key: "source", label: t("Lähde"), format: value => value === "portal" ? t("Asukas") : value === "office" ? t("Toimisto") : text(value) },
    { key: "recorded_by", label: t("Kirjaaja") }
  ]
};

export function isDataTable(table: string | null | undefined): table is TicketTab {
  return !!table && Object.hasOwn(dataColumns, table);
}

// Solun teksti: sarakkeen oma muotoilu tai arvo sellaisenaan.
export function dataCellText(column: DataColumn, row: DataRow) {
  return column.format ? column.format(row[column.key], row) : text(row[column.key]);
}
