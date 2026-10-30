import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, startServer, type TestServer } from "./helpers.js";

// Merkityshaun asetukset palvelimessa: vain pääkäyttäjälle, muutokset toimintalokiin, ja päälle kytkentä
// käynnistää vektorien laskennan taustalla. Mallin tilalla on sanatiivisteisiin perustuva vektori (hash),
// joten mitään ei ladata.

describe("Merkityshaun asetukset", () => {
  let server: TestServer;
  let admin: string;

  before(async () => {
    server = await startServer({ env: { EMBEDDING_MODEL: "hash" } });
    admin = await login(server, ADMIN_EMAIL);
  });

  after(async () => {
    await server.stop();
  });

  it("on oletuksena pois ja vain pääkäyttäjän muutettavissa", async () => {
    const manager = await login(server, MANAGER_EMAIL);
    assert.equal((await call(server, manager, "GET", "/embedding/status")).status, 403);
    assert.equal((await call(server, manager, "PUT", "/embedding/companies/demo-company", { hybridKnowledge: true })).status, 403);
    const master = await call(server, admin, "GET", "/master-data");
    assert.deepEqual(master.data.values.embedding, { similarTickets: false, hybridKnowledge: false });
    const status = await call(server, admin, "GET", "/embedding/status");
    assert.equal(status.data.killed, false);
    assert.equal(status.data.backend, "sqlite-vec");
    assert.deepEqual(status.data.companies.find((company: any) => company.id === "demo-company").vectors, { ticket: 0, chunk: 0, memory: 0 });
  });

  it("taloyhtiön ohitus kirjataan lokiin ja käynnistää vektorien laskennan", async () => {
    const saved = await call(server, admin, "PUT", "/embedding/companies/demo-company", { hybridKnowledge: true });
    assert.equal(saved.status, 200);
    let company: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      company = (await call(server, admin, "GET", "/embedding/status")).data.companies.find((item: any) => item.id === "demo-company");
      if (company.vectors.chunk > 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(company.hybridKnowledge, true);
    assert.equal(company.similarTickets, null);
    assert.ok(company.vectors.chunk > 0, "dokumentaation palat vektoroitu");
    const audit = (await call(server, admin, "GET", "/audit")).data as { action: string; details: string }[];
    const entry = audit.find(item => item.action === "embedding_settings_updated");
    assert.ok(entry);
    assert.equal(JSON.parse(entry.details).hybridKnowledge, true);
    assert.equal((await call(server, admin, "PUT", "/embedding/companies/ei-ole", { hybridKnowledge: true })).status, 404);
  });

  it("toimiston yleinen asetus tallentuu perustietoihin ja kirjataan lokiin", async () => {
    const saved = await call(server, admin, "PUT", "/master-data", { embedding: { similarTickets: true, hybridKnowledge: false } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.embedding, { similarTickets: true, hybridKnowledge: false });
    const audit = (await call(server, admin, "GET", "/audit")).data as { action: string; details: string }[];
    const entry = audit.find(item => item.action === "master_data_updated");
    assert.deepEqual(JSON.parse(entry!.details).embedding, { similarTickets: true, hybridKnowledge: false });
  });
});
