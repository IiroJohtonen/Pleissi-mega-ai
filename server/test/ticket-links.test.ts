import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, inbound, login, PASSWORD, startServer, tempDir, type TestServer } from "./helpers.js";

// Ilmoitusten yhdistäminen, aiheiden avainsanat (melu, turvallisuus) ja AI-agentin rajaus häiriö- ja
// turvallisuusilmoituksiin. Ilman AI:ta: aihe tulee avainsanoista.

describe("aiheiden avainsanat", () => {
  let classifyTopic: typeof import("../src/incidents.js").classifyTopic;
  before(async () => {
    process.env.DATA_DIR = await tempDir("kotilo-topics-");
    process.env.GMAIL_DISABLED = "1";
    ({ classifyTopic } = await import("../src/incidents.js"));
  });

  it("tunnistaa melun uudet sanat ja turvallisuuden", () => {
    for (const text of ["Naapuri kiroilee ja huutaa rapussa", "Yläkerrassa riehutaan öisin", "Asunnossa tapellaan"]) assert.equal(classifyTopic(text), "noise", text);
    for (const text of ["Kellarissa oli murto yöllä", "Pihalla epäilyttävä auto", "Polkupyöräni varastettiin", "Ilkivaltaa porraskäytävässä"]) {
      assert.equal(classifyTopic(text), "safety", text);
    }
    assert.notEqual(classifyTopic("Haluaisin vuokrata varastokopin"), "safety");
  });
});

describe("ilmoitusten yhdistäminen", () => {
  let server: TestServer;
  let admin: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-1", {
      name: "Matti Meikäläinen", email: "matti@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12", password: PASSWORD
    });
  });

  after(async () => {
    await server.stop();
  });

  async function report(subject: string, body: string, sender = "matti@example.com") {
    const created = await inbound(server, admin, { companyId: "demo-company", senderName: "Matti", senderEmail: sender, subject, body, channel: "email" });
    assert.equal(created.status, 201);
    const ticketId = created.data.ticketId as string;
    // Aihe päätellään taustalla.
    for (let attempt = 0; attempt < 50; attempt++) {
      const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
      if (detail.ticket.topic) return ticketId;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return ticketId;
  }

  it("ehdottaa saman asukkaan avointa samanaiheista tehtävää 14 päivän sisällä ja yhdistää yhdellä klikkauksella", async () => {
    const first = await report("Patteri kylmä", "Olohuoneen patteri on kylmä.");
    const second = await report("Edelleen kylmä", "Lämmitys ei toimi vieläkään, patteri kylmä.");
    const other = await report("Hissi", "Hissi on rikki.");
    const suggestion = (await call(server, admin, "GET", `/tickets/${second}/merge-suggestion`)).data.candidate;
    assert.equal(suggestion.id, first);
    assert.equal((await call(server, admin, "GET", `/tickets/${other}/merge-suggestion`)).data.candidate, null, "eri aihe");

    const merged = await call(server, admin, "POST", `/tickets/${second}/merge`, { intoTicketId: first });
    assert.equal(merged.status, 200);
    const target = (await call(server, admin, "GET", `/tickets/${first}`)).data;
    assert.equal(target.messages.filter((message: any) => message.direction === "inbound").length, 2);
    assert.ok(target.audit.some((entry: any) => entry.action === "ticket_merged_from"));
    const source = (await call(server, admin, "GET", `/tickets/${second}`)).data;
    assert.deepEqual([source.ticket.merged_into, source.ticket.status], [first, "closed"]);
    assert.equal(source.messages.length, 0);
    assert.equal((await call(server, admin, "POST", `/tickets/${second}/merge`, { intoTicketId: first })).status, 409);
    assert.equal((await call(server, admin, "GET", `/tickets/${second}/merge-suggestion`)).data.candidate, null);
  });

  it("ei ehdota yli 14 päivää vanhaa, suljettua eikä toisen lähettäjän tehtävää", async () => {
    const old = await report("Ovi ei lukitu", "Ulko-ovi ei mene lukkoon.");
    const db = new Database(path.join(server.dataDir, "kotilo.sqlite"));
    try {
      db.prepare("UPDATE tickets SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 15 * 86_400_000).toISOString(), old);
    } finally {
      db.close();
    }
    const fresh = await report("Ovi ei lukitu taas", "Ulko-ovi ei vieläkään mene lukkoon.");
    assert.equal((await call(server, admin, "GET", `/tickets/${fresh}/merge-suggestion`)).data.candidate, null);
    const stranger = await report("Ovi auki", "Rapun ovi ei mene lukkoon.", "vieras@example.com");
    assert.equal((await call(server, admin, "GET", `/tickets/${stranger}/merge-suggestion`)).data.candidate, null);
  });

  it("AI-agentti ei käsittele häiriö- eikä turvallisuusilmoituksia", async () => {
    const office = (await call(server, admin, "GET", "/office")).data;
    assert.equal((await call(server, admin, "PUT", "/office", { name: office.name, aiAgent: true })).status, 200);
    const noise = await report("Meteli", "Naapurissa on meteliä joka yö.");
    const safety = await report("Murto", "Kellarikomeroon on tehty murto.");
    const noiseRun = await call(server, admin, "POST", `/tickets/${noise}/agent`);
    assert.deepEqual([noiseRun.status, noiseRun.data.error], [400, "Häiriöilmoitus kuuluu aina henkilökunnalle."]);
    assert.equal((await call(server, admin, "POST", `/tickets/${safety}/agent`)).data.error, "Turvallisuusilmoitus kuuluu aina henkilökunnalle.");
  });
});
