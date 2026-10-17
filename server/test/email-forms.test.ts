import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, startServer, type TestServer } from "./helpers.js";

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
    const created = await call(server, admin, "POST", "/inbound/messages", {
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

    // Lomakkeet-taulussa tilinumero ja nimi eivät näy tiivistelmässä.
    const listed = (await call(server, admin, "GET", `/companies/${otherCompanyId}/forms`)).data as any[];
    const row = listed.find(item => item.ticketId === detail.ticket.id);
    assert.equal(row.title, "Irtisanomisilmoitus");
    assert.equal(row.reporter, "Pekka Rantanen");
    assert.ok(row.summary.length > 0);
    assert.ok(!row.summary.some((field: any) => /Pankkitili|nimi/i.test(field.label)));
  });

  it("muut lomakkeet tunnistetaan otsikosta, ja tavallinen viesti jää tavalliseksi", async () => {
    const meter = await receive("Mittarilukemailmoitus", "Etu- ja Sukunimi: Liisa Mallikas\nOsoite: Koivikkotie 10\nHuoneistonumero: A 12\nKylmä vesi: 123,4\nLämmin vesi: 56,7");
    assert.equal(meter.ticket.type, "Mittarilukemailmoitus");
    // Lomakkeen asunto ratkaisee, vaikka ilmoittaja asuu toisessa asunnossa.
    assert.equal(meter.ticket.apartment_number, "A 12");
    assert.equal(meter.ticket.resident_id, "resident-2");
    assert.equal(value(meter, "Kylmä vesi"), "123,4");

    const heating = await receive("Lomake: Auton lämmityspaikka", "Osoite: Koivikkotie 10\nTilaan: Lämmitystolppapaikan\nTilaustyyppi: Määräaikainen\nEtu- ja Sukunimi: Ville Vieras");
    assert.equal(heating.ticket.type, "Auton lämmityspaikka");
    assert.equal(heating.ticket.resident_id, null);

    const disturbance = await receive("Häiriöilmoitus", "Osoite: Koivikkotie 10\nIlmoittajan nimi: Liisa Mallikas\nPvm.: 2026-10-15\nAjankohta: klo 23-01\nHäiriön laatu: kovaääninen juhliminen\nAsunnon numero: as A12");
    assert.equal(disturbance.ticket.type, "Häiriöilmoitus");
    assert.equal(value(disturbance, "Häiriön laatu"), "kovaääninen juhliminen");
    assert.equal(value(disturbance, "Pvm."), "15.10.2026");

    const plain = await receive("Muuttoilmoitus", "Hei, muutan pois joulukuun alussa. Mitä minun pitää tehdä?");
    assert.equal(plain.form, null);
    assert.notEqual(plain.ticket.type, "Muuttoilmoitus");

    const forms = (await call(server, admin, "GET", "/companies/demo-company/forms")).data as any[];
    assert.deepEqual([...new Set(forms.map(item => item.form))].sort(), ["disturbance", "heating", "meter", "service"]);
  });
});
