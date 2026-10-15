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
        if (String(body.system).includes("recurring")) {
          // Raporttipyyntö: yksi uusi aihe ja yksi, johon dokumentaatio jo vastaa.
          const report = {
            topics: [{ title: "Pyöräkellarin lukko", summary: "Lukko on jäykkä.", documentation: "Ilmoita huoltoyhtiölle.", tickets: [1, 2] }],
            covered: [{ title: "Saunavuoron varaus", knowledgeId: "knowledge-1" }, { title: "Keksitty", knowledgeId: "ei-ole" }]
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "msg_test", type: "message", role: "assistant", model: body.model,
            content: [{ type: "text", text: JSON.stringify(report) }],
            stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
          }));
          return;
        }
        if (String(body.system).includes("reply draft")) {
          const suggestion = { draft: "Huoltomies tulee torstaina.", reason: "Käsittelijän lisätieto.", sourceId: null };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "msg_test", type: "message", role: "assistant", model: body.model,
            content: [{ type: "text", text: JSON.stringify(suggestion) }],
            stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
          }));
          return;
        }
        const assessment = message.includes("jäykkä") ? { priority: "normal", reason: "Jäykkä lukko ei vaadi välittömiä toimia." }
          : message.includes("tippuu") ? { priority: "emergency", reason: "Katosta tuleva vesi vahingoittaa rakenteita." }
          : { priority: "low", reason: "Viesti on palautetta." };
        const advert = message.includes("Tarjous");
        const answer = {
          relevant: !advert,
          relevanceReason: advert ? "Viesti on mainos." : "Viesti koskee taloyhtiön asioita.",
          ...assessment
        };
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

  async function inbound(subject: string, body: string, channel = "email") {
    const created = await call(server, admin, "POST", "/inbound/messages", { companyId: "demo-company", senderName: "Tuntematon", subject, body, channel });
    assert.equal(created.status, 201);
    const detail = (await call(server, admin, "GET", `/tickets/${created.data.ticketId}`)).data;
    return {
      id: created.data.ticketId as string, emergency: created.data.emergency as boolean, filtered: created.data.filtered as boolean,
      ticket: detail.ticket, audit: detail.audit as any[]
    };
  }

  async function queueIds() {
    return ((await call(server, admin, "GET", "/decision-queue?companyId=demo-company")).data as any[]).map(row => row.id);
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

  it("asiaankuuluvuuden tarkistus on oletuksena pois, jolloin mainoskin menee päätösjonoon", async () => {
    assert.equal((await call(server, admin, "GET", "/office")).data.aiRelevance, 0);
    const advert = await inbound("Tarjous", "Tarjous: ikkunanpesu nyt puoleen hintaan!");
    assert.equal(advert.filtered, false);
    assert.equal(advert.ticket.status, "open");
    assert.ok((await queueIds()).includes(advert.id));
  });

  it("päällä AI pitää asiaan kuulumattoman sähköpostin poissa päätösjonosta, mutta tehtävä säilyy", async () => {
    assert.equal((await call(server, service, "PUT", "/office", { name: "Testitoimisto", aiRelevance: true })).status, 403);
    assert.equal((await call(server, admin, "PUT", "/office", { name: "Testitoimisto", aiRelevance: true })).data.aiRelevance, 1);

    const advert = await inbound("Tarjous", "Tarjous: ikkunanpesu nyt puoleen hintaan! Vesivuoto ei haittaa.");
    assert.equal(advert.filtered, true);
    assert.equal(advert.emergency, false);
    assert.equal(advert.ticket.status, "closed");
    assert.equal(advert.ticket.ai_action, "filtered");
    assert.equal(advert.ticket.ai_reason, "Viesti on mainos.");
    assert.ok(advert.audit.some(row => row.action === "ai_filtered"));
    assert.ok(!advert.audit.some(row => row.action.startsWith("emergency_alert")));
    assert.ok(!(await queueIds()).includes(advert.id));

    // Suodatetun tehtävän voi avata uudelleen, jolloin se palaa jonoon.
    assert.equal((await call(server, admin, "POST", `/tickets/${advert.id}/reopen`)).status, 200);

    const real = await inbound("Pyöräkellari", "Pyöräkellarin lukko on jäykkä.");
    assert.equal(real.filtered, false);
    assert.ok((await queueIds()).includes(real.id));
  });

  it("käsin kirjattua asiaa ei suodateta", async () => {
    const note = await inbound("Tarjous", "Tarjous huoltoyhtiöltä kirjattu puhelusta.", "quick_note");
    assert.equal(note.filtered, false);
    assert.equal(note.ticket.status, "open");
  });

  it("toistuvien aiheiden raportti saa dokumentaation mukaansa ja jättää jo dokumentoidut aiheet pois", async () => {
    const created = await call(server, admin, "POST", "/companies/demo-company/reports/topics", {
      period: "month", since: new Date(Date.now() - 30 * 86_400_000).toISOString()
    });
    assert.equal(created.status, 200);
    assert.deepEqual(created.data.report.topics.map((topic: any) => topic.title), ["Pyöräkellarin lukko"]);
    // Tuntemattomaan tietueeseen viittaava merkintä pudotetaan pois.
    assert.equal(created.data.report.covered.length, 1);
    assert.equal(created.data.report.covered[0].title, "Saunavuoron varaus");
    assert.equal(created.data.report.covered[0].knowledgeId, "knowledge-1");
    assert.ok(created.data.report.covered[0].knowledgeTitle);

    const request = requests.at(-1);
    assert.match(JSON.stringify(request.body.messages), /Existing documentation/);
    assert.match(JSON.stringify(request.body.messages), /\[knowledge-1\]/);

    const stored = (await call(server, admin, "GET", "/companies/demo-company/reports/topics?period=month")).data.report;
    assert.equal(stored.covered.length, 1);
  });

  it("AI:n virhe ei estä tehtävän syntymistä, vaan prioriteetti tulee avainsanoista", async () => {
    failing = true;
    try {
      const result = await inbound("Vesivuoto", "Kylpyhuoneessa on vesivuoto.");
      assert.equal(result.emergency, true);
      // Kun AI ei vastaa, viestiä ei suodateta.
      assert.equal(result.filtered, false);
      assert.equal(JSON.parse(result.audit.find(row => row.action === "emergency_routed").details).priorityBy, "keywords");
    } finally {
      failing = false;
    }
  });

  it("AI-ehdotus ottaa huomioon käsittelijän lisätiedon", async () => {
    const created = await call(server, admin, "POST", "/inbound/messages", { companyId: "demo-company", senderName: "Asukas", subject: "Ilmanvaihto", body: "Ilmanvaihto pitää kovaa ääntä.", channel: "email" });
    const ticketId = created.data.ticketId as string;

    const tooLong = await call(server, admin, "POST", `/tickets/${ticketId}/suggest`, { context: "x".repeat(2001) });
    assert.equal(tooLong.status, 400);

    const suggested = await call(server, admin, "POST", `/tickets/${ticketId}/suggest`, { context: "Huoltomies käy torstaina klo 10." });
    assert.equal(suggested.status, 200);
    assert.equal(suggested.data.draft, "Huoltomies tulee torstaina.");
    assert.equal(suggested.data.usedAi, true);
    const request = requests.at(-1);
    assert.match(JSON.stringify(request.body.messages), /Manager's notes:\\nHuoltomies käy torstaina klo 10\./);
  });
});
