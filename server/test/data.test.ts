import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, PASSWORD, startServer, type TestServer } from "./helpers.js";

const TABLES = [
  "knowledge", "knowledge-ai", "knowledge-internal", "residents", "apartments", "waitlist", "keys",
  "sauna", "laundry", "parking", "announcements", "moves", "renovations", "meters"
];

describe("data-osio", () => {
  let server: TestServer;
  let admin: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
  });

  after(() => server.stop());

  it("jokainen taulu näyttää kaikkien taloyhtiöiden rivit", async () => {
    const companyId = (await call(server, admin, "POST", "/companies", { name: "As Oy Datatesti", emailAddress: "" })).data.companyId;
    assert.equal((await call(server, admin, "POST", `/companies/${companyId}/apartments`, {
      apartmentNumber: "A 1", address: "Datatie 1"
    })).status, 201);

    const apartments = (await call(server, admin, "GET", "/data/apartments")).data as any[];
    const companyNames = new Set(apartments.map(row => row.company_name));
    assert.ok(companyNames.has("As Oy Datatesti"));
    assert.ok(companyNames.has("As Oy Koivikko"));

    for (const table of TABLES) {
      const result = await call(server, admin, "GET", `/data/${table}`);
      assert.equal(result.status, 200, table);
      assert.ok(Array.isArray(result.data), table);
    }
    assert.equal((await call(server, admin, "GET", "/data/users")).status, 404);
  });

  it("taulun näkee vain rooli, jolla on pääsy siihen", async () => {
    assert.equal((await call(server, admin, "POST", "/roles", { name: "Asukasdata", base: "Asiakaspalvelu", tables: ["residents"] })).status, 201);
    assert.equal((await call(server, admin, "POST", "/users", {
      name: "Dora Data", email: "dora.data@example.com", role: "Asukasdata", password: PASSWORD
    })).status, 201);
    const token = await login(server, "dora.data@example.com");
    assert.equal((await call(server, token, "GET", "/data/residents")).status, 200);
    assert.equal((await call(server, token, "GET", "/data/keys")).status, 403);
  });
});
