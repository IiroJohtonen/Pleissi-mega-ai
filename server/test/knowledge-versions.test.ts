import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, localDate, login, MANAGER_EMAIL, startServer, type TestServer } from "./helpers.js";

const V1 = [
  "Saunavuorot varataan asukasportaalista. Vuoron voi perua kolme tuntia ennen alkua.",
  "Pyörät säilytetään pyöräkellarissa B-portaan alla.",
  "Mattojen tamppaus on sallittu arkisin kello 8–20 tamppaustelineellä."
].join("\n\n");

const V2 = [
  "Saunavuorot varataan asukasportaalista. Vuoron voi perua kuusi tuntia ennen alkua.",
  "Pyörät säilytetään pyöräkellarissa B-portaan alla.",
  "Grillaaminen parvekkeella on kielletty hiiligrillillä."
].join("\n\n");

describe("dokumentin uusi versio", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
  });

  after(() => server.stop());

  async function upload(title: string, text: string, replaces?: string) {
    const query = new URLSearchParams({ fileName: `${title}.txt`, mimeType: "text/plain", title, ...(replaces ? { replaces } : {}) });
    const response = await fetch(`${server.url}/api/companies/demo-company/knowledge/documents?${query}`, {
      method: "POST", headers: { Authorization: `Bearer ${admin}` }, body: text
    });
    assert.equal(response.status, 201);
    return response.json() as Promise<{ knowledgeId: string; pending: boolean; likelyVersionOf: { id: string; title: string } | null }>;
  }
  const chunks = async (knowledgeId: string) => (await call(server, admin, "GET", `/knowledge/${knowledgeId}/chunks`)).data as any[];
  const select = async (question: string) =>
    ((await call(server, admin, "POST", "/companies/demo-company/knowledge/test", { question })).data.chunks as any[]);

  // Vanha versio, jonka saunatiedon isännöitsijä on tarkistanut ja muokannut.
  async function firstVersion(title: string) {
    const { knowledgeId } = await upload(title, V1);
    const sauna = (await chunks(knowledgeId))[0];
    assert.equal((await call(server, manager, "PUT", `/knowledge-chunks/${sauna.id}`, {
      title: "Saunavuorot", content: sauna.content, tags: ["sauna"]
    })).status, 200);
    return knowledgeId;
  }

  it("vertailu erottelee uudet, muuttuneet, poistuneet, ennallaan olevat ja ristiriidat", async () => {
    const oldId = await firstVersion("Asumisohje");
    const { knowledgeId: newId, pending } = await upload("Asumisohje", V2, oldId);
    assert.equal(pending, true);

    // Ennen hyväksyntää vanha on voimassa ja uusi odottaa.
    const list = (await call(server, admin, "GET", "/companies/demo-company/knowledge")).data as any[];
    assert.equal(list.find(entry => entry.id === oldId).pending_version_id, newId);
    assert.ok(!list.some(entry => entry.id === newId));
    assert.equal((await select("Kuinka kauan ennen saunavuoron voi perua?"))[0].knowledgeId, oldId);

    const comparison = (await call(server, admin, "GET", `/knowledge/${newId}/comparison`)).data;
    assert.equal(comparison.state, "ready");
    assert.equal(comparison.previous.id, oldId);
    const kinds = Object.fromEntries(comparison.items.map((item: any) => [item.oldChunk?.content ?? item.newChunk.content, item.kind]));
    // Tarkistettu saunatieto muuttui: ristiriita, jota ei muuteta automaattisesti.
    assert.equal(kinds[V1.split("\n\n")[0]], "conflict");
    assert.equal(kinds[V1.split("\n\n")[1]], "unchanged");
    assert.equal(kinds[V1.split("\n\n")[2]], "removed");
    assert.equal(kinds[V2.split("\n\n")[2]], "new");

    // Hyväksy muutokset: ristiriidassa vanha tarkistettu tieto säilyy.
    assert.equal((await call(server, manager, "POST", `/knowledge/${newId}/apply-version`, {})).status, 200);
    const current = await chunks(newId);
    assert.deepEqual(current.map(chunk => chunk.content).sort(), [V1.split("\n\n")[0], V2.split("\n\n")[1], V2.split("\n\n")[2]].sort());
    const kept = current.find(chunk => chunk.title === "Saunavuorot");
    assert.equal(kept.origin, "manual");
    assert.equal(kept.verified, 1);
    assert.equal((await call(server, admin, "GET", `/knowledge/${oldId}`)).data.status, "replaced");
    assert.deepEqual(await chunks(oldId), []);
    assert.equal((await select("Kuinka kauan ennen saunavuoron voi perua?"))[0].knowledgeId, newId);
  });

  it("yksitellen läpi käydessä ristiriidan voi ratkaista uuden version hyväksi ja muutoksen hylätä", async () => {
    const oldId = await firstVersion("Saunaohje");
    const { knowledgeId: newId } = await upload("Saunaohje", V2, oldId);
    const { items } = (await call(server, admin, "GET", `/knowledge/${newId}/comparison`)).data;
    const conflict = items.find((item: any) => item.kind === "conflict");
    const removed = items.find((item: any) => item.kind === "removed");
    const added = items.find((item: any) => item.kind === "new");
    const decisions = { [conflict.key]: "accept", [removed.key]: "reject", [added.key]: "reject" };
    assert.equal((await call(server, manager, "POST", `/knowledge/${newId}/apply-version`, { decisions })).status, 200);
    const contents = (await chunks(newId)).map(chunk => chunk.content).sort();
    assert.deepEqual(contents, [V2.split("\n\n")[0], V2.split("\n\n")[1], V1.split("\n\n")[2]].sort());
  });

  it("odottavan version hylkäys jättää vanhan voimaan", async () => {
    const { knowledgeId: oldId } = await upload("Pihaohje", V1);
    const { knowledgeId: newId } = await upload("Pihaohje", V2, oldId);
    assert.equal((await call(server, manager, "DELETE", `/knowledge/${newId}`)).status, 200);
    const detail = (await call(server, admin, "GET", `/knowledge/${oldId}`)).data;
    assert.equal(detail.status, "active");
    assert.equal(detail.pending_version_id, null);
    assert.equal((await chunks(oldId)).length, 3);
  });

  it("lataus tunnistaa todennäköisen uuden version, ja sen voi merkitä uudeksi versioksi", async () => {
    const { knowledgeId: oldId } = await upload("Järjestyssäännöt 2025", V1);
    const { knowledgeId: newId, likelyVersionOf } = await upload("Järjestyssäännöt 2026", V2);
    assert.equal(likelyVersionOf?.id, oldId);
    assert.equal((await upload("Kokouskutsu", "Yhtiökokous pidetään kerhohuoneessa.")).likelyVersionOf, null);

    assert.equal((await call(server, manager, "POST", `/knowledge/${newId}/as-version-of`, { knowledgeId: oldId })).status, 200);
    const detail = (await call(server, admin, "GET", `/knowledge/${newId}`)).data;
    assert.equal(detail.status, "pending");
    assert.equal(detail.version, 2);
    assert.equal((await call(server, admin, "GET", `/knowledge/${oldId}`)).data.pending_version_id, newId);
  });

  it("merkitse vanhentuneeksi päättää voimassaolon tänään", async () => {
    const { knowledgeId } = await upload("Talvikunnossapito", "Lumityöt tehdään aamuisin ennen kello seitsemää.");
    assert.equal((await call(server, manager, "POST", `/knowledge/${knowledgeId}/expire`)).status, 200);
    assert.equal((await call(server, admin, "GET", `/knowledge/${knowledgeId}`)).data.valid_until, localDate());
  });
});
