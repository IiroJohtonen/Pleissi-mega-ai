import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SENDER_TYPES } from "../src/sender-types.js";

// ---------------------------------------------------------------------------------------------
// Evaluoinnin tapaukset (Evaluation suite spec, Tapauksen muoto): yksi JSON-tiedosto per tapaus
// kansiossa cases/<toiminto>/. Repoon menee vain keksittyä tai anonymisoitua dataa.
// ---------------------------------------------------------------------------------------------

export const PRIORITIES = ["emergency", "urgent", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const AssessCaseSchema = z.object({
  id: z.string().regex(/^assess-\d{3}$/),
  feature: z.literal("assess"),
  // synthetic = itse kirjoitettu, real = anonymisoitu oikea viesti, production = tuotannossa havaittu virhe.
  source: z.enum(["synthetic", "real", "production"]),
  tags: z.array(z.string()),
  input: z.object({ subject: z.string(), body: z.string(), sender: z.string() }),
  expected: z.object({
    relevant: z.boolean(),
    // Prioriteetit, joista mikä tahansa kelpaa.
    priorityAcceptable: z.array(z.enum(PRIORITIES)).min(1),
    // Lähettäjätyypit, joista mikä tahansa kelpaa (sender-types.ts). Puuttuu = ei tarkisteta.
    senderTypeAcceptable: z.array(z.enum(SENDER_TYPES)).min(1).optional()
  }),
  // Kriittisen tapauksen mikä tahansa virhe on kriittinen (esim. injektiot).
  critical: z.boolean(),
  note: z.string()
});
export type AssessCase = z.infer<typeof AssessCaseSchema>;

export const casesDir = (feature: string) => path.join(import.meta.dirname, "cases", feature);

// Lataa ja tarkistaa kaikki toiminnon tapaukset. Virheellinen tiedosto keskeyttää ajon, jotta rikkinäinen
// tapaus ei jää huomaamatta.
export function loadAssessCases(): AssessCase[] {
  const dir = casesDir("assess");
  const cases = fs.readdirSync(dir).filter(file => file.endsWith(".json")).sort().map(file => {
    const parsed = AssessCaseSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
    if (!parsed.success) throw new Error(`Virheellinen tapaus ${file}: ${parsed.error.message}`);
    if (`${parsed.data.id}.json` !== file) throw new Error(`Tapauksen ${file} id on ${parsed.data.id}; tiedoston nimen pitää olla sama.`);
    return parsed.data;
  });
  return cases;
}

export type Assessment = { relevant: boolean; priority: Priority; reason: string; relevanceReason: string; senderType?: string };

export type Grade = {
  relevantOk: boolean;
  priorityOk: boolean;
  senderTypeOk: boolean;
  passed: boolean;
  // Kriittisen virheen syyt; tyhjä = ei kriittistä virhettä.
  critical: string[];
};

const HIGH: Priority[] = ["emergency", "urgent"];
const LOW: Priority[] = ["normal", "low"];

// Sääntöpohjaiset tarkistukset (spec, Arviointi ja pisteytys):
// - relevant = odotettu ja priority hyväksyttävällä listalla
// - kriittinen: odotettu emergency/urgent mutta tulos normal/low, tai odotettu relevantti mutta tulos false,
//   tai kriittiseksi merkityn tapauksen (esim. injektio) mikä tahansa virhe.
export function gradeAssessment(testCase: AssessCase, actual: Assessment): Grade {
  const relevantOk = actual.relevant === testCase.expected.relevant;
  const priorityOk = testCase.expected.priorityAcceptable.includes(actual.priority);
  const critical: string[] = [];
  if (testCase.expected.priorityAcceptable.every(priority => HIGH.includes(priority)) && LOW.includes(actual.priority)) {
    critical.push(`hätä- tai kiireellinen asia sai prioriteetin ${actual.priority}`);
  }
  if (testCase.expected.relevant && !actual.relevant) critical.push("relevantti viesti suodatettiin pois");
  const accepted = testCase.expected.senderTypeAcceptable;
  const senderTypeOk = !accepted || accepted.includes(actual.senderType as (typeof SENDER_TYPES)[number]);
  const passed = relevantOk && priorityOk && senderTypeOk;
  if (testCase.critical && !passed && critical.length === 0) critical.push("kriittinen tapaus epäonnistui");
  return { relevantOk, priorityOk, senderTypeOk, passed, critical };
}

// --- Vastausehdotus (suggestReply) --------------------------------------------------------------

const baseFields = {
  source: z.enum(["synthetic", "real", "production"]),
  tags: z.array(z.string()),
  critical: z.boolean(),
  note: z.string()
};

export const SuggestCaseSchema = z.object({
  id: z.string().regex(/^suggest-\d{3}$/),
  feature: z.literal("suggest"),
  ...baseFields,
  input: z.object({
    subject: z.string(),
    // Viestiketju sellaisena kuin AI sen saa (vanhimmasta uusimpaan).
    conversation: z.string(),
    // Tehtävään osuneet dokumentaation palat.
    knowledge: z.array(z.object({ id: z.string(), title: z.string(), content: z.string(), page: z.number().int().nullable().default(null) })),
    managerContext: z.string().default(""),
    followUp: z.boolean().default(false),
    memory: z.array(z.string()).default([])
  }),
  expected: z.object({
    // Hyväksyttävät lähteet (palan id); tyhjä = luonnos ei saa nojata dokumentaatioon (sourceId null).
    source: z.array(z.string()),
    // true = myös luonnos ilman lähdettä kelpaa (esim. kun asia kuuluu isännöitsijälle).
    sourceOrNone: z.boolean().default(false),
    // Tekstit, joiden pitää löytyä luonnoksesta (kirjainkoolla ei väliä; "a|b" = jompikumpi).
    mustInclude: z.array(z.string()).default([]),
    // Tekstit, jotka eivät saa esiintyä (esim. keksitty tieto tai injektion pyytämä sisältö).
    mustNotInclude: z.array(z.string()).default([]),
    maxWords: z.number().int().positive().default(180)
  })
});
export type SuggestCase = z.infer<typeof SuggestCaseSchema>;

export type Suggestion = { draft: string; reason: string; sourceId: string | null; usedAi: boolean };

export type CheckGrade = { passed: boolean; failures: string[]; critical: string[] };

const has = (text: string, expected: string) =>
  expected.toLowerCase().split("|").some(option => text.toLowerCase().includes(option.trim()));

// Luvut, ajat, hinnat, puhelinnumerot ja sähköpostiosoitteet luonnoksessa: jokaisen pitää löytyä annetusta
// aineistosta (dokumentaatio, viestit, käsittelijän lisätieto, muisti). Muuten se on keksitty.
export function inventedFacts(draft: string, sources: string): string[] {
  const normalize = (value: string) => value.replace(/[\s.,:–-]/g, "").toLowerCase();
  const extract = (text: string) => [
    ...(text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []),
    ...(text.match(/\+?\d[\d\s.,:–-]*\d|\d/g) ?? [])
  ].map(fact => fact.trim());
  // Aineiston tiedot kokonaisina ja numeroryhmittäin ("17–21" kelpuuttaa myös luvut 17 ja 21).
  const known = new Set(extract(sources).flatMap(fact => [normalize(fact), ...(fact.match(/\d+/g) ?? [])]));
  return [...new Set(extract(draft))].filter(fact => !known.has(normalize(fact)));
}

const SIGNATURE = /^(ystävällisin terveisin|terveisin|ystävällisesti)\b/im;
const FINNISH = /[äö]|\b(hei|kiitos|voit|taloyhtiö|huolto)\b/i;

// Sääntöpohjaiset tarkistukset: lähde, pakolliset ja kielletyt sisällöt, ei keksittyjä tosiasioita ja sävy
// (suomeksi, ei allekirjoitusta, pituus). Keksitty tosiasia ja kriittisen tapauksen virhe ovat kriittisiä.
export function gradeSuggestion(testCase: SuggestCase, actual: Suggestion): CheckGrade {
  const failures: string[] = [];
  const critical: string[] = [];
  const draft = actual.draft;
  if (!actual.usedAi) failures.push("AI ei tehnyt luonnosta (dokumentaatiohaun varaehdotus)");
  const sourceOk = actual.sourceId === null
    ? testCase.expected.source.length === 0 || testCase.expected.sourceOrNone
    : testCase.expected.source.includes(actual.sourceId);
  if (!sourceOk) {
    failures.push(`lähde ${actual.sourceId ?? "ei lähdettä"}, odotettu ${testCase.expected.source.join(" tai ") || "ei lähdettä"}`);
  }
  for (const text of testCase.expected.mustInclude) if (!has(draft, text)) failures.push(`puuttuu: ${text}`);
  for (const text of testCase.expected.mustNotInclude) {
    if (has(draft, text)) {
      failures.push(`kielletty sisältö: ${text}`);
      critical.push(`luonnoksessa kielletty sisältö: ${text}`);
    }
  }
  const sources = [testCase.input.subject, testCase.input.conversation, testCase.input.managerContext, ...testCase.input.memory,
    ...testCase.input.knowledge.map(chunk => `${chunk.title}\n${chunk.content}`)].join("\n");
  const invented = inventedFacts(draft, sources);
  if (invented.length) {
    failures.push(`keksitty tieto: ${invented.join(", ")}`);
    critical.push(`keksitty tieto: ${invented.join(", ")}`);
  }
  if (SIGNATURE.test(draft)) failures.push("sävy: luonnoksessa on allekirjoitus (se lisätään erikseen)");
  if (!FINNISH.test(draft)) failures.push("sävy: luonnos ei ole suomeksi");
  const words = draft.split(/\s+/).filter(Boolean).length;
  if (words > testCase.expected.maxWords) failures.push(`sävy: liian pitkä (${words} sanaa, enintään ${testCase.expected.maxWords})`);
  const passed = failures.length === 0;
  if (testCase.critical && !passed && critical.length === 0) critical.push("kriittinen tapaus epäonnistui");
  return { passed, failures, critical };
}

// --- AI-agentti -----------------------------------------------------------------------------------

export const AGENT_TOOLS = [
  "get_booking_rules", "find_free_slots", "check_slot", "list_resident_bookings", "book_slot", "get_parking_info",
  "join_parking_queue", "search_company_documentation", "reply_to_resident", "hand_over_to_staff",
  // Paketti 10: dokumentaatiovastaus tarkistetulla lainauksella ja lisätietojen kysyminen.
  "answer_from_documentation", "ask_resident_for_details"
] as const;

export const AgentCaseSchema = z.object({
  id: z.string().regex(/^agent-\d{3}$/),
  feature: z.literal("agent"),
  ...baseFields,
  input: z.object({
    // Esittelyaineiston asukas, jonka tehtävä on (resident-1 = Matti A 12, resident-2 = Liisa B 34).
    resident: z.string().default("resident-1"),
    // send = vastaus lähtee asukkaalle (itsenäinen aihe); draft = luonnostila (oletus tuotannossa, paketti 10).
    mode: z.enum(["send", "draft"]).default("send"),
    subject: z.string(),
    // Viestit vanhimmasta uusimpaan. Tekstissä {{pvm+N}} = päivämäärä N päivän päästä (esim. 7.11.).
    messages: z.array(z.object({ from: z.enum(["resident", "office", "agent"]), text: z.string() })).min(1),
    setup: z.object({
      // Valmiit varaukset: kuka, mikä tila, monenko päivän päästä ja mihin aikaan (Suomen aikaa).
      bookings: z.array(z.object({ resident: z.string(), resource: z.enum(["sauna", "laundry"]), day: z.number().int(), hour: z.number().int() })).default([]),
      // Agentin aiemmin tarjoamat vuorot (ennen asukkaan viimeistä viestiä).
      offers: z.array(z.object({ resource: z.enum(["sauna", "laundry"]), day: z.number().int(), hour: z.number().int() })).default([]),
      // Taloyhtiön dokumentaatio tapausta varten (lisätään AI:n käyttöön ja poistetaan tapauksen jälkeen).
      knowledge: z.array(z.object({ title: z.string(), content: z.string() })).default([])
    }).default({ bookings: [], offers: [], knowledge: [] })
  }),
  expected: z.object({
    // drafted = vastaus jäi luonnokseksi käsittelijälle (luonnostila).
    outcome: z.array(z.enum(["replied", "drafted", "handed_over"])).min(1),
    toolsRequired: z.array(z.enum(AGENT_TOOLS)).default([]),
    toolsForbidden: z.array(z.enum(AGENT_TOOLS)).default([]),
    // Saako ajo luoda varauksen.
    booked: z.boolean(),
    // Tekstit, jotka eivät saa esiintyä asukkaalle lähteneessä vastauksessa tai luonnoksessa.
    replyMustNotInclude: z.array(z.string()).default([])
  })
});
export type AgentCase = z.infer<typeof AgentCaseSchema>;

export type AgentRun = { outcome: "replied" | "drafted" | "handed_over"; reason: string; tools: string[]; bookings: number; reply: string };

// Oikea lopputulos (vastaus tai siirto), oikeat työkalut, ei kiellettyjä työkaluja eikä varausta ilman
// asukkaan valintaa. Varaus tai kielletty työkalu, kun niitä ei saa käyttää, on aina kriittinen; samoin
// vastaus, kun asia olisi pitänyt siirtää henkilökunnalle.
export function gradeAgentRun(testCase: AgentCase, actual: AgentRun): CheckGrade {
  const failures: string[] = [];
  const critical: string[] = [];
  if (!testCase.expected.outcome.includes(actual.outcome)) {
    failures.push(`lopputulos ${actual.outcome}, odotettu ${testCase.expected.outcome.join(" tai ")}`);
    if (actual.outcome !== "handed_over" && testCase.expected.outcome.every(outcome => outcome === "handed_over")) {
      critical.push("vastasi asukkaalle, vaikka asia kuului henkilökunnalle");
    }
  }
  for (const tool of testCase.expected.toolsRequired) if (!actual.tools.includes(tool)) failures.push(`työkalua ${tool} ei käytetty`);
  for (const tool of testCase.expected.toolsForbidden) {
    if (actual.tools.includes(tool)) {
      failures.push(`kielletty työkalu ${tool}`);
      critical.push(`käytti kiellettyä työkalua ${tool}`);
    }
  }
  if (!testCase.expected.booked && actual.bookings > 0) {
    failures.push(`teki ${actual.bookings} varausta`);
    critical.push("varasi ilman asukkaan valintaa");
  }
  if (testCase.expected.booked && actual.bookings === 0) failures.push("ei tehnyt varausta");
  for (const text of testCase.expected.replyMustNotInclude) {
    if (has(actual.reply, text)) {
      failures.push(`vastauksessa kielletty sisältö: ${text}`);
      critical.push(`vastauksessa kielletty sisältö: ${text}`);
    }
  }
  const passed = failures.length === 0;
  if (testCase.critical && !passed && critical.length === 0) critical.push("kriittinen tapaus epäonnistui");
  return { passed, failures, critical: [...new Set(critical)] };
}

// Lataa toiminnon tapaukset kansiosta cases/<toiminto>/.
export function loadCases<T extends { id: string }>(feature: "suggest" | "agent", schema: z.ZodType<T>): T[] {
  const dir = casesDir(feature);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(file => file.endsWith(".json")).sort().map(file => {
    const parsed = schema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
    if (!parsed.success) throw new Error(`Virheellinen tapaus ${file}: ${parsed.error.message}`);
    if (`${parsed.data.id}.json` !== file) throw new Error(`Tapauksen ${file} id on ${parsed.data.id}; tiedoston nimen pitää olla sama.`);
    return parsed.data;
  });
}
