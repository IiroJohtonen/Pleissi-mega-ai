import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { tempDir } from "./helpers.js";

// AI-luonnosten muokkausmittari ilman palvelinta: sanatason vertailu, muuttuneet kohdat, sävy/asia-luokittelu
// valepalvelimella ja aihekohtainen raja (99 % / 100 luonnosta).

let edits: typeof import("../src/ai-draft-edits.js");
let classifyDraftChange: typeof import("../src/ai.js").classifyDraftChange;
let db: typeof import("../src/db.js").db;
let claude: http.Server;
const requests: any[] = [];

describe("AI-luonnosten muokkausmittari", () => {
  before(async () => {
    claude = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const text = JSON.stringify(body.messages);
        const answer = text.includes("torstaina") ? { change: "fact", reason: "Päivä muuttui." } : { change: "tone", reason: "Vain sanamuoto." };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "msg", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify(answer) }],
          stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 }
        }));
      });
    });
    await new Promise<void>(resolve => claude.listen(0, "127.0.0.1", resolve));
    process.env.DATA_DIR = await tempDir("kotilo-drafts-");
    process.env.GMAIL_DISABLED = "1";
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(claude.address() as AddressInfo).port}`;
    ({ db } = await import("../src/db.js"));
    await import("../src/routes/tickets.js");
    edits = await import("../src/ai-draft-edits.js");
    ({ classifyDraftChange } = await import("../src/ai.js"));
  });

  after(async () => {
    await new Promise(resolve => claude.close(resolve));
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it("luokittelee muokkauksen sanatasolla", () => {
    const draft = "Hei, huolto käy korjaamassa hanan maanantaina. Ystävällisin terveisin";
    assert.equal(edits.classifyDraftEdit(edits.draftSimilarity(draft, draft)), "unchanged");
    assert.equal(edits.classifyDraftEdit(edits.draftSimilarity(draft, "hei! Huolto käy korjaamassa hanan maanantaina, ystävällisin terveisin")), "unchanged");
    assert.equal(edits.classifyDraftEdit(edits.draftSimilarity(draft, "Hei, huolto käy korjaamassa hanan maanantaina aamupäivällä. Ystävällisin terveisin")), "light");
    assert.equal(edits.classifyDraftEdit(edits.draftSimilarity(draft, "Hei, huolto ei ehdi tällä viikolla. Ystävällisin terveisin")), "heavy");
    assert.equal(edits.classifyDraftEdit(edits.draftSimilarity(draft, "Kiitos viestistä, selvitämme asian.")), "rewritten");
  });

  it("antaa vain muuttuneet kohdat", () => {
    assert.deepEqual(edits.changedParts("Huolto käy maanantaina klo 10.", "Huolto käy torstaina klo 10."), [{ removed: "maanantaina", added: "torstaina" }]);
    assert.deepEqual(edits.changedParts("Hei Matti, kiitos.", "Hei Matti, kiitos viestistä."), [{ removed: "", added: "viestistä." }]);
  });

  it("AI luokittelee eron sävyksi tai asiakorjaukseksi peitetyistä muutoksista", async () => {
    const fact = await classifyDraftChange(edits.changedParts("Huolto käy maanantaina.", "Huolto käy torstaina. Soita 040 123 4567."));
    assert.deepEqual(fact, { change: "fact", reason: "Päivä muuttui." });
    const sent = JSON.stringify(requests.at(-1).messages);
    assert.doesNotMatch(sent, /040 123 4567/, "puhelinnumero peitetään");
    assert.doesNotMatch(sent, /Huolto käy/, "muuttumaton teksti ei lähde AI:lle");
    assert.equal((await classifyDraftChange(edits.changedParts("Kiitos viestistä.", "Kiitos paljon viestistäsi.")))?.change, "tone");
    assert.equal(await classifyDraftChange([]), null, "ilman muutoksia AI:ta ei kutsuta");
  });

  it("aiheen raja täyttyy vasta 100 luonnoksella, joista 99 % sellaisenaan tai sävymuokattuna", () => {
    db.prepare("INSERT INTO companies (id, name, email_address) VALUES ('draft-company', 'As Oy Luonnos', 'luonnos@example.com')").run();
    const timestamp = new Date().toISOString();
    const addTicket = (ticketId: string, topic: string) => db.prepare(`
      INSERT INTO tickets (id, company_id, type, priority, status, subject, summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at, topic)
      VALUES (?, 'draft-company', 'Kysymys', 'normal', 'open', 'Sauna', 'Sauna', 'email', 'pending_decision', '', '', ?, ?, ?)
    `).run(ticketId, timestamp, timestamp, topic);
    const reply = (ticketId: string, details: Record<string, unknown>) =>
      db.prepare("INSERT INTO audit_log VALUES (?, ?, 'Hanna', 'reply_sent', ?, ?)").run(`audit-${ticketId}-${Math.random()}`, ticketId, JSON.stringify(details), timestamp);

    for (let index = 0; index < 99; index++) {
      addTicket(`sauna-${index}`, "sauna");
      reply(`sauna-${index}`, { ai_draft_edit: index % 3 ? "unchanged" : "light", ai_draft_change: "tone" });
    }
    let sauna = edits.draftTopicStats(["draft-company"]).find(item => item.topic === "sauna")!;
    assert.deepEqual([sauna.drafts, sauna.readyShare, sauna.ready], [99, 1, false], "alle 100 luonnosta");
    addTicket("sauna-99", "sauna");
    reply("sauna-99", { ai_draft_edit: "light", ai_draft_change: "tone" });
    sauna = edits.draftTopicStats(["draft-company"]).find(item => item.topic === "sauna")!;
    assert.equal(sauna.ready, true);

    // Kaksi asiakorjausta 101 luonnoksesta: 99/101 < 99 %.
    addTicket("sauna-100", "sauna");
    reply("sauna-100", { ai_draft_edit: "heavy", ai_draft_change: "fact" });
    reply("sauna-0", { ai_draft_edit: "rewritten" });
    sauna = edits.draftTopicStats(["draft-company"]).find(item => item.topic === "sauna")!;
    assert.deepEqual([sauna.drafts, sauna.fact, sauna.rewritten, sauna.ready], [102, 1, 1, false]);

    // Luokittelematon muokkaus ei kelpaa, eikä vastaus ilman AI-luonnosta ole luonnos.
    addTicket("pesula-1", "laundry");
    reply("pesula-1", { ai_draft_edit: "light" });
    reply("pesula-1", { to: "x@example.com" });
    db.prepare("INSERT INTO audit_log VALUES ('agent-1', 'pesula-1', 'ai', 'ai_agent_handover', '{}', ?)").run(timestamp);
    db.prepare("INSERT INTO audit_log VALUES ('agent-2', 'pesula-1', 'ai', 'ai_agent_replied', '{}', ?)").run(timestamp);
    const laundry = edits.draftTopicStats(["draft-company"]).find(item => item.topic === "laundry")!;
    assert.deepEqual([laundry.drafts, laundry.unclassified, laundry.readyShare], [1, 1, 0]);
    assert.deepEqual([laundry.agentRuns, laundry.handovers, laundry.handoverShare], [2, 1, 0.5], "siirrot seurataan erikseen");
  });

  it("lähetetty vastaus verrataan viimeisimpään AI-luonnokseen, ja luonnos tyhjennetään", () => {
    edits.rememberAiDraft("pesula-1", "Pesula on auki klo 8–21.");
    const comparison = edits.takeDraftComparison("pesula-1", "Pesula on auki klo 8–21.");
    assert.deepEqual([comparison?.edit, comparison?.similarity], ["unchanged", 1]);
    assert.equal(edits.takeDraftComparison("pesula-1", "Seuraava vastaus"), null);
  });
});
