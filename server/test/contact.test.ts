import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, startServer, type TestServer } from "./helpers.js";

describe("kotisivun yhteydenottolomake", () => {
  let server: TestServer;
  let admin: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
  });

  after(() => server.stop());

  const request = { name: "Maija Isännöitsijä", email: "maija@example.com", phone: "040 123 4567", company: "Esimerkki Isännöinti Oy", message: "Haluaisin esittelyn." };

  it("kävijä lähettää yhteystiedot kirjautumatta; puutteellinen pyyntö hylätään", async () => {
    assert.equal((await call(server, "", "POST", "/contact", request)).status, 201);
    assert.equal((await call(server, "", "POST", "/contact", { ...request, email: "ei-osoite" })).status, 400);
    assert.equal((await call(server, "", "POST", "/contact", { ...request, name: " " })).status, 400);
    assert.equal((await call(server, "", "POST", "/contact", { ...request, website: "http://roskaa.example" })).status, 201);
  });

  it("pyyntöjä ei tallenneta eikä näytetä alustalla", async () => {
    assert.equal((await call(server, admin, "GET", "/contact-requests")).status, 404);
    assert.equal((await call(server, admin, "GET", "/contact-settings")).status, 404);
  });
});
