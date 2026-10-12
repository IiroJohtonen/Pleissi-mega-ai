import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, startServer, type TestServer } from "./helpers.js";

describe("tietoturva", () => {
  let server: TestServer;
  let admin: string;

  before(async () => {
    server = await startServer({ env: { CORS_ORIGINS: "https://kotilo.example", AUTH_RATE_LIMIT: "5" } });
    admin = await login(server, ADMIN_EMAIL);
  });

  after(() => server.stop());

  it("istuntotunniste ei kelpaa osoitteessa", async () => {
    assert.equal((await call(server, null, "GET", `/companies?token=${admin}`)).status, 401);
    assert.equal((await call(server, admin, "GET", "/companies")).status, 200);
  });

  it("CORS sallii vain määritetyn osoitteen", async () => {
    const allowed = await call(server, null, "GET", "/health", undefined, { Origin: "https://kotilo.example" });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://kotilo.example");
    const denied = await call(server, null, "GET", "/health", undefined, { Origin: "https://paha.example" });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  });

  it("vastauksissa on suojausotsakkeet", async () => {
    const health = await call(server, null, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.data.service, "kotilo-api");
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.ok(health.headers.get("content-security-policy"));
    assert.equal(health.headers.get("x-powered-by"), null);
  });

  it("virheellinen JSON palauttaa siistin virheen", async () => {
    const response = await fetch(`${server.url}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{rikki"
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Virheellinen pyyntö." });
  });

  it("uloskirjautuminen mitätöi istunnon", async () => {
    const token = await login(server, ADMIN_EMAIL);
    assert.equal((await call(server, token, "POST", "/auth/logout")).status, 200);
    assert.equal((await call(server, token, "GET", "/companies")).status, 401);
  });

  // Viimeisenä, koska raja jää voimaan tälle palvelimelle.
  it("epäonnistuneita kirjautumisia rajoitetaan osoitteen mukaan", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      statuses.push((await call(server, null, "POST", "/auth/login", { email: `ei-ole-${attempt}@example.com`, password: "väärä-salasana" })).status);
    }
    // Raja on viisi epäonnistunutta pyyntöä; aiempi virheellinen JSON-pyyntö kuluttaa niistä yhden.
    assert.equal(statuses[0], 401);
    assert.ok(statuses.filter(status => status === 401).length <= 5);
    assert.deepEqual(statuses.slice(-2), [429, 429]);
  });
});

describe("aloitussalasana", () => {
  it("arvotaan ja tulostetaan lokiin, kun sitä ei ole annettu", async () => {
    const server = await startServer({ env: { INITIAL_PASSWORD: "" } });
    try {
      const printed = server.output().match(/Aloitussalasana kaikille: (\S+)/)?.[1];
      assert.ok(printed && printed.length >= 8, "salasana löytyy lokista");
      assert.equal((await call(server, null, "POST", "/auth/login", { email: ADMIN_EMAIL, password: "Kiito2026!" })).status, 401);
      assert.equal((await call(server, null, "POST", "/auth/login", { email: ADMIN_EMAIL, password: printed })).status, 200);
    } finally {
      await server.stop();
    }
  });
});
