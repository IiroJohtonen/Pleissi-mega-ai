import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, PASSWORD, startServer, type TestServer } from "./helpers.js";

describe("asukkaan rappu ja autopaikat", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
  });

  after(() => server.stop());

  const residents = async () => (await call(server, manager, "GET", "/companies/demo-company/residents")).data as any[];

  it("rappu tallentuu asukkaan tietoihin ja näkyy asukaslistassa", async () => {
    const saved = await call(server, manager, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "34", staircase: "C"
    });
    assert.equal(saved.status, 200);
    assert.equal((await residents()).find(row => row.id === "resident-2").staircase, "C");
    // Ilman rappua tallennettaessa rappu säilyy.
    await call(server, manager, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "34"
    });
    assert.equal((await residents()).find(row => row.id === "resident-2").staircase, "C");
  });

  it("asukkaalle annettu autopaikka näkyy asukkaan tiedoissa", async () => {
    const space = await call(server, manager, "POST", "/companies/demo-company/parking", { label: "P7", type: "Autotalli", residentId: "resident-2" });
    assert.equal(space.status, 201);
    const liisa = (await residents()).find(row => row.id === "resident-2");
    assert.deepEqual(liisa.parking.map((item: any) => item.label), ["P7"]);
    assert.deepEqual((await residents()).find(row => row.id === "resident-1").parking, []);
  });

  it("rapulle kohdistettu tiedote näkyy vain rapun asukkaille", async () => {
    await call(server, admin, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "34", staircase: "C", password: PASSWORD
    });
    const audience = (await call(server, manager, "GET", "/companies/demo-company/announcement-audience")).data;
    assert.ok(audience.stairwells.some((row: any) => row.stairwell === "C"));
    const created = await call(server, manager, "POST", "/companies/demo-company/announcements", {
      title: "Rapun C ovi", body: "Rapun C ulko-ovi huolletaan torstaina.", stairwell: "C", sendEmail: false
    });
    assert.equal(created.status, 201);
    const liisa = await login(server, "liisa@example.com");
    const seen = (await call(server, liisa, "GET", "/portal/announcements")).data as any[];
    assert.ok(seen.some(item => item.id === created.data.announcementId));
  });
});
