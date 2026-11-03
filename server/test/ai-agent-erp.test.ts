import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { after, before, describe, it } from "node:test";
import { addDays, helsinkiIso, helsinkiParts } from "../src/util.js";
import { ADMIN_EMAIL, call, login, PASSWORD, startServer, type TestServer } from "./helpers.js";

// AI-agentti ERP-integraation ollessa päällä: varaus jää odottamaan ERP:n vahvistusta, agentti ei vahvista sitä
// asukkaalle, ja simuloidun ERP:n 201-vastauksen jälkeen asukkaalle lähtee vakiovahvistus samaan ketjuun.

describe("AI-agentin varaus ERP-integraatiossa", () => {
  let server: TestServer;
  let claude: http.Server;
  let admin: string;
  let matti: string;
  const toolResults: string[] = [];
  const day = addDays(helsinkiParts(new Date().toISOString()).day, 4);
  const requested = helsinkiIso(day, 19);

  before(async () => {
    claude = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw) as { model: string; system?: unknown; messages: { content: string | { type: string; content?: unknown }[] }[] };
        // Kiellettyjen aiheiden tarkistus ennen agenttia: saunavuoro on sallittu.
        if (JSON.stringify(body.system ?? "").includes("screen a Finnish housing-company ticket")) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            id: "msg_guard", type: "message", role: "assistant", model: body.model,
            content: [{ type: "text", text: JSON.stringify({ category: "none", reason: "" }) }],
            stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
          }));
          return;
        }
        const last = body.messages.at(-1)!;
        const result = typeof last.content === "string" ? "" : last.content.filter(block => block.type === "tool_result")
          .map(block => (typeof block.content === "string" ? block.content : JSON.stringify(block.content))).join("\n");
        if (result) toolResults.push(result);
        const call = !result ? { name: "book_slot", input: { resource: "sauna", starts_at: requested, basis: "resident_requested" } }
          : result.startsWith("Booking requested") ? { name: "reply_to_resident", input: { message: "Varauspyyntö on lähetetty, saat vahvistuksen pian.", outcome: "awaiting_resident" } }
          : null;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          id: `msg_${toolResults.length}`, type: "message", role: "assistant", model: body.model,
          content: call ? [{ type: "tool_use", id: `toolu_${toolResults.length}`, name: call.name, input: call.input }] : [{ type: "text", text: "Valmis." }],
          stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
        }));
      });
    });
    await new Promise<void>(resolve => claude.listen(0, "127.0.0.1", resolve));
    server = await startServer({
      env: {
        ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(claude.address() as AddressInfo).port}`,
        INTEGRATION_ADAPTER: "mock", INTEGRATION_SEND_DELAY_MS: "300", INTEGRATION_POLL_MS: "100"
      }
    });
    admin = await login(server, ADMIN_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-1", {
      name: "Matti Meikäläinen", email: "matti@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12", password: PASSWORD
    });
    matti = await login(server, "matti@example.com");
    const office = (await call(server, admin, "GET", "/office")).data;
    assert.equal((await call(server, admin, "PUT", "/office", { name: office.name, aiAgent: true })).status, 200);
  });

  after(async () => {
    await server.stop();
    await new Promise(resolve => claude.close(resolve));
  });

  it("varaus odottaa ERP:n vahvistusta, ja vahvistus lähtee asukkaalle vasta sen jälkeen", async () => {
    const created = await call(server, matti, "POST", "/portal/tickets", {
      subject: "Sauna", description: `Saisinko saunavuoron ${day} klo 19?`, type: "Pyyntö", attachments: []
    });
    const ticketId = created.data.ticketId;
    // Aihe on taloyhtiössä hyväksytty itsenäiseksi (raja täyttyy), joten agentti varaa ja vastaa itse.
    let topic = "";
    for (let attempt = 0; attempt < 50 && !topic; attempt++) {
      topic = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data.ticket.topic ?? "";
      if (!topic) await new Promise(resolve => setTimeout(resolve, 50));
    }
    const db = new Database(path.join(server.dataDir, "kotilo.sqlite"));
    try {
      db.prepare(`INSERT INTO tickets (id, company_id, type, priority, status, subject, summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at, topic)
        VALUES ('ticket-ready', 'demo-company', 'Kysymys', 'normal', 'closed', 'Raja', '', 'email', 'pending_decision', '', '', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', ?)`).run(topic);
      const insert = db.prepare("INSERT INTO audit_log VALUES (?, 'ticket-ready', 'Testi', 'reply_sent', ?, '2020-01-01T00:00:00.000Z')");
      for (let index = 0; index < 100; index++) insert.run(`audit-ready-${index}`, JSON.stringify({ ai_draft_edit: "unchanged" }));
    } finally {
      db.close();
    }
    assert.equal((await call(server, admin, "PUT", `/agent/topics/${topic}`, { companyId: "demo-company", autonomous: true })).status, 200);
    const run = await call(server, admin, "POST", `/tickets/${ticketId}/agent`);
    assert.equal(run.status, 200);
    assert.deepEqual([run.data.outcome, run.data.booked], ["replied", true]);
    assert.match(toolResults[0], /NOT confirmed yet/);

    let detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.equal(detail.ticket.status, "waiting_third_party", "tehtävä odottaa ERP:n vahvistusta");
    const booked = detail.audit.find((entry: any) => entry.action === "ai_agent_booked");
    assert.equal(JSON.parse(booked.details).status, "requested");

    const deadline = Date.now() + 10_000;
    while (!detail.audit.some((entry: any) => entry.action === "ai_agent_booking_confirmed")) {
      if (Date.now() > deadline) throw new Error(`ERP ei vahvistanut:\n${server.output()}`);
      await new Promise(resolve => setTimeout(resolve, 100));
      detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    }
    const replies = detail.messages.filter((message: any) => message.direction === "outbound").map((message: any) => message.body);
    assert.equal(replies.length, 2);
    assert.match(replies[0], /Varauspyyntö on lähetetty/);
    assert.match(replies[1], /varauksesi on nyt vahvistettu/);
    assert.equal(detail.ticket.status, "closed");

    // Integraatioloki näyttää varaussanoman.
    const log = (await call(server, admin, "GET", "/integration/messages")).data;
    assert.ok(log.messages.some((message: any) => message.event_type === "booking.created" && message.status === "sent"));
  });
});
