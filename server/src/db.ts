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

-- Jonotuslista autopaikalle tai saunavuorolle. status: 'waiting', 'offered', 'done' tai 'cancelled'.
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
// ja vanha jää historiaan tilaan 'replaced'. Poistettu tietue jää tilaan 'deleted'.
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
  ["audience", "TEXT NOT NULL DEFAULT 'ai'"]
]) {
  if (!knowledgeColumns.some(existing => existing.name === column)) {
    db.exec(`ALTER TABLE knowledge ADD COLUMN ${column} ${definition}`);
  }
}

const ticketSourceColumns = db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[];
for (const column of ["knowledge_source_id", "knowledge_source_title"]) {
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

// Toistuvien aiheiden raportti: aiheet, jotka jätettiin pois, koska niistä on jo dokumentaatio.
if (!(db.prepare("PRAGMA table_info(topic_reports)").all() as { name: string }[]).some(column => column.name === "covered")) {
  db.exec("ALTER TABLE topic_reports ADD COLUMN covered TEXT NOT NULL DEFAULT '[]'");
}

db.exec(`
-- Käyttäjälle lähetetty muistutuskooste: enintään yksi päivässä.
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

function backfillKnowledge() {
  db.prepare("UPDATE knowledge SET group_id = id WHERE group_id IS NULL").run();
  db.prepare("UPDATE knowledge SET created_at = ? WHERE created_at IS NULL").run(new Date().toISOString());
}

export function seed() {
  backfillKnowledge();
  const company = db.prepare("SELECT id FROM companies WHERE id = ?").get("demo-company");
  if (company) return;

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
    "Normaalit huoltoasiat ilmoitetaan Kotilon kautta. Päivystysnumero on 010 123 4567."
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
    "Hei! Saunavuorot varataan taloyhtiön varausjärjestelmästä. Terveisin Kotilo-sihteeri.",
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
}
