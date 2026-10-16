import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, startServer, type TestServer } from "./helpers.js";

const DOCUMENT = [
  "Saunamaksu on 12 euroa kuukaudessa, ja vuoro varataan portaalista.",
  "Pyörät säilytetään pyöräkellarissa B-portaan alla."
].join("\n\n");

// Claude korvataan paikallisella palvelimella, joka pilkkoo dokumentin ennalta määrätyllä tavalla.
describe("dokumentin pilkonta AI:lla", () => {
  let server: TestServer;
  let claude: http.Server;
  let admin: string;
  const requests: any[] = [];
  let failing = false;

  before(async () => {
    claude = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        requests.push(body);
        if (failing || !JSON.stringify(body.system).includes("knowledge chunks")) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "testivirhe" } }));
          return;
        }
        const result = {
          chunks: [
            { title: "Saunamaksu", content: "Saunamaksu on 12 euroa kuukaudessa.", tags: ["sauna", "maksu"], page: 1, validUntil: "2026-12-31" },
            // Luku 15 ei ole dokumentissa: pala pitää tarkistaa.
            { title: "Pyöräkellari", content: "Pyörät säilytetään pyöräkellarissa, avain maksaa 15 euroa.", tags: ["pyörä", "fillari"], page: 1, validUntil: null }
          ]
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_test", type: "message", role: "assistant", model: body.model,
          content: [{ type: "text", text: JSON.stringify(result) }],
          stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
        }));
      });
    });
    await new Promise<void>(resolve => claude.listen(0, "127.0.0.1", resolve));
    const { port } = claude.address() as AddressInfo;
    server = await startServer({ env: { ANTHROPIC_API_KEY: "testiavain", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } });
    admin = await login(server, ADMIN_EMAIL);
  });

  after(async () => {
    await server.stop();
    await new Promise(resolve => claude.close(resolve));
  });

  async function upload(title: string) {
    const query = new URLSearchParams({ fileName: `${title}.txt`, mimeType: "text/plain", title });
    const response = await fetch(`${server.url}/api/companies/demo-company/knowledge/documents?${query}`, {
      method: "POST", headers: { Authorization: `Bearer ${admin}` }, body: DOCUMENT
    });
    assert.equal(response.status, 201);
    const knowledgeId = (await response.json()).knowledgeId as string;
    // Pilkonta jatkuu taustalla; odotetaan, että dokumentti on käsitelty.
    for (let attempt = 0; attempt < 100; attempt++) {
      const detail = (await call(server, admin, "GET", `/knowledge/${knowledgeId}`)).data;
      if (detail.processing_state === "ready") return { knowledgeId, detail };
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Dokumentin käsittely ei valmistunut");
  }

  it("AI pilkkoo dokumentin, ja keksitty luku merkitään tarkistettavaksi", async () => {
    const { knowledgeId, detail } = await upload("Asukasopas");
    const request = requests.at(-1);
    assert.equal(request.model, "claude-haiku-5-5");
    assert.deepEqual(request.system[0].cache_control, { type: "ephemeral" });
    assert.match(request.messages[0].content, /\[Sivu 1\]\nSaunamaksu on 12 euroa/);

    const chunks = (await call(server, admin, "GET", `/knowledge/${knowledgeId}/chunks`)).data as any[];
    assert.deepEqual(chunks.map(chunk => chunk.title), ["Saunamaksu", "Pyöräkellari"]);
    assert.ok(chunks.every(chunk => chunk.origin === "ai" && chunk.verified === 0));
    assert.deepEqual(chunks.map(chunk => chunk.needs_review), [0, 1]);
    assert.equal(chunks[1].tags, "pyörä, fillari");
    // Muun kuin PDF:n sivunumero jätetään pois.
    assert.equal(chunks[0].page, null);

    // AI:n ehdottama päättymispäivä on vain ehdotus.
    assert.equal(chunks[0].suggested_valid_until, "2026-12-31");
    assert.equal(detail.valid_until, null);

    const selected = (await call(server, admin, "POST", "/companies/demo-company/knowledge/test", { question: "Paljonko saunamaksu on?" })).data;
    assert.equal(selected.chunks[0].title, "Saunamaksu");
  });

  it("kun AI-kutsu epäonnistuu, dokumentti pilkotaan kappaleittain", async () => {
    failing = true;
    try {
      const { knowledgeId } = await upload("Asukasopas 2");
      const chunks = (await call(server, admin, "GET", `/knowledge/${knowledgeId}/chunks`)).data as any[];
      assert.equal(chunks.length, 2);
      assert.ok(chunks.every(chunk => chunk.origin === "local"));
      assert.match(chunks[1].content, /pyöräkellarissa B-portaan/);
    } finally {
      failing = false;
    }
  });
});
