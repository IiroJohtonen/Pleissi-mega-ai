import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, startServer, type TestServer } from "./helpers.js";

describe("kotisivun yhteydenottolomake", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
  });

  after(() => server.stop());

  const request = { name: "Maija Isännöitsijä", email: "maija@example.com", phone: "040 123 4567", company: "Esimerkki Isännöinti Oy", message: "Haluaisin esittelyn." };

  it("kävijä jättää yhteystiedot kirjautumatta ja pääkäyttäjä näkee ne", async () => {
    assert.equal((await call(server, "", "POST", "/contact", request)).status, 201);
    const list = await call(server, admin, "GET", "/contact-requests");
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].email, "maija@example.com");
    assert.equal(list.data[0].company, "Esimerkki Isännöinti Oy");
  });

  it("puutteellinen pyyntö hylätään ja automaattisen lähettäjän pyyntöä ei tallenneta", async () => {
    assert.equal((await call(server, "", "POST", "/contact", { ...request, email: "ei-osoite" })).status, 400);
    assert.equal((await call(server, "", "POST", "/contact", { ...request, name: " " })).status, 400);
    assert.equal((await call(server, "", "POST", "/contact", { ...request, website: "http://roskaa.example" })).status, 201);
    assert.equal((await call(server, admin, "GET", "/contact-requests")).data.length, 1);
  });

  it("pyynnöt näkee ja poistaa vain pääkäyttäjä", async () => {
    assert.equal((await call(server, "", "GET", "/contact-requests")).status, 401);
    assert.equal((await call(server, manager, "GET", "/contact-requests")).status, 403);
    const [first] = (await call(server, admin, "GET", "/contact-requests")).data;
    assert.equal((await call(server, manager, "DELETE", `/contact-requests/${first.id}`)).status, 403);
    assert.equal((await call(server, admin, "DELETE", `/contact-requests/${first.id}`)).status, 200);
    assert.equal((await call(server, admin, "GET", "/contact-requests")).data.length, 0);
  });

  it("pääkäyttäjä asettaa osoitteen, johon pyynnöt lähetetään sähköpostina", async () => {
    assert.equal((await call(server, "", "GET", "/contact-settings")).status, 401);
    assert.equal((await call(server, manager, "PUT", "/contact-settings", { email: "myynti@example.com" })).status, 403);
    assert.equal((await call(server, admin, "PUT", "/contact-settings", { email: "ei osoite" })).status, 400);

    const saved = await call(server, admin, "PUT", "/contact-settings", { email: "myynti@example.com" });
    assert.equal(saved.status, 200);
    assert.equal((await call(server, admin, "GET", "/contact-settings")).data.email, "myynti@example.com");

    // Testipalvelimella posti on pois päältä: lähetys epäonnistuu, mutta pyyntö tallentuu silti.
    const before = (await call(server, admin, "GET", "/contact-requests")).data.length;
    assert.equal((await call(server, "", "POST", "/contact", { ...request, email: "uusi@example.com" })).status, 201);
    assert.equal((await call(server, admin, "GET", "/contact-requests")).data.length, before + 1);

    assert.equal((await call(server, admin, "PUT", "/contact-settings", { email: "" })).data.email, "");
  });
});
