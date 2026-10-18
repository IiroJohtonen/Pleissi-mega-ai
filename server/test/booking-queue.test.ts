import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, PASSWORD, startServer, type TestServer } from "./helpers.js";

describe("vuorojen jono", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;
  let matti: string;
  let liisa: string;
  let pekka: string;
  let otherCompanyId: string;
  let olli: string;

  // Uusi kirjautumistunnuksellinen asukas annettuun taloyhtiöön.
  async function resident(companyId: string, name: string, email: string, apartmentNumber: string) {
    const created = await call(server, admin, "POST", `/companies/${companyId}/residents`, {
      name, email, address: "Koivikkotie 10", apartmentNumber, password: PASSWORD
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return login(server, email);
  }

  async function settings(companyId: string, queue: { sauna?: object; laundry?: object }) {
    const base = { single: true, weekly: true, weeklyWeeks: 12, singlePrice: 0, monthlyPrice: 0 };
    const saved = await call(server, admin, "PUT", `/companies/${companyId}/booking-settings`, {
      sauna: { ...base, ...queue.sauna }, laundry: { ...base, ...queue.laundry }
    });
    assert.equal(saved.status, 200);
  }

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-1", {
      name: "Matti Meikäläinen", email: "matti@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12", password: PASSWORD
    });
    await call(server, admin, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34", password: PASSWORD
    });
    matti = await login(server, "matti@example.com");
    liisa = await login(server, "liisa@example.com");
    pekka = await resident("demo-company", "Pekka Puupää", "pekka@example.com", "C 5");
    otherCompanyId = (await call(server, admin, "POST", "/companies", { name: "As Oy Toinen" })).data.companyId;
    olli = await resident(otherCompanyId, "Olli Toinen", "olli@example.com", "D 1");
    await settings("demo-company", { sauna: { queueEnabled: true, queueSize: 2 }, laundry: { queueEnabled: true, queueSize: 1 } });
    await settings(otherCompanyId, { sauna: { queueEnabled: true, queueSize: 2 } });
  });

  after(() => server.stop());

  // Tunnin vuoro, joka alkaa annetun ajan päästä.
  function slot(resource: "sauna" | "laundry", fromNowMs: number) {
    const start = new Date(Math.ceil((Date.now() + fromNowMs) / 60_000) * 60_000);
    return { resource, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString() };
  }
  const DAY = 86_400_000;
  const HOUR = 3_600_000;

  async function bookingsAt(token: string, path: string, time: ReturnType<typeof slot>) {
    const query = `resource=${time.resource}&from=${encodeURIComponent(time.startsAt)}&to=${encodeURIComponent(time.endsAt)}`;
    return (await call(server, token, "GET", `${path}?${query}`)).data as any[];
  }
  const join = (token: string, time: ReturnType<typeof slot>) => call(server, token, "POST", "/portal/booking-queue", time);
  const myQueue = async (token: string) => (await call(server, token, "GET", "/portal/booking-queue")).data as any[];

  it("vanha varaustoiveiden rajapinta on poistettu", async () => {
    assert.equal((await call(server, liisa, "POST", "/portal/booking-requests", slot("sauna", 2 * DAY))).status, 404);
    assert.equal((await call(server, manager, "GET", "/companies/demo-company/booking-requests")).status, 404);
  });

  it("jonoon liitytään vain varatun vuoron päältä, ja jonosija näkyy asukkaalle", async () => {
    const time = slot("sauna", 2 * DAY);
    assert.equal((await join(liisa, time)).status, 409);
    assert.equal((await call(server, matti, "POST", "/portal/bookings", time)).status, 201);
    assert.equal((await join(matti, time)).status, 409);

    const first = await join(liisa, time);
    assert.equal(first.status, 201);
    assert.equal(first.data.position, 1);
    assert.equal((await join(liisa, time)).status, 409);
    assert.equal((await join(pekka, time)).data.position, 2);

    const [entry] = (await myQueue(pekka)).filter(row => row.starts_at === time.startsAt);
    assert.equal(entry.position, 2);
    assert.equal(entry.status, "waiting");
    // Kalenterissa näkyy jonon pituus ja oma sija, mutta ei muiden jonottajien tietoja.
    const [booking] = await bookingsAt(pekka, "/portal/bookings", time);
    assert.equal(booking.queue_count, 2);
    assert.equal(booking.queue_position, 2);
    assert.equal(booking.resident_name, undefined);
  });

  it("jonopaikkojen enimmäismäärä on tilakohtainen", async () => {
    const sauna = slot("sauna", 3 * DAY);
    assert.equal((await call(server, matti, "POST", "/portal/bookings", sauna)).status, 201);
    assert.equal((await join(liisa, sauna)).status, 201);
    assert.equal((await join(pekka, sauna)).status, 201);
    // Kolmas jonottaja ei mahdu (saunan jonossa on kaksi paikkaa).
    const third = await resident("demo-company", "Kaisa Kolmas", "kaisa@example.com", "C 6");
    const full = await join(third, sauna);
    assert.equal(full.status, 409);
    assert.match(full.data.error, /täynnä/);

    const laundry = slot("laundry", 3 * DAY);
    assert.equal((await call(server, matti, "POST", "/portal/bookings", laundry)).status, 201);
    assert.equal((await join(liisa, laundry)).status, 201);
    const laundryFull = await join(pekka, laundry);
    assert.equal(laundryFull.status, 409);
    assert.match(laundryFull.data.error, /täynnä/);
  });

  it("jonoon ei voi liittyä alle kolme tuntia ennen vuoron alkua", async () => {
    const soon = slot("sauna", 2 * HOUR);
    assert.equal((await call(server, matti, "POST", "/portal/bookings", soon)).status, 201);
    const late = await join(liisa, soon);
    assert.equal(late.status, 409);
    assert.match(late.data.error, /kolme tuntia/);
    const ok = slot("sauna", 3 * HOUR + 10 * 60_000);
    assert.equal((await call(server, matti, "POST", "/portal/bookings", ok)).status, 201);
    assert.equal((await join(liisa, ok)).status, 201);
  });

  it("peruutus siirtää vuoron jonon ensimmäiselle myös alle kolme tuntia ennen alkua, ja muiden sijat päivittyvät", async () => {
    // Vuoron alkuun on alle kolme tuntia. Jonopaikat on otettu aiemmin, joten ne lisätään suoraan tietokantaan.
    const time = slot("sauna", 45 * 60_000);
    const booked = await call(server, matti, "POST", "/portal/bookings", time);
    assert.equal(booked.status, 201);
    const db = new Database(path.join(server.dataDir, "kotilo.sqlite"));
    const insert = db.prepare(`
      INSERT INTO booking_queue (id, company_id, resource, starts_at, ends_at, resident_id, status, created_at)
      VALUES (?, 'demo-company', 'sauna', ?, ?, ?, 'waiting', ?)
    `);
    insert.run("queue-test-1", time.startsAt, time.endsAt, "resident-2", new Date(Date.now() - 2 * DAY).toISOString());
    const pekkaId = (db.prepare("SELECT id FROM residents WHERE email = 'pekka@example.com'").get() as { id: string }).id;
    insert.run("queue-test-2", time.startsAt, time.endsAt, pekkaId, new Date(Date.now() - DAY).toISOString());
    db.close();

    const [own] = await bookingsAt(matti, "/portal/bookings", time);
    assert.equal((await call(server, matti, "DELETE", `/portal/bookings/${own.id}`)).status, 200);

    const [after] = await bookingsAt(manager, "/companies/demo-company/bookings", time);
    assert.equal(after.resident_name, "Liisa Mallikas");
    assert.equal(after.queue_count, 1);
    assert.equal((await bookingsAt(liisa, "/portal/bookings", time))[0].mine, true);
    const granted = (await myQueue(liisa)).find(row => row.starts_at === time.startsAt);
    assert.equal(granted.status, "granted");
    assert.equal((await myQueue(pekka)).find(row => row.starts_at === time.startsAt).position, 1);
    // Ilmoitus lähtee sähköpostilla (testipalvelimella posti ei ole käytössä, joten yritys näkyy lokissa).
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.match(server.output(), /Sait saunavuoron/);

    // Toimiston poistama varaus siirtyy samoin seuraavalle; tyhjän jonon jälkeen vuoro vapautuu.
    const [liisaBooking] = await bookingsAt(manager, "/companies/demo-company/bookings", time);
    assert.equal((await call(server, manager, "DELETE", `/bookings/${liisaBooking.id}`)).status, 200);
    assert.equal((await bookingsAt(manager, "/companies/demo-company/bookings", time))[0].resident_name, "Pekka Puupää");
    const [pekkaBooking] = await bookingsAt(pekka, "/portal/bookings", time);
    assert.equal((await call(server, pekka, "DELETE", `/portal/bookings/${pekkaBooking.id}`)).status, 200);
    assert.equal((await bookingsAt(manager, "/companies/demo-company/bookings", time)).length, 0);
  });

  it("asukas poistuu jonosta itse, ja toimisto näkee jonot sijoineen", async () => {
    const time = slot("laundry", 5 * DAY);
    assert.equal((await call(server, matti, "POST", "/portal/bookings", time)).status, 201);
    const entry = await join(liisa, time);
    const staff = (await call(server, manager, "GET", "/companies/demo-company/booking-queue?resource=laundry")).data as any[];
    const row = staff.find(item => item.id === entry.data.entryId);
    assert.equal(row.resident_name, "Liisa Mallikas");
    assert.equal(row.position, 1);
    assert.match(row.current_holder, /Matti/);

    assert.equal((await call(server, pekka, "DELETE", `/portal/booking-queue/${entry.data.entryId}`)).status, 404);
    assert.equal((await call(server, liisa, "DELETE", `/portal/booking-queue/${entry.data.entryId}`)).status, 200);
    assert.ok(!(await myQueue(liisa)).some(item => item.id === entry.data.entryId));
  });

  it("jono ei ole käytössä, kun asetus on pois päältä", async () => {
    await settings("demo-company", { sauna: { queueEnabled: false }, laundry: { queueEnabled: true, queueSize: 1 } });
    const time = slot("sauna", 6 * DAY);
    assert.equal((await call(server, matti, "POST", "/portal/bookings", time)).status, 201);
    const blocked = await join(liisa, time);
    assert.equal(blocked.status, 403);
    const rules = (await call(server, liisa, "GET", "/portal/booking-settings")).data;
    assert.equal(rules.sauna.queueEnabled, false);
    assert.equal(rules.laundry.queueSize, 1);
    await settings("demo-company", { sauna: { queueEnabled: true, queueSize: 2 }, laundry: { queueEnabled: true, queueSize: 1 } });
  });

  it("eri taloyhtiöiden jonot eivät sekoitu", async () => {
    const time = slot("sauna", 7 * DAY);
    // Samaan aikaan on varaus molemmissa taloyhtiöissä.
    assert.equal((await call(server, matti, "POST", "/portal/bookings", time)).status, 201);
    assert.equal((await call(server, manager, "POST", `/companies/${otherCompanyId}/bookings`, { ...time, note: "Huolto" })).status, 201);
    assert.equal((await join(olli, time)).status, 201);
    assert.equal((await join(liisa, time)).data.position, 1);

    const [demo] = await bookingsAt(manager, "/companies/demo-company/bookings", time);
    const [other] = await bookingsAt(manager, `/companies/${otherCompanyId}/bookings`, time);
    assert.equal(demo.queue_count, 1);
    assert.equal(other.queue_count, 1);

    // Toisen taloyhtiön peruutus ei anna vuoroa tämän taloyhtiön jonottajalle.
    assert.equal((await call(server, manager, "DELETE", `/bookings/${other.id}`)).status, 200);
    assert.equal((await bookingsAt(manager, `/companies/${otherCompanyId}/bookings`, time))[0].resident_name, "Olli Toinen");
    assert.equal((await bookingsAt(manager, "/companies/demo-company/bookings", time))[0].resident_name, "Matti Meikäläinen");
    const staff = (await call(server, manager, "GET", "/companies/demo-company/booking-queue")).data as any[];
    assert.ok(staff.every(row => row.company_id === "demo-company"));
  });

  it("toimisto lisää asukkaan varatun vuoron jonoon myös, kun asukkaiden jono ei ole käytössä", async () => {
    await settings("demo-company", { sauna: { queueEnabled: false, queueSize: 2 }, laundry: { queueEnabled: true, queueSize: 1 } });
    const time = slot("sauna", 8 * DAY);
    const add = (residentId: string) => call(server, manager, "POST", "/companies/demo-company/booking-queue", { ...time, residentId });
    // Vapaaseen vuoroon ei lisätä jonoa.
    assert.equal((await add("resident-2")).status, 409);
    assert.equal((await call(server, matti, "POST", "/portal/bookings", time)).status, 201);
    assert.equal((await add("resident-1")).status, 409);
    const added = await add("resident-2");
    assert.equal(added.status, 201);
    assert.equal(added.data.position, 1);
    assert.equal((await add("resident-2")).status, 409);
    const [queued] = (await myQueue(liisa)).filter(row => row.starts_at === time.startsAt);
    assert.equal(queued.position, 1);
    // Toisen taloyhtiön asukasta ei voi lisätä.
    const other = (await call(server, admin, "GET", `/companies/${otherCompanyId}/residents`)).data[0];
    assert.equal((await add(other.id)).status, 404);
    await settings("demo-company", { sauna: { queueEnabled: true, queueSize: 2 }, laundry: { queueEnabled: true, queueSize: 1 } });
  });

  it("varattava aikaikkuna on taloyhtiökohtainen", async () => {
    const defaults = (await call(server, manager, "GET", "/companies/demo-company/booking-settings")).data;
    assert.deepEqual([defaults.sauna.firstHour, defaults.sauna.lastHour], [15, 22]);
    await settings("demo-company", { sauna: { queueEnabled: true, queueSize: 2, firstHour: 8, lastHour: 22 } });
    const saved = (await call(server, manager, "GET", "/companies/demo-company/booking-settings")).data;
    assert.deepEqual([saved.sauna.firstHour, saved.sauna.lastHour], [8, 22]);
    assert.deepEqual([saved.laundry.firstHour, saved.laundry.lastHour], [7, 21]);
    // Toisen taloyhtiön aikaikkuna ei muutu.
    const other = (await call(server, manager, "GET", `/companies/${otherCompanyId}/booking-settings`)).data;
    assert.equal(other.sauna.firstHour, 15);
    const base = { single: true, weekly: true, weeklyWeeks: 12, singlePrice: 0, monthlyPrice: 0 };
    const invalid = await call(server, admin, "PUT", "/companies/demo-company/booking-settings", {
      sauna: { ...base, firstHour: 20, lastHour: 10 }, laundry: base
    });
    assert.equal(invalid.status, 400);
  });
});
