import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { call, login, MANAGER_EMAIL, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

describe("asunnot", () => {
  let server: TestServer;
  let manager: string;
  let service: string;

  before(async () => {
    server = await startServer();
    manager = await login(server, MANAGER_EMAIL);
    service = await login(server, SERVICE_EMAIL);
  });

  after(() => server.stop());

  it("asunnon voi lisätä ja muokata, eikä samaa asuntoa voi lisätä kahdesti", async () => {
    const created = await call(server, manager, "POST", "/companies/demo-company/apartments", {
      apartmentNumber: "C 41", address: "Koivikkotie 12", staircase: "C"
    });
    assert.equal(created.status, 201);
    assert.equal((await call(server, manager, "POST", "/companies/demo-company/apartments", {
      apartmentNumber: "c 41", address: "koivikkotie 12"
    })).status, 409);
    assert.equal((await call(server, service, "POST", "/companies/demo-company/apartments", {
      apartmentNumber: "C 42", address: "Koivikkotie 12"
    })).status, 403);

    const list = (await call(server, manager, "GET", "/companies/demo-company/apartments")).data as any[];
    const apartment = list.find(item => item.id === created.data.apartmentId);
    assert.deepEqual([apartment.apartment_number, apartment.staircase, apartment.resident_count], ["C 41", "C", 0]);

    assert.equal((await call(server, manager, "PUT", `/apartments/${apartment.id}`, {
      apartmentNumber: "C 43", address: "Koivikkotie 12", staircase: "C"
    })).status, 200);
    const detail = (await call(server, manager, "GET", `/apartments/${apartment.id}`)).data;
    assert.equal(detail.apartment_number, "C 43");
    assert.equal(detail.company_name, "As Oy Koivikko");
  });

  it("asukkaan voi valita asuntoon, ja hänellä voi olla roolit osakas ja asukas", async () => {
    const apartmentId = (await call(server, manager, "POST", "/companies/demo-company/apartments", {
      apartmentNumber: "D 5", address: "Koivikkotie 14", staircase: "D"
    })).data.apartmentId;
    const created = await call(server, manager, "POST", "/companies/demo-company/residents", {
      name: "Olli Osakas", email: "olli.osakas@example.com", apartmentId, roles: ["osakas", "asukas"]
    });
    assert.equal(created.status, 201);
    const residents = (await call(server, manager, "GET", "/companies/demo-company/residents")).data as any[];
    const olli = residents.find(resident => resident.id === created.data.residentId);
    assert.equal(olli.apartment_id, apartmentId);
    assert.equal(olli.apartment_number, "D 5");
    assert.equal(olli.roles, "osakas,asukas");

    // Vain osakas; muut tiedot ennallaan.
    assert.equal((await call(server, manager, "PUT", `/residents/${olli.id}`, {
      name: "Olli Osakas", email: "olli.osakas@example.com", apartmentId, roles: ["osakas"]
    })).status, 200);
    const detail = (await call(server, manager, "GET", `/apartments/${apartmentId}`)).data;
    assert.deepEqual(detail.residents.map((resident: any) => [resident.name, resident.roles]), [["Olli Osakas", "osakas"]]);

    // Toisen taloyhtiön tai olematonta asuntoa ei voi valita.
    assert.equal((await call(server, manager, "PUT", `/residents/${olli.id}`, {
      name: "Olli Osakas", apartmentId: "apt-ei-ole"
    })).status, 404);
  });

  it("henkilön ja avaimen voi liittää asuntoon", async () => {
    const apartmentId = (await call(server, manager, "POST", "/companies/demo-company/apartments", {
      apartmentNumber: "E 7", address: "Koivikkotie 16"
    })).data.apartmentId;
    const residents = (await call(server, manager, "GET", "/companies/demo-company/residents")).data as any[];
    const resident = residents[0];
    assert.equal((await call(server, manager, "POST", `/apartments/${apartmentId}/residents`, { residentId: resident.id })).status, 200);

    const keyId = (await call(server, manager, "POST", "/companies/demo-company/keys", { code: "E-7", type: "Asunto" })).data.keyId;
    assert.equal((await call(server, manager, "PUT", `/apartments/${apartmentId}/keys/${keyId}`, {})).status, 200);

    let detail = (await call(server, manager, "GET", `/apartments/${apartmentId}`)).data;
    assert.deepEqual(detail.residents.map((item: any) => item.id), [resident.id]);
    assert.deepEqual(detail.keys.map((item: any) => item.code), ["E-7"]);
    const list = (await call(server, manager, "GET", "/companies/demo-company/apartments")).data as any[];
    assert.equal(list.find(item => item.id === apartmentId).resident_count, 1);

    assert.equal((await call(server, manager, "PUT", `/apartments/${apartmentId}/keys/${keyId}`, { linked: false })).status, 200);
    detail = (await call(server, manager, "GET", `/apartments/${apartmentId}`)).data;
    assert.deepEqual(detail.keys, []);
    assert.deepEqual([detail.parking, detail.bookings, detail.renovations].map(rows => Array.isArray(rows)), [true, true, true]);
  });
});
