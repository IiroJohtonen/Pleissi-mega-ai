import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

describe("AI-dokumentaatio ja sisäinen dokumentaatio", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;
  let service: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
    service = await login(server, SERVICE_EMAIL);
  });

  after(() => server.stop());

  const question = "Missä vara-avain säilytetään?";

  async function entries() {
    return (await call(server, service, "GET", "/companies/demo-company/knowledge")).data as any[];
  }

  async function aiAnswers() {
    return (await call(server, service, "POST", "/companies/demo-company/knowledge/test", { question })).data.found as boolean;
  }

  it("sisäinen tietue näkyy henkilökunnalle, mutta AI ei käytä sitä", async () => {
    const created = await call(server, manager, "POST", "/companies/demo-company/knowledge/facts", {
      question, answer: "Vara-avain säilytetään toimiston kassakaapissa.", audience: "internal"
    });
    assert.equal(created.status, 201);

    const entry = (await entries()).find(row => row.id === created.data.knowledgeId);
    assert.equal(entry.audience, "internal");
    assert.equal(entry.state, "internal");
    assert.equal(await aiAnswers(), false);
  });

  it("tietueen voi siirtää AI:n käyttöön ja takaisin", async () => {
    const entry = (await entries()).find(row => row.title === question);
    assert.equal((await call(server, service, "PUT", `/knowledge/${entry.id}/audience`, { audience: "ai" })).status, 403);
    assert.equal((await call(server, manager, "PUT", `/knowledge/${entry.id}/audience`, { audience: "kaikki" })).status, 400);

    assert.equal((await call(server, manager, "PUT", `/knowledge/${entry.id}/audience`, { audience: "ai" })).status, 200);
    assert.equal((await entries()).find(row => row.id === entry.id).state, "in_use");
    assert.equal(await aiAnswers(), true);

    assert.equal((await call(server, manager, "PUT", `/knowledge/${entry.id}/audience`, { audience: "internal" })).status, 200);
    assert.equal(await aiAnswers(), false);
  });

  it("uusi versio perii kohteen ja uusi tietue on oletuksena AI-dokumentaatiota", async () => {
    const entry = (await entries()).find(row => row.title === question);
    const replaced = await call(server, manager, "POST", "/companies/demo-company/knowledge/facts", {
      question, answer: "Vara-avain on huoltoyhtiöllä.", replaces: entry.id
    });
    assert.equal(replaced.status, 201);
    const current = (await entries()).find(row => row.id === replaced.data.knowledgeId);
    assert.equal(current.audience, "internal");
    assert.equal(current.version, 2);

    const plain = await call(server, admin, "POST", "/companies/demo-company/knowledge/facts", { question: "Milloin piha aurataan?", answer: "Aamuisin." });
    assert.equal((await entries()).find(row => row.id === plain.data.knowledgeId).audience, "ai");
  });
});
