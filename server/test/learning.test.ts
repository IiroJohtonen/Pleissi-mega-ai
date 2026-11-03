import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, inbound, login, MANAGER_EMAIL, startServer, type TestServer } from "./helpers.js";

// Oppiminen isännöitsijän vastauksista: luokitellut muistiehdotukset (osaamisaukot kärkeen), hyväksyntä
// dokumentaatioon taloyhtiölle tai koko toimistolle, vastaus dokumentaatioksi, ristiriitatarkistus,
// Tietopohja-haku, tarkistuspäivä, aukkoraportti ja vienti evaluoinnin testitapaukseksi. AI on valepalvelin.

describe("oppiminen ja Tietopohja", () => {
  let server: TestServer;
  let claude: http.Server;
  let admin: string;
  let manager: string;
  const requests: any[] = [];

  const reply = (body: any, result: unknown) => JSON.stringify({
    id: "msg", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify(result) }],
    stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
  });

  before(async () => {
    claude = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        requests.push(body);
        const system = JSON.stringify(body.system ?? "");
        const user = JSON.stringify(body.messages);
        res.writeHead(200, { "Content-Type": "application/json" });
        if (system.includes("long-term memory")) {
          res.end(reply(body, { notes: [
            { target: "documentation", title: "Pesutuvan avain", text: "Pesutuvan avain noudetaan huoltoyhtiöltä arkisin klo 8–16.", topic: null, stairwell: "", sources: [1], validMonths: null },
            { target: "memory", title: "", text: "B-portaan pumppu vaihdettiin 10/2026.", topic: null, stairwell: "B", sources: [2], validMonths: 12 },
            { target: "none", title: "", text: "Yksittäiselle asukkaalle myönnettiin poikkeus.", topic: null, stairwell: "", sources: [2], validMonths: null }
          ] }));
        } else if (system.includes("general instruction for the housing")) {
          res.end(reply(body, { title: "Saunavuoron peruutus", content: "Saunavuoron voi perua asukasportaalista viimeistään edellisenä päivänä." }));
        } else if (system.includes("check a new Finnish housing-company instruction")) {
          const ids = [...user.matchAll(/\[(chunk-[^\]]+)\]/g)].map(match => match[1]);
          res.end(reply(body, { conflicts: ids.length ? [{ id: ids[0], reason: "Eri aukioloaika." }, { id: "keksitty", reason: "x" }] : [] }));
        } else {
          res.writeHead(500);
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "tuntematon" } }));
        }
      });
    });
    await new Promise<void>(resolve => claude.listen(0, "127.0.0.1", resolve));
    server = await startServer({ env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(claude.address() as AddressInfo).port}` } });
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
  });

  after(async () => {
    await server.stop();
    await new Promise(resolve => claude.close(resolve));
  });

  const sqlite = (readonly = true) => new Database(path.join(server.dataDir, "kotilo.sqlite"), { readonly });

  it("osaamisaukon ratkaisu menee AI:lle ensimmäisenä, ja ehdotukset luokitellaan", async () => {
    const created = await inbound(server, admin, { companyId: "demo-company", senderName: "Matti", senderEmail: "matti@example.com", subject: "Pesutuvan avain", body: "Mistä saan pesutuvan avaimen?", channel: "email" });
    const ticketId = created.data.ticketId;
    const db = sqlite(false);
    try {
      const at = new Date(Date.now() - 60_000).toISOString();
      db.prepare("INSERT INTO knowledge_gaps (id, company_id, ticket_id, topic, question, created_at) VALUES ('gap-1', 'demo-company', ?, 'laundry', 'Mistä saa pesutuvan avaimen?', ?)").run(ticketId, at);
      db.prepare("INSERT INTO messages (id, ticket_id, direction, sender, subject, body, created_at, channel) VALUES ('answer-1', ?, 'outbound', 'Hanna Lehtonen', 'Re', 'Avain noudetaan huoltoyhtiöltä arkisin klo 8–16, soita 040 111 2222.', ?, 'email')")
        .run(ticketId, new Date().toISOString());
      db.prepare("UPDATE tickets SET resolution = 'Pumppu vaihdettu', resolution_at = ? WHERE id = (SELECT id FROM tickets WHERE id != ? AND sensitive = 0 LIMIT 1)").run(new Date().toISOString(), ticketId);
    } finally {
      db.close();
    }
    const proposed = await call(server, manager, "POST", "/companies/demo-company/memory/propose");
    assert.equal(proposed.status, 200, JSON.stringify(proposed.data));
    const sent = JSON.stringify(requests.at(-1).messages);
    assert.match(sent, /Resolved cases:\\n1\. \[KNOWLEDGE GAP\]/, "osaamisaukko ensimmäisenä");
    assert.doesNotMatch(sent, /040 111 2222/, "vastauksen puhelinnumero peitetään");

    const notes = (await call(server, manager, "GET", "/companies/demo-company/memory")).data.notes as any[];
    const proposals = notes.filter(note => note.status === "proposed");
    assert.equal(proposals[0].target, "documentation", "osaamisaukosta syntynyt ensin");
    assert.deepEqual(proposals.map(note => note.target).sort(), ["documentation", "memory", "none"]);
    assert.equal(proposals[0].gap, true);
    assert.equal(proposals[0].docTitle, "Pesutuvan avain");
    // Toinen haku ei käytä samaa osaamisaukkoa uudelleen.
    const db2 = sqlite();
    try {
      assert.ok((db2.prepare("SELECT proposed_at FROM knowledge_gaps WHERE id = 'gap-1'").get() as { proposed_at: string }).proposed_at);
    } finally {
      db2.close();
    }
  });

  it("dokumentaatioehdotus hyväksytään ohjeeksi; koko toimiston taso vaatii pääkäyttäjän; kertaluonteista ei tallenneta", async () => {
    const notes = (await call(server, manager, "GET", "/companies/demo-company/memory")).data.notes as any[];
    const doc = notes.find(note => note.target === "documentation");
    const none = notes.find(note => note.target === "none");
    const fields = (note: any) => ({ text: note.text, topic: note.topic, stairwell: note.stairwell, validUntil: note.validUntil });
    assert.equal((await call(server, manager, "PUT", `/memory/${none.id}`, { ...fields(none), status: "approved" })).status, 400);
    assert.equal((await call(server, manager, "PUT", `/memory/${none.id}`, { ...fields(none), status: "rejected" })).status, 200);
    assert.equal((await call(server, manager, "PUT", `/memory/${doc.id}`, { ...fields(doc), status: "approved", docTitle: "Pesutuvan avain", scope: "office" })).status, 403);
    const approved = await call(server, admin, "PUT", `/memory/${doc.id}`, { ...fields(doc), status: "approved", docTitle: "Pesutuvan avain", scope: "office" });
    assert.equal(approved.status, 200);
    assert.ok(approved.data.knowledgeId);

    // Toimistotason ohje näkyy toisen taloyhtiön AI-haussa, mutta ei mene muistiin.
    const other = (await call(server, admin, "POST", "/companies", { name: "As Oy Toinen", emailAddress: "toinen@example.com" })).data.companyId;
    const search = await call(server, admin, "POST", `/companies/${other}/knowledge/test`, { question: "pesutuvan avain" });
    assert.equal(search.status, 200);
    assert.match(JSON.stringify(search.data), /Pesutuvan avain noudetaan/);
    const db = sqlite();
    try {
      const knowledge = db.prepare("SELECT scope, kind, audience, review_at FROM knowledge WHERE id = ?").get(approved.data.knowledgeId) as any;
      assert.deepEqual([knowledge.scope, knowledge.kind, knowledge.audience], ["office", "fact", "ai"]);
      assert.ok(knowledge.review_at > new Date().toISOString().slice(0, 10), "tarkistuspäivä tulevaisuudessa");
    } finally {
      db.close();
    }
  });

  it("lähetetystä vastauksesta yleinen ohje, ristiriitatarkistus ja tallennus", async () => {
    const created = await inbound(server, admin, { companyId: "demo-company", senderName: "Liisa", senderEmail: "liisa@example.com", subject: "Saunavuoron peruutus", body: "Miten perun saunavuoron?", channel: "email" });
    const ticketId = created.data.ticketId;
    const db = sqlite(false);
    try {
      db.prepare("INSERT INTO messages (id, ticket_id, direction, sender, subject, body, created_at, channel) VALUES ('reply-guide', ?, 'outbound', 'Hanna Lehtonen', 'Re', 'Hei Liisa, voit perua vuoron portaalista. Soita 040 333 4444.', ?, 'email')")
        .run(ticketId, new Date().toISOString());
    } finally {
      db.close();
    }
    const draft = await call(server, manager, "POST", `/tickets/${ticketId}/messages/reply-guide/guide`);
    assert.equal(draft.status, 200);
    assert.equal(draft.data.title, "Saunavuoron peruutus");
    assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /040 333 4444/);
    assert.equal((await call(server, manager, "POST", `/tickets/${ticketId}/messages/ei-ole/guide`)).status, 404);

    const conflicts = await call(server, manager, "POST", "/companies/demo-company/knowledge-base/conflicts", { title: "Saunavuorot", content: "Sauna on avoinna klo 16–22." });
    assert.equal(conflicts.status, 200);
    assert.equal(conflicts.data.checked, true);
    assert.equal(conflicts.data.conflicts.length, 1, "tuntematon tunniste pudotetaan");
    assert.equal(conflicts.data.conflicts[0].reason, "Eri aukioloaika.");

    const saved = await call(server, manager, "POST", "/companies/demo-company/knowledge-base/guides", { ...draft.data, scope: "company", ticketId });
    assert.equal(saved.status, 201);
    assert.equal((await call(server, manager, "POST", "/companies/demo-company/knowledge-base/guides", { ...draft.data, scope: "office" })).status, 403);
    const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.ok(detail.audit.some((entry: any) => entry.action === "guide_saved"));
  });

  it("Tietopohja palauttaa muistin ja dokumentaation tyyppimerkinnällä; tarkistuspäivä päivittyy", async () => {
    const notes = (await call(server, manager, "GET", "/companies/demo-company/memory")).data.notes as any[];
    const memory = notes.find(note => note.target === "memory");
    await call(server, manager, "PUT", `/memory/${memory.id}`, { text: memory.text, topic: memory.topic, stairwell: memory.stairwell, validUntil: memory.validUntil, status: "approved" });

    const all = (await call(server, manager, "GET", "/companies/demo-company/knowledge-base")).data.items as any[];
    assert.ok(all.some(item => item.type === "memory" && item.text.includes("pumppu")));
    assert.ok(all.some(item => item.type === "documentation" && item.title === "Saunavuoron peruutus"));
    const onlyMemory = (await call(server, manager, "GET", "/companies/demo-company/knowledge-base?type=memory")).data.items as any[];
    assert.ok(onlyMemory.every(item => item.type === "memory"));
    const found = (await call(server, manager, "GET", "/companies/demo-company/knowledge-base?q=pesutuvan%20avain")).data.items as any[];
    assert.ok(found.some(item => item.type === "documentation" && item.scope === "office"));

    const guide = all.find(item => item.title === "Saunavuoron peruutus");
    const changed = await call(server, manager, "PUT", `/knowledge/${guide.knowledgeId}/review`, { reviewAt: "2027-01-15" });
    assert.equal(changed.data.reviewAt, "2027-01-15");
    const reviewed = await call(server, manager, "PUT", `/knowledge/${guide.knowledgeId}/review`, { reviewed: true });
    assert.ok(reviewed.data.reviewAt > "2027-01-15");
  });

  it("aukkoraportti ja opitun tiedon vienti testitapaukseksi", async () => {
    const report = (await call(server, manager, "GET", "/reports/knowledge-gaps?companyId=demo-company")).data;
    assert.equal(report.topics[0].topic, "laundry");
    assert.equal(report.topics[0].questions[0].question, "Mistä saa pesutuvan avaimen?");

    const notes = (await call(server, manager, "GET", "/companies/demo-company/memory")).data.notes as any[];
    const doc = notes.find(note => note.target === "documentation");
    const exported = await call(server, manager, "GET", `/memory/${doc.id}/eval-case`);
    assert.equal(exported.status, 200);
    assert.equal(exported.data.feature, "suggest");
    assert.equal(exported.data.input.subject, "Mistä saa pesutuvan avaimen?");
    assert.deepEqual(exported.data.expected.source, [exported.data.input.knowledge[0].id]);
    const rejected = notes.find(note => note.target === "none");
    assert.equal((await call(server, manager, "GET", `/memory/${rejected.id}/eval-case`)).status, 404);
  });
});
