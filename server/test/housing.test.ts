import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ADMIN_EMAIL, call, localDate, login, MANAGER_EMAIL, PASSWORD, SERVICE_EMAIL, startServer, type TestServer
} from "./helpers.js";

describe("remontti-ilmoitukset, avaimet ja kulutuslukemat", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;
  let service: string;
  let resident: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
    service = await login(server, SERVICE_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34", password: PASSWORD
    });
    resident = await login(server, "liisa@example.com");
  });

  after(() => server.stop());

  const renovation = {
    workType: "Märkätila", description: "Kylpyhuoneen vesieristys ja laatoitus uusitaan.",
    startDate: "2027-03-01", endDate: "2027-03-20", contractor: "Remontti Oy, 040 123 4567"
  };

  async function renovations() {
    return (await call(server, manager, "GET", "/companies/demo-company/renovations")).data as any[];
  }

  it("asukkaan remontti-ilmoitus hyväksytään ehdoin ja merkitään valmistuneeksi", async () => {
    const created = await call(server, resident, "POST", "/portal/renovations", renovation);
    assert.equal(created.status, 201);
    const id = created.data.renovationId as string;
    const [notice] = await renovations();
    assert.equal(notice.resident_name, "Liisa Mallikas");
    assert.equal(notice.status, "pending");

    assert.equal((await call(server, service, "POST", `/renovations/${id}/approve`, {})).status, 403);
    assert.equal((await call(server, manager, "POST", `/renovations/${id}/complete`)).status, 409);
    assert.equal((await call(server, manager, "POST", `/renovations/${id}/approve`, { note: "Valvoja tarkastaa vesieristyksen." })).status, 200);
    assert.equal((await call(server, manager, "POST", `/renovations/${id}/approve`, {})).status, 409);

    const mine = (await call(server, resident, "GET", "/portal/renovations")).data;
    assert.equal(mine[0].status, "approved");
    assert.equal(mine[0].decision_note, "Valvoja tarkastaa vesieristyksen.");

    assert.equal((await call(server, manager, "POST", `/renovations/${id}/complete`)).status, 200);
    assert.equal((await renovations())[0].status, "completed");
  });

  it("remontti-ilmoituksen hylkäys vaatii perustelun ja päivämäärät tarkistetaan", async () => {
    assert.equal((await call(server, resident, "POST", "/portal/renovations", { ...renovation, endDate: "2027-02-01" })).status, 400);
    assert.equal((await call(server, resident, "POST", "/portal/renovations", { ...renovation, workType: "Jotain muuta" })).status, 400);

    const created = await call(server, resident, "POST", "/portal/renovations", renovation);
    const id = created.data.renovationId as string;
    assert.equal((await call(server, manager, "POST", `/renovations/${id}/reject`, {})).status, 400);
    assert.equal((await call(server, manager, "POST", `/renovations/${id}/reject`, { note: "Suunnitelmat puuttuvat." })).status, 200);
    assert.equal((await call(server, resident, "GET", "/portal/renovations")).data[0].status, "rejected");
  });

  it("avaimen voi luovuttaa vain kerran ja palautus vapauttaa sen", async () => {
    const created = await call(server, service, "POST", "/companies/demo-company/keys", { code: "A-101", type: "Asunto" });
    assert.equal(created.status, 201);
    const id = created.data.keyId as string;
    assert.equal((await call(server, service, "POST", "/companies/demo-company/keys", { code: "a-101", type: "Asunto" })).status, 409);

    assert.equal((await call(server, service, "POST", `/keys/${id}/hand-over`, {})).status, 400);
    assert.equal((await call(server, service, "POST", `/keys/${id}/hand-over`, { residentId: "resident-2", dueDate: "2027-01-31" })).status, 201);
    assert.equal((await call(server, service, "POST", `/keys/${id}/hand-over`, { holderName: "Putki Oy" })).status, 409);

    const [key] = (await call(server, service, "GET", "/companies/demo-company/keys")).data;
    assert.equal(key.holder_name, "Liisa Mallikas");
    assert.equal(key.due_date, "2027-01-31");

    assert.equal((await call(server, service, "POST", `/keys/${id}/return`)).status, 200);
    assert.equal((await call(server, service, "POST", `/keys/${id}/return`)).status, 409);
    assert.equal((await call(server, service, "POST", `/keys/${id}/hand-over`, { holderName: "Putki Oy" })).status, 201);
    assert.equal((await call(server, service, "GET", `/keys/${id}/loans`)).data.length, 2);
  });

  it("kadonnutta avainta ei luovuteta ja avaimen poistaa vain isännöitsijä", async () => {
    const created = await call(server, service, "POST", "/companies/demo-company/keys", { code: "Y-1", type: "Yleisavain" });
    const id = created.data.keyId as string;
    assert.equal((await call(server, service, "PUT", `/keys/${id}`, { code: "Y-1", type: "Yleisavain", lost: true })).status, 200);
    assert.equal((await call(server, service, "POST", `/keys/${id}/hand-over`, { holderName: "Putki Oy" })).status, 409);
    assert.equal((await call(server, service, "DELETE", `/keys/${id}`)).status, 403);
    assert.equal((await call(server, manager, "DELETE", `/keys/${id}`)).status, 200);
    assert.equal((await call(server, manager, "GET", `/keys/${id}/loans`)).status, 404);
  });

  it("asukkaan lukema ei voi pienentyä ja kulutus lasketaan edellisestä lukemasta", async () => {
    const first = await call(server, resident, "POST", "/portal/meter-readings", { meterType: "cold_water", value: 120.5, readingDate: localDate(-30) });
    assert.equal(first.status, 201);
    assert.equal((await call(server, resident, "POST", "/portal/meter-readings", { meterType: "cold_water", value: 119 })).status, 409);
    assert.equal((await call(server, resident, "POST", "/portal/meter-readings", { meterType: "cold_water", value: 130, readingDate: localDate(1) })).status, 400);
    assert.equal((await call(server, resident, "POST", "/portal/meter-readings", { meterType: "cold_water", value: 126.25 })).status, 201);
    // Toinen mittari alkaa omasta lukemastaan.
    assert.equal((await call(server, resident, "POST", "/portal/meter-readings", { meterType: "hot_water", value: 40 })).status, 201);

    const readings = (await call(server, service, "GET", "/companies/demo-company/meter-readings")).data as any[];
    const latest = readings.find(row => row.meter_type === "cold_water" && row.value === 126.25);
    assert.equal(latest.previous_value, 120.5);
    assert.equal(latest.apartment_number, "B 34");
    assert.equal(readings.find(row => row.meter_type === "hot_water").previous_value, null);
    assert.equal((await call(server, resident, "GET", "/portal/meter-readings")).data.length, 3);
  });

  it("toimisto kirjaa ja poistaa lukeman", async () => {
    const apartments = (await call(server, service, "GET", "/companies/demo-company/apartments")).data as any[];
    assert.ok(apartments.length > 0);
    const created = await call(server, service, "POST", "/companies/demo-company/meter-readings", {
      apartmentId: apartments[0].id, meterType: "electricity", value: 5321
    });
    assert.equal(created.status, 201);
    assert.equal((await call(server, service, "POST", "/companies/demo-company/meter-readings", {
      apartmentId: "ei-ole", meterType: "electricity", value: 1
    })).status, 404);
    assert.equal((await call(server, service, "DELETE", `/meter-readings/${created.data.readingId}`)).status, 200);
    assert.equal((await call(server, service, "DELETE", `/meter-readings/${created.data.readingId}`)).status, 404);
  });

  it("asukkaan poisto vie remontti-ilmoitukset ja irrottaa lukemat ja avaimet asukkaasta", async () => {
    const exported = (await call(server, manager, "GET", "/residents/resident-2/export")).data;
    assert.equal(exported.renovation_notices.length, 2);
    assert.equal(exported.meter_readings.length, 3);
    assert.equal(exported.key_loans.length, 1);

    assert.equal((await call(server, manager, "DELETE", "/residents/resident-2")).status, 200);
    assert.equal((await renovations()).length, 0);
    const readings = (await call(server, service, "GET", "/companies/demo-company/meter-readings")).data as any[];
    assert.equal(readings.length, 3);
    assert.ok(readings.every(row => row.recorded_by === "Poistettu asukas"));
    const [key] = (await call(server, service, "GET", "/companies/demo-company/keys")).data;
    const loans = (await call(server, service, "GET", `/keys/${key.id}/loans`)).data as any[];
    assert.ok(loans.some(loan => loan.holder_name === "Poistettu asukas"));
  });
});
