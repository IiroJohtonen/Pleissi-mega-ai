import { t } from "./i18n";

// Tehtävän aiheet samassa järjestyksessä kuin palvelimen tunnistuksessa (server/src/incidents.ts).
export const topicLabels: Record<string, string> = {
  heating: t("Lämmitys"),
  hot_water: t("Lämmin vesi"),
  water_leak: t("Vesivuoto"),
  drain: t("Viemäri tai haju"),
  electricity: t("Sähkö"),
  elevator: t("Hissi"),
  door: t("Ovi tai lukko"),
  ventilation: t("Ilmanvaihto"),
  common_room: t("Sauna tai pesutupa"),
  pests: t("Tuholaiset"),
  noise: t("Melu tai häiriö"),
  waste: t("Jätehuolto"),
  booking: t("Varaukset"),
  other: t("Muu")
};

export const topicOptions = Object.entries(topicLabels).map(([value, label]) => ({ value, label }));

export function topicLabel(topic?: string | null) {
  return topicLabels[topic ?? "other"] ?? topic ?? topicLabels.other;
}

// Paikka sanoina: "B-porras" tai "koko taloyhtiö".
export function placeLabel(stairwell: string) {
  return stairwell ? t("{0}-porras", stairwell) : t("koko taloyhtiö");
}
