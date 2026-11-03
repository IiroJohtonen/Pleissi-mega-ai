import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, inbound, login, PASSWORD, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

// AI-reseptionisti: automaattinen käynnistys taloyhtiöittäin, luonnostila, dokumentaatiovastaus vain tarkistetulla
// lainauksella, täydennä-pyyntö, kiellettyjen aiheiden erillinen luokittelu ja aiheiden autonomia. Claude
// korvataan paikallisella palvelimella, joka vastaa käsikirjoituksen mukaan.

type Body = { system?: unknown; tools?: unknown[]; messages: { role: string; content: string | { type: string; content?: unknown; text?: string }[] }[] };

const QUOTE = "Saunavuoron voi perua maksutta viimeistään kaksi tuntia ennen vuoron alkua.";

describe("AI-reseptionisti", () => {
  let server: TestServer;
  let claude: http.Server;
  let admin: string;
  let service: string;
  const requests: Body[] = [];
  let chunkId = "";

  // Agentin seuraava työkalukutsu tehtävän ensimmäisen viestin ja edellisen työkalun tuloksen mukaan.
  function agentStep(first: string, lastResult: string): { name: string; input: Record<string, unknown> } | null {
    if (lastResult) return null;
    if (first.includes("perua saunavuoron")) {
      return first.includes("[keksitty]")
        ? { name: "answer_from_documentation", input: { message: "Voit perua milloin vain.", chunk_id: chunkId, quote: "Saunavuoron voi perua milloin tahansa ilman maksua." } }
        : { name: "answer_from_documentation", input: { message: "Voit perua vuoron maksutta kaksi tuntia ennen.", chunk_id: chunkId, quote: QUOTE } };
    }
    if (first.includes("lattiakaivo")) {
      return { name: "ask_resident_for_details", input: { message: "Kertoisitko, milloin haju alkoi ja koskeeko se naapureita?", missing: ["started_when", "affects_neighbours"] } };
    }
    return { name: "hand_over_to_staff", input: { reason: "Ei agentin asia." } };
  }

  before(async () => {
    claude = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Body;
        requests.push(body);
        const text = (content: Body["messages"][number]["content"]) =>
          typeof content === "string" ? content : content.map(block => block.text ?? (typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""))).join("\n");
        const first = text(body.messages[0].content);
        const reply = (content: unknown[], stop: string) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: `msg_${requests.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", content,
            stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
          }));
        };
        if (JSON.stringify(body.system ?? "").includes("screen a Finnish housing-company ticket")) {
          const category = /korvau/i.test(first) ? "compensation" : "none";
          reply([{ type: "text", text: JSON.stringify({ category, reason: category === "none" ? "" : "Asukas vaatii korvausta." }) }], "end_turn");
          return;
        }
        const last = body.messages[body.messages.length - 1];
        const lastResult = last.role === "user" && typeof last.content !== "string" && last.content.some(block => block.type === "tool_result") ? text(last.content) : "";
        const step = agentStep(first, lastResult);
        reply(step ? [{ type: "tool_use", id: `toolu_${requests.length}`, name: step.name, input: step.input }] : [{ type: "text", text: "Valmis." }],
          step ? "tool_use" : "end_turn");
      });
    });
    await new Promise<void>(resolve => claude.listen(0, "127.0.0.1", resolve));
    const { port } = claude.address() as AddressInfo;
    server = await startServer({ env: { ANTHROPIC_API_KEY: "testiavain", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } });
    admin = await login(server, ADMIN_EMAIL);
    service = await login(server, SERVICE_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-1", {
      name: "Matti Meikäläinen", email: "matti@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12", password: PASSWORD
    });
    const fact = await call(server, admin, "POST", "/companies/demo-company/knowledge/facts", {
      question: "Miten saunavuoron voi perua?", answer: QUOTE
    });
    assert.equal(fact.status, 201);
    chunkId = ((await call(server, admin, "GET", `/knowledge/${fact.data.knowledgeId}/chunks`)).data as { id: string }[])[0].id;
  });

  after(async () => {
    await server.stop();
    await new Promise(resolve => claude.close(resolve));
  });

  let messageNumber = 0;
  async function receive(subject: string, body: string, threadOf?: string) {
    const sourceMessageId = `viesti-${++messageNumber}`;
    const created = await inbound(server, admin, {
      companyId: "demo-company", senderName: "Matti", senderEmail: "matti@example.com", subject, body, channel: "email",
      sourceMessageId, ...(threadOf ? { threadMessageIds: [threadOf] } : {})
    });
    assert.equal(created.status, 201);
    return { ticketId: created.data.ticketId as string, sourceMessageId };
  }

  // Taustalla käynnistyvä agentti: odotetaan, kunnes lokissa on haluttu merkintä.
  async function waitFor(ticketId: string, action: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
      if ((detail.audit as any[]).some(entry => entry.action === action)) return detail;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.fail(`Merkintää ${action} ei tullut: ${JSON.stringify({ topic: detail.ticket.topic, audit: (detail.audit as any[]).map(entry => [entry.action, entry.details]) })}`);
  }

  it("automaattinen käynnistys on oletuksena pois; vain pääkäyttäjä muuttaa asetuksia", async () => {
    const settings = (await call(server, admin, "GET", "/agent/settings")).data;
    assert.equal(settings.autoStart, false);
    // Agentin nimi allekirjoituksessa: oletus Aino, pääkäyttäjä voi vaihtaa.
    assert.equal(settings.agentName, "Aino");
    assert.match(settings.signature, /Aino, tekoälyavustaja[^]*kirjoitti tekoäly/);
    const renamed = await call(server, admin, "PUT", "/agent/settings", { agentName: "Pleissi-Pete" });
    assert.match(renamed.data.signature, /Pleissi-Pete, tekoälyavustaja/);
    assert.equal((await call(server, admin, "PUT", "/agent/settings", { agentName: "" })).status, 400);
    await call(server, admin, "PUT", "/agent/settings", { agentName: "Aino" });
    assert.equal((await call(server, service, "GET", "/agent/settings")).status, 403);
    const before = requests.length;
    await receive("Sauna", "Miten voin perua saunavuoron?");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(requests.length, before, "AI:ta ei kutsuttu");

    await call(server, admin, "PUT", "/office", { name: "Testitoimisto", aiAgent: true });
    assert.equal((await call(server, admin, "PUT", "/agent/settings", { autoStart: true })).data.autoStart, true);
  });

  it("taloyhtiön ohitus kytkee automaattisen käynnistyksen pois", async () => {
    assert.equal((await call(server, admin, "PUT", "/agent/companies/demo-company", { autoStart: false })).status, 200);
    const before = requests.length;
    await receive("Sauna", "Miten voin perua saunavuoron?");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(requests.length, before);
    await call(server, admin, "PUT", "/agent/companies/demo-company", { autoStart: null });
  });

  it("vastaa dokumentaatiosta tarkistetulla lainauksella luonnoksena, jota ei lähetetä", async () => {
    const { ticketId } = await receive("Saunavuoron peruminen", "Miten voin perua saunavuoron?");
    const detail = await waitFor(ticketId, "ai_agent_drafted");
    assert.equal(detail.ticket.draft, "Voit perua vuoron maksutta kaksi tuntia ennen.");
    assert.equal(detail.ticket.ai_draft, "Voit perua vuoron maksutta kaksi tuntia ennen.");
    assert.equal(detail.ticket.knowledge_source_chunk_id, chunkId);
    assert.equal(detail.ticket.ai_action, "pending_decision");
    assert.equal((detail.messages as any[]).filter(message => message.direction === "outbound").length, 0, "asukkaalle ei lähtenyt mitään");
    // Luonnostilassakin agentilla on vastuu tehtävästä.
    assert.equal(detail.ticket.agent_owned, 1);
    // Luonnostilassa ei ole autopaikkajonoon lisäystä; varaus on rajattu asukkaan hyväksymään tarjoukseen (koodissa).
    const agentRequest = [...requests].reverse().find(request => Array.isArray(request.tools) && request.tools.length > 0)!;
    const names = (agentRequest.tools as { name: string }[]).map(tool => tool.name);
    assert.ok(!names.includes("join_parking_queue"));
    assert.ok(names.includes("answer_from_documentation") && names.includes("ask_resident_for_details"));
  });

  it("keksitty lainaus siirtää tehtävän henkilökunnalle ja vastuuisännöitsijälle lähtee ilmoitus", async () => {
    const { ticketId } = await receive("Saunavuoron peruminen", "Miten voin perua saunavuoron? [keksitty]");
    const detail = await waitFor(ticketId, "ai_agent_handover");
    assert.ok((detail.audit as any[]).some(entry => entry.action === "ai_agent_quote_failed"));
    assert.equal(detail.ticket.draft, "");
    await waitFor(ticketId, "agent_handover_mail_failed").catch(() => waitFor(ticketId, "agent_handover_mail_sent"));
    assert.match(detail.ticket.ai_reason, /lainausta/);
  });

  it("kielletty aihe tunnistetaan erillisellä luokittelulla ennen vastausta", async () => {
    const before = requests.length;
    const { ticketId } = await receive("Vahinko", "Vaadin korvausta pesukoneen rikkoutumisesta.");
    const detail = await waitFor(ticketId, "ai_agent_forbidden_topic");
    assert.ok((detail.audit as any[]).some(entry => entry.action === "ai_agent_handover"));
    const made = requests.slice(before);
    assert.equal(made.length, 1, "vain luokittelu, ei agentin kutsua");
    assert.ok(!made[0].tools);
  });

  it("itsenäinen aihe vaatii rajan ja pääkäyttäjän hyväksynnän; täydennä-kysymyksen vastaus siirtää henkilökunnalle", async () => {
    assert.equal((await call(server, admin, "PUT", "/agent/topics/drain", { companyId: "demo-company", autonomous: true })).status, 409);
    assert.equal((await call(server, service, "PUT", "/agent/topics/drain", { companyId: "demo-company", autonomous: true })).status, 403);
    // 100 viemäriaiheen luonnosta lähti sellaisenaan: raja täyttyy.
    const db = new Database(path.join(server.dataDir, "kotilo.sqlite"));
    try {
      const ticket = db.prepare("SELECT id FROM tickets LIMIT 1").get() as { id: string };
      db.prepare("INSERT INTO tickets (id, company_id, type, priority, status, subject, summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at, topic) SELECT 'ticket-drain', company_id, type, priority, 'closed', 'Viemäri', '', 'email', 'pending_decision', '', '', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'drain' FROM tickets WHERE id = ?").run(ticket.id);
      const insert = db.prepare("INSERT INTO audit_log VALUES (?, 'ticket-drain', 'Testi', 'reply_sent', ?, ?)");
      for (let index = 0; index < 100; index++) insert.run(`audit-drain-${index}`, JSON.stringify({ ai_draft_edit: "unchanged" }), new Date().toISOString());
    } finally {
      db.close();
    }
    const approved = await call(server, admin, "PUT", "/agent/topics/drain", { companyId: "demo-company", autonomous: true });
    assert.equal(approved.status, 200);
    assert.ok(approved.data.topics.some((topic: any) => topic.topic === "drain" && topic.autonomous));
    // Hyväksyntä ja raja ovat taloyhtiökohtaisia: toisessa taloyhtiössä aihe on luonnostilassa.
    const other = (await call(server, admin, "POST", "/companies", { name: "As Oy Toinen" })).data.companyId as string;
    const otherTopics = (await call(server, admin, "GET", `/agent/settings?companyId=${other}`)).data.topics as any[];
    assert.ok(!otherTopics.some(topic => topic.topic === "drain" && topic.approved));
    assert.equal((await call(server, admin, "PUT", "/agent/topics/drain", { companyId: other, autonomous: true })).status, 409);

    // Portaalin tehtävä: vastaus näkyy asukkaalle portaalissa.
    const matti = await login(server, "matti@example.com");
    const created = await call(server, matti, "POST", "/portal/tickets", {
      subject: "Viemäri haisee", description: "Kylpyhuoneen lattiakaivo haisee pahalle.", type: "Vikailmoitus", attachments: []
    });
    assert.equal(created.status, 201);
    const ticketId = created.data.ticketId as string;
    const detail = await waitFor(ticketId, "ai_agent_replied");
    assert.equal(detail.ticket.agent_state, "details_requested");
    assert.equal((detail.messages as any[]).filter(message => message.direction === "outbound").length, 1, "kysymys lähti asukkaalle");
    assert.ok((detail.audit as any[]).some(entry => entry.action === "ai_agent_details_requested"));

    const before = requests.length;
    assert.equal((await call(server, matti, "POST", `/portal/tickets/${ticketId}/messages`, { body: "Haju alkoi eilen, naapurilla ei ole hajua.", attachments: [] })).status, 201);
    const after = await waitFor(ticketId, "ai_agent_handover");
    assert.equal(after.ticket.ai_action, "pending_decision");
    assert.equal(after.ticket.agent_state, null);
    assert.equal(requests.length, before, "siirto ilman uutta AI-kutsua");

    assert.equal((await call(server, admin, "PUT", "/agent/topics/drain", { companyId: "demo-company", autonomous: false })).status, 200);
  });
});
