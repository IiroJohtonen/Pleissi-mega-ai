import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { after, before, describe, it } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdfBatches } from "../src/extract.js";
import { ADMIN_EMAIL, call, login, startServer, type TestServer } from "./helpers.js";

// PDF menee pilkonnassa AI:lle sellaisenaan (document-lohkona) erissä: skannattu PDF ei jää tyhjäksi,
// sivunumerot säilyvät alkuperäisinä, ja taulukko- ja kuvapalat merkitään tarkistettaviksi.

async function makePdf(pages: number, text: string | null) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index++) {
    const page = document.addPage([300, 300]);
    // Skannattua PDF:ää vastaa sivu, jossa ei ole tekstikerrosta.
    if (text) page.drawText(`${text} ${index + 1}`, { x: 20, y: 250, size: 12, font });
  }
  return Buffer.from(await document.save());
}

describe("PDF:n luku AI:lla", () => {
  let server: TestServer;
  let claude: http.Server;
  let admin: string;
  const requests: any[] = [];

  before(async () => {
    claude = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", async () => {
        const body = JSON.parse(raw || "{}");
        requests.push(body);
        const content = body.messages[0].content;
        const document = Array.isArray(content) ? content.find((block: any) => block.type === "document") : null;
        if (!document) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "odotettiin PDF:ää" } }));
          return;
        }
        const pages = (await PDFDocument.load(Buffer.from(document.source.data, "base64"))).getPageCount();
        const first = Number(/its first page is page (\d+)/.exec(JSON.stringify(content))![1]);
        const chunks = [
          { title: `Teksti s. ${first}`, content: "Pyörät säilytetään pyöräkellarissa.", tags: ["pyörä"], page: first, validUntil: null, kind: "text" },
          { title: "Saunamaksut", content: "| Vuoro | Hinta |\n| --- | --- |\n| Kerta | 5 € |", tags: ["sauna"], page: first + pages - 1, validUntil: null, kind: "table" },
          { title: "Pihakartta", content: "Kartta näyttää jätekatoksen sijainnin pihan pohjoispäässä.", tags: ["piha"], page: 999, validUntil: null, kind: "image" }
        ];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_pdf", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify({ chunks }) }],
          stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
        }));
      });
    });
    await new Promise<void>(resolve => claude.listen(0, "127.0.0.1", resolve));
    server = await startServer({ env: { ANTHROPIC_API_KEY: "testiavain", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(claude.address() as AddressInfo).port}` } });
    admin = await login(server, ADMIN_EMAIL);
  });

  after(async () => {
    await server.stop();
    await new Promise(resolve => claude.close(resolve));
  });

  async function upload(title: string, pdf: Buffer) {
    const query = new URLSearchParams({ fileName: `${title}.pdf`, mimeType: "application/pdf", title });
    const response = await fetch(`${server.url}/api/companies/demo-company/knowledge/documents?${query}`, {
      method: "POST", headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/octet-stream" }, body: new Uint8Array(pdf)
    });
    assert.equal(response.status, 201);
    const knowledgeId = (await response.json()).knowledgeId as string;
    for (let attempt = 0; attempt < 100; attempt++) {
      const detail = (await call(server, admin, "GET", `/knowledge/${knowledgeId}`)).data;
      if (detail.processing_state === "ready" || detail.processing_state === "failed") return { knowledgeId, detail };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Dokumentin käsittely ei valmistunut");
  }

  it("jakaa pitkän PDF:n eriin, jotka säilyttävät alkuperäiset sivunumerot", async () => {
    const batches = await pdfBatches(await makePdf(25, "Sivu"), 10);
    assert.deepEqual(batches.map(batch => [batch.firstPage, batch.lastPage]), [[1, 10], [11, 20], [21, 25]]);
    for (const batch of batches) {
      assert.equal((await PDFDocument.load(batch.data)).getPageCount(), batch.lastPage - batch.firstPage + 1);
    }
    assert.equal((await pdfBatches(await makePdf(3, "Sivu"), 10)).length, 1);
  });

  it("skannattu PDF luetaan AI:lla erissä, ja taulukko- ja kuvapalat merkitään tarkistettaviksi", async () => {
    const { knowledgeId, detail } = await upload("Skannattu järjestyssääntö", await makePdf(12, null));
    assert.equal(detail.processing_state, "ready", "skannattu PDF ei jää tyhjäksi");
    const pdfRequests = requests.filter(request => Array.isArray(request.messages[0].content));
    assert.equal(pdfRequests.length, 2, "12 sivua lähtee kahdessa erässä");
    assert.match(JSON.stringify(pdfRequests[1].messages[0].content), /pages 11–12/);

    const db = new Database(path.join(server.dataDir, "kotilo.sqlite"), { readonly: true });
    try {
      const active = db.prepare("SELECT title, page, content, needs_review FROM knowledge_chunks WHERE knowledge_id = ? AND status = 'active'")
        .all(knowledgeId) as { title: string; page: number; content: string; needs_review: number }[];
      assert.deepEqual(active.map(chunk => `${chunk.title}@${chunk.page}`).sort(), [
        "Pihakartta@1", "Pihakartta@11", "Saunamaksut@10", "Saunamaksut@12", "Teksti s. 1@1", "Teksti s. 11@11"
      ].sort(), "sivu säilyy; erän ulkopuolinen sivu korjataan erän ensimmäiseksi");
      assert.ok(active.filter(chunk => chunk.title !== "Teksti s. 1" && chunk.title !== "Teksti s. 11").every(chunk => chunk.needs_review === 1));
      assert.match(active.find(chunk => chunk.title === "Saunamaksut")!.content, /\| Vuoro \| Hinta \|/);
    } finally {
      db.close();
    }

    const stored = new Database(path.join(server.dataDir, "kotilo.sqlite"), { readonly: true });
    try {
      const knowledge = stored.prepare("SELECT content, extraction_ok FROM knowledge WHERE id = ?").get(knowledgeId) as { content: string; extraction_ok: number };
      assert.equal(knowledge.extraction_ok, 1);
      assert.match(knowledge.content, /Pyörät säilytetään/);
      // Lokiin ei tallenneta PDF:n sisältöä.
      const logged = (stored.prepare("SELECT payload FROM ai_requests WHERE feature = 'chunking'").all() as { payload: string }[]).map(row => row.payload).join("");
      assert.doesNotMatch(logged, /JVBER/);
      assert.match(logged, /PDF, sivut 1–10/);
    } finally {
      stored.close();
    }
  });
});
