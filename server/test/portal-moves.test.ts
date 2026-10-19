import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, PASSWORD, startServer, type TestServer } from "./helpers.js";

describe("asukasportaalin muuttoilmoitus verkkosivun lomakkeen kentillä", () => {
  let server: TestServer;
  let manager: string;
  let resident: string;

  before(async () => {
    server = await startServer();
    const admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34", password: PASSWORD
    });
    resident = await login(server, "liisa@example.com");
  });

  after(() => server.stop());

  it("lomakkeen kentät näkyvät muuttoilmoituksen tietueella, ja mukana muuttavat lisätään uusiksi asukkaiksi", async () => {
    assert.equal((await call(server, resident, "POST", "/portal/moves", { moveDate: "2026-12-01", details: { name: "Liisa Mallikas" } })).status, 400);

    const created = await call(server, resident, "POST", "/portal/moves", {
      moveDate: "2026-12-01",
      note: "Muuttoauto pihassa aamupäivällä.",
      details: {
        kind: "Uusi asukas (lisätään huoneiston asukkaisiin)", name: "Liisa Mallikas", phone: "040 123 4567", email: "liisa@example.com",
        birthDate: "1.2.1990", currentAddress: "Koivikkotie 10", currentApartment: "B 34", with1Name: "Pekka Mallikas",
        with1Birth: "3.4.1988", role: "Vuokralainen", waterPersons: "2", waterPayment: "Omistajalle vuokran yhteydessä"
      }
    });
    assert.equal(created.status, 201);

    const [notice] = (await call(server, manager, "GET", "/companies/demo-company/moves")).data as any[];
    assert.equal(notice.source, "portal");
    assert.equal(notice.moves_out, 0);
    assert.equal(notice.note, "Muuttoauto pihassa aamupäivällä.");
    // Ilmoittaja itse ei ole uusi asukas; mukana muuttava on.
    assert.deepEqual(JSON.parse(notice.new_residents).map((person: any) => person.name), ["Pekka Mallikas"]);
    const fields = Object.fromEntries((notice.details as any[]).map(field => [field.label, field.value]));
    assert.equal(fields["Muutto"], "Uusi asukas (lisätään huoneiston asukkaisiin)");
    assert.equal(fields["Puhelinnumero"], "040 123 4567");
    assert.equal(fields["Mukana muuttava 1: syntymäaika"], "3.4.1988");
    assert.equal(fields["Maksu suoritetaan"], "Omistajalle vuokran yhteydessä");

    // Toista ei voi tehdä ennen käsittelyä.
    assert.equal((await call(server, resident, "POST", "/portal/moves", {
      moveDate: "2026-12-02", details: { kind: "Poismuuttoilmoitus", name: "Liisa Mallikas" }
    })).status, 409);
  });
});
