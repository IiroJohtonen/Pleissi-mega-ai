import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

// Claude korvataan paikallisella palvelimella, joka vastaa Messages-rajapinnan muodossa. Näin AI-polku
// testataan päästä päähän kutsumatta oikeaa palvelua.
describe("AI arvioi saapuvan tehtävän prioriteetin", () => {
  let server: TestServer;
  let claude: http.Server;
  let admin: string;
  let service: string;
  const requests: any[] = [];
  let failing = false;

  before(async () => {
    claude = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        requests.push({ path: req.url, body });
        if (failing) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "testivirhe" } }));
          return;
        }
        const message = JSON.stringify(body.messages);
        const answer = message.includes("jäykkä") ? { priority: "normal", reason: "Jäykkä lukko ei vaadi välittömiä toimia." }
          : message.includes("tippuu") ? { priority: "emergency", reason: "Katosta tuleva vesi vahingoittaa rakenteita." }
          : { priority: "low", reason: "Viesti on palautetta." };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_test", type: "message", role: "assistant", model: body.model,
          content: [{ type: "text", text: JSON.stringify(answer) }],
          stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
        }));
      });
    });
    await new Promise<void>(resolve => claude.listen(0, "127.0.0.1", resolve));
    const { port } = claude.address() as AddressInfo;

    server = await startServer({ env: { ANTHROPIC_API_KEY: "testiavain", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } });
    admin = await login(server, ADMIN_EMAIL);
    service = await login(server, SERVICE_EMAIL);
  });

  after(async () => {
    await server.stop();
    await new Promise(resolve => claude.close(resolve));
  });

  async function inbound(subject: string, body: string) {
    const created = await call(server, admin, "POST", "/inbound/messages", { companyId: "demo-company", senderName: "Tuntematon", subject, body });
    assert.equal(created.status, 201);
    const detail = (await call(server, admin, "GET", `/tickets/${created.data.ticketId}`)).data;
    return { emergency: created.data.emergency as boolean, ticket: detail.ticket, audit: detail.audit as any[] };
  }

  it("on oletuksena pois päältä, jolloin prioriteetti tulee avainsanoista eikä AI:ta kutsuta", async () => {
    const office = (await call(server, admin, "GET", "/office")).data;
    assert.equal(office.aiPriority, 0);
    assert.equal(office.aiAvailable, true);

    const result = await inbound("Pyöräkellari", "Pyöräkellarin lukko on jäykkä.");
    assert.equal(result.emergency, true);
    assert.equal(requests.length, 0);
  });

  it("vain pääkäyttäjä kytkee asetuksen päälle", async () => {
    assert.equal((await call(server, service, "PUT", "/office", { name: "Testitoimisto", aiPriority: true })).status, 403);
    const saved = await call(server, admin, "PUT", "/office", { name: "Testitoimisto", aiPriority: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.aiPriority, 1);
    // Muiden tietojen tallennus ei muuta asetusta.
    assert.equal((await call(server, admin, "PUT", "/office", { name: "Testitoimisto" })).data.aiPriority, 1);
  });

  it("päällä AI päättää prioriteetin avainsanojen sijaan", async () => {
    const stiff = await inbound("Pyöräkellari", "Pyöräkellarin lukko on jäykkä.");
    assert.equal(stiff.emergency, false);
    assert.equal(stiff.ticket.priority, "normal");
    assert.equal(stiff.ticket.ai_reason, "Jäykkä lukko ei vaadi välittömiä toimia.");
    assert.equal(JSON.parse(stiff.audit.find(row => row.action === "triaged").details).priorityBy, "ai");

    const request = requests.at(-1);
    assert.match(request.path, /^\/v1\/messages/);
    assert.equal(request.body.model, "claude-opus-5-5");
    assert.equal(request.body.output_config.effort, "low");
    assert.match(JSON.stringify(request.body.messages), /jäykkä/);

    const feedback = await inbound("Kiitos", "Kiitos hyvästä pihatalkoiden järjestämisestä!");
    assert.equal(feedback.ticket.priority, "low");
  });

  it("AI:n tunnistama hätätapaus hälyttää, vaikka viestissä ei ole avainsanaa", async () => {
    const leak = await inbound("Keittiö", "Keittiön katosta tippuu koko ajan lattialle.");
    assert.equal(leak.emergency, true);
    assert.equal(leak.ticket.priority, "emergency");
    assert.equal(leak.ticket.ai_reason, "Katosta tuleva vesi vahingoittaa rakenteita.");
    assert.ok(leak.audit.some(row => row.action === "emergency_routed"));
  });

  it("AI:n virhe ei estä tehtävän syntymistä, vaan prioriteetti tulee avainsanoista", async () => {
    failing = true;
    try {
      const result = await inbound("Vesivuoto", "Kylpyhuoneessa on vesivuoto.");
      assert.equal(result.emergency, true);
      assert.equal(JSON.parse(result.audit.find(row => row.action === "emergency_routed").details).priorityBy, "keywords");
    } finally {
      failing = false;
    }
  });
});
