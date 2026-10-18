import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { htmlToMarkdown, markdownToPlain, plainToMarkdown } from "../src/rich-text.js";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

describe("dokumentin muotoilu", () => {
  it("Word-dokumentin otsikot, lihavoinnit ja luettelot säilyvät", () => {
    const html = "<h1>Järjestyssäännöt</h1><p>Nämä <strong>säännöt </strong>koskevat <em>kaikkia</em> &amp; vieraita.</p>" +
      "<ol><li>Yleistä<ol><li>Alakohta</li></ol></li><li><p>Toinen</p></li></ol><p><strong> </strong></p>" +
      "<table><tr><td><p>Sauna</p></td><td><p>klo 18</p></td></tr></table><p>1. ei luettelo</p>";
    assert.equal(htmlToMarkdown(html), [
      "# Järjestyssäännöt",
      "Nämä **säännöt** koskevat *kaikkia* & vieraita.",
      "1. Yleistä\n  1. Alakohta\n2. Toinen",
      "Sauna | klo 18",
      "1\\. ei luettelo"
    ].join("\n\n"));
  });

  it("PDF:n tekstistä erotetaan otsikot, luettelot ja katkenneet rivit", () => {
    const text = "JÄRJESTYSSÄÄNNÖT\n1. Yleistä\nNämä säännöt koskevat kaikkia asukkaita ja\nheidän vieraitaan.\n• Pallo\n• Maila\n\n" +
      "2. Asukkaan on huolehdittava siitä, että piha-alueet pidetään siisteinä ja roskat viedään.";
    assert.equal(plainToMarkdown(text), [
      "## JÄRJESTYSSÄÄNNÖT",
      "## 1. Yleistä",
      "Nämä säännöt koskevat kaikkia asukkaita ja heidän vieraitaan.",
      "- Pallo\n- Maila",
      "2\\. Asukkaan on huolehdittava siitä, että piha-alueet pidetään siisteinä ja roskat viedään."
    ].join("\n\n"));
  });

  it("AI ja haku saavat tekstin ilman muotoilumerkkejä", () => {
    assert.equal(markdownToPlain("## 1. Yleistä\n\nHinta **5 €** ja 2 \\* 3\n\n1. Eka\n  - alakohta\n\n1\\. teksti"),
      "1. Yleistä\n\nHinta 5 € ja 2 * 3\n\n1. Eka\n  - alakohta\n\n1. teksti");
  });
});

describe("dokumentin tekstin muokkaus", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
  });

  after(() => server.stop());

  it("luo uuden version, joka odottaa hyväksyntää ja säilyttää muotoilun", async () => {
    const query = new URLSearchParams({ fileName: "Pihaohje.txt", mimeType: "text/plain", title: "Pihaohje" });
    const response = await fetch(`${server.url}/api/companies/demo-company/knowledge/documents?${query}`, {
      method: "POST", headers: { Authorization: `Bearer ${admin}` },
      body: "PIHAOHJE\n\nPyörät säilytetään pyöräkellarissa.\n\nMattojen tamppaus on sallittu arkisin."
    });
    const { knowledgeId } = await response.json() as { knowledgeId: string };
    const detail = (await call(server, admin, "GET", `/knowledge/${knowledgeId}`)).data;
    assert.equal(detail.formatted, "## PIHAOHJE\n\nPyörät säilytetään pyöräkellarissa.\n\nMattojen tamppaus on sallittu arkisin.");

    const formatted = "## Pihaohje\n\nPyörät säilytetään **pyöräkellarissa**.\n\n1. Mattojen tamppaus on sallittu arkisin.\n2. Grillaus on kielletty.";
    assert.equal((await call(server, manager, "POST", `/knowledge/${knowledgeId}/text-version`, { formatted: "  " })).status, 400);
    assert.equal((await call(server, manager, "POST", `/knowledge/${knowledgeId}/text-version`, { formatted: detail.formatted })).status, 400);
    const service = await login(server, SERVICE_EMAIL);
    assert.equal((await call(server, service, "POST", `/knowledge/${knowledgeId}/text-version`, { formatted })).status, 403);

    const created = await call(server, manager, "POST", `/knowledge/${knowledgeId}/text-version`, { formatted });
    assert.equal(created.status, 201);
    const version = (await call(server, admin, "GET", `/knowledge/${created.data.knowledgeId}`)).data;
    assert.equal(version.status, "pending");
    assert.equal(version.version, 2);
    assert.equal(version.formatted, formatted);
    assert.equal(version.content, "Pihaohje\n\nPyörät säilytetään pyöräkellarissa.\n\n1. Mattojen tamppaus on sallittu arkisin.\n2. Grillaus on kielletty.");
    assert.equal((await call(server, admin, "GET", `/knowledge/${knowledgeId}`)).data.pending_version_id, version.id);

    // Alkuperäinen tiedosto on ladattavissa myös uudesta versiosta.
    const file = await fetch(`${server.url}/api/knowledge/${version.id}/file`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(file.status, 200);
    assert.match(await file.text(), /PIHAOHJE/);

    assert.equal((await call(server, admin, "GET", `/knowledge/${version.id}/comparison`)).data.state, "ready");
    assert.equal((await call(server, manager, "POST", `/knowledge/${version.id}/apply-version`, {})).status, 200);
    assert.equal((await call(server, admin, "GET", `/knowledge/${version.id}`)).data.status, "active");
  });
});
