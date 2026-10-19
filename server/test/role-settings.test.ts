import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, PASSWORD, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

describe("asetusten roolit", () => {
  let server: TestServer;
  let admin: string;
  let service: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    service = await login(server, SERVICE_EMAIL);
  });

  after(() => server.stop());

  it("valmiit roolit näkevät kaikki taulut, ja vain pääkäyttäjä muokkaa rooleja", async () => {
    const roles = (await call(server, service, "GET", "/roles")).data as any[];
    assert.deepEqual(roles.map(role => [role.name, role.base, role.tables]), [
      ["Isännöitsijä", "Isännöitsijä", null], ["Asiakaspalvelu", "Asiakaspalvelu", null]
    ]);
    assert.ok(roles.find(role => role.name === "Asiakaspalvelu").userCount >= 1);
    assert.equal((await call(server, service, "POST", "/roles", { name: "Testi", base: "Asiakaspalvelu", tables: [] })).status, 403);
    // Pääkäyttäjä-nimistä tai samannimistä roolia ei voi luoda.
    assert.equal((await call(server, admin, "POST", "/roles", { name: "pääkäyttäjä", base: "Isännöitsijä", tables: null })).status, 400);
    assert.equal((await call(server, admin, "POST", "/roles", { name: "Asiakaspalvelu", base: "Isännöitsijä", tables: null })).status, 400);
    // Käyttäjälle voi antaa vain olemassa olevan roolin.
    assert.equal((await call(server, admin, "POST", "/users", {
      name: "Tuntematon Rooli", email: "tuntematon@example.com", role: "Keksitty", password: PASSWORD
    })).status, 400);
  });

  it("käyttäjä saa roolinsa taulut ja oikeustason, ja nimen vaihto ja poisto koskevat käyttäjiä", async () => {
    const created = await call(server, admin, "POST", "/roles", {
      name: "Kiinteistösihteeri", base: "Asiakaspalvelu", tables: ["tickets", "residents", "residents"]
    });
    assert.equal(created.status, 201);
    const user = await call(server, admin, "POST", "/users", {
      name: "Sanna Sihteeri", email: "sanna.sihteeri@example.com", role: "Kiinteistösihteeri", password: PASSWORD
    });
    assert.equal(user.status, 201);

    const token = await login(server, "sanna.sihteeri@example.com");
    const me = (await call(server, token, "GET", "/auth/me")).data;
    assert.deepEqual([me.role, me.manager, me.tables], ["Kiinteistösihteeri", false, ["tickets", "residents"]]);
    // Asiakaspalvelun oikeustasolla ei voi lisätä asuntoa.
    assert.equal((await call(server, token, "POST", "/companies/demo-company/apartments", {
      apartmentNumber: "R 1", address: "Roolitie 1"
    })).status, 403);

    // Isännöitsijän oikeustaso ja uusi nimi: käyttäjän rooli seuraa mukana, ja asunnon voi lisätä.
    assert.equal((await call(server, admin, "PUT", `/roles/${created.data.roleId}`, {
      name: "Kiinteistöpäällikkö", base: "Isännöitsijä", tables: null
    })).status, 200);
    const renamed = (await call(server, token, "GET", "/auth/me")).data;
    assert.deepEqual([renamed.role, renamed.manager, renamed.tables], ["Kiinteistöpäällikkö", true, null]);
    assert.equal((await call(server, token, "POST", "/companies/demo-company/apartments", {
      apartmentNumber: "R 1", address: "Roolitie 1"
    })).status, 201);

    // Pääkäyttäjä näkee aina kaikki taulut.
    assert.equal((await call(server, admin, "GET", "/auth/me")).data.tables, null);

    // Roolia, jolla on käyttäjiä, ei voi poistaa.
    assert.equal((await call(server, admin, "DELETE", `/roles/${created.data.roleId}`)).status, 409);
    assert.equal((await call(server, admin, "PUT", `/users/${user.data.id}`, {
      name: "Sanna Sihteeri", email: "sanna.sihteeri@example.com", role: "Asiakaspalvelu"
    })).status, 200);
    assert.equal((await call(server, admin, "DELETE", `/roles/${created.data.roleId}`)).status, 200);
    const roles = (await call(server, admin, "GET", "/roles")).data as any[];
    assert.equal(roles.some(role => role.name === "Kiinteistöpäällikkö"), false);
  });

  it("Taloyhtiö tunnistamatta -jonon rooliasetus seuraa roolin nimen vaihtoa", async () => {
    const created = await call(server, admin, "POST", "/roles", { name: "Jonottaja", base: "Asiakaspalvelu", tables: ["unidentified"] });
    const office = (await call(server, admin, "GET", "/office")).data;
    assert.equal((await call(server, admin, "PUT", "/office", {
      name: office.name, unidentifiedQueueRoles: ["Asiakaspalvelu", "Jonottaja"]
    })).status, 200);
    await call(server, admin, "PUT", `/roles/${created.data.roleId}`, { name: "Jonon käsittelijä", base: "Asiakaspalvelu", tables: ["unidentified"] });
    assert.deepEqual((await call(server, admin, "GET", "/office")).data.unidentifiedQueueRoles, ["Asiakaspalvelu", "Jonon käsittelijä"]);
    await call(server, admin, "DELETE", `/roles/${created.data.roleId}`);
    assert.deepEqual((await call(server, admin, "GET", "/office")).data.unidentifiedQueueRoles, ["Asiakaspalvelu"]);
  });
});
