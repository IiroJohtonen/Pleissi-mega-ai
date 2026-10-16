import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { ADMIN_EMAIL, call, localDate, login, MANAGER_EMAIL, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

const RULES = [
  "Järjestyssäännöt",
  "Pysäköinti pihalla on sallittu vain merkityillä autopaikoilla. Vieraspaikkoja on kolme portin vieressä.",
  "Saunavuoron voi perua asukasportaalissa viimeistään kolme tuntia ennen vuoron alkua.",
  "Parvekkeella grillaaminen hiiligrillillä on kielletty. Sähkögrilli on sallittu."
].join("\n\n");

describe("tietopalat ja niiden valinta vastausehdotukseen", () => {
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

  const select = async (question: string, companyId = "demo-company", token = service) =>
    (await call(server, token, "POST", `/companies/${companyId}/knowledge/test`, { question })).data as { found: boolean; chunks: any[] };

  async function upload(companyId: string, title: string, text: string) {
    const query = new URLSearchParams({ fileName: `${title}.txt`, mimeType: "text/plain", title });
    const response = await fetch(`${server.url}/api/companies/${companyId}/knowledge/documents?${query}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/octet-stream" },
      body: text
    });
    assert.equal(response.status, 201);
    return (await response.json()).knowledgeId as string;
  }

  it("vanhat tietueet on pilkottu käynnistyksessä, ja oikea pala löytyy", async () => {
    // Demokannan tietueet lisätään ilman paloja; käynnistys pilkkoo ne.
    const result = await select("Mikä on huoltoyhtiön päivystysnumero?");
    assert.equal(result.found, true);
    assert.match(result.chunks[0].content, /010 123 4567/);
    assert.equal(result.chunks[0].knowledgeId, "knowledge-3");
  });

  it("dokumentti pilkotaan kappaleittain ja kysymykseen valitaan osuva kappale", async () => {
    const knowledgeId = await upload("demo-company", "Järjestyssäännöt 2026", RULES);
    const result = await select("Saako parvekkeella grillata hiiligrillillä?");
    assert.ok(result.chunks.length >= 1 && result.chunks.length <= 5);
    assert.equal(result.chunks[0].knowledgeId, knowledgeId);
    assert.match(result.chunks[0].content, /hiiligrillillä/);
    assert.doesNotMatch(result.chunks[0].content, /Pysäköinti/);
  });

  it("ilman osumaa palautetaan tyhjä lista eikä koko tietopankkia", async () => {
    const result = await select("Kuinka monta kissaa Brasiliassa asuu?");
    assert.equal(result.found, false);
    assert.deepEqual(result.chunks, []);
  });

  it("sisäinen ja vanhentunut tieto ei päädy AI:lle", async () => {
    const internal = await call(server, manager, "POST", "/companies/demo-company/knowledge/facts", {
      question: "Mikä on kattoluukun koodi?", answer: "Kattoluukun koodi on 4455.", audience: "internal"
    });
    assert.equal(internal.status, 201);
    const expired = await call(server, manager, "POST", "/companies/demo-company/knowledge/facts", {
      question: "Milloin pihatalkoot pidetään?", answer: "Pihatalkoot pidetään toukokuussa.", validUntil: localDate(-1)
    });
    assert.equal(expired.status, 201);
    assert.deepEqual((await select("Mikä on kattoluukun koodi?")).chunks, []);
    assert.deepEqual((await select("Milloin pihatalkoot pidetään?")).chunks, []);
  });

  it("toisen taloyhtiön tieto ei näy", async () => {
    const other = (await call(server, admin, "POST", "/companies", { name: "As Oy Naapuri" })).data.companyId as string;
    await upload(other, "Naapurin kerhohuone", "Kerhohuoneen avain noudetaan naapurin toimistosta tiistaisin.");
    assert.equal((await select("Mistä kerhohuoneen avain noudetaan?", other, admin)).chunks.length, 1);
    assert.deepEqual((await select("Mistä kerhohuoneen avain noudetaan?")).chunks, []);
  });

  it("ilman AI-avainta ehdotus tehdään parhaasta palasta, ja pala tallentuu tehtävälle", async () => {
    const created = await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Asukas", subject: "Grillaus", body: "Saako parvekkeella grillata hiiligrillillä?", channel: "email"
    });
    const ticketId = created.data.ticketId as string;
    const suggested = await call(server, admin, "POST", `/tickets/${ticketId}/suggest`, {});
    assert.equal(suggested.status, 200);
    assert.equal(suggested.data.usedAi, false);
    assert.match(suggested.data.draft, /Sähkögrilli on sallittu/);
    assert.equal(suggested.data.source.title, "Järjestyssäännöt 2026");
    assert.match(suggested.data.source.chunkId, /^chunk/);

    const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.equal(detail.ticket.knowledge_source_chunk_id, suggested.data.source.chunkId);
    assert.equal(detail.ticket.knowledge_source_title, "Järjestyssäännöt 2026");
  });

  it("korvattu ja poistettu tietue vie palansa pois käytöstä", async () => {
    const [before] = (await select("Saako parvekkeella grillata hiiligrillillä?")).chunks;
    const replaced = await fetch(`${server.url}/api/companies/demo-company/knowledge/documents?${new URLSearchParams({
      fileName: "säännöt.txt", mimeType: "text/plain", title: "Järjestyssäännöt 2026", replaces: before.knowledgeId
    })}`, { method: "POST", headers: { Authorization: `Bearer ${admin}` }, body: "Parvekkeella grillaaminen hiiligrillillä ja sähkögrillillä on kokonaan kielletty." });
    assert.equal(replaced.status, 201);
    const newId = (await replaced.json()).knowledgeId as string;
    const [after] = (await select("Saako parvekkeella grillata hiiligrillillä?")).chunks;
    assert.equal(after.knowledgeId, newId);
    assert.match(after.content, /kokonaan kielletty/);

    assert.equal((await call(server, manager, "DELETE", `/knowledge/${newId}`)).status, 200);
    assert.deepEqual((await select("Saako parvekkeella grillata hiiligrillillä?")).chunks, []);

    const db = new Database(path.join(server.dataDir, "kotilo.sqlite"), { readonly: true });
    try {
      const statuses = db.prepare("SELECT knowledge_id, status FROM knowledge_chunks WHERE knowledge_id IN (?, ?)")
        .all(before.knowledgeId, newId) as { knowledge_id: string; status: string }[];
      assert.ok(statuses.filter(row => row.knowledge_id === before.knowledgeId).every(row => row.status === "archived"));
      assert.ok(statuses.filter(row => row.knowledge_id === newId).every(row => row.status === "deleted"));
    } finally {
      db.close();
    }
  });

  it("isännöitsijä muokkaa, lisää ja poistaa tietoja, ja muokattu tieto on tarkistettu", async () => {
    const knowledgeId = await upload("demo-company", "Pihasäännöt", "Roskakatos on pihan pohjoispäädyssä.\n\nPyöräteline on B-portaan edessä.");
    const chunks = async () => (await call(server, admin, "GET", `/knowledge/${knowledgeId}/chunks`)).data as any[];
    const [first, second] = await chunks();
    assert.equal(first.origin, "local");
    assert.equal(first.verified, 0);

    const edit = { title: "Roskakatos", content: "Roskakatos on pihan pohjoispäädyssä, avain on sama kuin ulko-ovessa.", tags: ["roskat", "jäte"] };
    assert.equal((await call(server, service, "PUT", `/knowledge-chunks/${first.id}`, edit)).status, 403);
    assert.equal((await call(server, manager, "PUT", `/knowledge-chunks/${first.id}`, edit)).status, 200);
    const edited = (await chunks()).find(chunk => chunk.id === first.id);
    assert.equal(edited.origin, "manual");
    assert.equal(edited.verified, 1);
    assert.equal(edited.tags, "roskat, jäte");

    // Ilman AI:ta luonnos on teksti sellaisenaan; samaa asiaa käsittelevä pala ehdotetaan päivitettäväksi.
    const draft = await call(server, manager, "POST", `/knowledge/${knowledgeId}/chunks/draft`, { text: "Roskakatoksen avain on sama kuin ulko-ovessa ja roskakatos tyhjennetään maanantaisin." });
    assert.equal(draft.status, 200);
    assert.equal(draft.data.usedAi, false);
    assert.equal(draft.data.similar?.id, first.id);
    const fresh = await call(server, manager, "POST", `/knowledge/${knowledgeId}/chunks/draft`, { text: "Kerhohuoneen voi varata isännöitsijältä." });
    assert.equal(fresh.data.similar, null);
    const saved = await call(server, manager, "POST", `/knowledge/${knowledgeId}/chunks`, { title: fresh.data.title, content: fresh.data.content, tags: [] });
    assert.equal(saved.status, 201);
    assert.equal((await chunks()).length, 3);
    const [hit] = (await select("Miten kerhohuoneen voi varata?")).chunks;
    assert.equal(hit.id, saved.data.chunkId);

    assert.equal((await call(server, manager, "DELETE", `/knowledge-chunks/${second.id}`)).status, 200);
    assert.deepEqual((await chunks()).map(chunk => chunk.id).sort(), [first.id, saved.data.chunkId].sort());
  });

  it("puuttuvien tietojen haku ilman AI:ta ehdottaa vain kappaleet, joita ei vielä ole", async () => {
    const knowledgeId = await upload("demo-company", "Kerhohuone", "Kerhohuone on kellarissa.\n\nKerhohuoneen voi varata viikonloppuisin.");
    const [first] = (await call(server, admin, "GET", `/knowledge/${knowledgeId}/chunks`)).data as any[];
    assert.equal((await call(server, manager, "DELETE", `/knowledge-chunks/${first.id}`)).status, 200);
    const missing = await call(server, manager, "POST", `/knowledge/${knowledgeId}/chunks/missing`, { note: "Kerhohuoneen sijainti puuttuu" });
    assert.equal(missing.status, 200);
    assert.equal(missing.data.usedAi, false);
    assert.deepEqual(missing.data.proposals.map((proposal: any) => proposal.content), ["Kerhohuone on kellarissa."]);
  });
});
