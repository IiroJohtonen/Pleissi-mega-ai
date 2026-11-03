import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

// Pleissin integraatiorajapinta /api/v1 käynnissä olevassa palvelimessa: API-avaimet, ERP:n tapahtumien
// vastaanotto, ensilataus ja jonon haku kursorilla. Adapteria ei ole, joten haku kytketään asetuksista.

let seq = 0;
const eventId = () => `erp-evt-${++seq}`;
const envelope = (eventType: string, data: unknown, id = eventId()) =>
  ({ eventId: id, eventType, schemaVersion: "1.0", occurredAt: "2026-10-30T09:00:00+02:00", source: "erp", data });

const company = (ref: string, extra: Record<string, unknown> = {}) => ({
  externalRefs: { erp: ref },
  name: `As Oy ${ref}`,
  businessId: null,
  email: `${ref.toLowerCase()}@isannointi.example`,
  phone: "+358201234567",
  propertyManager: { email: MANAGER_EMAIL },
  maintenance: { name: "Huoltoyhtiö Oy", phone: "+358207654321", email: "huolto@huolto.example", emergencyPhone: "+358201112223" },
  apartments: [
    { externalRefs: { erp: `${ref}-A1` }, apartmentNumber: "A 1", staircase: "A", address: `${ref}tie 1` },
    { externalRefs: { erp: `${ref}-B8` }, apartmentNumber: "B 8", staircase: "B", address: `${ref}tie 1` }
  ],
  ...extra
});

const resident = (ref: string, companyRef: string, apartmentRef: string, extra: Record<string, unknown> = {}) => ({
  externalRefs: { erp: ref }, housingCompanyRef: companyRef, apartmentRef, name: `Asukas ${ref}`,
  email: `${ref.toLowerCase()}@example.com`, phone: "040 123 4567", roles: ["asukas"], movedInAt: "2025-06-01", movedOutAt: null, ...extra
});

function query<T>(server: TestServer, sql: string, ...params: unknown[]): T[] {
  const db = new Database(path.join(server.dataDir, "kotilo.sqlite"), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

describe("integraatiorajapinta /api/v1", () => {
  let server: TestServer;
  let admin: string;
  let key: string;

  async function createKey(name: string, scopes: string[]) {
    const created = await call(server, admin, "POST", "/integration/api-keys", { name, scopes });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data as { key: string; apiKey: { id: string } };
  }

  const send = (events: unknown[], token = key) => call(server, token, "POST", "/v1/events", { events });

  before(async () => {
    server = await startServer({ env: { INTEGRATION_SEND_DELAY_MS: "800", INTEGRATION_POLL_MS: "100", API_V1_RATE_LIMIT_PER_MINUTE: "40" } });
    admin = await login(server, ADMIN_EMAIL);
    key = (await createKey("ERP", ["events:write", "events:read", "sync:write"])).key;
  });

  after(async () => {
    await server.stop();
  });

  it("API-avaimen hallinta on vain pääkäyttäjällä, ja avain näytetään vain kerran", async () => {
    const manager = await login(server, MANAGER_EMAIL);
    assert.equal((await call(server, manager, "POST", "/integration/api-keys", { name: "x", scopes: ["events:read"] })).status, 403);
    assert.equal((await call(server, manager, "GET", "/integration/api")).status, 403);
    assert.equal((await call(server, admin, "POST", "/integration/api-keys", { name: "x", scopes: [] })).status, 400);

    const created = await createKey("Testiavain", ["events:read"]);
    assert.match(created.key, /^plk_live_[A-Za-z0-9_-]{20,}$/);
    const settings = await call(server, admin, "GET", "/integration/api");
    const listed = settings.data.keys.find((item: any) => item.id === created.apiKey.id);
    assert.deepEqual(listed.scopes, ["events:read"]);
    assert.ok(!JSON.stringify(settings.data).includes(created.key), "avain ei näy listassa");
    assert.equal(listed.key_hash, undefined);
    const stored = query<{ key_hash: string }>(server, "SELECT key_hash FROM integration_api_keys WHERE id = ?", created.apiKey.id)[0];
    assert.notEqual(stored.key_hash, created.key, "tietokannassa on vain tiiviste");

    const audit = (await call(server, admin, "GET", "/audit")).data as { action: string }[];
    assert.ok(audit.some(entry => entry.action === "integration_api_key_created"));
  });

  it("väärä, puuttuva tai mitätöity avain saa 401 ja puuttuva oikeus 403", async () => {
    assert.equal((await send([envelope("resident.moved_out", {})], "")).status, 401);
    assert.equal((await send([envelope("resident.moved_out", {})], "plk_live_vaaraavainvaaraavainvaara")).status, 401);
    // Kirjautumisen tunniste ei kelpaa rajapinnan avaimeksi.
    assert.equal((await send([envelope("resident.moved_out", {})], admin)).status, 401);

    const readOnly = await createKey("Vain luku", ["events:read"]);
    const denied = await send([envelope("resident.moved_out", {})], readOnly.key);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, "missing_scope");
    assert.equal((await call(server, readOnly.key, "POST", "/v1/sync/housing-companies", { housingCompanies: [] })).status, 403);
    const writeOnly = await createKey("Vain kirjoitus", ["events:write"]);
    assert.equal((await call(server, writeOnly.key, "GET", "/v1/events")).status, 403);

    assert.equal((await call(server, admin, "DELETE", `/integration/api-keys/${readOnly.apiKey.id}`)).status, 200);
    assert.equal((await call(server, readOnly.key, "GET", "/v1/events")).status, 401, "mitätöity avain ei kelpaa");
    const listed = (await call(server, admin, "GET", "/integration/api")).data.keys.find((item: any) => item.id === readOnly.apiKey.id);
    assert.ok(listed.revoked_at);
    assert.ok(listed.last_used_at, "viimeisin käyttö tallentuu");
  });

  it("kutsussa saa olla 1–100 tapahtumaa", async () => {
    assert.equal((await send([])).status, 400);
    assert.equal((await call(server, key, "POST", "/v1/events", { foo: 1 })).status, 400);
    const tooMany = await send(Array.from({ length: 101 }, () => envelope("resident.moved_out", {})));
    assert.equal(tooMany.status, 413);
  });

  it("avaimella on oma pyyntöraja, ja ylitys palauttaa 429 ja Retry-After", async () => {
    const limited = await createKey("Pyyntöraja", ["events:read"]);
    let response = await call(server, limited.key, "GET", "/v1/events");
    for (let index = 0; index < 45 && response.status !== 429; index++) response = await call(server, limited.key, "GET", "/v1/events");
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
    // Toisen avaimen pyynnöt eivät kulu samaan rajaan.
    assert.notEqual((await call(server, key, "GET", "/v1/events")).status, 429);
  });

  it("taloyhtiö ja asukas hyväksytään; puhelin tallentuu E.164-muodossa ja tuplatapahtuma tunnistetaan", async () => {
    const companyEvent = envelope("housingCompany.upserted", company("HC1"));
    const residentEvent = envelope("resident.upserted", resident("R1", "HC1", "HC1-A1"));
    const response = await send([companyEvent, residentEvent]);
    assert.equal(response.status, 202);
    const [companyResult, residentResult] = response.data.results;
    assert.equal(companyResult.status, "accepted", JSON.stringify(companyResult));
    assert.equal(residentResult.status, "accepted", JSON.stringify(residentResult));

    const companies = (await call(server, admin, "GET", "/companies")).data as any[];
    const created = companies.find(item => item.id === companyResult.pleissiId);
    assert.equal(created.name, "As Oy HC1");
    assert.equal(created.maintenance_name, "Huoltoyhtiö Oy");
    assert.ok(created.manager_id, "vastuuisännöitsijä sähköpostilla");
    const residents = (await call(server, admin, "GET", `/companies/${created.id}/residents`)).data as any[];
    const saved = residents.find(item => item.id === residentResult.pleissiId);
    assert.equal(saved.phone, "+358401234567");
    assert.equal(saved.moved_in_at, "2025-06-01");
    assert.equal(saved.apartment_number, "A 1");

    const again = await send([companyEvent, residentEvent]);
    assert.deepEqual(again.data.results.map((result: any) => [result.status, result.pleissiId]),
      [["duplicate", companyResult.pleissiId], ["duplicate", residentResult.pleissiId]]);
    assert.equal(query(server, "SELECT 1 FROM integration_inbox WHERE event_id IN (?, ?)", companyEvent.eventId, residentEvent.eventId).length, 2);

    // Päivitys samalla ERP-tunnisteella muuttaa samaa asukasta.
    const updated = await send([envelope("resident.upserted", resident("R1", "HC1", "HC1-B8", { name: "Liisa Uusinimi", phone: "+358501112222" }))]);
    assert.equal(updated.data.results[0].pleissiId, residentResult.pleissiId);
    const after = (await call(server, admin, "GET", `/companies/${created.id}/residents`)).data.find((item: any) => item.id === residentResult.pleissiId);
    assert.deepEqual([after.name, after.phone, after.apartment_number], ["Liisa Uusinimi", "+358501112222", "B 8"]);
  });

  it("virheellinen tai tukematon sanoma hylätään syyn kanssa", async () => {
    const results = (await send([
      envelope("resident.upserted", resident("R9", "HC1", "HC1-A1", { email: null, phone: null })),
      envelope("resident.upserted", resident("R9", "HC1", "HC1-A1", { phone: "12" })),
      envelope("booking.created", {}),
      { eventType: "resident.upserted" },
      { ...envelope("resident.moved_out", { externalRefs: { erp: "R1" } }), source: "pleissi" }
    ])).data.results;
    assert.deepEqual(results.map((result: any) => [result.status, result.reason]), [
      ["rejected", "validation_error"], ["rejected", "validation_error"], ["rejected", "validation_error"],
      ["rejected", "validation_error"], ["rejected", "validation_error"]
    ]);
    assert.match(results[1].message, /phone/);
    assert.match(results[2].message, /booking\.created/);
    assert.equal(results[3].eventId, null);
  });

  it("asukas ennen taloyhtiötään odottaa ja käsitellään, kun taloyhtiö saapuu", async () => {
    const early = envelope("resident.upserted", resident("R2", "HC2", "HC2-B8"));
    const movedOut = envelope("resident.moved_out", { externalRefs: { erp: "R2" }, movedOutAt: "2026-12-31" });
    const pending = await send([early, movedOut]);
    assert.deepEqual(pending.data.results.map((result: any) => [result.status, result.reason]),
      [["pending", "unknown_reference"], ["pending", "unknown_reference"]]);
    assert.match(pending.data.results[0].message, /housingCompanyRef/);

    const arrived = await send([envelope("housingCompany.upserted", company("HC2"))]);
    assert.equal(arrived.data.results[0].status, "accepted");
    const rows = query<{ event_id: string; status: string; attempts: number; entity_id: string }>(server,
      "SELECT event_id, status, attempts, entity_id FROM integration_inbox WHERE event_id IN (?, ?) ORDER BY rowid", early.eventId, movedOut.eventId);
    assert.deepEqual(rows.map(row => row.status), ["accepted", "accepted"]);
    assert.ok(rows.every(row => row.attempts === 2));
    const saved = query<{ moved_out_at: string; phone: string }>(server, "SELECT moved_out_at, phone FROM residents WHERE id = ?", rows[0].entity_id)[0];
    assert.equal(saved.moved_out_at, "2026-12-31");
    assert.equal((await send([early])).data.results[0].status, "duplicate");
  });

  it("ensilataus lisää ja päivittää, ja listasta puuttuvat asukkaat merkitään poismuuttaneiksi", async () => {
    const residents = [
      resident("S1", "HC3", "HC3-A1"),
      resident("S2", "HC3", "HC3-B8", { email: null, phone: "+358401230000" }),
      resident("S3", "HC3", "HC3-B8", { roles: ["osakas", "asukas"] })
    ].map(({ housingCompanyRef: _ref, ...rest }) => rest);
    const first = await call(server, key, "POST", "/v1/sync/housing-companies", { housingCompanies: [{ ...company("HC3"), residents }] });
    assert.equal(first.status, 202, JSON.stringify(first.data));
    assert.deepEqual([first.data.added, first.data.updated, first.data.movedOut], [3, 0, 0]);
    const companyId = first.data.companies[0].pleissiId;
    // Pleissiin käsin lisätty asukas, jota ERP ei tunne.
    const manual = await call(server, admin, "POST", `/companies/${companyId}/residents`, {
      name: "Käsin lisätty", email: "kasin@example.com", address: "HC3tie 1", apartmentNumber: "A 1"
    });
    assert.equal(manual.status, 201);

    const second = await call(server, key, "POST", "/v1/sync/housing-companies", {
      housingCompanies: [{ ...company("HC3"), residents: [residents[0], { ...residents[1], name: "S2 Uusi" }, { externalRefs: { erp: "S9" } }] }]
    });
    assert.equal(second.status, 202);
    assert.deepEqual([second.data.added, second.data.updated, second.data.movedOut], [0, 2, 2], JSON.stringify(second.data));
    assert.equal(second.data.rejected.length, 1);
    const active = ((await call(server, admin, "GET", `/companies/${companyId}/residents`)).data as any[]).map(item => item.name).sort();
    assert.deepEqual(active, ["Asukas S1", "S2 Uusi"]);
    assert.equal((await call(server, key, "POST", "/v1/sync/housing-companies", { housingCompanies: [{ name: "x" }] })).status, 400);
    const audit = (await call(server, admin, "GET", "/audit")).data as { action: string; details: string }[];
    assert.equal(JSON.parse(audit.find(entry => entry.action === "integration_sync")!.details).movedOut, 2);
  });

  it("asukkaan puhelin ja muuttopäivä tallentuvat lomakkeelta ja tiedostotuonnista", async () => {
    const imported = await call(server, admin, "POST", "/companies/demo-company/residents/import", { rows: [
      { line: 2, name: "Tuotu Puhelin", email: "tuotu@example.com", address: "Tuontikatu 1", apartmentNumber: "C 3", phone: "040 222 3333", movedInAt: "1.6.2025" },
      { line: 3, name: "Väärä Numero", email: "vaara@example.com", address: "Tuontikatu 1", apartmentNumber: "C 4", phone: "123" }
    ] });
    assert.equal(imported.data.added, 1);
    assert.equal(imported.data.skipped[0].line, 3);
    const saved = ((await call(server, admin, "GET", "/companies/demo-company/residents")).data as any[]).find(item => item.name === "Tuotu Puhelin");
    assert.deepEqual([saved.phone, saved.moved_in_at], ["+358402223333", "2025-06-01"]);
    const changed = await call(server, admin, "PUT", `/residents/${saved.id}`, {
      name: saved.name, email: saved.email, apartmentId: saved.apartment_id, phone: "+358 50 111 2222", movedInAt: ""
    });
    assert.equal(changed.status, 200);
    assert.equal((await call(server, admin, "PUT", `/residents/${saved.id}`, { name: saved.name, email: saved.email, apartmentId: saved.apartment_id, phone: "abc" })).status, 400);
    const after = ((await call(server, admin, "GET", "/companies/demo-company/residents")).data as any[]).find(item => item.id === saved.id);
    assert.deepEqual([after.phone, after.moved_in_at], ["+358501112222", null]);
  });

  it("asukkaan tietojen poisto tyhjentää asukkaan sanomat vastaanottolokista", async () => {
    const event = envelope("resident.upserted", resident("R5", "HC1", "HC1-A1"));
    const residentId = (await send([event])).data.results[0].pleissiId;
    const pendingEvent = envelope("resident.moved_out", { externalRefs: { erp: "R5" }, movedOutAt: "2027-01-01" });
    await send([pendingEvent]);
    const manager = await login(server, MANAGER_EMAIL);
    assert.equal((await call(server, manager, "DELETE", `/residents/${residentId}`, {})).status, 200);
    const rows = query<{ payload: string | null }>(server, "SELECT payload FROM integration_inbox WHERE event_id IN (?, ?)", event.eventId, pendingEvent.eventId);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.payload === null));
    assert.equal(query<{ phone: string | null }>(server, "SELECT phone FROM residents WHERE id = ?", residentId)[0].phone, null);
  });

  it("jonon haku: pois päältä 409; asetuksesta päälle; kursorihaku sivuttain ja kursori tallentuu avaimelle", async () => {
    assert.equal((await call(server, key, "GET", "/v1/events")).status, 409);
    const manager = await login(server, MANAGER_EMAIL);
    assert.equal((await call(server, manager, "PUT", "/integration/api/pull", { enabled: true })).status, 403);
    const enabled = await call(server, admin, "PUT", "/integration/api/pull", { enabled: true });
    assert.equal(enabled.data.pull, true);

    const service = await login(server, SERVICE_EMAIL);
    const first = (await call(server, service, "POST", "/tickets", { companyId: "demo-company", subject: "Hana vuotaa", summary: "Keittiön hana vuotaa." })).data.ticketId;
    const second = (await call(server, service, "POST", "/tickets", { companyId: "demo-company", subject: "Ovi jumittaa", summary: "Ulko-ovi jumittaa." })).data.ticketId;
    await call(server, service, "POST", `/tickets/${first}/notes`, { body: "Sisäinen muistiinpano" });
    await call(server, service, "PUT", `/tickets/${second}/fields`, { priority: "urgent" });
    await call(server, service, "PUT", `/tickets/${second}/fields`, { priority: "low" });

    // Julkaisu odottaa viiveen tehtävän viimeisimmästä muutoksesta; sen aikana päivitykset yhdistetään.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.equal((await call(server, key, "GET", "/v1/events?after=abc")).status, 400);
    assert.equal((await call(server, key, "GET", "/v1/events?limit=101")).status, 400);
    const page1 = await call(server, key, "GET", "/v1/events?limit=1");
    assert.equal(page1.status, 200);
    assert.equal(page1.data.events.length, 1);
    assert.equal(page1.data.hasMore, true);
    assert.equal(page1.data.events[0].cursor, page1.data.nextCursor);
    assert.match(page1.data.nextCursor, /^c_\d{6}$/);
    const rest = await call(server, key, "GET", `/v1/events?after=${page1.data.nextCursor}&limit=100`);
    assert.equal(rest.data.hasMore, false);
    const events = [...page1.data.events, ...rest.data.events];
    const cursors = events.map((event: any) => Number(event.cursor.slice(2)));
    assert.deepEqual(cursors, [...cursors].sort((a, b) => a - b), "kursorit ovat järjestyksessä");
    assert.ok(events.every((event: any) => event.source === "pleissi" && event.tenantId));

    // Nopeista päivityksistä julkaistaan vain uusin, ja muistiinpano ei ole jonossa.
    const updates = events.filter((event: any) => event.data.id === second && event.eventType === "task.updated");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.priority, "low");
    assert.ok(!events.some((event: any) => event.eventType === "task.comment.added" && event.data.text === "Sisäinen muistiinpano"));
    assert.equal(query(server, "SELECT 1 FROM integration_outbox WHERE status = 'superseded' AND task_id = ?", second).length, 1);
    assert.equal(query(server, "SELECT 1 FROM integration_outbox WHERE status = 'pending' AND cursor IS NOT NULL").length, 0, "haetut ovat sent");

    const empty = await call(server, key, "GET", `/v1/events?after=${rest.data.nextCursor}`);
    assert.deepEqual([empty.data.events.length, empty.data.nextCursor, empty.data.hasMore], [0, rest.data.nextCursor, false]);
    const listed = (await call(server, admin, "GET", "/integration/api")).data.keys.find((item: any) => item.name === "ERP");
    assert.equal(listed.last_cursor, rest.data.nextCursor);
    assert.ok(listed.last_fetched_at);

    // Arkaluonteisesta vain tunnisteet, otsikko, tila ja merkintä.
    assert.equal((await call(server, admin, "PUT", `/tickets/${first}/sensitive`, { sensitive: true })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const sensitive = (await call(server, key, "GET", `/v1/events?after=${rest.data.nextCursor}`)).data.events.filter((event: any) => event.data.id === first);
    assert.equal(sensitive.length, 1);
    assert.deepEqual(Object.keys(sensitive[0].data).sort(), ["externalRefs", "id", "sensitive", "status", "ticketNumber", "title"]);
    assert.equal(sensitive[0].data.title, "Hana vuotaa");
    assert.equal(sensitive[0].data.sensitive, true);
    assert.equal(typeof sensitive[0].data.ticketNumber, "number");
  });
});
