import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { after, before, describe, it } from "node:test";
import { addDays, helsinkiIso, helsinkiParts } from "../src/util.js";
import { ADMIN_EMAIL, call, login, PASSWORD, startServer, type TestServer } from "./helpers.js";

type ToolCall = { name: string; input: Record<string, unknown> };
type Request = { system?: unknown; messages: { role: string; content: string | { type: string; content?: unknown; text?: string }[] }[] };

// Valepalvelin Anthropicin rajapinnan tilalle (kuten ai-agent.test.ts): agentin portti sallii kaiken, ja agentin
// työkalukutsut tulevat käsikirjoituksesta. Viimeisin työkalun tulos välitetään asukkaan vastaukseen, jotta testi näkee sen.
function fakeAnthropic(script: (lastResult: string, firstMessage: string) => ToolCall | null) {
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
      if (JSON.stringify(request.system ?? "").includes("screen a Finnish housing-company ticket")) {
        res.end(JSON.stringify({
          id: `msg_${calls}`, type: "message", role: "assistant", model: "claude-haiku-5-5",
          content: [{ type: "text", text: JSON.stringify({ category: "none", reason: "" }) }],
          stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
        }));
        return;
      }
      const next = script(lastResult, firstMessage);
      res.end(JSON.stringify({
        id: `msg_${calls}`, type: "message", role: "assistant", model: "claude-opus-5-5",
        content: next ? [{ type: "tool_use", id: `toolu_${calls}`, name: next.name, input: next.input }] : [{ type: "text", text: "Valmis." }],
        stop_reason: next ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
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

describe("AI-agentti: jatkuvat vuorot ja autopaikat", () => {
  let server: TestServer;
  let fake: { url: string; close: () => Promise<void> };
  let admin: string;
  let matti: string;
  let liisa: string;
  let companyId = "";
  // Ensimmäinen viikko alkaa kolmen päivän päästä; Liisan varaus osuu jatkuvan vuoron toiselle viikolle.
  const day = addDays(helsinkiParts(new Date().toISOString()).day, 3);
  const WEEKS = 4;

  before(async () => {
    fake = await fakeAnthropic((lastResult, firstMessage) => {
      const weekly = /vakiovuoro klo (\d+)/.exec(firstMessage);
      if (weekly) {
        if (!lastResult) {
          return { name: "book_slot", input: { resource: "sauna", starts_at: helsinkiIso(day, Number(weekly[1])), weeks: WEEKS, basis: "resident_requested" } };
        }
        return { name: "reply_to_resident", input: { message: lastResult.slice(0, 500), outcome: lastResult.startsWith("Booked") ? "resolved" : "awaiting_resident" } };
      }
      if (firstMessage.includes("autotallin")) {
        if (!lastResult) return { name: "assign_parking_space", input: { parking_type: "Autotalli", basis: "resident_requested" } };
        return { name: "reply_to_resident", input: { message: lastResult.slice(0, 500), outcome: "resolved" } };
      }
      return lastResult ? null : { name: "hand_over_to_staff", input: { reason: "Muu asia." } };
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
    companyId = withDb(db => (db.prepare("SELECT company_id FROM residents WHERE id = 'resident-1'").get() as { company_id: string }).company_id);
  });

  after(async () => {
    await server.stop();
    await fake.close();
  });

  function withDb<T>(work: (db: Database.Database) => T): T {
    const db = new Database(path.join(server.dataDir, "kotilo.sqlite"));
    try {
      return work(db);
    } finally {
      db.close();
    }
  }

  async function runAgent(token: string, subject: string, description: string) {
    const created = await call(server, token, "POST", "/portal/tickets", { subject, description, type: "Pyyntö", attachments: [] });
    assert.equal(created.status, 201);
    const ticketId = created.data.ticketId as string;
    const run = await call(server, admin, "POST", `/tickets/${ticketId}/agent`);
    assert.equal(run.status, 200);
    const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    const reply = detail.messages.filter((message: any) => message.direction === "outbound").map((message: any) => message.body).join("\n");
    return { ticketId, run: run.data, detail, reply };
  }

  const saunaBookings = (residentId: string) => withDb(db => db.prepare(
    "SELECT starts_at, series_id FROM bookings WHERE resident_id = ? AND resource = 'sauna' AND starts_at >= ? ORDER BY starts_at"
  ).all(residentId, helsinkiIso(day, 0)) as { starts_at: string; series_id: string | null }[]);

  it("jatkuvaa vuoroa ei varata lainkaan, jos yksikin viikko menisi toisen varauksen päälle", async () => {
    const taken = helsinkiIso(addDays(day, 7), 19);
    assert.equal((await call(server, liisa, "POST", "/portal/bookings", {
      resource: "sauna", startsAt: taken, endsAt: new Date(Date.parse(taken) + 3600_000).toISOString()
    })).status, 201);

    const { run, reply } = await runAgent(matti, "Sauna", "Haluaisin saunaan vakiovuoro klo 19 joka viikko.");
    assert.equal(run.booked, false);
    assert.match(reply, /these weeks are already booked/);
    // Mitään viikkoa ei varattu, eikä Liisan vuoro muuttunut.
    assert.deepEqual(saunaBookings("resident-1"), []);
    assert.deepEqual(saunaBookings("resident-2").map(booking => booking.starts_at), [taken]);
  });

  it("varaa jatkuvan vuoron jokaiselle viikolle samaan paikalliseen aikaan, kun kaikki viikot ovat vapaina", async () => {
    const { run, detail } = await runAgent(matti, "Sauna", "Haluaisin saunaan vakiovuoro klo 20 joka viikko.");
    assert.equal(run.booked, true);
    const bookings = saunaBookings("resident-1");
    assert.equal(bookings.length, WEEKS);
    assert.ok(bookings.every(booking => booking.series_id && booking.series_id === bookings[0].series_id), "sama sarja");
    assert.deepEqual(bookings.map(booking => helsinkiParts(booking.starts_at).hour), Array(WEEKS).fill(20));
    assert.deepEqual(bookings.map(booking => booking.starts_at), Array.from({ length: WEEKS }, (_, week) => helsinkiIso(addDays(day, week * 7), 20)));
    const booked = detail.audit.find((entry: any) => entry.action === "ai_agent_booked");
    assert.equal(JSON.parse(booked.details).weeks, WEEKS);
  });

  it("ei varaa jatkuvaa vuoroa, kun taloyhtiö ei salli viikoittaisia vuoroja", async () => {
    const rules = (await call(server, admin, "GET", `/companies/${companyId}/booking-settings`)).data;
    assert.equal((await call(server, admin, "PUT", `/companies/${companyId}/booking-settings`, {
      ...rules, sauna: { ...rules.sauna, weekly: false }
    })).status, 200);
    try {
      const { run, reply } = await runAgent(matti, "Sauna", "Haluaisin saunaan vakiovuoro klo 17 joka viikko.");
      assert.equal(run.booked, false);
      assert.match(reply, /Viikoittaisten saunavuorojen varaaminen ei ole käytössä/);
      assert.ok(saunaBookings("resident-1").every(booking => helsinkiParts(booking.starts_at).hour !== 17));
    } finally {
      await call(server, admin, "PUT", `/companies/${companyId}/booking-settings`, rules);
    }
  });

  it("antaa vapaan autotallin vain, kun kukaan ei ole jonossa edellä, eikä anna paikkaa, jolla on jo tuleva haltija", async () => {
    const future = addDays(helsinkiParts(new Date().toISOString()).day, 20);
    withDb(db => {
      db.prepare("DELETE FROM parking_assignments WHERE company_id = ?").run(companyId);
      db.prepare("DELETE FROM parking_spaces WHERE company_id = ?").run(companyId);
      db.prepare("DELETE FROM waitlist WHERE company_id = ? AND resource = 'parking'").run(companyId);
      db.prepare("INSERT OR IGNORE INTO parking_prices (company_id, type, monthly_price) VALUES (?, 'Autotalli', 45)").run(companyId);
      const space = db.prepare("INSERT INTO parking_spaces (id, company_id, label, type, resident_id, note, created_at) VALUES (?, ?, ?, 'Autotalli', NULL, '', ?)");
      // T1 on luvattu Liisalle ensi kuusta alkaen; T2 on vapaa.
      space.run("space-t1", companyId, "T1", new Date().toISOString());
      space.run("space-t2", companyId, "T2", new Date().toISOString());
      db.prepare("INSERT INTO parking_assignments (id, parking_id, company_id, resident_id, start_date) VALUES ('pa-future', 'space-t1', ?, 'resident-2', ?)")
        .run(companyId, future);
      // Liisa jonottaa myös mitä tahansa paikkaa ennen Mattia.
      db.prepare("INSERT INTO waitlist (id, company_id, resource, parking_type, resident_id, note, status, created_at) VALUES ('wait-liisa', ?, 'parking', '', 'resident-2', '', 'waiting', ?)")
        .run(companyId, new Date(Date.now() - 86_400_000).toISOString());
    });
    const holder = (spaceId: string) => withDb(db => (db.prepare("SELECT resident_id FROM parking_spaces WHERE id = ?").get(spaceId) as { resident_id: string | null }).resident_id);

    // Jonossa edellä on toinen asukas: paikkaa ei anneta.
    const blocked = await runAgent(matti, "Autotalli", "Haluaisin vuokrata autotallin.");
    assert.match(blocked.reply, /ahead in the parking queue/);
    assert.equal(holder("space-t2"), null);

    // Jono tyhjenee: Matti saa vapaan T2:n, ei T1:tä, jolla on jo tuleva haltija.
    withDb(db => db.prepare("UPDATE waitlist SET status = 'cancelled' WHERE id = 'wait-liisa'").run());
    const assigned = await runAgent(matti, "Autotalli", "Haluaisin vuokrata autotallin.");
    assert.match(assigned.reply, /Assigned Autotalli T2/);
    assert.equal(holder("space-t2"), "resident-1");
    assert.equal(holder("space-t1"), null);
    assert.ok(assigned.detail.audit.some((entry: any) => entry.action === "ai_agent_parking_assigned"));

    // Toista paikkaa ei anneta asukkaalle, jolla on jo paikka.
    const second = await runAgent(matti, "Autotalli", "Haluaisin vuokrata autotallin.");
    assert.match(second.reply, /already has the space T2/);
    assert.equal(withDb(db => (db.prepare("SELECT COUNT(*) AS count FROM parking_spaces WHERE resident_id = 'resident-1'").get() as { count: number }).count), 1);
  });
});
