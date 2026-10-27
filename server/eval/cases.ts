import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

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
    priorityAcceptable: z.array(z.enum(PRIORITIES)).min(1)
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

export type Assessment = { relevant: boolean; priority: Priority; reason: string; relevanceReason: string };

export type Grade = {
  relevantOk: boolean;
  priorityOk: boolean;
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
  const passed = relevantOk && priorityOk;
  if (testCase.critical && !passed && critical.length === 0) critical.push("kriittinen tapaus epäonnistui");
  return { relevantOk, priorityOk, passed, critical };
}
