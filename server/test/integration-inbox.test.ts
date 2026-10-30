import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { tempDir } from "./helpers.js";

// ERP:n tapahtumien vastaanotto ilman palvelinta, annetulla kellonajalla: odotustilan 24 tunnin raja,
// sanomien säilytysaika sekä asukkaan puhelinnumero ja tunnistus puhelinnumerolla.

let db: typeof import("../src/db.js").db;
let inbox: typeof import("../src/integration/inbox.js");
let findResident: typeof import("../src/routes/residents.js").findResident;
let addResident: typeof import("../src/routes/residents.js").addResident;
let normalizePhone: typeof import("../src/util.js").normalizePhone;

const HOUR = 60 * 60 * 1000;
let seq = 0;
const envelope = (eventType: string, data: unknown) =>
  ({ eventId: `inbox-evt-${++seq}`, eventType, schemaVersion: "1.0", occurredAt: "2026-10-30T09:00:00+02:00", source: "erp", data });
const companyData = (ref: string) => ({
  externalRefs: { erp: ref }, name: `As Oy ${ref}`, email: `${ref.toLowerCase()}@example.com`,
  apartments: [{ externalRefs: { erp: `${ref}-A1` }, apartmentNumber: "A 1", address: `${ref}katu 1` }]
});
const residentData = (ref: string, companyRef: string) => ({
  externalRefs: { erp: ref }, housingCompanyRef: companyRef, apartmentRef: `${companyRef}-A1`, name: `Asukas ${ref}`,
  email: null, phone: "+358401234567", roles: ["asukas"]
});
const row = (eventId: string) => db.prepare("SELECT status, reason, attempts, payload FROM integration_inbox WHERE event_id = ?").get(eventId) as
  { status: string; reason: string | null; attempts: number; payload: string | null };

describe("ERP:n tapahtumien vastaanotto", () => {
  before(async () => {
    process.env.DATA_DIR = await tempDir("kotilo-inbox-");
    process.env.GMAIL_DISABLED = "1";
    ({ db } = await import("../src/db.js"));
    await import("../src/routes/tickets.js");
    inbox = await import("../src/integration/inbox.js");
    ({ findResident, addResident } = await import("../src/routes/residents.js"));
    ({ normalizePhone } = await import("../src/util.js"));
  });

  it("odottava sanoma hylätään 24 tunnin jälkeen, eikä myöhemmin saapuva tieto enää käsittele sitä", () => {
    const start = Date.parse("2026-10-30T08:00:00Z");
    const late = envelope("resident.upserted", residentData("R-LATE", "HC-LATE"));
    const inTime = envelope("resident.upserted", residentData("R-OK", "HC-OK"));
    assert.equal(inbox.receiveEvents([late, inTime], null, start)[0].status, "pending");

    // 23 h: edelleen odottaa, ja uusi yritys kasvattaa yrityskertoja.
    inbox.processPendingInbox(start + 23 * HOUR);
    assert.deepEqual([row(late.eventId).status, row(late.eventId).attempts], ["pending", 2]);
    // Puuttuva taloyhtiö saapuu ajoissa toiselle sanomalle.
    assert.equal(inbox.receiveEvents([envelope("housingCompany.upserted", companyData("HC-OK"))], null, start + 23.5 * HOUR)[0].status, "accepted");
    assert.equal(row(inTime.eventId).status, "accepted");

    inbox.processPendingInbox(start + 24 * HOUR + 1);
    assert.deepEqual([row(late.eventId).status, row(late.eventId).reason], ["rejected", "unknown_reference"]);
    inbox.receiveEvents([envelope("housingCompany.upserted", companyData("HC-LATE"))], null, start + 25 * HOUR);
    assert.equal(row(late.eventId).status, "rejected", "hylättyä ei käsitellä uudelleen automaattisesti");
    assert.equal(db.prepare("SELECT 1 FROM residents WHERE name = 'Asukas R-LATE'").get(), undefined);
  });

  it("sanoman sisältö poistetaan 30 päivän jälkeen, tulosrivi jää", () => {
    const start = Date.parse("2026-11-01T08:00:00Z");
    const event = envelope("housingCompany.upserted", companyData("HC-OLD"));
    inbox.receiveEvents([event], null, start);
    inbox.purgeInboxPayloads(start + 29 * 24 * HOUR);
    assert.ok(row(event.eventId).payload, "säilyy 30 päivää");
    inbox.purgeInboxPayloads(start + 31 * 24 * HOUR);
    assert.deepEqual([row(event.eventId).status, row(event.eventId).payload], ["accepted", null]);
  });

  it("puhelinnumero muunnetaan E.164-muotoon", () => {
    assert.equal(normalizePhone("040 123 4567"), "+358401234567");
    assert.equal(normalizePhone("+358 (40) 123-4567"), "+358401234567");
    assert.equal(normalizePhone("00358401234567"), "+358401234567");
    assert.equal(normalizePhone("358401234567"), "+358401234567");
    assert.equal(normalizePhone("12"), null);
    assert.equal(normalizePhone(""), null);
  });

  it("asukas tunnistetaan puhelinnumerolla, kun numero on yhdellä asukkaalla", () => {
    const companyId = (db.prepare("SELECT entity_id FROM integration_refs WHERE entity_type = 'company' AND external_id = 'HC-OK'").get() as { entity_id: string }).entity_id;
    const apartmentId = (db.prepare("SELECT id FROM apartments WHERE company_id = ?").get(companyId) as { id: string }).id;
    const added = addResident(companyId, { name: "Matti Puhelin", phone: "050 765 4321", apartmentId });
    assert.ok("residentId" in added);
    assert.equal(findResident(companyId, undefined, undefined, "+358 50 765 4321")?.id, added.residentId);
    assert.equal(findResident(companyId, "ei@example.com", undefined, "0507654321")?.id, added.residentId, "sähköposti ei osu, puhelin osuu");
    assert.deepEqual(addResident(companyId, { name: "Väärä numero", phone: "123", apartmentId }), {
      error: "Tarkista puhelinnumero (esim. 040 123 4567 tai +358 40 123 4567).", status: 400
    });
    // Sama numero kahdella asukkaalla ei yksin tunnista ketään.
    addResident(companyId, { name: "Maija Puhelin", phone: "+358507654321", apartmentId });
    assert.equal(findResident(companyId, undefined, undefined, "0507654321"), null);
  });
});
