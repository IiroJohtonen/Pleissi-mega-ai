import type { Statement } from "better-sqlite3";
import { z } from "zod";
import { AUTHORIZED_COMPANY_IDS } from "../access.js";
import { db } from "../db.js";
import { isManagerRole } from "../roles.js";
import { addResident } from "../routes/residents.js";
import { ACTIVE_RESIDENT, id, normalizePhone, today } from "../util.js";
import {
  HousingCompanySchema, ResidentMovedOutSchema, ResidentSchema, SyncResidentSchema,
  type HousingCompany, type SyncResident
} from "./canonical.js";

// ---------------------------------------------------------------------------------------------
// ERP → Pleissi: tapahtumien vastaanotto (POST /api/v1/events) ja ensilataus (POST /api/v1/sync/
// housing-companies), docs/integraatiospec.md. Jokainen tapahtuma käsitellään omassa transaktiossaan ja
// kirjataan vastaanottolokiin (integration_inbox) tuloksineen:
//   accepted   käsitelty
//   pending    viitattu taloyhtiö, asunto tai asukas puuttuu vielä; käsitellään uudelleen, kun tieto
//              saapuu, enintään 24 h, sitten rejected + unknown_reference
//   duplicate  sama eventId on jo vastaanotettu (ei kirjata uudelleen)
//   rejected   validation_error tai unknown_reference
// ERP:ltä tulleita tietoja ei julkaista takaisin lähtevään jonoon: jono koskee vain tehtäviä ja viestejä.
// Koko sanoma säilytetään 30 päivää (henkilötietoja), tulosrivi pidempään ilman sisältöä.
// ---------------------------------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS integration_inbox (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  api_key_id TEXT,
  occurred_at TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- accepted, pending tai rejected.
  status TEXT NOT NULL,
  -- Hylkäyksen tai odotuksen syy (unknown_reference, validation_error) ja selite (kenttä).
  reason TEXT,
  message TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  -- Pleissin olio, jota sanoma koski (accepted).
  entity_type TEXT,
  entity_id TEXT,
  -- Odottavan sanoman puuttuva tieto (esim. company:ERP-HC-1); käsitellään uudelleen, kun se saapuu.
  waiting_ref TEXT,
  -- Asukastapahtumissa asukkaan ERP-tunniste: asukkaan tietojen poisto tyhjentää myös odottavat ja hylätyt sanomat.
  resident_ref TEXT,
  -- Koko sanoma JSONina; NULL säilytysajan jälkeen tai asukkaan tietojen poiston jälkeen.
  payload TEXT,
  payload_removed_at TEXT
);
CREATE INDEX IF NOT EXISTS integration_inbox_status ON integration_inbox (status, received_at);
CREATE INDEX IF NOT EXISTS integration_inbox_entity ON integration_inbox (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS integration_inbox_resident ON integration_inbox (resident_ref);
-- Säilytysajan siivous käy läpi vain rivit, joissa sanoma on vielä tallessa.
CREATE INDEX IF NOT EXISTS integration_inbox_payload ON integration_inbox (received_at) WHERE payload IS NOT NULL;
`);
if (!(db.prepare("PRAGMA table_info(integration_inbox)").all() as { name: string }[]).some(column => column.name === "waiting_ref")) {
  db.exec("ALTER TABLE integration_inbox ADD COLUMN waiting_ref TEXT");
}
db.exec("CREATE INDEX IF NOT EXISTS integration_inbox_waiting ON integration_inbox (waiting_ref) WHERE status = 'pending'");

// Ensilataus ja vastaanotto ajavat samoja kyselyitä tuhansia kertoja, joten lauseet käännetään kerran.
const statements = new Map<string, Statement>();
function sql(text: string) {
  let statement = statements.get(text);
  if (!statement) {
    statement = db.prepare(text);
    statements.set(text, statement);
  }
  return statement;
}

export const PENDING_MAX_MS = 24 * 60 * 60 * 1000;
export const PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_EVENTS = 100;
export const SUPPORTED_EVENTS = ["housingCompany.upserted", "resident.upserted", "resident.moved_out"] as const;
type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];

export type EventResult = {
  eventId: string | null;
  status: "accepted" | "pending" | "duplicate" | "rejected";
  pleissiId?: string;
  reason?: "unknown_reference" | "validation_error";
  message?: string;
};

// accepted: provides = ERP-tunnisteet, joita odottavat sanomat voivat tarvita (company:…, apartment:…, resident:…).
// pending: waiting = puuttuva tunniste samassa muodossa.
type Outcome =
  | { status: "accepted"; entityType: "company" | "resident"; entityId: string; created: boolean; provides: string[] }
  | { status: "rejected"; reason: "unknown_reference" | "validation_error"; message: string }
  | { status: "pending"; reason: "unknown_reference"; message: string; waiting: string };

const reject = (message: string): Outcome => ({ status: "rejected", reason: "validation_error", message });
const missing = (waiting: string, message: string): Outcome => ({ status: "pending", reason: "unknown_reference", message, waiting });

const EnvelopeSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
  eventType: z.string().min(1).max(100),
  schemaVersion: z.string().regex(/^1(\.\d+)*$/, "Tuettu versio on 1.x"),
  occurredAt: z.iso.datetime({ offset: true }),
  source: z.literal("erp"),
  data: z.unknown()
});

// Zod-virhe muotoon "kenttä: syy" ilman arvoja (sanomassa voi olla henkilötietoja).
function issues(error: z.ZodError, prefix = "") {
  return error.issues.slice(0, 5).map(issue => `${[prefix, ...issue.path.map(String)].filter(Boolean).join(".") || "data"}: ${issue.message}`).join("; ");
}

// --- ERP-tunnisteet ---------------------------------------------------------------------------

const ENTITY_TABLE = { company: "companies", apartment: "apartments", resident: "residents" } as const;
type RefEntity = keyof typeof ENTITY_TABLE;

// Pleissin olio ERP:n tunnisteella. Poistettuun olioon jäänyt tunniste siivotaan.
export function findByRef(entityType: RefEntity, externalId: string): string | null {
  const ref = sql("SELECT entity_id FROM integration_refs WHERE entity_type = ? AND system = 'erp' AND external_id = ?")
    .get(entityType, externalId) as { entity_id: string } | undefined;
  if (!ref) return null;
  if (sql(`SELECT 1 FROM ${ENTITY_TABLE[entityType]} WHERE id = ?`).get(ref.entity_id)) return ref.entity_id;
  sql("DELETE FROM integration_refs WHERE entity_type = ? AND entity_id = ? AND system = 'erp'").run(entityType, ref.entity_id);
  return null;
}

function setRef(entityType: RefEntity, entityId: string, externalId: string) {
  sql(`
    INSERT INTO integration_refs (entity_type, entity_id, task_id, system, external_id, created_at) VALUES (?, ?, NULL, 'erp', ?, ?)
    ON CONFLICT (entity_type, entity_id, system) DO UPDATE SET external_id = excluded.external_id
  `).run(entityType, entityId, externalId, new Date().toISOString());
}

// --- Taloyhtiö ja asunnot ---------------------------------------------------------------------

const text = (value: string | null | undefined) => (value ?? "").trim();

function applyHousingCompany(data: HousingCompany): Outcome {
  const refs = data.apartments.map(apartment => apartment.externalRefs.erp);
  if (new Set(refs).size !== refs.length) return reject("apartments: sama externalRefs.erp useaan kertaan");

  const businessId = text(data.businessId);
  let companyId = findByRef("company", data.externalRefs.erp);
  if (!companyId && businessId) {
    // Ensilatauksessa Y-tunnus yhdistää ERP:n taloyhtiön Pleissiin jo lisättyyn yhtiöön.
    const match = sql(`
      SELECT id FROM companies c WHERE business_id = ?
        AND NOT EXISTS (SELECT 1 FROM integration_refs WHERE entity_type = 'company' AND entity_id = c.id)
    `).all(businessId) as { id: string }[];
    companyId = match.find(company => AUTHORIZED_COMPANY_IDS.has(company.id))?.id ?? null;
  }
  if (sql("SELECT 1 FROM companies WHERE lower(email_address) = lower(?) AND id != ?").get(data.email, companyId ?? "")) {
    return reject("email: sähköposti on jo toisen taloyhtiön käytössä");
  }
  let managerId: string | undefined;
  const managerEmail = text(data.propertyManager?.email);
  if (managerEmail) {
    const user = sql("SELECT id, role FROM users WHERE lower(email) = lower(?)").get(managerEmail) as { id: string; role: string } | undefined;
    if (user && isManagerRole(user.role)) managerId = user.id;
  }

  const created = !companyId;
  if (!companyId) {
    companyId = id("company");
    sql("INSERT INTO companies (id, name, email_address, managed) VALUES (?, ?, ?, 1)").run(companyId, data.name, data.email);
    AUTHORIZED_COMPANY_IDS.add(companyId);
  }
  sql("UPDATE companies SET name = ?, email_address = ? WHERE id = ?").run(data.name, data.email, companyId);
  if (data.businessId !== undefined) sql("UPDATE companies SET business_id = ? WHERE id = ?").run(businessId, companyId);
  if (data.phone !== undefined) sql("UPDATE companies SET phone = ? WHERE id = ?").run(text(data.phone), companyId);
  if (managerId) sql("UPDATE companies SET manager_id = ? WHERE id = ?").run(managerId, companyId);
  if (data.maintenance) {
    sql(`
      UPDATE companies SET maintenance_name = ?, maintenance_phone = ?, maintenance_email = ?, maintenance_emergency_phone = ? WHERE id = ?
    `).run(text(data.maintenance.name), text(data.maintenance.phone), text(data.maintenance.email), text(data.maintenance.emergencyPhone), companyId);
  }
  setRef("company", companyId, data.externalRefs.erp);

  for (const [index, apartment] of data.apartments.entries()) {
    let apartmentId = findByRef("apartment", apartment.externalRefs.erp);
    if (apartmentId) {
      const owner = (sql("SELECT company_id FROM apartments WHERE id = ?").get(apartmentId) as { company_id: string }).company_id;
      if (owner !== companyId) throw new Rejection(`apartments.${index}.externalRefs.erp: asunto kuuluu toiseen taloyhtiöön`);
    } else {
      apartmentId = (sql(`
        SELECT id FROM apartments a WHERE company_id = ? AND lower(apartment_number) = lower(?) AND lower(address) = lower(?)
          AND NOT EXISTS (SELECT 1 FROM integration_refs WHERE entity_type = 'apartment' AND entity_id = a.id)
      `).get(companyId, apartment.apartmentNumber, apartment.address) as { id: string } | undefined)?.id ?? null;
    }
    if (!apartmentId) {
      apartmentId = id("apt");
      sql("INSERT INTO apartments (id, company_id, apartment_number, address) VALUES (?, ?, ?, ?)")
        .run(apartmentId, companyId, apartment.apartmentNumber, apartment.address);
    }
    sql("UPDATE apartments SET apartment_number = ?, address = ? WHERE id = ?").run(apartment.apartmentNumber, apartment.address, apartmentId);
    if (apartment.staircase !== undefined) sql("UPDATE apartments SET staircase = ? WHERE id = ?").run(text(apartment.staircase), apartmentId);
    setRef("apartment", apartmentId, apartment.externalRefs.erp);
  }
  return {
    status: "accepted", entityType: "company", entityId: companyId, created,
    provides: [`company:${data.externalRefs.erp}`, ...refs.map(ref => `apartment:${ref}`)]
  };
}

// Hylkäys kesken käsittelyn: transaktio perutaan, ja tapahtuma kirjataan hylätyksi.
class Rejection extends Error {}

// --- Asukas -----------------------------------------------------------------------------------

function applyResident(data: SyncResident, companyId: string): Outcome {
  const apartmentId = findByRef("apartment", data.apartmentRef);
  if (!apartmentId) return missing(`apartment:${data.apartmentRef}`, `apartmentRef: asuntoa ${data.apartmentRef} ei ole vielä Pleississä`);
  const apartmentCompany = (sql("SELECT company_id FROM apartments WHERE id = ?").get(apartmentId) as { company_id: string }).company_id;
  if (apartmentCompany !== companyId) return reject("apartmentRef: asunto kuuluu toiseen taloyhtiöön");

  const phone = text(data.phone) ? normalizePhone(data.phone) : null;
  if (text(data.phone) && !phone) return reject("phone: puhelinnumero ei ole E.164-muodossa");
  const email = text(data.email) || null;
  const roles = ["osakas", "asukas"].filter(role => data.roles.includes(role as never)).join(",");

  let residentId = findByRef("resident", data.externalRefs.erp);
  if (!residentId && email) {
    // Pleissiin aiemmin lisätty asukas yhdistetään ERP:n asukkaaseen sähköpostilla.
    residentId = (sql(`
      SELECT r.id FROM residents r WHERE r.company_id = ? AND lower(r.email) = lower(?) AND ${ACTIVE_RESIDENT} AND r.erased_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM integration_refs WHERE entity_type = 'resident' AND entity_id = r.id)
    `).get(companyId, email) as { id: string } | undefined)?.id ?? null;
  }

  let created = false;
  if (residentId) {
    const resident = sql("SELECT apartment_id, erased_at FROM residents WHERE id = ?").get(residentId) as { apartment_id: string; erased_at: string | null };
    if (resident.erased_at) return reject("externalRefs.erp: asukkaan tiedot on poistettu Pleissistä");
    if (email && sql(`
      SELECT 1 FROM residents r WHERE r.company_id = ? AND lower(r.email) = lower(?) AND r.id != ? AND ${ACTIVE_RESIDENT}
    `).get(companyId, email, residentId)) {
      return reject("email: sähköposti on jo toisen asukkaan käytössä");
    }
    sql("UPDATE residents SET company_id = ?, apartment_id = ?, name = ?, email = ?, roles = ? WHERE id = ?")
      .run(companyId, apartmentId, data.name, email, roles, residentId);
    // Asukkaan tehtävät seuraavat asukasta uuteen asuntoon, kuten käsin muutettaessa.
    sql("UPDATE tickets SET apartment_id = ? WHERE resident_id = ? AND apartment_id = ?").run(apartmentId, residentId, resident.apartment_id);
  } else {
    const result = addResident(companyId, { name: data.name, email: email ?? "", apartmentId, roles: roles.split(",") });
    if ("error" in result) return reject(result.status === 409 ? "email: sähköposti on jo toisen asukkaan käytössä" : result.error);
    residentId = result.residentId;
    created = true;
  }
  sql("UPDATE residents SET phone = ? WHERE id = ?").run(phone, residentId);
  if (data.movedInAt !== undefined) sql("UPDATE residents SET moved_in_at = ? WHERE id = ?").run(data.movedInAt, residentId);
  if (data.movedOutAt !== undefined) sql("UPDATE residents SET moved_out_at = ? WHERE id = ?").run(data.movedOutAt, residentId);
  setRef("resident", residentId, data.externalRefs.erp);
  return { status: "accepted", entityType: "resident", entityId: residentId, created, provides: [`resident:${data.externalRefs.erp}`] };
}

// --- Tapahtumat -------------------------------------------------------------------------------

function handle(eventType: SupportedEvent, data: unknown): Outcome {
  if (eventType === "housingCompany.upserted") {
    const parsed = HousingCompanySchema.safeParse(data);
    return parsed.success ? applyHousingCompany(parsed.data) : reject(issues(parsed.error, "data"));
  }
  if (eventType === "resident.upserted") {
    const parsed = ResidentSchema.safeParse(data);
    if (!parsed.success) return reject(issues(parsed.error, "data"));
    const companyId = findByRef("company", parsed.data.housingCompanyRef);
    if (!companyId) return missing(`company:${parsed.data.housingCompanyRef}`, `housingCompanyRef: taloyhtiötä ${parsed.data.housingCompanyRef} ei ole vielä Pleississä`);
    return applyResident(parsed.data, companyId);
  }
  const parsed = ResidentMovedOutSchema.safeParse(data);
  if (!parsed.success) return reject(issues(parsed.error, "data"));
  const residentId = findByRef("resident", parsed.data.externalRefs.erp);
  if (!residentId) return missing(`resident:${parsed.data.externalRefs.erp}`, `externalRefs.erp: asukasta ${parsed.data.externalRefs.erp} ei ole vielä Pleississä`);
  sql("UPDATE residents SET moved_out_at = ? WHERE id = ?").run(parsed.data.movedOutAt ?? today(), residentId);
  return { status: "accepted", entityType: "resident", entityId: residentId, created: false, provides: [] };
}

// Käsittely transaktiossa: hylkäys tai virhe kesken perii kaikki saman tapahtuman muutokset.
function handleInTransaction(eventType: SupportedEvent, data: unknown, after: (outcome: Outcome) => void): Outcome {
  let outcome: Outcome = reject("Käsittely epäonnistui");
  try {
    db.transaction(() => {
      outcome = handle(eventType, data);
      if (outcome.status !== "accepted") throw new Rejection();
      after(outcome);
    })();
  } catch (error) {
    if (!(error instanceof Rejection)) throw error;
    if (error.message) outcome = reject(error.message);
    after(outcome);
  }
  return outcome;
}

const residentRef = (eventType: string, data: unknown) =>
  eventType.startsWith("resident.") ? (data as { externalRefs?: { erp?: unknown } } | null)?.externalRefs?.erp : undefined;

function toResult(eventId: string, outcome: Outcome): EventResult {
  return outcome.status === "accepted"
    ? { eventId, status: "accepted", pleissiId: outcome.entityId }
    : { eventId, status: outcome.status, reason: outcome.reason, message: outcome.message };
}

// Vastaanottaa ERP:n tapahtumat (enintään 100) ja palauttaa tuloksen kullekin samassa järjestyksessä.
export function receiveEvents(events: unknown[], apiKeyId: string | null, at = Date.now()): EventResult[] {
  const timestamp = new Date(at).toISOString();
  const results: EventResult[] = [];
  const provided: string[] = [];
  const insert = sql(`
    INSERT INTO integration_inbox (event_id, event_type, api_key_id, occurred_at, received_at, updated_at, status, reason, message,
      entity_type, entity_id, resident_ref, waiting_ref, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const raw of events) {
    const rawId = (raw as { eventId?: unknown } | null)?.eventId;
    const eventId = typeof rawId === "string" && rawId.trim() ? rawId.trim().slice(0, 200) : null;
    if (!eventId) {
      results.push({ eventId: null, status: "rejected", reason: "validation_error", message: "eventId: puuttuu" });
      continue;
    }
    const existing = sql("SELECT entity_id FROM integration_inbox WHERE event_id = ?").get(eventId) as { entity_id: string | null } | undefined;
    if (existing) {
      results.push({ eventId, status: "duplicate", ...(existing.entity_id ? { pleissiId: existing.entity_id } : {}) });
      continue;
    }

    const rawType = (raw as { eventType?: unknown }).eventType;
    const eventType = typeof rawType === "string" ? rawType.slice(0, 100) : "unknown";
    const payload = JSON.stringify(raw);
    const envelope = EnvelopeSchema.safeParse(raw);
    const record = (outcome: Outcome) => {
      const accepted = outcome.status === "accepted" ? outcome : null;
      const ref = residentRef(eventType, envelope.success ? envelope.data.data : null);
      insert.run(
        eventId, eventType, apiKeyId, envelope.success ? envelope.data.occurredAt : null, timestamp, timestamp, outcome.status,
        accepted ? null : (outcome as { reason: string }).reason, accepted ? null : (outcome as { message: string }).message,
        accepted?.entityType ?? null, accepted?.entityId ?? null, typeof ref === "string" ? ref : null,
        outcome.status === "pending" ? outcome.waiting : null, payload
      );
    };

    let outcome: Outcome;
    if (!envelope.success) {
      outcome = reject(issues(envelope.error));
      record(outcome);
    } else if (!(SUPPORTED_EVENTS as readonly string[]).includes(envelope.data.eventType)) {
      outcome = reject(`eventType: tapahtumaa ${envelope.data.eventType} ei vielä tueta`);
      record(outcome);
    } else {
      outcome = handleInTransaction(envelope.data.eventType as SupportedEvent, envelope.data.data, record);
    }
    if (outcome.status === "accepted") provided.push(...outcome.provides);
    results.push(toResult(eventId, outcome));
  }

  retryWaiting(provided, at);
  return results;
}

type InboxRow = { event_id: string; event_type: string; received_at: string; attempts: number; payload: string | null };

const expired = (row: Pick<InboxRow, "received_at">, at: number) => at - Date.parse(row.received_at) > PENDING_MAX_MS;

function expire(eventId: string, timestamp: string) {
  sql(`
    UPDATE integration_inbox SET status = 'rejected', reason = 'unknown_reference', waiting_ref = NULL, updated_at = ?,
      message = COALESCE(message, '') || ' (odotettu yli 24 tuntia)' WHERE event_id = ?
  `).run(timestamp, eventId);
}

// Odottavat sanomat, joiden puuttuva tieto juuri saapui (provided: company:…, apartment:…, resident:…),
// käsitellään uudelleen. Vain niitä, joten odottavien määrä ei hidasta muita kutsuja. Hyväksytty sanoma
// voi olla toisen odottavan puuttuva tieto (taloyhtiö → asukas → poismuutto), joten jatketaan ketjua.
// Yli 24 tuntia odottanut hylätään (unknown_reference) eikä sitä enää käsitellä.
export function retryWaiting(provided: string[], at = Date.now()) {
  const timestamp = new Date(at).toISOString();
  const counts = { accepted: 0, rejected: 0, pending: 0 };
  const queue = [...new Set(provided)];
  const seen = new Set(queue);
  while (queue.length) {
    const rows = sql(`
      SELECT event_id, event_type, received_at, attempts, payload FROM integration_inbox
      WHERE status = 'pending' AND waiting_ref = ? ORDER BY received_at, rowid
    `).all(queue.shift()!) as InboxRow[];
    for (const row of rows) {
      if (!row.payload || expired(row, at)) {
        expire(row.event_id, timestamp);
        counts.rejected++;
        continue;
      }
      const envelope = JSON.parse(row.payload) as { data: unknown };
      const outcome = handleInTransaction(row.event_type as SupportedEvent, envelope.data, result => {
        const accepted = result.status === "accepted" ? result : null;
        sql(`
          UPDATE integration_inbox SET status = ?, reason = ?, message = ?, entity_type = ?, entity_id = ?, waiting_ref = ?,
            attempts = ?, updated_at = ?
          WHERE event_id = ?
        `).run(
          result.status, accepted ? null : (result as { reason: string }).reason, accepted ? null : (result as { message: string }).message,
          accepted?.entityType ?? null, accepted?.entityId ?? null, result.status === "pending" ? result.waiting : null,
          row.attempts + 1, timestamp, row.event_id
        );
      });
      if (outcome.status === "accepted") {
        counts.accepted++;
        for (const ref of outcome.provides) if (!seen.has(ref)) { seen.add(ref); queue.push(ref); }
      } else if (outcome.status === "rejected") counts.rejected++;
      else counts.pending++;
    }
  }
  return counts;
}

// Ajastettu tarkistus: yli 24 tuntia odottaneet hylätään. Uudelleenkäsittely tehdään, kun tieto saapuu
// (retryWaiting), joten tämä ei käsittele sanomia.
export function expirePendingInbox(at = Date.now()) {
  return sql(`
    UPDATE integration_inbox SET status = 'rejected', reason = 'unknown_reference', waiting_ref = NULL, updated_at = ?,
      message = COALESCE(message, '') || ' (odotettu yli 24 tuntia)'
    WHERE status = 'pending' AND received_at < ?
  `).run(new Date(at).toISOString(), new Date(at - PENDING_MAX_MS).toISOString()).changes;
}

// --- Ensilataus ja täsmäytys ------------------------------------------------------------------

export const SyncSchema = z.object({
  housingCompanies: z.array(HousingCompanySchema.extend({ residents: z.array(z.unknown()).max(10_000).default([]) })).min(1).max(500)
});

type SyncRejection = { housingCompanyRef: string; residentRef: string | null; reason: string; message: string };

// Taloyhtiöt asuntoineen ja asukkaineen kerralla: uudet lisätään, muuttuneet päivitetään, ja yhtiön
// asukkaat, jotka puuttuvat listasta, merkitään poismuuttaneiksi tästä päivästä. Kukin taloyhtiö
// käsitellään omassa transaktiossaan, ja taloyhtiöiden välissä palvelin ehtii vastata muihin pyyntöihin.
export async function syncHousingCompanies(input: z.infer<typeof SyncSchema>, at = Date.now()) {
  const summary = { added: 0, updated: 0, movedOut: 0 };
  const companies: { housingCompanyRef: string; pleissiId: string | null; added: number; updated: number; movedOut: number }[] = [];
  const rejected: SyncRejection[] = [];
  const provided: string[] = [];

  for (const { residents, ...company } of input.housingCompanies) {
    const companyRef = company.externalRefs.erp;
    const result = { housingCompanyRef: companyRef, pleissiId: null as string | null, added: 0, updated: 0, movedOut: 0 };
    try {
      db.transaction(() => {
        const applied = applyHousingCompany(company);
        if (applied.status !== "accepted") throw new Rejection(applied.message);
        result.pleissiId = applied.entityId;
        provided.push(...applied.provides);
        const seen = new Set<string>();
        for (const [index, raw] of residents.entries()) {
          const parsed = SyncResidentSchema.safeParse(raw);
          const ref = parsed.success ? parsed.data.externalRefs.erp
            : typeof (raw as { externalRefs?: { erp?: unknown } } | null)?.externalRefs?.erp === "string" ? (raw as { externalRefs: { erp: string } }).externalRefs.erp : null;
          // Asukas, jonka tiedoissa on virhe, ei ole poismuuttanut: se jää ennalleen.
          const known = ref ? findByRef("resident", ref) : null;
          if (known) seen.add(known);
          const outcome = parsed.success ? applyResident(parsed.data, applied.entityId) : reject(issues(parsed.error, `residents.${index}`));
          if (outcome.status === "accepted") {
            seen.add(outcome.entityId);
            provided.push(...outcome.provides);
            if (outcome.created) result.added++;
            else result.updated++;
          } else {
            rejected.push({ housingCompanyRef: companyRef, residentRef: ref, reason: outcome.status === "pending" ? "unknown_reference" : outcome.reason, message: outcome.message });
          }
        }
        const active = sql(`SELECT r.id FROM residents r WHERE r.company_id = ? AND ${ACTIVE_RESIDENT} AND r.erased_at IS NULL`)
          .all(applied.entityId) as { id: string }[];
        const moveOut = sql("UPDATE residents SET moved_out_at = ? WHERE id = ?");
        for (const resident of active.filter(row => !seen.has(row.id))) {
          moveOut.run(today(), resident.id);
          result.movedOut++;
        }
      })();
    } catch (error) {
      if (!(error instanceof Rejection)) throw error;
      rejected.push({ housingCompanyRef: companyRef, residentRef: null, reason: "validation_error", message: error.message });
      result.added = result.updated = result.movedOut = 0;
    }
    summary.added += result.added;
    summary.updated += result.updated;
    summary.movedOut += result.movedOut;
    companies.push(result);
    await new Promise(resolve => setImmediate(resolve));
  }
  retryWaiting(provided, at);
  return { ...summary, companies, rejected };
}

// --- Säilytys ja tietosuoja -------------------------------------------------------------------

// Koko sanoma poistetaan 30 päivän jälkeen; tulosrivi jää. Odottavat käsitellään ensin loppuun.
export function purgeInboxPayloads(at = Date.now()) {
  return sql(`
    UPDATE integration_inbox SET payload = NULL, payload_removed_at = ?
    WHERE payload IS NOT NULL AND status != 'pending' AND received_at < ?
  `).run(new Date(at).toISOString(), new Date(at - PAYLOAD_RETENTION_MS).toISOString()).changes;
}

// Asukkaan tietojen poisto: asukasta koskevien sanomien sisältö ja selitteet poistetaan vastaanottolokista.
export function eraseInboxForResident(residentId: string) {
  const ref = (sql("SELECT external_id FROM integration_refs WHERE entity_type = 'resident' AND entity_id = ? AND system = 'erp'")
    .get(residentId) as { external_id: string } | undefined)?.external_id ?? null;
  sql(`
    UPDATE integration_inbox SET payload = NULL, message = NULL, payload_removed_at = ?,
      status = CASE status WHEN 'pending' THEN 'rejected' ELSE status END, waiting_ref = NULL
    WHERE (entity_type = 'resident' AND entity_id = ?) OR (resident_ref IS NOT NULL AND resident_ref = ?)
  `).run(new Date().toISOString(), residentId, ref);
}
