import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { tempDir } from "./helpers.js";

// Merkityshaun testit ilman mallia: embed() korvataan deterministisellä valetoteutuksella, jossa
// synonyymit ("löylyhuone" ~ "sauna", "kylmä" ~ "lämpenee") saavat saman vektorin osan. Samat testit ajetaan
// sqlite-vec-indeksillä ja muistivertailulla (embedding.test.ts ja embedding-fallback.test.ts).

const SYNONYMS: Record<string, string> = {
  löylyhuone: "sauna", löylyhuoneessa: "sauna", saunassa: "sauna", saunan: "sauna",
  kylmä: "lämpö", kylmänä: "lämpö", lämpene: "lämpö", lämpenee: "lämpö", lämmin: "lämpö",
  vuotaa: "vuoto", tippuu: "vuoto", vuoto: "vuoto", vesivuoto: "vuoto"
};
let embedCalls = 0;

function fakeVector(text: string): number[] {
  const vector = new Array<number>(384).fill(0);
  for (const word of text.toLowerCase().match(/[a-zåäö0-9]+/g) ?? []) {
    if (word.length < 3 || word === "query" || word === "passage") continue;
    const token = SYNONYMS[word] ?? word.slice(0, 6);
    const digest = crypto.createHash("sha256").update(token).digest();
    vector[digest.readUInt16BE(0) % 384] += 1;
  }
  const length = Math.hypot(...vector) || 1;
  return vector.map(value => value / length);
}

export function embeddingSuite(name: string, env: Record<string, string>) {
  describe(name, () => {
    let db: typeof import("../src/db.js").db;
    let embedding: typeof import("../src/embedding.js");
    let chunks: typeof import("../src/knowledge-chunks.js");
    let similar: typeof import("../src/similar-tickets.js");
    let sensitivity: typeof import("../src/ticket-sensitivity.js");
    let erasure: typeof import("../src/resident-erasure.js");
    let masterData: typeof import("../src/master-data.js");
    let suggestReply: typeof import("../src/ai.js").suggestReply;
    let fakeClaude: http.Server;
    const requests: string[] = [];
    let seq = 0;

    before(async () => {
      fakeClaude = http.createServer((req, res) => {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          requests.push(body);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5",
            content: [{ type: "text", text: JSON.stringify({ draft: "Hei, katsomme asian.", reason: "Luonnos.", sourceId: null }) }],
            stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
          }));
        });
      });
      await new Promise<void>(resolve => fakeClaude.listen(0, "127.0.0.1", resolve));
      Object.assign(process.env, {
        DATA_DIR: await tempDir("kotilo-embedding-"), GMAIL_DISABLED: "1", INITIAL_PASSWORD: "Testi-salasana1",
        ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(fakeClaude.address() as AddressInfo).port}`,
        EMBEDDING_MIN_SIMILARITY: "0.3", ...env
      });
      delete process.env.EMBEDDING_ENABLED;
      ({ db } = await import("../src/db.js"));
      embedding = await import("../src/embedding.js");
      chunks = await import("../src/knowledge-chunks.js");
      similar = await import("../src/similar-tickets.js");
      sensitivity = await import("../src/ticket-sensitivity.js");
      erasure = await import("../src/resident-erasure.js");
      masterData = await import("../src/master-data.js");
      ({ suggestReply } = await import("../src/ai.js"));
      embedding.setEmbedderForTests(async texts => {
        embedCalls += texts.length;
        return texts.map(fakeVector);
      });
      for (const company of ["company-a", "company-b"]) {
        db.prepare("INSERT INTO companies (id, name, email_address) VALUES (?, ?, ?)").run(company, `As Oy ${company}`, `${company}@example.com`);
        db.prepare("INSERT INTO apartments (id, company_id, apartment_number, address) VALUES (?, ?, ?, ?)").run(`apt-${company}`, company, "A 12", "Testitie 1");
      }
      db.prepare("INSERT INTO residents (id, company_id, apartment_id, name, email) VALUES (?, ?, ?, ?, ?)")
        .run("resident-liisa", "company-a", "apt-company-a", "Liisa Mattila", "liisa@example.com");
    });

    after(() => {
      embedding.setEmbedderForTests(null);
      fakeClaude.close();
    });

    const setGlobal = (similarTickets: boolean, hybridKnowledge: boolean) =>
      masterData.saveMasterData({ embedding: { similarTickets, hybridKnowledge } });

    function addDocument(companyId: string, title: string, paragraphs: string[], audience = "ai") {
      const knowledgeId = `knowledge-${++seq}`;
      db.prepare(`INSERT INTO knowledge (id, company_id, title, content, kind, status, audience, extraction_ok, created_at)
        VALUES (?, ?, ?, ?, 'document', 'active', ?, 1, ?)`).run(knowledgeId, companyId, title, paragraphs.join("\n\n"), audience, new Date().toISOString());
      chunks.saveChunks({ id: knowledgeId, company_id: companyId, status: "active" }, paragraphs.map(content => ({ title: content.slice(0, 30), content, origin: "local" })));
      return knowledgeId;
    }

    function addResolvedTicket(companyId: string, subject: string, body: string, reply: string, residentId: string | null = null) {
      const ticketId = `ticket-emb-${++seq}`;
      const at = new Date(Date.now() - 86_400_000).toISOString();
      db.prepare(`INSERT INTO tickets (id, company_id, apartment_id, resident_id, type, priority, status, subject, summary, source_channel,
        ai_action, ai_reason, draft, created_at, updated_at) VALUES (?, ?, ?, ?, 'Vikailmoitus', 'normal', 'closed', ?, '', 'email', 'human', '', '', ?, ?)`)
        .run(ticketId, companyId, `apt-${companyId}`, residentId, subject, at, at);
      db.prepare("INSERT INTO messages VALUES (?, ?, 'inbound', ?, ?, ?, ?, 'email')")
        .run(`m-${++seq}`, ticketId, residentId ? "Liisa Mattila <liisa@example.com>" : "Asukas <asukas@example.com>", subject, body, at);
      db.prepare("INSERT INTO messages VALUES (?, ?, 'outbound', 'Hanna Isännöitsijä', ?, ?, ?, 'email')")
        .run(`m-${++seq}`, ticketId, subject, reply, at);
      return ticketId;
    }

    const vectorCount = (sourceType: string, sourceId: string) =>
      (db.prepare("SELECT COUNT(*) AS count FROM embeddings WHERE source_type = ? AND source_id = ?").get(sourceType, sourceId) as { count: number }).count;
    const vecRows = () => embedding.vectorBackend() === "sqlite-vec"
      ? (db.prepare("SELECT COUNT(*) AS count FROM vec_embeddings").get() as { count: number }).count
      : (db.prepare("SELECT COUNT(*) AS count FROM embeddings").get() as { count: number }).count;

    it("on oletuksena pois: vektoreita ei lasketa eikä haku muutu", async () => {
      addDocument("company-a", "Saunasäännöt", ["Jos sauna ei lämpene, ilmoita huoltoyhtiölle.", "Saunavuoro varataan portaalista."]);
      const result = await embedding.indexEmbeddings();
      assert.equal(result.embedded, 0);
      assert.deepEqual(await chunks.searchKnowledgeChunks("company-a", "löylyhuone kylmä"), chunks.selectKnowledgeChunks("company-a", "löylyhuone kylmä"));
      assert.deepEqual(await similar.selectSimilarTickets("company-a", "hana vuotaa"), []);
    });

    it("taloyhtiön ohitus kytkee toiminnon vain sille, ja hätäkatkaisin ohittaa kaiken", async () => {
      embedding.setCompanyOverride("company-a", "hybridKnowledge", true);
      assert.equal(embedding.embeddingEnabled("company-a", "hybridKnowledge"), true);
      assert.equal(embedding.embeddingEnabled("company-b", "hybridKnowledge"), false);
      addDocument("company-b", "Saunasäännöt", ["Jos sauna ei lämpene, ilmoita huoltoyhtiölle."]);
      await embedding.indexEmbeddings();
      const companies = (db.prepare("SELECT DISTINCT company_id FROM embeddings").all() as { company_id: string }[]).map(row => row.company_id);
      assert.deepEqual(companies, ["company-a"]);

      process.env.EMBEDDING_ENABLED = "false";
      try {
        assert.equal(embedding.embeddingEnabled("company-a", "hybridKnowledge"), false);
        assert.equal(embedding.scheduleEmbeddingIndex(), null);
      } finally {
        delete process.env.EMBEDDING_ENABLED;
      }
    });

    it("hybridihaku löytää synonyymillä kysytyn palan, jota sanahaku ei löydä", async () => {
      const byWords = chunks.selectKnowledgeChunks("company-a", "löylyhuone kylmä");
      assert.equal(byWords.length, 0);
      const hybrid = await chunks.searchKnowledgeChunks("company-a", "löylyhuone kylmä");
      assert.match(hybrid[0].content, /sauna ei lämpene/);
      // Sanahaun osumat säilyvät hybridissä.
      const exact = await chunks.searchKnowledgeChunks("company-a", "saunavuoro varataan");
      assert.ok(exact.some(chunk => chunk.content.startsWith("Saunavuoro varataan")));
    });

    it("sisäistä dokumentaatiota ei vektoroida eikä palauteta", async () => {
      const internal = addDocument("company-a", "Sisäinen ohje", ["Saunan termostaatti on kellarissa."], "internal");
      await embedding.indexEmbeddings();
      const chunkIds = (db.prepare("SELECT id FROM knowledge_chunks WHERE knowledge_id = ?").all(internal) as { id: string }[]).map(row => row.id);
      assert.ok(chunkIds.every(chunkId => vectorCount("chunk", chunkId) === 0));
    });

    it("text_hash estää turhan uudelleenlaskennan, ja muuttunut teksti lasketaan uudelleen", async () => {
      await embedding.indexEmbeddings();
      const calls = embedCalls;
      assert.equal((await embedding.indexEmbeddings()).embedded, 0);
      assert.equal(embedCalls, calls);
      const chunkId = (db.prepare("SELECT id FROM knowledge_chunks WHERE company_id = 'company-a' AND status = 'active' LIMIT 1").get() as { id: string }).id;
      db.prepare("UPDATE knowledge_chunks SET content = content || ' Lisätty lause.' WHERE id = ?").run(chunkId);
      assert.equal((await embedding.indexEmbeddings()).embedded, 1);
    });

    it("mallin versio tallentuu malliavaimeen, ja versiomuutos laskee vektorit uudelleen", async () => {
      await embedding.indexEmbeddings();
      const models = () => (db.prepare("SELECT DISTINCT model FROM embeddings").all() as { model: string }[]).map(row => row.model);
      assert.deepEqual(models(), [`${embedding.embeddingModel()}@${embedding.embeddingRevision()}`]);
      const count = (db.prepare("SELECT COUNT(*) AS count FROM embeddings").get() as { count: number }).count;
      process.env.EMBEDDING_MODEL_REVISION = "uusi-versio";
      try {
        assert.equal((await embedding.indexEmbeddings()).embedded, count);
        assert.deepEqual(models(), [`${embedding.embeddingModel()}@uusi-versio`]);
        assert.ok((await chunks.searchKnowledgeChunks("company-a", "löylyhuone kylmä")).length > 0, "uuden version vektorit käytössä");
      } finally {
        delete process.env.EMBEDDING_MODEL_REVISION;
      }
      await embedding.indexEmbeddings();
    });

    it("arkistoidun ja poistetun palan vektori poistuu samassa transaktiossa", async () => {
      const knowledgeId = addDocument("company-a", "Pyykkitupa", ["Pyykkituvan kone pitää puhdistaa käytön jälkeen."]);
      await embedding.indexEmbeddings();
      const chunkId = (db.prepare("SELECT id FROM knowledge_chunks WHERE knowledge_id = ?").get(knowledgeId) as { id: string }).id;
      assert.equal(vectorCount("chunk", chunkId), 1);
      const before = vecRows();
      chunks.setChunksStatus(knowledgeId, "archived");
      assert.equal(vectorCount("chunk", chunkId), 0);
      assert.equal(vecRows(), before - 1, "myös hakuindeksistä");
      await embedding.indexEmbeddings();
      assert.equal(vectorCount("chunk", chunkId), 0, "ei lasketa uudelleen");

      const replaced = addDocument("company-a", "Avaimet", ["Lisäavaimen voi tilata isännöitsijältä."]);
      await embedding.indexEmbeddings();
      const oldChunk = (db.prepare("SELECT id FROM knowledge_chunks WHERE knowledge_id = ?").get(replaced) as { id: string }).id;
      chunks.saveChunks({ id: replaced, company_id: "company-a", status: "active" }, [{ title: "Avaimet", content: "Avaimet tilataan portaalista.", origin: "local" }]);
      assert.equal(vectorCount("chunk", oldChunk), 0, "uuden pilkonnan korvaama pala");
    });

    it("aiemmat tehtävät: vain saman taloyhtiön ratkaistut tehtävät, peitettyinä ja ohjeen kera", async () => {
      embedding.setCompanyOverride("company-a", "similarTickets", true);
      embedding.setCompanyOverride("company-b", "similarTickets", true);
      const ownTicket = addResolvedTicket("company-a", "Keittiön hana", "Keittiön hana tippuu. Soita 040 123 4567, terveisin Liisa Mattila",
        "Hei Liisa, huoltomies vaihtoi tiivisteen. Terveisin Hanna Isännöitsijä", "resident-liisa");
      const otherCompany = addResolvedTicket("company-b", "Keittiön hana", "Keittiön hana tippuu.", "Toisen taloyhtiön vastaus.");
      await embedding.indexEmbeddings();
      assert.equal(vectorCount("ticket", otherCompany), 1);

      const examples = await similar.selectSimilarTickets("company-a", "Kylpyhuoneen hana vuotaa");
      assert.deepEqual(examples.map(example => example.ticketId), [ownTicket]);
      const [example] = examples;
      assert.ok(!/Liisa|Mattila|Hanna|040 123/.test(JSON.stringify(example)), JSON.stringify(example));
      assert.match(example.message, /\[puhelin\]/);
      assert.match(example.reply, /\[asukas\]/);
      assert.deepEqual(await similar.selectSimilarTickets("company-a", "Kylpyhuoneen hana vuotaa", 3, ownTicket), [], "nykyinen tehtävä ei ole oma esimerkkinsä");
      assert.ok(!(await embedding.searchSimilar("company-a", "ticket", "Keittiön hana tippuu", 10)).some(item => item.sourceId === otherCompany));

      await suggestReply("Hana vuotaa", "Hana vuotaa", [], "", { examples });
      assert.match(requests.at(-1)!, /Earlier resolved tickets/);
      assert.match(requests.at(-1)!, /Never take facts from them/);
      await suggestReply("Hana vuotaa", "Hana vuotaa", [], "", {});
      assert.doesNotMatch(requests.at(-1)!, /Earlier resolved tickets/, "ilman esimerkkejä viesti ei muutu");
    });

    it("arkaluonteiseksi merkityn tehtävän vektori poistuu, eikä sitä lasketa uudelleen", async () => {
      const manual = addResolvedTicket("company-a", "Ovikello", "Ovikello ei soi.", "Ovikello on osakkaan vastuulla.");
      const keywords = addResolvedTicket("company-a", "Avustaja", "Ovikello ei soi.", "Selvitämme.");
      await embedding.indexEmbeddings();
      assert.equal(vectorCount("ticket", manual), 1);
      sensitivity.setSensitivity(manual, true, "Testi");
      assert.equal(vectorCount("ticket", manual), 0);
      sensitivity.detectSensitivity(keywords, "Olen sairaalassa enkä kuule ovikelloa.");
      assert.equal(vectorCount("ticket", keywords), 0);
      await embedding.indexEmbeddings();
      assert.equal(vectorCount("ticket", manual) + vectorCount("ticket", keywords), 0);
    });

    it("asukkaan tietojen poisto poistaa tehtävän vektorin samassa transaktiossa", async () => {
      const ticketId = addResolvedTicket("company-a", "Parveke", "Parvekkeen ovi ei sulkeudu.", "Huolto korjasi saranan.", "resident-liisa");
      await embedding.indexEmbeddings();
      assert.equal(vectorCount("ticket", ticketId), 1);
      db.transaction(() => erasure.eraseResidentFromTicket(ticketId, { id: "resident-liisa", name: "Liisa Mattila", email: "liisa@example.com" }))();
      assert.equal(vectorCount("ticket", ticketId), 0);
      await embedding.indexEmbeddings();
      assert.equal(vectorCount("ticket", ticketId), 0, "anonymisoitua tehtävää ei vektoroida uudelleen");
      assert.equal(embedding.ERASED_MARK, erasure.ERASED_TEXT);
    });

    it("hyväksytty muistitieto vektoroidaan, hylätty poistetaan", async () => {
      const at = new Date().toISOString();
      db.prepare("INSERT INTO company_memory (id, company_id, text, status, created_at, updated_at) VALUES (?, ?, ?, 'approved', ?, ?)")
        .run("memory-1", "company-a", "B-portaan lämmityslinjan pumppu vaihdettiin.", at, at);
      await embedding.indexEmbeddings();
      assert.equal(vectorCount("memory", "memory-1"), 1);
      db.prepare("UPDATE company_memory SET status = 'rejected' WHERE id = 'memory-1'").run();
      await embedding.indexEmbeddings();
      assert.equal(vectorCount("memory", "memory-1"), 0);
    });

    it("kun toiminto kytketään pois, taloyhtiön vektorit poistetaan", async () => {
      embedding.setCompanyOverride("company-b", "similarTickets", null);
      setGlobal(false, false);
      await embedding.indexEmbeddings();
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM embeddings WHERE company_id = 'company-b'").get() as { count: number }).count, 0);
      assert.ok((db.prepare("SELECT COUNT(*) AS count FROM embeddings WHERE company_id = 'company-a'").get() as { count: number }).count > 0);
    });

    it("Reciprocal Rank Fusion suosii kummassakin listassa korkealla olevia", () => {
      assert.deepEqual(embedding.reciprocalRankFusion([["a", "b", "c"], ["c", "a", "d"]]), ["a", "c", "b", "d"]);
    });
  });
}
