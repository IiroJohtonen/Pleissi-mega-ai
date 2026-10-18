import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// Tietokanta ja tiedostot ovat oletuksena käynnistyskansion data-kansiossa; DATA_DIR vaihtaa paikan.
export const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
fs.mkdirSync(dataDir, { recursive: true });

export const attachmentsDir = path.join(dataDir, "attachments");
fs.mkdirSync(attachmentsDir, { recursive: true });

export const knowledgeFilesDir = path.join(dataDir, "knowledge-files");
fs.mkdirSync(knowledgeFilesDir, { recursive: true });

// Tietokantatiedoston nimi oli aiemmin kiito.sqlite. Se nimetään uudelleen vasta, kun kaikki muutokset
// on kirjoitettu päätiedostoon; jos tiedosto on toisen prosessin käytössä, vanha nimi jää käyttöön.
function databasePath() {
  const current = path.join(dataDir, "kotilo.sqlite");
  const legacy = path.join(dataDir, "kiito.sqlite");
  if (fs.existsSync(current) || !fs.existsSync(legacy)) return current;
  try {
    const old = new Database(legacy);
    old.pragma("wal_checkpoint(TRUNCATE)");
    old.close();
    if (fs.existsSync(`${legacy}-wal`) && fs.statSync(`${legacy}-wal`).size > 0) return legacy;
    fs.renameSync(legacy, current);
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(legacy + suffix, { force: true });
    return current;
  } catch {
    return legacy;
  }
}

export const db = new Database(databasePath());

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email_address TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apartments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  apartment_number TEXT NOT NULL,
  address TEXT NOT NULL,
  FOREIGN KEY(company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS residents (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  apartment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  FOREIGN KEY(company_id) REFERENCES companies(id),
  FOREIGN KEY(apartment_id) REFERENCES apartments(id)
);

CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  FOREIGN KEY(company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  apartment_id TEXT,
  resident_id TEXT,
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  subject TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  ai_action TEXT NOT NULL,
  ai_reason TEXT NOT NULL,
  draft TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(ticket_id) REFERENCES tickets(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Poistettujen tehtävien sähköpostien tunnisteet: postin tarkistus ei tuo niitä uudelleen.
-- Viestien sisältöä ei säilytetä. Rivit poistetaan 90 päivän kuluttua.
CREATE TABLE IF NOT EXISTS deleted_mail_messages (
  message_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gmail_imports (
  gmail_message_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(ticket_id) REFERENCES tickets(id)
);

CREATE TABLE IF NOT EXISTS gmail_sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  resident_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(company_id) REFERENCES companies(id)
);

-- Asukkaan toive jo varatusta vuorosta. Isännöitsijä hyväksyy (vuoro siirtyy toivojalle) tai hylkää sen.
-- status: pending, approved, rejected tai cancelled (asukas perui).
CREATE TABLE IF NOT EXISTS booking_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  resident_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT NOT NULL DEFAULT '',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(company_id) REFERENCES companies(id)
);

-- Mitä vuorotyyppejä taloyhtiön tilaan saa varata. Rivin puuttuessa molemmat ovat sallittuja.
CREATE TABLE IF NOT EXISTS booking_settings (
  company_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  allow_single INTEGER NOT NULL DEFAULT 1,
  allow_weekly INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(company_id, resource)
);

CREATE TABLE IF NOT EXISTS parking_spaces (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  resident_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY(company_id) REFERENCES companies(id)
);

-- Autopaikan kuukausihinta taloyhtiössä paikkatyypeittäin. Rivin puuttuessa hinta on 0.
CREATE TABLE IF NOT EXISTS parking_prices (
  company_id TEXT NOT NULL,
  type TEXT NOT NULL,
  monthly_price REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(company_id, type)
);

-- Huoltoyhtiölle tehtävältä lähetetty työtilaus. status: 'ordered' tai 'done'.
CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  contractor_name TEXT NOT NULL,
  contractor_email TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ordered',
  email_sent INTEGER NOT NULL DEFAULT 0,
  ordered_by TEXT NOT NULL,
  ordered_at TEXT NOT NULL,
  done_by TEXT,
  done_at TEXT,
  FOREIGN KEY(ticket_id) REFERENCES tickets(id)
);

-- Tiedote taloyhtiön asukkaille. stairwell = '' koskee koko yhtiötä, muuten yhtä rappua (esim. 'B').
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  stairwell TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  emailed_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(company_id) REFERENCES companies(id)
);

-- Autopaikan haltijahistoria. end_date on ensimmäinen päivä, jona paikka ei enää ole haltijalla
-- (NULL = toistaiseksi). Laskutusraportti lukee menneet kuukaudet tästä.
CREATE TABLE IF NOT EXISTS parking_assignments (
  id TEXT PRIMARY KEY,
  parking_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  resident_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT
);

-- Asukkaan portaalissa tekemä muuttoilmoitus. status: 'pending', 'approved' tai 'rejected'.
CREATE TABLE IF NOT EXISTS move_notices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  apartment_id TEXT NOT NULL,
  resident_id TEXT NOT NULL,
  move_date TEXT NOT NULL,
  moves_out INTEGER NOT NULL DEFAULT 0,
  new_residents TEXT NOT NULL DEFAULT '[]',
  door_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  result TEXT
);

-- Asukasportaalin lomakkeet (huoltotyötilaus, häiriöilmoitus, irtisanomisilmoitus, asuntohakemus).
-- Lomake luo tehtävän; fields on JSON-lista {label, value}, joka näytetään tehtävällä sellaisenaan.
CREATE TABLE IF NOT EXISTS portal_forms (
  ticket_id TEXT PRIMARY KEY,
  form TEXT NOT NULL,
  resident_id TEXT,
  fields TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Remontti-ilmoitukset: asukas ilmoittaa portaalissa, isännöitsijä hyväksyy (ehdoin) tai hylkää.
-- status: pending, approved, rejected, completed.
CREATE TABLE IF NOT EXISTS renovation_notices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  apartment_id TEXT NOT NULL,
  resident_id TEXT NOT NULL,
  work_type TEXT NOT NULL,
  description TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  contractor TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  completed_at TEXT
);

-- Avainrekisteri: taloyhtiön avaimet ja niiden luovutukset. Avain on luovutettu, kun sillä on
-- luovutusrivi ilman palautusaikaa. status: active tai lost.
CREATE TABLE IF NOT EXISTS building_keys (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  code TEXT NOT NULL,
  type TEXT NOT NULL,
  apartment_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS key_loans (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  resident_id TEXT,
  holder_name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  handed_at TEXT NOT NULL,
  handed_by TEXT NOT NULL,
  returned_at TEXT,
  received_by TEXT
);

-- Kulutuslukemat asunnoittain. meter_type: cold_water, hot_water tai electricity.
-- source: portal (asukas ilmoitti) tai office (toimisto kirjasi).
CREATE TABLE IF NOT EXISTS meter_readings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  apartment_id TEXT NOT NULL,
  resident_id TEXT,
  meter_type TEXT NOT NULL,
  reading_date TEXT NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Kotisivun yhteydenottolomakkeella jätetyt yhteystiedot.
CREATE TABLE IF NOT EXISTS contact_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Jonotuslista autopaikalle tai saunavuorolle. status: 'waiting', 'offered', 'done' tai 'cancelled'.
CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  parking_type TEXT NOT NULL DEFAULT '',
  resident_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL,
  offered_at TEXT,
  offered_by TEXT,
  closed_at TEXT
);

-- Yhdistetyt Gmail-tilit: id 'office' on toimiston tili, muut tunnisteet ovat taloyhtiöitä.
CREATE TABLE IF NOT EXISTS gmail_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  connected_by TEXT NOT NULL
);

-- Laskutetuksi merkitty kuukausi: raportin rivit ja hinnat tallennetaan merkintähetken mukaisina.
CREATE TABLE IF NOT EXISTS billing_periods (
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  month TEXT NOT NULL,
  billed_at TEXT NOT NULL,
  billed_by TEXT NOT NULL,
  total REAL NOT NULL,
  prices TEXT NOT NULL,
  rows TEXT NOT NULL,
  PRIMARY KEY(company_id, kind, month)
);

-- Taloyhtiön muut isännöitsijät vastuuisännöitsijän (companies.manager_id) lisäksi.
CREATE TABLE IF NOT EXISTS company_managers (
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(company_id, user_id)
);

-- Isännöitsijätoimiston omat tiedot (yksi rivi). Taloyhtiöiden tiedot ovat companies-taulussa.
CREATE TABLE IF NOT EXISTS office_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  business_id TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO office_settings (id, name) VALUES (1, 'Pohjantähti Isännöinti Oy');

CREATE TABLE IF NOT EXISTS topic_reports (
  company_id TEXT NOT NULL,
  period TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  ticket_count INTEGER NOT NULL,
  topics TEXT NOT NULL,
  PRIMARY KEY(company_id, period)
);

CREATE TABLE IF NOT EXISTS ticket_reporters (
  ticket_id TEXT NOT NULL,
  resident_id TEXT NOT NULL,
  PRIMARY KEY(ticket_id, resident_id),
  FOREIGN KEY(ticket_id) REFERENCES tickets(id),
  FOREIGN KEY(resident_id) REFERENCES residents(id)
);

CREATE TABLE IF NOT EXISTS ticket_notes (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(ticket_id) REFERENCES tickets(id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(ticket_id) REFERENCES tickets(id)
);

CREATE TRIGGER IF NOT EXISTS tickets_link_reporter
AFTER INSERT ON tickets
WHEN NEW.resident_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO ticket_reporters (ticket_id, resident_id)
  VALUES (NEW.id, NEW.resident_id);
END;

INSERT OR IGNORE INTO ticket_reporters (ticket_id, resident_id)
SELECT id, resident_id FROM tickets WHERE resident_id IS NOT NULL;
`);

const companyColumns = db.prepare("PRAGMA table_info(companies)").all() as { name: string }[];
for (const column of [
  "business_id",
  "address",
  "phone",
  "maintenance_name",
  "maintenance_phone",
  "maintenance_email",
  "maintenance_emergency_phone"
]) {
  if (!companyColumns.some(existing => existing.name === column)) {
    db.exec(`ALTER TABLE companies ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  }
}

// Taloyhtiön vastuuisännöitsijä: viittaus toimiston käyttäjään.
if (!companyColumns.some(existing => existing.name === "manager_id")) {
  db.exec("ALTER TABLE companies ADD COLUMN manager_id TEXT");
}

// Sovelluksessa luodut yhtiöt (managed = 1) ovat käytettävissä ilman AUTHORIZED_COMPANY_IDS-merkintää.
if (!companyColumns.some(existing => existing.name === "managed")) {
  db.exec("ALTER TABLE companies ADD COLUMN managed INTEGER NOT NULL DEFAULT 0");
}

// Tietopankin tietue on joko dokumentti tai vakiotieto. Uusi versio saa saman group_id:n,
// ja vanha jää historiaan tilaan 'replaced'. Poistettu tietue jää tilaan 'deleted'. Dokumentin uusi versio
// odottaa tilassa 'pending', kunnes isännöitsijä hyväksyy muutokset; vasta silloin vanha korvataan.
const knowledgeColumns = db.prepare("PRAGMA table_info(knowledge)").all() as { name: string }[];
for (const [column, definition] of [
  ["kind", "TEXT NOT NULL DEFAULT 'fact'"],
  ["valid_from", "TEXT"],
  ["valid_until", "TEXT"],
  ["file_name", "TEXT"],
  ["mime_type", "TEXT"],
  ["version", "INTEGER NOT NULL DEFAULT 1"],
  ["group_id", "TEXT"],
  ["status", "TEXT NOT NULL DEFAULT 'active'"],
  ["extraction_ok", "INTEGER NOT NULL DEFAULT 1"],
  ["created_at", "TEXT"],
  // Pilkuilla erotetut avainsanat, joiden avulla tietue löytyy samantapaisille tehtäville.
  ["tags", "TEXT NOT NULL DEFAULT ''"],
  // Kenelle tietue on: 'ai' = AI käyttää sitä vastausehdotuksissa, 'internal' = vain henkilökunnan luettavaksi.
  ["audience", "TEXT NOT NULL DEFAULT 'ai'"],
  // Dokumentin pilkonta taustalla: 'processing' | 'ready' | 'failed'.
  ["processing_state", "TEXT NOT NULL DEFAULT 'ready'"],
  // PDF:n teksti sivuittain (JSON-taulukko), jotta tiedon sivu säilyy ja sivun voi lukea uudelleen.
  ["pages", "TEXT"],
  // Odottavan uuden version vertailu edelliseen (JSON), lasketaan kerran pilkonnan valmistuttua.
  ["comparison", "TEXT"],
  // Dokumentin muotoiltu teksti (otsikot, lihavoinnit, luettelot), ks. rich-text.ts. content on sama ilman muotoilua.
  ["formatted", "TEXT"]
]) {
  if (!knowledgeColumns.some(existing => existing.name === column)) {
    db.exec(`ALTER TABLE knowledge ADD COLUMN ${column} ${definition}`);
  }
}

// Tietopalat: dokumentti tai vakiotieto pilkottuna aiheittain. AI saa vastausehdotukseen vain kysymykseen
// osuvat palat, ei koko tietopankkia. Voimassaolo, kohde (AI/sisäinen) ja taloyhtiö tulevat tietueelta;
// company_id on palalla tallessa, jotta jokainen haku rajautuu yhtiöön myös palatasolla.
// origin: 'ai' = AI pilkkoi, 'local' = paikallinen kappalejako, 'manual' = isännöitsijän kirjoittama.
// status: 'active' | 'archived' (vanhan version pala) | 'deleted'.
db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  page INTEGER,
  tags TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'local',
  verified INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(knowledge_id) REFERENCES knowledge(id)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_knowledge ON knowledge_chunks(knowledge_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_company ON knowledge_chunks(company_id, status);
`);
// AI:n dokumentista löytämä päättymispäivä. Näytetään vain ehdotuksena, eikä sitä aseteta tietueelle
// ilman isännöitsijän hyväksyntää.
if (!(db.prepare("PRAGMA table_info(knowledge_chunks)").all() as { name: string }[]).some(column => column.name === "suggested_valid_until")) {
  db.exec("ALTER TABLE knowledge_chunks ADD COLUMN suggested_valid_until TEXT");
}

// Arkaluonteinen tehtävä (terveys ym. erityiset tietoryhmät) ei mene AI:lle. sensitive_source:
// 'keywords' (perustietojen sanalista), 'manual' (käsittelijä) tai 'cleared' (käsittelijä poisti merkinnän).
{
  const columns = (db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[]).map(column => column.name);
  if (!columns.includes("sensitive")) db.exec("ALTER TABLE tickets ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0");
  if (!columns.includes("sensitive_source")) db.exec("ALTER TABLE tickets ADD COLUMN sensitive_source TEXT");
  // 1 = taloyhtiötä ei tunnistettu: tehtävä on Taloyhtiö tunnistamatta -jonossa, kunnes yhtiö valitaan.
  // company_id on silloin vain paikkamerkki (oletusyhtiö), eikä tehtävä näy yhtiön muille käsittelijöille.
  if (!columns.includes("company_pending")) db.exec("ALTER TABLE tickets ADD COLUMN company_pending INTEGER NOT NULL DEFAULT 0");
}

// Kuka käsittelee Taloyhtiö tunnistamatta -jonoa: roolit ja yksittäiset käyttäjät (JSON-taulukot).
// Pääkäyttäjä näkee jonon aina.
{
  const columns = (db.prepare("PRAGMA table_info(office_settings)").all() as { name: string }[]).map(column => column.name);
  if (!columns.includes("unidentified_queue_roles")) {
    db.exec(`ALTER TABLE office_settings ADD COLUMN unidentified_queue_roles TEXT NOT NULL DEFAULT '["Pääkäyttäjä","Asiakaspalvelu"]'`);
  }
  if (!columns.includes("unidentified_queue_users")) {
    db.exec("ALTER TABLE office_settings ADD COLUMN unidentified_queue_users TEXT NOT NULL DEFAULT '[]'");
  }
}

const ticketSourceColumns = db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[];
for (const column of ["knowledge_source_id", "knowledge_source_title", "knowledge_source_chunk_id", "knowledge_source_page"]) {
  if (!ticketSourceColumns.some(existing => existing.name === column)) {
    db.exec(`ALTER TABLE tickets ADD COLUMN ${column} TEXT`);
  }
}

// Tehtävän käsittelijä (toimiston käyttäjä) ja asukkaan muuttopäivä (pois muuttanut asukas jää historiaan).
if (!(db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[]).some(column => column.name === "assignee_id")) {
  db.exec("ALTER TABLE tickets ADD COLUMN assignee_id TEXT");
}
if (!(db.prepare("PRAGMA table_info(residents)").all() as { name: string }[]).some(column => column.name === "moved_out_at")) {
  db.exec("ALTER TABLE residents ADD COLUMN moved_out_at TEXT");
}

// Nykyisille autopaikan haltijoille luodaan historian ensimmäinen rivi paikan luontipäivästä.
db.exec(`
  INSERT INTO parking_assignments (id, parking_id, company_id, resident_id, start_date)
  SELECT 'pa-' || p.id, p.id, p.company_id, p.resident_id, substr(p.created_at, 1, 10)
  FROM parking_spaces p
  WHERE p.resident_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM parking_assignments pa WHERE pa.parking_id = p.id)
`);

// Kuinka monelle viikolle viikoittainen vuoro varataan kerralla.
const bookingSettingColumns = db.prepare("PRAGMA table_info(booking_settings)").all() as { name: string }[];
if (!bookingSettingColumns.some(column => column.name === "weekly_weeks")) {
  db.exec("ALTER TABLE booking_settings ADD COLUMN weekly_weeks INTEGER NOT NULL DEFAULT 12");
}

// Hinnat laskutusraporttia varten: yksittäisen vuoron hinta ja viikoittaisen vuoron kuukausihinta.
for (const column of ["single_price", "monthly_price"]) {
  if (!bookingSettingColumns.some(existing => existing.name === column)) {
    db.exec(`ALTER TABLE booking_settings ADD COLUMN ${column} REAL NOT NULL DEFAULT 0`);
  }
}

// Vuorokohtainen jono: onko jono käytössä tilassa ja montako jonopaikkaa yhdellä vuorolla on.
if (!bookingSettingColumns.some(column => column.name === "queue_enabled")) {
  db.exec("ALTER TABLE booking_settings ADD COLUMN queue_enabled INTEGER NOT NULL DEFAULT 0");
}
if (!bookingSettingColumns.some(column => column.name === "queue_size")) {
  db.exec("ALTER TABLE booking_settings ADD COLUMN queue_size INTEGER NOT NULL DEFAULT 3");
}

// Jonopaikat varatuille sauna- ja pyykkitupavuoroille. Kun varaus perutaan, vuoro siirtyy jonon
// ensimmäiselle. status: waiting (jonossa), granted (sai vuoron), left (poistui itse),
// cancelled (poistettu, esim. muutto). Jonosija lasketaan liittymisjärjestyksestä.
db.exec(`
CREATE TABLE IF NOT EXISTS booking_queue (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  resident_id TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL,
  closed_at TEXT,
  booking_id TEXT
);
CREATE INDEX IF NOT EXISTS booking_queue_slot ON booking_queue(company_id, resource, starts_at, status);
`);

// Postilaatikko, jonka kautta tehtävä saapui (esim. isännöitsijän oma tili "user:<id>"). Vastaukset
// lähetetään samasta laatikosta, jotta asukas saa ne siltä, jolle hän kirjoitti.
const ticketMailColumns = db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[];
if (!ticketMailColumns.some(column => column.name === "mail_account_id")) {
  db.exec("ALTER TABLE tickets ADD COLUMN mail_account_id TEXT");
}

// Sähköpostitilin palvelu: gmail, microsoft tai imap. Muut kuin salaiset asetukset (esim. IMAP-palvelin)
// ovat JSON-muodossa settings-sarakkeessa; token-sarakkeessa on tunnisteet tai salattu salasana.
const mailAccountColumns = db.prepare("PRAGMA table_info(gmail_accounts)").all() as { name: string }[];
if (!mailAccountColumns.some(column => column.name === "provider")) {
  db.exec("ALTER TABLE gmail_accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'gmail'");
}
if (!mailAccountColumns.some(column => column.name === "settings")) {
  db.exec("ALTER TABLE gmail_accounts ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
}

// Viikoittain toistuvan varauksen vuorot jakavat saman series_id:n.
const bookingColumns = db.prepare("PRAGMA table_info(bookings)").all() as { name: string }[];
if (!bookingColumns.some(column => column.name === "series_id")) {
  db.exec("ALTER TABLE bookings ADD COLUMN series_id TEXT");
}

// Liitteen suunta: 'inbound' = asukkaalta saapunut, 'outbound' = vastauksen mukana lähetetty.
const attachmentColumns = db.prepare("PRAGMA table_info(attachments)").all() as { name: string }[];
if (!attachmentColumns.some(column => column.name === "direction")) {
  db.exec("ALTER TABLE attachments ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound'");
}
// Viesti, jonka mukana liite tuli; liite näytetään aikajanalla viestin alla.
if (!attachmentColumns.some(column => column.name === "message_id")) {
  db.exec("ALTER TABLE attachments ADD COLUMN message_id TEXT");
}

const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
if (!messageColumns.some(column => column.name === "channel")) {
  db.exec(`
    ALTER TABLE messages ADD COLUMN channel TEXT;
    UPDATE messages
    SET channel = CASE
      WHEN direction = 'inbound' THEN (SELECT source_channel FROM tickets WHERE tickets.id = messages.ticket_id)
      ELSE 'email'
    END;
  `);
}

const ticketColumns = db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[];
if (!ticketColumns.some(column => column.name === "ticket_number")) {
  db.exec("ALTER TABLE tickets ADD COLUMN ticket_number INTEGER");
}

const existingTickets = db.prepare(`
  SELECT id, company_id
  FROM tickets
  WHERE ticket_number IS NULL
  ORDER BY company_id, created_at, id
`).all() as { id: string; company_id: string }[];
const nextNumbers = new Map<string, number>();
const companyMaxNumbers = db.prepare(`
  SELECT company_id, MAX(ticket_number) AS max_number
  FROM tickets
  WHERE ticket_number IS NOT NULL
  GROUP BY company_id
`).all() as { company_id: string; max_number: number }[];
for (const company of companyMaxNumbers) {
  nextNumbers.set(company.company_id, company.max_number);
}
for (const ticket of existingTickets) {
  const nextNumber = (nextNumbers.get(ticket.company_id) ?? 0) + 1;
  db.prepare("UPDATE tickets SET ticket_number = ? WHERE id = ?").run(nextNumber, ticket.id);
  nextNumbers.set(ticket.company_id, nextNumber);
}

// Tehtävän määräaika (VVVV-KK-PP). Uusi tehtävä saa oletusmääräajan prioriteetin mukaan; ennen
// tätä muutosta luoduilla tehtävillä määräaikaa ei ole, ellei käsittelijä aseta sitä.
if (!ticketColumns.some(column => column.name === "due_date")) {
  db.exec("ALTER TABLE tickets ADD COLUMN due_date TEXT");
}

// Tehtävän sulkemisaika raportteja varten. Tehtävän voi sulkea monesta paikasta, joten aika asetetaan
// tietokannan triggerillä aina, kun tila muuttuu suljetuksi, ja tyhjennetään, kun tehtävä avataan uudelleen.
// Ennen tätä muutosta suljetuille tehtäville käytetään viimeisintä muokkausaikaa.
if (!ticketColumns.some(column => column.name === "closed_at")) {
  db.exec("ALTER TABLE tickets ADD COLUMN closed_at TEXT");
  db.exec("UPDATE tickets SET closed_at = updated_at WHERE status = 'closed'");
}
db.exec(`
CREATE TRIGGER IF NOT EXISTS tickets_closed_at_update
AFTER UPDATE OF status ON tickets
WHEN (NEW.status = 'closed') != (OLD.status = 'closed')
BEGIN
  UPDATE tickets SET closed_at = CASE WHEN NEW.status = 'closed' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS tickets_closed_at_insert
AFTER INSERT ON tickets
WHEN NEW.status = 'closed' AND NEW.closed_at IS NULL
BEGIN
  UPDATE tickets SET closed_at = NEW.created_at WHERE id = NEW.id;
END;
`);

// Poistetun (anonymisoidun) asukkaan rivi jää historiaan ilman henkilötietoja.
if (!(db.prepare("PRAGMA table_info(residents)").all() as { name: string }[]).some(column => column.name === "erased_at")) {
  db.exec("ALTER TABLE residents ADD COLUMN erased_at TEXT");
}

// Muistutussähköpostit käsittelijöille (0 = pois), suljettujen tehtävien ja lokin säilytysaika
// kuukausina (0 = säilytetään toistaiseksi), saapuvan tehtävän prioriteetin arviointi AI:lla (0 = pois)
// ja AI:n tarkistus siitä, koskeeko saapuva sähköposti taloyhtiön asioita (0 = pois).
const officeColumns = db.prepare("PRAGMA table_info(office_settings)").all() as { name: string }[];
for (const column of ["reminder_emails", "retention_months", "ai_priority", "ai_relevance"]) {
  if (!officeColumns.some(existing => existing.name === column)) {
    db.exec(`ALTER TABLE office_settings ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
}
// Osoite, johon kotisivun yhteydenottopyynnöt lähetetään sähköpostina; tyhjä = ei lähetetä.
if (!officeColumns.some(existing => existing.name === "contact_email")) {
  db.exec("ALTER TABLE office_settings ADD COLUMN contact_email TEXT NOT NULL DEFAULT ''");
}
// Kotisivun yhteydenottopyynnöille asetetaan vastaanottaja kerran. Pääkäyttäjä voi vaihtaa tai
// tyhjentää sen asetuksista, eikä tämä aseta sitä uudelleen.
if ((db.pragma("user_version", { simple: true }) as number) < 1) {
  db.prepare("UPDATE office_settings SET contact_email = ? WHERE contact_email = ''").run("kotilotesti2@outlook.com");
  db.pragma("user_version = 1");
}
// Muistutusten rajat päivinä: asukas on odottanut vastausta / määräaikaan on enintään näin monta päivää.
if (!officeColumns.some(existing => existing.name === "reply_reminder_days")) {
  db.exec("ALTER TABLE office_settings ADD COLUMN reply_reminder_days INTEGER NOT NULL DEFAULT 2");
}
if (!officeColumns.some(existing => existing.name === "due_reminder_days")) {
  db.exec("ALTER TABLE office_settings ADD COLUMN due_reminder_days INTEGER NOT NULL DEFAULT 1");
}
// Asukkaan tilapäivitykset sähköpostilla (1 = päällä): työ tilattu, työ tehty, käsittelyssä, valmis.
if (!officeColumns.some(existing => existing.name === "resident_status_updates")) {
  db.exec("ALTER TABLE office_settings ADD COLUMN resident_status_updates INTEGER NOT NULL DEFAULT 1");
}

// Toistuvien aiheiden raportti: aiheet, jotka jätettiin pois, koska niistä on jo dokumentaatio.
if (!(db.prepare("PRAGMA table_info(topic_reports)").all() as { name: string }[]).some(column => column.name === "covered")) {
  db.exec("ALTER TABLE topic_reports ADD COLUMN covered TEXT NOT NULL DEFAULT '[]'");
}

db.exec(`
-- Käyttäjälle lähetetty muistutuskooste: enintään yksi päivässä.
-- Käyttäjän sähköpostin allekirjoitus. template NULL = oletuspohja, tyhjä = ei allekirjoitusta.
CREATE TABLE IF NOT EXISTS user_signatures (
  user_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  template TEXT
);

CREATE TABLE IF NOT EXISTS reminder_log (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY(user_id, day)
);

CREATE TRIGGER IF NOT EXISTS tickets_default_due
AFTER INSERT ON tickets
WHEN NEW.due_date IS NULL
BEGIN
  UPDATE tickets
  SET due_date = date('now', 'localtime', CASE NEW.priority
    WHEN 'emergency' THEN '+0 days'
    WHEN 'urgent' THEN '+1 days'
    WHEN 'low' THEN '+14 days'
    ELSE '+5 days'
  END)
  WHERE id = NEW.id;
END;

CREATE UNIQUE INDEX IF NOT EXISTS tickets_company_number
ON tickets(company_id, ticket_number)
WHERE ticket_number IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS tickets_assign_number
AFTER INSERT ON tickets
WHEN NEW.ticket_number IS NULL
BEGIN
  UPDATE tickets
  SET ticket_number = (
    SELECT COALESCE(MAX(ticket_number), 0) + 1
    FROM tickets
    WHERE company_id = NEW.company_id AND id != NEW.id
  )
  WHERE id = NEW.id;
END;
`);

// Remontti-ilmoitus on tehtävä (tickets.kind = 'renovation'), ja ilmoituksen tiedot ovat
// renovation_notices-rivillä, joka viittaa tehtävään. Kaikki muutostyöilmoituksen kentät ovat
// valinnaisia, joten vanhan taulun NOT NULL -sarakkeet muutetaan kerran valinnaisiksi. Toimiston
// kirjaamalla ilmoituksella ei välttämättä ole asukasta, ja asukkaan tietojen poisto jättää
// ilmoituksen taloyhtiön historiaan ilman asukasta.
if (!ticketColumns.some(column => column.name === "kind")) {
  db.exec("ALTER TABLE tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'ticket'");
}
{
  const columns = db.prepare("PRAGMA table_info(renovation_notices)").all() as { name: string; notnull: number }[];
  if (columns.find(column => column.name === "resident_id")?.notnull) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE renovation_notices RENAME TO renovation_notices_old;
        CREATE TABLE renovation_notices (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          apartment_id TEXT,
          resident_id TEXT,
          work_type TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          start_date TEXT,
          end_date TEXT,
          contractor TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          decision_note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          decided_by TEXT,
          decided_at TEXT,
          completed_at TEXT
        );
        INSERT INTO renovation_notices
          (id, company_id, apartment_id, resident_id, work_type, description, start_date, end_date, contractor,
           status, decision_note, created_at, decided_by, decided_at, completed_at)
        SELECT id, company_id, apartment_id, resident_id, work_type, description, start_date, end_date, contractor,
               status, decision_note, created_at, decided_by, decided_at, completed_at
        FROM renovation_notices_old;
        DROP TABLE renovation_notices_old;
      `);
    })();
  }
  // Työn tyypit vastaavat nyt muutostyöilmoituksen luokittelua.
  db.prepare("UPDATE renovation_notices SET work_type = 'Sähkö' WHERE work_type = 'Sähkötyöt'").run();
  db.prepare("UPDATE renovation_notices SET work_type = 'LVI' WHERE work_type = 'Vesi- ja viemärityöt'").run();
  const renovationColumns = (db.prepare("PRAGMA table_info(renovation_notices)").all() as { name: string }[]).map(column => column.name);
  // ticket_id: remonttitehtävä. Muut: asunto-osakeyhtiölain 4. luvun muutostyöilmoituksen tiedot.
  for (const column of [
    "ticket_id", "reporter_name", "contractor_contact", "supervisor", "impact_structures", "impact_water",
    "impact_sewer", "impact_electric", "impact_ventilation", "waterproofing", "hazmat_survey", "started_at", "inspected_at"
  ]) {
    if (!renovationColumns.includes(column)) {
      db.exec(`ALTER TABLE renovation_notices ADD COLUMN ${column} TEXT${column === "ticket_id" || column.endsWith("_at") ? "" : " NOT NULL DEFAULT ''"}`);
    }
  }
}

function backfillKnowledge() {
  db.prepare("UPDATE knowledge SET group_id = id WHERE group_id IS NULL").run();
  db.prepare("UPDATE knowledge SET created_at = ? WHERE created_at IS NULL").run(new Date().toISOString());
}

// Verkkosivun lomakkeilta tulevat lukemat, muuttoilmoitukset ja lämmityspaikkatilaukset: asunto voi
// puuttua, jos lomakkeen osoitetta ei tunnisteta (isännöitsijä valitsee sen muokkaamalla), eikä
// ilmoittaja ole välttämättä asukastaulussa. details: lomakkeen kentät JSON-oliona (avain → arvo).
{
  const meterColumns = db.prepare("PRAGMA table_info(meter_readings)").all() as { name: string; notnull: number }[];
  if (meterColumns.find(column => column.name === "apartment_id")?.notnull) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE meter_readings RENAME TO meter_readings_old;
        CREATE TABLE meter_readings (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          apartment_id TEXT,
          resident_id TEXT,
          meter_type TEXT NOT NULL,
          reading_date TEXT NOT NULL,
          value REAL NOT NULL,
          source TEXT NOT NULL,
          recorded_by TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        INSERT INTO meter_readings (id, company_id, apartment_id, resident_id, meter_type, reading_date, value, source, recorded_by, note, created_at)
        SELECT id, company_id, apartment_id, resident_id, meter_type, reading_date, value, source, recorded_by, note, created_at
        FROM meter_readings_old;
        DROP TABLE meter_readings_old;
      `);
    })();
  }
  if (!meterColumns.some(column => column.name === "details")) {
    db.exec("ALTER TABLE meter_readings ADD COLUMN details TEXT NOT NULL DEFAULT '{}'");
  }

  const moveColumns = db.prepare("PRAGMA table_info(move_notices)").all() as { name: string; notnull: number }[];
  if (moveColumns.find(column => column.name === "resident_id")?.notnull) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE move_notices RENAME TO move_notices_old;
        CREATE TABLE move_notices (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          apartment_id TEXT,
          resident_id TEXT,
          move_date TEXT NOT NULL,
          moves_out INTEGER NOT NULL DEFAULT 0,
          new_residents TEXT NOT NULL DEFAULT '[]',
          door_name TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          decided_by TEXT,
          decided_at TEXT,
          result TEXT
        );
        INSERT INTO move_notices (id, company_id, apartment_id, resident_id, move_date, moves_out, new_residents, door_name, note,
          status, created_at, decided_by, decided_at, result)
        SELECT id, company_id, apartment_id, resident_id, move_date, moves_out, new_residents, door_name, note,
          status, created_at, decided_by, decided_at, result
        FROM move_notices_old;
        DROP TABLE move_notices_old;
      `);
    })();
  }
  const moveColumnNames = (db.prepare("PRAGMA table_info(move_notices)").all() as { name: string }[]).map(column => column.name);
  if (!moveColumnNames.includes("details")) db.exec("ALTER TABLE move_notices ADD COLUMN details TEXT NOT NULL DEFAULT '{}'");
  if (!moveColumnNames.includes("source")) db.exec("ALTER TABLE move_notices ADD COLUMN source TEXT NOT NULL DEFAULT 'portal'");

  // Lomakeviestit, joista tehtiin tietue (lukema, muutto, lämmityspaikka) eikä tehtävää: ei tuoda uudelleen.
  db.exec(`
    CREATE TABLE IF NOT EXISTS form_imports (
      message_id TEXT PRIMARY KEY,
      record_kind TEXT NOT NULL,
      record_ids TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Auton lämmityspaikan tilaukset. status: pending (odottaa), approved (myönnetty), rejected, ended.
  db.exec(`
    CREATE TABLE IF NOT EXISTS heating_orders (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      apartment_id TEXT,
      resident_id TEXT,
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'office',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

// Muutot, mittarilukemat ja lämmityspaikat ovat omissa tauluissaan, eivät tehtävätyyppejä:
// vanhat tehtävät näillä tyypeillä muutetaan ilmoituksiksi.
db.prepare(`
  UPDATE tickets SET type = 'Ilmoitus'
  WHERE type IN ('Muutto', 'Muuttoilmoitus', 'Mittarilukemailmoitus', 'Auton lämmityspaikka')
`).run();

// Kiireellisiä esimerkkitehtäviä samankaltaisista aiheista (vesi- ja lämmitysviat). Lisätään myös
// olemassa olevaan demokantaan, jos niitä ei vielä ole.
const urgentExamples = [
  {
    apartment: "apt-12", resident: "resident-1", sender: "Matti Meikäläinen <matti@example.com>",
    subject: "Keittiön altaan alla vuotaa", summary: "Asukas ilmoittaa vesivuodosta keittiön altaan alla. Lattialla on vettä.",
    body: "Keittiön tiskialtaan alta tippuu vettä ja kaapin pohja on märkä. Laitoin ämpärin alle."
  },
  {
    apartment: "apt-34", resident: "resident-2", sender: "Liisa Mallikas <liisa@example.com>",
    subject: "Patterit kylmänä", summary: "Asukas kertoo, että asunnon kaikki patterit ovat kylmiä.",
    body: "Kaikki patterit ovat olleet kylmiä eilisestä asti ja sisälämpö on laskenut 17 asteeseen."
  },
  {
    apartment: "apt-12", resident: "resident-1", sender: "Matti Meikäläinen <matti@example.com>",
    subject: "Kylpyhuoneen lattiakaivo tulvii", summary: "Asukas ilmoittaa, että kylpyhuoneen lattiakaivo nostaa vettä lattialle.",
    body: "Lattiakaivosta nousee vettä aina kun suihkua käytetään. Vesi ei vedä ollenkaan."
  },
  {
    apartment: "apt-34", resident: "resident-2", sender: "Liisa Mallikas <liisa@example.com>",
    subject: "Lämmintä vettä ei tule", summary: "Asukas kertoo, että hanoista tulee vain kylmää vettä.",
    body: "Keittiön ja kylpyhuoneen hanoista ei tule lämmintä vettä lainkaan tänä aamuna."
  },
  {
    apartment: "apt-12", resident: "resident-1", sender: "Matti Meikäläinen <matti@example.com>",
    subject: "Kosteusläikkä katossa", summary: "Asukas havaitsi kasvavan kosteusläikän kylpyhuoneen katossa.",
    body: "Kylpyhuoneen kattoon on ilmestynyt kostea läikkä, joka on kasvanut päivän aikana. Epäilen yläkerran vuotoa."
  }
];

function seedUrgentExamples() {
  if (!db.prepare("SELECT id FROM companies WHERE id = ?").get("demo-company")) return;
  const insertTicket = db.prepare(`
    INSERT INTO tickets
    (id, company_id, apartment_id, resident_id, type, priority, status, subject, summary,
     source_channel, ai_action, ai_reason, draft, created_at, updated_at)
    VALUES (?, 'demo-company', ?, ?, 'Vikailmoitus', 'urgent', 'open', ?, ?, 'email', 'pending_decision', ?, NULL, ?, ?)
  `);
  const insertMessage = db.prepare("INSERT INTO messages VALUES (?, ?, 'inbound', ?, ?, ?, ?, 'email')");
  const insertAudit = db.prepare("INSERT INTO audit_log VALUES (?, ?, 'system', 'ticket_created', 'Demo-ticket luotu', ?)");
  urgentExamples.forEach((example, index) => {
    const id = `ticket-urgent-${index + 1}`;
    if (db.prepare("SELECT id FROM tickets WHERE id = ?").get(id)) return;
    const now = new Date().toISOString();
    insertTicket.run(
      id, example.apartment, example.resident, example.subject, example.summary,
      "Vikailmoitus vaatii huoltoyhtiön nopeaa toimenpidettä.", now, now
    );
    insertMessage.run(`message-urgent-${index + 1}`, id, example.sender, example.subject, example.body, now);
    insertAudit.run(`audit-urgent-${index + 1}`, id, now);
  });
}

export function seed() {
  backfillKnowledge();
  const company = db.prepare("SELECT id FROM companies WHERE id = ?").get("demo-company");
  if (company) {
    seedUrgentExamples();
    return;
  }

  db.prepare("INSERT INTO companies (id, name, email_address) VALUES (?, ?, ?)").run(
    "demo-company",
    "As Oy Koivikko",
    "koivikko@kotilo.example"
  );

  db.prepare("INSERT INTO apartments VALUES (?, ?, ?, ?)").run(
    "apt-12", "demo-company", "A 12", "Koivikkotie 10"
  );
  db.prepare("INSERT INTO apartments VALUES (?, ?, ?, ?)").run(
    "apt-34", "demo-company", "B 34", "Koivikkotie 10"
  );

  db.prepare("INSERT INTO residents (id, company_id, apartment_id, name, email) VALUES (?, ?, ?, ?, ?)").run(
    "resident-1", "demo-company", "apt-12", "Matti Meikäläinen", "matti@example.com"
  );
  db.prepare("INSERT INTO residents (id, company_id, apartment_id, name, email) VALUES (?, ?, ?, ?, ?)").run(
    "resident-2", "demo-company", "apt-34", "Liisa Mallikas", "liisa@example.com"
  );

  db.prepare("INSERT INTO knowledge (id, company_id, title, content) VALUES (?, ?, ?, ?)").run(
    "knowledge-1",
    "demo-company",
    "Järjestyssäännöt",
    "Hiljaisuus on klo 22–07. Taloyhtiön yhteiset tilat pidetään siisteinä."
  );
  db.prepare("INSERT INTO knowledge (id, company_id, title, content) VALUES (?, ?, ?, ?)").run(
    "knowledge-2",
    "demo-company",
    "Saunavuorot",
    "Saunavuorot varataan taloyhtiön varausjärjestelmästä. Vuoroja voi varata yhden kerrallaan."
  );
  db.prepare("INSERT INTO knowledge (id, company_id, title, content) VALUES (?, ?, ?, ?)").run(
    "knowledge-3",
    "demo-company",
    "Huoltoyhtiö",
    "Normaalit huoltoasiat ilmoitetaan Pleissin kautta. Päivystysnumero on 010 123 4567."
  );
  backfillKnowledge();

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tickets
    (id, company_id, apartment_id, resident_id, type, priority, status, subject, summary,
     source_channel, ai_action, ai_reason, draft, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "ticket-1",
    "demo-company",
    "apt-12",
    "resident-1",
    "Kysymys",
    "normal",
    "open",
    "Saunavuoro",
    "Asukas kysyy, miten saunavuoro varataan.",
    "email",
    "ai",
    "Vastaus löytyy taloyhtiön tietopankista.",
    "Hei! Saunavuorot varataan taloyhtiön varausjärjestelmästä.",
    now,
    now
  );

  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "message-1",
    "ticket-1",
    "inbound",
    "Matti Meikäläinen <matti@example.com>",
    "Saunavuoro",
    "Miten saan varattua saunavuoron?",
    now,
    "email"
  );

  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    "audit-1",
    "ticket-1",
    "system",
    "ticket_created",
    "Demo-ticket luotu",
    now
  );
  seedUrgentExamples();
}
