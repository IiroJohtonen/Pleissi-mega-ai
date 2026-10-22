import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { addDays, helsinkiIso, helsinkiParts } from "../src/util.js";
import { ADMIN_EMAIL, call, login, PASSWORD, startServer, type TestServer } from "./helpers.js";

type ToolCall = { name: string; input: Record<string, unknown> };
type Request = { messages: { role: string; content: string | { type: string; content?: unknown; text?: string }[] }[] };

// Valepalvelin Anthropicin rajapinnan tilalle: vastaa AI-agentin pyyntöihin käsikirjoituksen mukaan, jotta
// agentin koko kulku voidaan testata ilman oikeaa AI:ta. script saa pyynnön ja palauttaa seuraavan
// työkalukutsun tai null, jolloin agentti lopettaa.
function fakeAnthropic(script: (request: Request, lastResult: string, firstMessage: string) => ToolCall | null) {
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
      const call = script(request, lastResult, firstMessage);
      calls++;
      res.setHeader("Content-Type", "application/json");
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
      // Muu asia: henkilökunnalle.
      if (!lastResult) return { name: "hand_over_to_staff", input: { reason: "Vikailmoitus kuuluu huollolle." } };
      return null;
    });
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

  it("tarjoaa vapaita vuoroja varatun tilalle ja varaa asukkaan valitseman vuoron", async () => {
    assert.equal((await call(server, liisa, "POST", "/portal/bookings", {
      resource: "sauna", startsAt: requested, endsAt: new Date(Date.parse(requested) + 3600_000).toISOString()
    })).status, 201);

    const created = await call(server, matti, "POST", "/portal/tickets", {
      subject: "Sauna", description: `Haluaisin saunavuoron ${day} klo 18.`, type: "Pyyntö", attachments: []
    });
    assert.equal(created.status, 201);
    const ticketId = created.data.ticketId;

    // Agentti vastaa asukkaalle ja jää odottamaan valintaa AI tehtävissä.
    const proposed = await waitFor(ticketId, detail => detail.ticket.ai_action === "ai");
    assert.equal(proposed.ticket.status, "waiting_third_party");
    assert.equal(offered.length, 2);
    // Tarjotut vuorot ovat vapaita ja alkavat aikaisintaan pyydettynä päivänä.
    assert.ok(offered.every(startsAt => startsAt !== requested && startsAt >= helsinkiIso(day, 0)));
    const reply = proposed.messages.find((message: any) => message.direction === "outbound");
    assert.match(reply.body, /Vapaita vuoroja/);
    assert.match(reply.body, /automaattinen vastaus/);
    // Asukas näkee vastauksen portaalissa.
    const portal = (await call(server, matti, "GET", `/portal/tickets/${ticketId}`)).data;
    assert.ok(portal.messages.some((message: any) => message.direction === "outbound"));

    // Asukas valitsee ensimmäisen vuoron; agentti varaa sen ja sulkee tehtävän.
    assert.equal((await call(server, matti, "POST", `/portal/tickets/${ticketId}/messages`, { body: "Käy ensimmäinen", attachments: [] })).status, 201);
    const closed = await waitFor(ticketId, detail => detail.ticket.status === "closed");
    assert.equal(closed.ticket.ai_action, "ai");
    const bookings = (await call(server, matti, "GET", `/portal/bookings?resource=sauna&from=${encodeURIComponent(helsinkiIso(day, 0))}&to=${encodeURIComponent(helsinkiIso(addDays(day, 5), 0))}`)).data as any[];
    assert.deepEqual(bookings.filter(booking => booking.mine).map(booking => booking.starts_at), [offered[0]]);
    assert.ok(closed.audit.some((entry: any) => entry.action === "ai_agent_booked"));
  });

  it("ei varaa vuoroa, jota asukkaalle ei ole tarjottu", async () => {
    const created = await call(server, matti, "POST", "/portal/tickets", {
      subject: "Pyykkitupa", description: "Varaatko minulle pyykkitupa-ajan?", type: "Pyyntö", attachments: []
    });
    const detail = await waitFor(created.data.ticketId, logged("ai_agent_handover"));
    assert.ok(!logged("ai_agent_booked")(detail));
    assert.equal(detail.ticket.status, "open");
  });

  it("jättää muut asiat henkilökunnalle vastaamatta asukkaalle", async () => {
    const created = await call(server, matti, "POST", "/portal/tickets", {
      subject: "Hana vuotaa", description: "Keittiön hana tippuu.", type: "Vikailmoitus", attachments: []
    });
    const detail = await waitFor(created.data.ticketId, logged("ai_agent_handover"));
    assert.equal(detail.ticket.status, "open");
    assert.equal(detail.ticket.ai_action, "pending_decision");
    assert.ok(!detail.messages.some((message: any) => message.direction === "outbound"));
  });
});
