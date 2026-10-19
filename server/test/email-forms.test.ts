import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, startServer, type TestServer , inbound as postInbound } from "./helpers.js";

// Verkkosivun lomakkeet tulevat toimiston postiin; otsikosta tunnistetaan lomake ja viestistä kentät.
describe("verkkosivun lomakkeet sähköpostina", () => {
  let server: TestServer;
  let admin: string;
  let otherCompanyId: string;
  let sequence = 0;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34"
    });
    otherCompanyId = (await call(server, admin, "POST", "/companies", { name: "As Oy Rantala" })).data.companyId;
    assert.equal((await call(server, admin, "POST", `/companies/${otherCompanyId}/residents`, {
      name: "Pekka Rantanen", email: "pekka@example.com", address: "Rantatie 5", apartmentNumber: "C 7"
    })).status, 201);
  });

  after(() => server.stop());

  async function receive(subject: string, body: string) {
    sequence += 1;
    const created = await postInbound(server, admin, {
      companyId: "demo-company", channel: "email", senderName: "Hemman verkkosivu", senderEmail: "wordpress@hemman.example",
      subject, body, sourceMessageId: `<lomake-${sequence}@example.com>`
    });
    assert.equal(created.status, 201);
    return (await call(server, admin, "GET", `/tickets/${created.data.ticketId}`)).data;
  }

  const value = (detail: any, label: string) => detail.form.fields.find((field: any) => field.label === label)?.value;

  it("huoltotyötilaus luetaan kentiksi ja liitetään asukkaaseen", async () => {
    const detail = await receive("Uusi lähetys lomakkeelta \"Huoltotyötilaus\"", [
      "Etu- ja Sukunimi: Liisa Mallikas",
      "Puhelinnumero: 040 123 4567",
      "Sähköposti: liisa@example.com",
      "Osoite: Koivikkotie 10",
      "Huoneistonumero: B 34",
      "Paikkakunta: Tampere",
      "Huoltotyö: Keittiön hana vuotaa.",
      "Tiskipöydän alla on vettä.",
      "Huoneistoon pääsemiseksi saa käyttää yleisavainta: Kyllä",
      "Asunnossa on lemmikkieläimiä: Ei",
      "---",
      "Date: 17.10.2026",
      "Page URL: https://www.example.com/asiointi/",
      "Powered by: Elementor"
    ].join("\n"));
    assert.equal(detail.ticket.type, "Huoltotyötilaus");
    assert.equal(detail.ticket.subject, "Huoltotyötilaus: Koivikkotie 10, B 34");
    assert.equal(detail.ticket.resident_id, "resident-2");
    assert.equal(detail.ticket.status, "open");
    assert.equal(detail.form.source, "email");
    assert.equal(value(detail, "Huoltotyö"), "Keittiön hana vuotaa.\nTiskipöydän alla on vettä.");
    assert.equal(value(detail, "Huoneistoon pääsemiseksi saa käyttää yleisavainta"), "Kyllä");
    assert.ok(!detail.form.fields.some((field: any) => /Date|Page URL|Powered/.test(field.label)));
  });

  it("osoite ohjaa lomakkeen oikeaan taloyhtiöön ja taulukkomuoto luetaan", async () => {
    const detail = await receive("Irtisanomisilmoitus", [
      "Vuokralaisen nimi *\tPekka Rantanen",
      "Irtisanottavan asunnon katuosoite *\tRantatie 5 C 7",
      "Postitoimipaikka *\tTurku",
      "Pankkitilinumero *\tFI21 1234 5600 0007 85",
      "Onko uusi osoite tiedossa? *\tuusi_kylla",
      "Uusi katuosoite *\tUusikatu 1",
      "Vahvistus *\tvahvistus"
    ].join("\n"));
    assert.equal(detail.ticket.company_id, otherCompanyId);
    assert.equal(detail.ticket.type, "Irtisanomisilmoitus");
    assert.equal(detail.ticket.apartment_number, "C 7");
    assert.equal(value(detail, "Onko uusi osoite tiedossa?"), "Kyllä");
    assert.equal(value(detail, "Vahvistus"), "Vahvistettu");

  });

  it("häiriöilmoitus on tehtävä, ja tavallinen viesti jää tavalliseksi", async () => {
    const disturbance = await receive("Häiriöilmoitus", "Osoite: Koivikkotie 10\nIlmoittajan nimi: Liisa Mallikas\nPvm.: 2026-10-15\nAjankohta: klo 23-01\nHäiriön laatu: kovaääninen juhliminen\nAsunnon numero: as A12");
    assert.equal(disturbance.ticket.type, "Häiriöilmoitus");
    assert.equal(value(disturbance, "Häiriön laatu"), "kovaääninen juhliminen");
    assert.equal(value(disturbance, "Pvm."), "15.10.2026");

    const plain = await receive("Muuttoilmoitus", "Hei, muutan pois joulukuun alussa. Mitä minun pitää tehdä?");
    assert.equal(plain.form, null);
    assert.notEqual(plain.ticket.type, "Muuttoilmoitus");
  });

  // Mittarilukema, muuttoilmoitus ja lämmityspaikka eivät ole tehtäviä vaan taloyhtiön tietueita.
  async function receiveRecord(subject: string, body: string) {
    sequence += 1;
    const messageId = `<tietue-${sequence}@example.com>`;
    const created = await postInbound(server, admin, {
      companyId: "demo-company", channel: "email", senderName: "Hemman verkkosivu", senderEmail: "wordpress@hemman.example",
      subject, body, sourceMessageId: messageId
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.ticketId, undefined);
    return { ...created.data, messageId };
  }

  const detail = (row: any, key: string) => row.details.find((field: any) => field.key === key)?.value;

  it("mittarilukemailmoitus menee Lukemat-tauluun ja on muokattavissa", async () => {
    const created = await receiveRecord("Mittarilukemailmoitus",
      "Etu- ja Sukunimi: Liisa Mallikas\nPuhelinnumero: 040 123 4567\nOsoite: Koivikkotie 10\nHuoneistonumero: A 12\nKylmä vesi: 123,4\nLämmin vesi: 56,7");
    assert.equal(created.record, "meter-readings");
    assert.equal(created.recordIds.length, 2);
    const readings = (await call(server, admin, "GET", "/companies/demo-company/meter-readings")).data as any[];
    const cold = readings.find(row => row.id === created.recordIds[0]);
    assert.equal(cold.meter_type, "cold_water");
    assert.equal(cold.value, 123.4);
    assert.equal(cold.source, "email");
    // Lomakkeen asunto ratkaisee, vaikka ilmoittaja asuu toisessa asunnossa.
    assert.equal(cold.apartment_number, "A 12");
    assert.equal(cold.resident_id, "resident-2");
    assert.equal(detail(cold, "phone"), "040 123 4567");

    // Sama viesti ei tule kahdesti.
    const again = await postInbound(server, admin, {
      companyId: "demo-company", channel: "email", senderName: "x", subject: "Mittarilukemailmoitus", body: "Kylmä vesi: 1", sourceMessageId: created.messageId
    });
    assert.equal(again.data.duplicate, true);

    const edited = await call(server, admin, "PUT", `/meter-readings/${cold.id}`, {
      apartmentId: "apt-34", meterType: "cold_water", value: 124, readingDate: cold.reading_date, note: "Korjattu",
      details: { name: "Liisa Mallikas", phone: "040 765 4321", address: "Koivikkotie 10", apartment: "B 34" }
    });
    assert.equal(edited.status, 200);
    const after = ((await call(server, admin, "GET", "/companies/demo-company/meter-readings")).data as any[]).find(row => row.id === cold.id);
    assert.equal(after.value, 124);
    assert.equal(after.apartment_number, "B 34");
    assert.equal(detail(after, "phone"), "040 765 4321");
    // Lukeman muokkaus ei hyväksy tulevaisuuden päivää.
    assert.equal((await call(server, admin, "PUT", `/meter-readings/${cold.id}`, {
      apartmentId: "apt-34", meterType: "cold_water", value: 124, readingDate: "2999-01-01"
    })).status, 400);
  });

  it("muuttoilmoitus menee Muutot-tauluun lomakkeen kentillä", async () => {
    const created = await receiveRecord("Muuttoilmoitus", [
      "Muutto: Sisäänmuuttoilmoitus",
      "Etu- ja Sukunimi: Ville Vieras",
      "Puhelinnumero: 040 111 2222",
      "Sähköposti: ville@example.com",
      "Syntymäaika: 1.2.1990",
      "Nykyisen asunnon katuosoite: Vanhatie 3",
      "Nykyisen asunnon numero: 5",
      "Nykyinen postinumero: 33100",
      "Nykyinen kaupunki: Tampere",
      "Etu- ja Sukunimi: Vilma Vieras",
      "Syntymäaika: 3.4.1992",
      "Muuttopäivä: 2026-11-01",
      "Uuden asunnon katuosoite: Koivikkotie 10",
      "Asunnon numero: B 34",
      "Paikkakunta: Tampere",
      "Olen: Vuokralainen",
      "Maksun suoritus: 2",
      "Maksu suoritetaan: Taloyhtiölle erillisellä laskulla"
    ].join("\n"));
    assert.equal(created.record, "moves");
    const moves = (await call(server, admin, "GET", "/companies/demo-company/moves")).data as any[];
    const move = moves.find(row => row.id === created.recordIds[0]);
    assert.equal(move.move_date, "2026-11-01");
    assert.equal(move.apartment_number, "B 34");
    assert.equal(move.moves_out, 0);
    assert.equal(move.source, "email");
    assert.deepEqual(JSON.parse(move.new_residents).map((person: any) => person.name), ["Ville Vieras", "Vilma Vieras"]);
    assert.equal(detail(move, "with1Name"), "Vilma Vieras");
    assert.equal(detail(move, "with1Birth"), "3.4.1992");
    assert.equal(detail(move, "waterPayment"), "Taloyhtiölle erillisellä laskulla");

    // Tunnistamaton osoite: ilmoitus tulee ilman asuntoa, ja asunto pitää valita ennen hyväksyntää.
    const unknown = await receiveRecord("Muuttoilmoitus", "Muutto: Poismuuttoilmoitus\nEtu- ja Sukunimi: Outi Outo\nNykyisen asunnon katuosoite: Tuntematon tie 9\nMuuttopäivä: 2026-12-01");
    assert.equal((await call(server, admin, "POST", `/moves/${unknown.recordIds[0]}/approve`)).status, 400);
    const edited = await call(server, admin, "PUT", `/moves/${unknown.recordIds[0]}`, {
      moveDate: "2026-12-01", movesOut: true, apartmentId: "apt-12", newResidents: [], doorName: "", note: "",
      details: { kind: "Poismuuttoilmoitus", name: "Outi Outo", currentAddress: "Koivikkotie 10", currentApartment: "A 12" }
    });
    assert.equal(edited.status, 200);
    const fixed = ((await call(server, admin, "GET", "/companies/demo-company/moves")).data as any[]).find(row => row.id === unknown.recordIds[0]);
    assert.equal(fixed.apartment_number, "A 12");
    assert.equal(detail(fixed, "currentAddress"), "Koivikkotie 10");
  });

  it("auton lämmityspaikka menee Autopaikat-sivun tilauksiin", async () => {
    const created = await receiveRecord("Lomake: Auton lämmityspaikka", [
      "Osoite: Koivikkotie 10", "Tilaan: Lämmitystolppapaikan", "Tilaustyyppi: Määräaikainen",
      "Tarve lämmityspaikalle alkaen: 2026-11-01", "Mikäli määräaikainen, loppumispäivä: 2027-03-31",
      "Etu- ja Sukunimi: Ville Vieras", "Puhelinnumero: 040 111 2222", "Osoite: Vanhatie 3", "Kaupunki: Tampere", "Postinumero: 33100"
    ].join("\n"));
    assert.equal(created.record, "heating-orders");
    const orders = (await call(server, admin, "GET", "/companies/demo-company/heating-orders")).data as any[];
    const order = orders.find(row => row.id === created.recordIds[0]);
    assert.equal(order.start_date, "2026-11-01");
    assert.equal(order.end_date, "2027-03-31");
    assert.equal(order.status, "pending");
    assert.equal(detail(order, "address"), "Koivikkotie 10");
    assert.equal(detail(order, "ordererAddress"), "Vanhatie 3");

    const edited = await call(server, admin, "PUT", `/heating-orders/${order.id}`, {
      apartmentId: "apt-12", startDate: "2026-11-01", endDate: null, status: "approved", note: "Paikka 4",
      details: { address: "Koivikkotie 10", spot: "Lämmitystolppapaikan", orderType: "Toistaiseksi voimassa oleva", name: "Ville Vieras" }
    });
    assert.equal(edited.status, 200);
    const approved = ((await call(server, admin, "GET", "/companies/demo-company/heating-orders")).data as any[]).find(row => row.id === order.id);
    assert.equal(approved.status, "approved");
    assert.equal(approved.end_date, null);
    assert.equal(detail(approved, "orderType"), "Toistaiseksi voimassa oleva");
    assert.equal(detail(approved, "phone"), "");
  });

  it("lukema ilman lukemia käsitellään tehtävänä", async () => {
    const fallback = await receive("Mittarilukemailmoitus", "Etu- ja Sukunimi: Liisa Mallikas\nOsoite: Koivikkotie 10\nHuoneistonumero: B 34\nKylmä vesi: en löydä mittaria");
    assert.notEqual(fallback.ticket.type, "Mittarilukemailmoitus");
    assert.ok(fallback.form);
  });
});
