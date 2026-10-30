import { z } from "zod";
import { db } from "./db.js";

// ---------------------------------------------------------------------------------------------
// Perustiedot: pääkäyttäjän muokattavat määrittelyt, joita sovellus käyttää kaikissa taloyhtiöissä.
// Tallennetaan avain–arvo-tauluun JSON-muodossa; puuttuva tai rikkinäinen arvo korvataan oletuksella.
// ---------------------------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS master_data (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const keywordList = z.array(z.string().trim().toLowerCase().min(2).max(60)).max(200)
  .transform(words => [...new Set(words)]);

export const AI_MODEL_CHOICES = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
// "" = palvelimen oletus (ympäristömuuttuja tai sovelluksen oletusmalli).
const modelChoice = z.union([z.literal(""), z.enum(AI_MODEL_CHOICES)]);

export const masterDataSchema = z.object({
  // Sanat, joilla saapuva viesti tunnistetaan hätätapaukseksi ilman AI:ta (osamerkkijono).
  emergencyKeywords: keywordList,
  // Sanojen alut, joilla viesti tunnistetaan arkaluonteiseksi (terveys ja muut erityiset tietoryhmät).
  sensitiveKeywords: keywordList,
  // Mitkä tiedot korvataan merkinnällä ennen kuin asukkaan teksti lähetetään AI:lle.
  masking: z.object({
    phone: z.boolean(),
    email: z.boolean(),
    personalId: z.boolean(),
    iban: z.boolean()
  }),
  // Uuden tehtävän määräaika päivinä prioriteetin mukaan.
  priorityDays: z.object({
    emergency: z.number().int().min(0).max(60),
    urgent: z.number().int().min(0).max(60),
    normal: z.number().int().min(0).max(120),
    low: z.number().int().min(0).max(365)
  }),
  // AI-mallit toiminnoittain.
  aiModels: z.object({
    reply: modelChoice,
    assess: modelChoice,
    fast: modelChoice,
    reports: modelChoice
  }),
  // Merkityshaku (embedding.ts): aiemmat ratkaistut tehtävät esimerkkeinä vastausehdotukseen ja agentille,
  // ja hybridihaku (sanat + merkitys) dokumentaatioon. Taloyhtiö voi ohittaa arvot omilla asetuksillaan.
  embedding: z.object({
    similarTickets: z.boolean(),
    hybridKnowledge: z.boolean()
  })
});

export type MasterData = z.infer<typeof masterDataSchema>;

export const MASTER_DATA_DEFAULTS: MasterData = {
  emergencyKeywords: [
    "vesivuoto", "vesi valuu", "putkirikko", "tulvii", "sähköt poikki", "sähkökatko",
    "ovi ei aukea", "tulipalo", "savua", "kaasun haju"
  ],
  sensitiveKeywords: [
    "sairau", "sairas", "sairaala", "diagnoo", "lääke", "lääki", "lääkär", "raskaana", "raskau",
    "mielenterv", "masenn", "ahdistu", "syöpä", "syövä", "astma", "allergi", "vamma", "pyörätuol",
    "rollaattor", "dementi", "muistisair", "päihde", "alkoholi", "huume", "terapi", "kuntoutu",
    "uskonto", "uskonnol", "seksuaal", "rikosrekist", "ammattiliit", "etnis"
  ],
  masking: { phone: true, email: true, personalId: true, iban: true },
  priorityDays: { emergency: 0, urgent: 1, normal: 5, low: 14 },
  aiModels: { reply: "", assess: "", fast: "", reports: "" },
  embedding: { similarTickets: false, hybridKnowledge: false }
};

type Key = keyof MasterData;

export function getMasterData(): MasterData {
  const rows = db.prepare("SELECT key, value FROM master_data").all() as { key: string; value: string }[];
  const result = structuredClone(MASTER_DATA_DEFAULTS);
  for (const row of rows) {
    const field = masterDataSchema.shape[row.key as Key];
    if (!field) continue;
    try {
      const parsed = field.safeParse(JSON.parse(row.value));
      if (parsed.success) (result as Record<string, unknown>)[row.key] = parsed.data;
    } catch {
      // Rikkinäinen arvo: käytetään oletusta.
    }
  }
  return result;
}

export function saveMasterData(values: Partial<MasterData>) {
  const upsert = db.prepare(`
    INSERT INTO master_data (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  db.transaction(() => {
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) upsert.run(key, JSON.stringify(value));
    }
  })();
}

// Uuden tehtävän oletusmääräaika luetaan perustiedoista. Trigger luodaan uudelleen, jotta myös
// olemassa oleva tietokanta saa uuden määrittelyn.
db.exec(`
DROP TRIGGER IF EXISTS tickets_default_due;
CREATE TRIGGER tickets_default_due
AFTER INSERT ON tickets
WHEN NEW.due_date IS NULL
BEGIN
  UPDATE tickets
  SET due_date = date('now', 'localtime', '+' || COALESCE(
    (SELECT json_extract(value, '$.' || NEW.priority) FROM master_data WHERE key = 'priorityDays'),
    CASE NEW.priority WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 WHEN 'low' THEN 14 ELSE 5 END
  ) || ' days')
  WHERE id = NEW.id;
END;
`);
