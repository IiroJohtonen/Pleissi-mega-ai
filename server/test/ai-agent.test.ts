import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { after, before, describe, it } from "node:test";
import { addDays, helsinkiIso, helsinkiParts } from "../src/util.js";
import { ADMIN_EMAIL, call, login, PASSWORD, startServer, type TestServer } from "./helpers.js";

type ToolCall = { name: string; input: Record<string, unknown> };
type Request = { messages: { role: string; content: string | { type: string; content?: unknown; text?: string }[] }[] };

// Valepalvelin Anthropicin rajapinnan tilalle: vastaa AI-agentin pyyntöihin käsikirjoituksen mukaan, jotta
// agentin koko kulku voidaan testata ilman oikeaa AI:ta. script saa pyynnön ja palauttaa seuraavan
// työkalukutsun tai null, jolloin agentti lopettaa.
function fakeAnthropic(script: (request: Request, lastResult: string, firstMessage: string) => ToolCall | null, onCall: () => void) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body) as Request;
      const first = request.messages[0];
      const firstMessage = typeof first.content === "string" ? first.content : first.content.map(block => block.text ?? "").join("");
      const last = request.messages[request.messages.length - 1];
      const lastResult = typeof last.content === "string" ? "" : last.content
        .filter(block => block.type === "tool_result")
        .map(block => typeof block.content === "string" ? block.content : JSON.stringify(block.content))
        .join("\n");
      res.setHeader("Content-Type", "application/json");
      calls++;
      onCall();
      // Kiellettyjen aiheiden erillinen luokittelu ennen agenttia: korvausasia on kielletty, muu sallittu.
      if (JSON.stringify((request as { system?: unknown }).system ?? "").includes("screen a Finnish housing-company ticket")) {
        const category = /korvau/i.test(firstMessage) ? "compensation" : "none";
        res.end(JSON.stringify({
          id: `msg_${calls}`, type: "message", role: "assistant", model: "claude-haiku-5-5",
          content: [{ type: "text", text: JSON.stringify({ category, reason: category === "none" ? "" : "Asukas vaatii korvausta." }) }],
          stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
        }));
        return;
      }
      const call = script(request, lastResult, firstMessage);
      res.end(JSON.stringify({
        id: `msg_${calls}`, type: "message", role: "assistant", model: "claude-opus-5-5",
        content: call ? [{ type: "tool_use", id: `toolu_${calls}`, name: call.name, input: call.input }] : [{ type: "text", text: "Valmis." }],
        stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 }
      }));
    });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise(done => server.close(() => done()))
    }));
  });
}

describe("AI-agentti", () => {
  let server: TestServer;
  let fake: { url: string; close: () => Promise<void> };
  let admin: string;
  let matti: string;
  let liisa: string;
  // Matti pyytää saunavuoroa viiden päivän päästä klo 18, mutta Liisa on varannut sen.
  const day = addDays(helsinkiParts(new Date().toISOString()).day, 5);
  const requested = helsinkiIso(day, 18);
  let offered: string[] = [];
  let aiCalls = 0;

  before(async () => {
    fake = await fakeAnthropic((_request, lastResult, firstMessage) => {
      // Saunavuoro: tarkista pyydetty aika → hae vapaat → tarjoa kaksi; asukkaan valinnan jälkeen varaa ja vahvista.
      if (firstMessage.includes("saunavuoron")) {
        const chose = firstMessage.includes("Käy ensimmäinen");
        if (chose) {
          if (!lastResult) return { name: "book_slot", input: { resource: "sauna", starts_at: offered[0], basis: "resident_accepted_offer" } };
          if (lastResult.startsWith("Booked")) return { name: "reply_to_resident", input: { message: "Varasin vuoron.", outcome: "resolved" } };
          return null;
        }
        if (!lastResult) return { name: "check_slot", input: { resource: "sauna", starts_at: requested } };
        if (lastResult.includes("already booked")) {
          return { name: "find_free_slots", input: { resource: "sauna", from_date: day, to_date: addDays(day, 3), earliest_hour: 17 } };
        }
        if (lastResult.includes("starts_at:")) {
          offered = [...lastResult.matchAll(/starts_at: ([^)]+)\)/g)].slice(0, 2).map(match => match[1]);
          return {
            name: "reply_to_resident",
            input: { message: "Pyytämäsi vuoro on varattu. Vapaita vuoroja on tarjolla.", outcome: "awaiting_resident",
              offered_slots: offered.map(startsAt => ({ resource: "sauna", starts_at: startsAt })) }
          };
        }
        return null;
      }
      // Pyykkitupa: agentti yrittää varata vuoron, jota ei ole tarjottu asukkaalle → varaus estetään.
      if (firstMessage.includes("pyykkitupa")) {
        if (!lastResult) return { name: "book_slot", input: { resource: "laundry", starts_at: helsinkiIso(day, 10), basis: "resident_accepted_offer" } };
        if (lastResult.startsWith("Not booked")) return { name: "hand_over_to_staff", input: { reason: "Varaus ei onnistunut." } };
        return null;
      }
      // Kysymys, johon dokumentaatio ei vastaa: osaamisaukko.
      if (firstMessage.includes("uima-allas")) {
        if (!lastResult) return { name: "hand_over_to_staff", input: { reason: "Vastausta ei löytynyt.", reason_type: "no_answer", general_question: "Onko taloyhtiössä uima-allas? Soita 040 555 6666." } };
        return null;
      }
      // Muu asia: henkilökunnalle.
      if (!lastResult) return { name: "hand_over_to_staff", input: { reason: "Vikailmoitus kuuluu huollolle." } };
      return null;
    }, () => { aiCalls++; });
    server = await startServer({ env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: fake.url } });
    admin = await login(server, ADMIN_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-1", {
      name: "Matti Meikäläinen", email: "matti@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12", password: PASSWORD
    });
    await call(server, admin, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34", password: PASSWORD
    });
    matti = await login(server, "matti@example.com");
    liisa = await login(server, "liisa@example.com");
    const office = (await call(server, admin, "GET", "/office")).data;
    assert.equal((await call(server, admin, "PUT", "/office", { name: office.name, aiAgent: true })).status, 200);
  });

  after(async () => {
    await server.stop();
    await fake.close();
  });

  // Agentti toimii taustalla, joten tehtävää luetaan, kunnes ehto täyttyy.
  async function waitFor(ticketId: string, done: (detail: any) => boolean) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
      if (done(detail)) return detail;
      if (Date.now() > deadline) throw new Error(`Agentti ei valmistunut: ${JSON.stringify(detail.ticket)}\n${server.output()}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const logged = (action: string) => (detail: any) => detail.audit.some((entry: any) => entry.action === action);

  // Tietokantaan suoraan (palvelin käynnissä, WAL): esim. luonnosmittarin rajan täyttävät lähetykset.
  function withDb<T>(work: (db: Database.Database) => T): T {
    const db = new Database(path.join(server.dataDir, "kotilo.sqlite"));
    try {
      return work(db);
    } finally {
      db.close();
    }
  }

  // Taloyhtiön aihe itsenäiseksi: 100 luonnosta lähti sellaisenaan, ja pääkäyttäjä hyväksyy aiheen.
  async function makeAutonomous(topic: string) {
    withDb(db => {
      db.prepare(`INSERT OR IGNORE INTO tickets (id, company_id, type, priority, status, subject, summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at, topic)
        VALUES (?, 'demo-company', 'Kysymys', 'normal', 'closed', 'Raja', '', 'email', 'pending_decision', '', '', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', ?)`).run(`ticket-ready-${topic}`, topic);
      const insert = db.prepare("INSERT OR IGNORE INTO audit_log VALUES (?, ?, 'Testi', 'reply_sent', ?, ?)");
      for (let index = 0; index < 100; index++) insert.run(`audit-ready-${topic}-${index}`, `ticket-ready-${topic}`, JSON.stringify({ ai_draft_edit: "unchanged" }), "2020-01-01T00:00:00.000Z");
    });
    assert.equal((await call(server, admin, "PUT", `/agent/topics/${topic}`, { companyId: "demo-company", autonomous: true })).status, 200);
  }

  it("tarjoaa vapaita vuoroja varatun tilalle ja varaa asukkaan valitseman vuoron", async () => {
    assert.equal((await call(server, liisa, "POST", "/portal/bookings", {
      resource: "sauna", startsAt: requested, endsAt: new Date(Date.parse(requested) + 3600_000).toISOString()
    })).status, 201);

    const created = await call(server, matti, "POST", "/portal/tickets", {
      subject: "Sauna", description: `Haluaisin saunavuoron ${day} klo 18.`, type: "Pyyntö", attachments: []
    });
    assert.equal(created.status, 201);
    const ticketId = created.data.ticketId;

    // Uusi tehtävä ei käynnistä agenttia: AI-kutsuja ei tehdä ennen kuin käsittelijä painaa painiketta.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(aiCalls, 0);
    const untouched = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.equal(untouched.ticket.status, "open");
    assert.ok(!logged("ai_agent_replied")(untouched));

    // Aihe on taloyhtiössä hyväksytty itsenäiseksi, joten agentti vastaa itse (muuten luonnos).
    const topic = (await waitFor(ticketId, detail => Boolean(detail.ticket.topic))).ticket.topic as string;
    await makeAutonomous(topic);

    // Käsittelijä antaa tehtävän agentille. Agentti vastaa asukkaalle ja jää odottamaan valintaa AI tehtävissä.
    const run = await call(server, admin, "POST", `/tickets/${ticketId}/agent`);
    assert.equal(run.status, 200);
    assert.deepEqual([run.data.outcome, run.data.resolved, run.data.booked], ["replied", false, false]);
    const proposed = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.equal(proposed.ticket.ai_action, "ai");
    assert.equal(proposed.ticket.status, "waiting_third_party");
    assert.equal(offered.length, 2);
    // Tarjotut vuorot ovat vapaita ja alkavat aikaisintaan pyydettynä päivänä.
    assert.ok(offered.every(startsAt => startsAt !== requested && startsAt >= helsinkiIso(day, 0)));
    const reply = proposed.messages.find((message: any) => message.direction === "outbound");
    assert.match(reply.body, /Vapaita vuoroja/);
    // Allekirjoituksesta asukas näkee, että vastauksen kirjoitti tekoäly.
    assert.match(reply.body, /Aino-AI, tekoälyavustaja/);
    assert.match(reply.body, /Tämän vastauksen kirjoitti tekoäly\./);
    // Agentilla on vastuu tehtävästä (vihreä painike).
    assert.equal(proposed.ticket.agent_owned, 1);
    // Asukas näkee vastauksen portaalissa.
    const portal = (await call(server, matti, "GET", `/portal/tickets/${ticketId}`)).data;
    assert.ok(portal.messages.some((message: any) => message.direction === "outbound"));

    // Asukas valitsee ensimmäisen vuoron; agentti jatkaa itse, varaa vuoron ja sulkee tehtävän.
    assert.equal((await call(server, matti, "POST", `/portal/tickets/${ticketId}/messages`, { body: "Käy ensimmäinen", attachments: [] })).status, 201);
    const closed = await waitFor(ticketId, detail => detail.ticket.status === "closed");
    assert.equal(closed.ticket.ai_action, "ai");
    const bookings = (await call(server, matti, "GET", `/portal/bookings?resource=sauna&from=${encodeURIComponent(helsinkiIso(day, 0))}&to=${encodeURIComponent(helsinkiIso(addDays(day, 5), 0))}`)).data as any[];
    assert.deepEqual(bookings.filter(booking => booking.mine).map(booking => booking.starts_at), [offered[0]]);
    assert.ok(closed.audit.some((entry: any) => entry.action === "ai_agent_booked"));

    // Jokainen ajo jättää jäljityksen: työkalukutsut syötteineen ja tuloksineen, myös lukutyökalut.
    const traces = closed.audit.filter((entry: any) => entry.action === "ai_agent_trace")
      .sort((a: any, b: any) => a.created_at.localeCompare(b.created_at));
    assert.equal(traces.length, 2);
    const first = JSON.parse((await call(server, admin, "GET", `/audit/${traces[0].id}/ai-request`)).data.payload);
    assert.equal(first.outcome, "replied");
    assert.deepEqual(first.steps.map((step: any) => step.tool), ["check_slot", "find_free_slots", "reply_to_resident"]);
    assert.equal(first.steps[0].input.starts_at, requested);
    const second = JSON.parse((await call(server, admin, "GET", `/audit/${traces[1].id}/ai-request`)).data.payload);
    assert.deepEqual(second.steps.map((step: any) => step.tool), ["book_slot", "reply_to_resident"]);
    assert.match(String(first.steps[0].output), /already booked/);
    assert.ok(first.steps.every((step: any) => typeof step.ms === "number"));
    // AI:n vastaukset tallentuvat pyynnön rinnalle.
    const request = (await call(server, admin, "GET", "/audit")).data.find((entry: any) => entry.action === "ai_request" && entry.ticket_id === ticketId);
    const stored = (await call(server, admin, "GET", `/audit/${request.id}/ai-request`)).data;
    assert.ok(stored.response);
    assert.match(stored.response, /tool_use/);
    // Seuraavat testit ovat luonnostilassa.
    assert.equal((await call(server, admin, "PUT", `/agent/topics/${topic}`, { companyId: "demo-company", autonomous: false })).status, 200);
  });

  it("luonnostilassa tarjoaa vuoroja luonnoksena ja varaa vuoron vasta asukkaan hyväksyttyä", async () => {
    const created = await call(server, matti, "POST", "/portal/tickets", {
      subject: "Sauna", description: `Haluaisin saunavuoron ${day} klo 18.`, type: "Pyyntö", attachments: []
    });
    const ticketId = created.data.ticketId as string;
    await waitFor(ticketId, detail => Boolean(detail.ticket.topic));
    const run = await call(server, admin, "POST", `/tickets/${ticketId}/agent`);
    assert.equal(run.status, 200);
    assert.deepEqual([run.data.outcome, run.data.booked], ["drafted", false]);
    const drafted = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.match(drafted.ticket.draft, /Vapaita vuoroja/);
    assert.equal(drafted.ticket.agent_state, "offer_drafted");
    assert.equal(drafted.ticket.ai_action, "pending_decision");
    assert.ok(!drafted.messages.some((message: any) => message.direction === "outbound"), "asukkaalle ei lähtenyt mitään");

    // Käsittelijä lähettää luonnoksen (sähköposti ei ole testissä käytössä, joten lähetys tehdään kuten
    // activateDraftOffers): tarjous tulee voimaan ja agentti jatkaa asukkaan vastauksesta.
    withDb(db => {
      const sentAt = new Date().toISOString();
      db.prepare("INSERT INTO ai_agent_offers (ticket_id, resource, starts_at, created_at) SELECT ticket_id, resource, starts_at, ? FROM ai_agent_draft_offers WHERE ticket_id = ?").run(sentAt, ticketId);
      db.prepare("DELETE FROM ai_agent_draft_offers WHERE ticket_id = ?").run(ticketId);
      db.prepare("UPDATE tickets SET ai_action = 'ai', agent_state = NULL, draft = '', status = 'answered' WHERE id = ?").run(ticketId);
      db.prepare("INSERT INTO messages VALUES (?, ?, 'outbound', 'Isännöitsijä', 'Sauna', ?, ?, 'portal')").run(`message-sent-${ticketId}`, ticketId, drafted.ticket.draft, sentAt);
    });

    assert.equal((await call(server, matti, "POST", `/portal/tickets/${ticketId}/messages`, { body: "Käy ensimmäinen", attachments: [] })).status, 201);
    const booked = await waitFor(ticketId, detail => logged("ai_agent_booked")(detail) && detail.ticket.draft === "Varasin vuoron.");
    assert.equal(booked.ticket.ai_action, "pending_decision", "vahvistus odottaa käsittelijää");
    assert.match(booked.ticket.ai_reason, /varasi/);
    const bookings = (await call(server, matti, "GET", `/portal/bookings?resource=sauna&from=${encodeURIComponent(helsinkiIso(day, 0))}&to=${encodeURIComponent(helsinkiIso(addDays(day, 5), 0))}`)).data as any[];
    assert.ok(bookings.filter(booking => booking.mine).some(booking => booking.starts_at === offered[0]));
  });

  it("vihreän painikkeen painallus lopettaa agentin käsittelyn: vastuu ja tarjoukset palaavat käsittelijälle", async () => {
    const created = await call(server, matti, "POST", "/portal/tickets", {
      subject: "Sauna", description: `Haluaisin saunavuoron ${day} klo 18.`, type: "Pyyntö", attachments: []
    });
    const ticketId = created.data.ticketId as string;
    await waitFor(ticketId, detail => Boolean(detail.ticket.topic));
    assert.equal((await call(server, admin, "POST", `/tickets/${ticketId}/agent`)).data.outcome, "drafted");
    const owned = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.equal(owned.ticket.agent_owned, 1);
    assert.equal(owned.ticket.agent_state, "offer_drafted");

    assert.equal((await call(server, admin, "DELETE", `/tickets/${ticketId}/agent`)).status, 200);
    const stopped = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.deepEqual([stopped.ticket.agent_owned, stopped.ticket.agent_state, stopped.ticket.ai_action], [0, null, "pending_decision"]);
    assert.match(stopped.ticket.draft, /Vapaita vuoroja/, "agentin luonnos jää kenttään");
    assert.ok(logged("ai_agent_stopped")(stopped));
    // Asukkaan vastaus ei enää käynnistä agenttia.
    const calls = aiCalls;
    assert.equal((await call(server, matti, "POST", `/portal/tickets/${ticketId}/messages`, { body: "Käy ensimmäinen", attachments: [] })).status, 201);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(aiCalls, calls);
  });

  it("ei varaa vuoroa, jota asukkaalle ei ole tarjottu", async () => {
    const created = await call(server, matti, "POST", "/portal/tickets", {
      subject: "Pyykkitupa", description: "Varaatko minulle pyykkitupa-ajan?", type: "Pyyntö", attachments: []
    });
    const run = await call(server, admin, "POST", `/tickets/${created.data.ticketId}/agent`);
    assert.deepEqual([run.data.outcome, run.data.booked], ["handed_over", false]);
    const detail = (await call(server, admin, "GET", `/tickets/${created.data.ticketId}`)).data;
    assert.ok(logged("ai_agent_handover")(detail));
    assert.ok(!logged("ai_agent_booked")(detail));
    assert.equal(detail.ticket.status, "open");
  });

  it("jättää muut asiat henkilökunnalle vastaamatta asukkaalle", async () => {
    const created = await call(server, matti, "POST", "/portal/tickets", {
      subject: "Hana vuotaa", description: "Keittiön hana tippuu.", type: "Vikailmoitus", attachments: []
    });
    const run = await call(server, admin, "POST", `/tickets/${created.data.ticketId}/agent`);
    assert.deepEqual([run.data.outcome, run.data.reason], ["handed_over", "Vikailmoitus kuuluu huollolle."]);
    const detail = (await call(server, admin, "GET", `/tickets/${created.data.ticketId}`)).data;
    assert.equal(detail.ticket.status, "open");
    assert.equal(detail.ticket.ai_action, "pending_decision");
    assert.ok(!detail.messages.some((message: any) => message.direction === "outbound"));
    assert.equal(detail.ticket.agent_owned, 0, "siirretty tehtävä on käsittelijän vastuulla");
    // Perustelu näkyy käsittelijälle tehtävän sisäisenä muistiinpanona.
    assert.ok(detail.notes.some((item: any) => item.body.includes("Vikailmoitus kuuluu huollolle.")));
  });

  it("siirtää tehtävän henkilökunnalle, kun agentin ajot tehtävää kohden vuorokaudessa ovat täynnä", async () => {
    assert.equal((await call(server, admin, "PUT", "/office/ai-limits", { agentRunsPerDay: 1 })).status, 200);
    try {
      const created = await call(server, matti, "POST", "/portal/tickets", {
        subject: "Ovi", description: "Ulko-ovi narisee.", type: "Vikailmoitus", attachments: []
      });
      const ticketId = created.data.ticketId;
      assert.equal((await call(server, admin, "POST", `/tickets/${ticketId}/agent`)).data.outcome, "handed_over");
      const calls = aiCalls;
      const second = await call(server, admin, "POST", `/tickets/${ticketId}/agent`);
      assert.equal(second.status, 200);
      assert.equal(second.data.outcome, "handed_over");
      assert.match(second.data.reason, /jo 1 kertaa vuorokauden aikana/);
      assert.equal(aiCalls, calls, "rajan täytyttyä AI:ta ei kutsuta");
      const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
      assert.ok(detail.notes.some((item: any) => item.body.includes("jo 1 kertaa")));
    } finally {
      await call(server, admin, "PUT", "/office/ai-limits", { agentRunsPerDay: 5 });
    }
  });

  it("kysymys, johon ei löydy vastausta, kirjataan osaamisaukoksi yleisessä muodossa", async () => {
    const created = await call(server, matti, "POST", "/portal/tickets", {
      subject: "Allas", description: "Onko meillä uima-allas?", type: "Kysymys", attachments: []
    });
    const run = await call(server, admin, "POST", `/tickets/${created.data.ticketId}/agent`);
    assert.equal(run.data.outcome, "handed_over");
    const detail = (await call(server, admin, "GET", `/tickets/${created.data.ticketId}`)).data;
    const gap = detail.audit.find((entry: any) => entry.action === "knowledge_gap");
    assert.ok(gap);
    assert.doesNotMatch(gap.details, /040 555 6666/, "henkilötiedot peitetään");
    const report = (await call(server, admin, "GET", "/reports/knowledge-gaps?companyId=demo-company")).data;
    assert.ok(report.topics.some((topic: any) => topic.questions.some((question: any) => question.question.startsWith("Onko taloyhtiössä uima-allas?"))));
  });

  it("kertoo, miksi agentti ei voi käsitellä tehtävää", async () => {
    const created = await call(server, admin, "POST", "/tickets", {
      companyId: "demo-company", subject: "Kysymys", summary: "Tunnistamaton lähettäjä kysyy saunasta."
    });
    assert.equal(created.status, 201);
    const ticketId = created.data.ticketId;
    const run = await call(server, admin, "POST", `/tickets/${ticketId}/agent`);
    assert.equal(run.status, 400);
    assert.match(run.data.error, /ilmoittajaa ei ole tunnistettu/);
  });
});
