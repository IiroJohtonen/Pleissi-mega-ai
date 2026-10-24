import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { classifyTopic } from "../src/incidents.js";
import { ADMIN_EMAIL, call, login, PASSWORD, startServer, type TestServer } from "./helpers.js";

describe("tehtävän aihe", () => {
  it("päättelee aiheen tekstistä", () => {
    assert.equal(classifyTopic("Asunnossa on kylmä, patterit eivät lämpene"), "heating");
    assert.equal(classifyTopic("Hanasta tulee vain kylmää vettä, lämmintä vettä ei tule"), "hot_water");
    assert.equal(classifyTopic("Hissi on jumissa"), "elevator");
    assert.equal(classifyTopic("Lattiakaivo tulvii"), "drain");
    assert.equal(classifyTopic("Kosteusläikkä katossa"), "water_leak");
    assert.equal(classifyTopic("Haluaisin varata saunavuoron"), "booking");
    // "ovi" tunnistetaan vain kokonaisena sanana.
    assert.equal(classifyTopic("Ulko-ovi ei mene lukkoon"), "door");
    assert.equal(classifyTopic("Kovin hyvä palvelu, kiitos"), "other");
  });
});

describe("yhteiset viat", () => {
  let server: TestServer;
  let admin: string;
  const residents: Record<string, string> = {};

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    for (const apartment of ["B 1", "B 2", "B 3", "A 1"]) {
      const email = `${apartment.replace(" ", "").toLowerCase()}@example.com`;
      const created = await call(server, admin, "POST", "/companies/demo-company/residents", {
        name: `Asukas ${apartment}`, email, address: "Koivikkotie 10", apartmentNumber: apartment, password: PASSWORD
      });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      residents[apartment] = await login(server, email);
    }
    // Testiaineistossa B 34 on jo ilmoittanut kylmistä pattereista; se siirretään muuksi aiheeksi, jotta
    // testi laskee vain omat ilmoituksensa.
    await call(server, admin, "POST", "/incidents/detect");
    const tickets = (await call(server, admin, "GET", "/tickets?companyId=all")).data as any[];
    for (const ticket of tickets.filter(item => item.topic === "heating")) {
      assert.equal((await call(server, admin, "PUT", `/tickets/${ticket.id}/fields`, { topic: "other" })).status, 200);
    }
  });

  after(async () => {
    await server.stop();
  });

  async function report(apartment: string, subject: string, description: string) {
    const created = await call(server, residents[apartment], "POST", "/portal/tickets", { subject, description, type: "Vikailmoitus", attachments: [] });
    assert.equal(created.status, 201);
    // Tunnistus ajetaan taustalla; detect odottaa, että se on valmis.
    await call(server, admin, "POST", "/incidents/detect");
    return created.data.ticketId as string;
  }
  const active = async () => (await call(server, admin, "GET", "/incidents")).data as any[];

  let incidentId = "";
  const ticketIds: string[] = [];

  it("kolme saman portaan asuntoa samasta aiheesta tekee poikkeaman", async () => {
    ticketIds.push(await report("B 1", "Kylmä asunto", "Asunnossa on kylmä, vain 17 astetta."));
    // Saman asunnon toinen ilmoitus ei lisää ilmoittajia.
    ticketIds.push(await report("B 1", "Edelleen kylmä", "Patterit ovat kylmiä."));
    ticketIds.push(await report("B 2", "Patterit kylmiä", "Patterit eivät lämpene."));
    assert.deepEqual(await active(), []);

    ticketIds.push(await report("B 3", "Kylmää", "Asunnossa on kylmä."));
    const [incident] = await active();
    assert.ok(incident);
    incidentId = incident.id;
    assert.equal(incident.topic, "heating");
    assert.equal(incident.stairwell, "B");
    assert.equal(incident.status, "open");
    assert.equal(incident.reporters, 3);
    assert.deepEqual(incident.tickets.map((ticket: any) => ticket.id).sort(), [...ticketIds].sort());
    assert.match(incident.summary, /3 asuntoa B-portaasta \(B 1, B 2, B 3\)/);
    assert.match(incident.drafts.workOrder, /B-portaan/);

    const detail = (await call(server, admin, "GET", `/tickets/${ticketIds[0]}`)).data;
    assert.equal(detail.ticket.topic, "heating");
    assert.equal(detail.ticket.topic_source, "keywords");
    assert.equal((await call(server, admin, "GET", `/tickets/${ticketIds[0]}/incident`)).data.id, incidentId);
  });

  it("toisen portaan ilmoitus liitetään samaan poikkeamaan, joka laajenee koko taloyhtiöön", async () => {
    const ticketId = await report("A 1", "Lämmitys", "Täälläkin on kylmä.");
    const [incident] = await active();
    assert.equal(incident.id, incidentId);
    assert.equal(incident.stairwell, "");
    assert.ok(incident.tickets.some((ticket: any) => ticket.id === ticketId));
    ticketIds.push(ticketId);
  });

  it("vastaa avoimiin ja uusiin ilmoituksiin poikkeaman viestillä", async () => {
    const message = "Lämmitysvika on tiedossa ja huoltoyhtiö selvittää sitä.";
    const saved = await call(server, admin, "PUT", `/incidents/${incidentId}/reply`, { message, autoReply: true, replyNow: true });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.replied, ticketIds.length);
    const detail = (await call(server, admin, "GET", `/tickets/${ticketIds[2]}`)).data;
    assert.equal(detail.ticket.status, "waiting_third_party");
    assert.ok(detail.messages.some((item: any) => item.direction === "outbound" && item.body.includes(message)));

    // Uuteen samanaiheiseen ilmoitukseen vastataan heti automaattisesti.
    const late = await report("B 2", "Kylmä", "Asunnossa on kylmä vieläkin.");
    const lateDetail = (await call(server, admin, "GET", `/tickets/${late}`)).data;
    assert.equal(lateDetail.ticket.status, "waiting_third_party");
    assert.ok(lateDetail.messages.some((item: any) => item.direction === "outbound" && item.body.includes(message)));
    assert.ok(lateDetail.audit.some((item: any) => item.action === "incident_replied"));
    ticketIds.push(late);
  });

  it("AI-agentti vastaa poikkeaman viestillä ilman AI-kutsua", async () => {
    const office = (await call(server, admin, "GET", "/office")).data;
    assert.equal((await call(server, admin, "PUT", "/office", { name: office.name, aiAgent: true })).status, 200);
    await call(server, admin, "PUT", `/incidents/${incidentId}/reply`, { message: "Vika on tiedossa ja sitä korjataan.", autoReply: false });
    const ticketId = await report("B 3", "Kylmä taas", "Patterit kylmiä.");
    const run = await call(server, admin, "POST", `/tickets/${ticketId}/agent`);
    assert.equal(run.status, 200, JSON.stringify(run.data));
    assert.equal(run.data.outcome, "replied");
    const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.ok(detail.messages.some((item: any) => item.direction === "outbound" && item.body.includes("Vika on tiedossa ja sitä korjataan.")));
    assert.equal(detail.ticket.status, "waiting_third_party");
    ticketIds.push(ticketId);
  });

  it("irrotettu ilmoitus ei palaa poikkeamaan", async () => {
    const removed = await call(server, admin, "DELETE", `/incidents/${incidentId}/tickets/${ticketIds[1]}`);
    assert.equal(removed.status, 200);
    await call(server, admin, "POST", "/incidents/detect");
    const [incident] = await active();
    assert.ok(!incident.tickets.some((ticket: any) => ticket.id === ticketIds[1]));
    const detail = (await call(server, admin, "GET", `/tickets/${ticketIds[1]}`)).data;
    assert.deepEqual([detail.ticket.topic, detail.ticket.topic_source], ["other", "manual"]);
  });

  it("korjattu poikkeama sulkee ilmoitukset viestin kera", async () => {
    const resolved = await call(server, admin, "POST", `/incidents/${incidentId}/resolve`, { message: "Lämmitys on korjattu." });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
    assert.equal(resolved.data.incident.status, "resolved");
    for (const ticketId of ticketIds.filter((_, index) => index !== 1)) {
      const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
      assert.equal(detail.ticket.status, "closed");
      assert.ok(detail.messages.some((item: any) => item.body.includes("Lämmitys on korjattu.")));
    }
    // Irrotettu ilmoitus jäi auki.
    assert.notEqual((await call(server, admin, "GET", `/tickets/${ticketIds[1]}`)).data.ticket.status, "closed");
    assert.deepEqual(await active(), []);
  });

  it("käsittelijä voi vaihtaa aiheen, ja tunnistuksen voi kytkeä pois", async () => {
    const ticketId = await report("A 1", "Hissi", "Hissi on rikki.");
    assert.equal((await call(server, admin, "PUT", `/tickets/${ticketId}/fields`, { topic: "door" })).status, 200);
    const detail = (await call(server, admin, "GET", `/tickets/${ticketId}`)).data;
    assert.deepEqual([detail.ticket.topic, detail.ticket.topic_source], ["door", "manual"]);
    assert.equal((await call(server, admin, "PUT", `/tickets/${ticketId}/fields`, { topic: "unknown" })).status, 400);

    const office = (await call(server, admin, "GET", "/office")).data;
    assert.equal((await call(server, admin, "PUT", "/office", { name: office.name, incidentDetection: false })).status, 200);
    await report("B 1", "Hissi", "Hissi ei toimi.");
    await report("B 2", "Hissi", "Hissi on jumissa.");
    assert.deepEqual(await active(), []);
  });
});

describe("yhteisen vian AI-tulkinta", () => {
  let server: TestServer;
  let fake: http.Server;
  let admin: string;
  let request: any = null;
  const interpretation = {
    summary: "Kolme B-portaan asuntoa ilmoittaa kylmästä.", likelyCause: "Todennäköisesti B-portaan lämmityslinjan vika.",
    actions: ["Tilaa huoltoyhtiö tarkistamaan B-portaan linja."], workOrder: "Tarkistakaa B-portaan lämmityslinja.",
    announcementTitle: "Lämmitysvika B-portaassa", announcementBody: "Vika on tiedossa.", reply: "Vika on tiedossa, kiitos ilmoituksesta."
  };

  before(async () => {
    fake = http.createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        request = JSON.parse(body);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5",
          content: [{ type: "text", text: JSON.stringify(interpretation) }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 }
        }));
      });
    });
    await new Promise<void>(resolve => fake.listen(0, "127.0.0.1", () => resolve()));
    server = await startServer({ env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` } });
    admin = await login(server, ADMIN_EMAIL);
  });

  after(async () => {
    await server.stop();
    await new Promise(resolve => fake.close(resolve));
  });

  it("tallentaa tulkinnan ja luonnokset, eikä lähetä arkaluonteisen ilmoituksen tekstiä", async () => {
    const tickets: string[] = [];
    for (const apartment of ["B 1", "B 2", "B 3"]) {
      const email = `ai-${apartment.replace(" ", "").toLowerCase()}@example.com`;
      await call(server, admin, "POST", "/companies/demo-company/residents", {
        name: `Asukas ${apartment}`, email, address: "Koivikkotie 10", apartmentNumber: apartment, password: PASSWORD
      });
      const token = await login(server, email);
      const description = apartment === "B 3" ? "Patterit kylmiä, olen raskaana ja palelen." : "Asunnossa on kylmä.";
      tickets.push((await call(server, token, "POST", "/portal/tickets", { subject: "Kylmä", description, type: "Vikailmoitus", attachments: [] })).data.ticketId);
    }
    await call(server, admin, "POST", "/incidents/detect");
    const incident = ((await call(server, admin, "GET", "/incidents")).data as any[]).find(item => item.topic === "heating" && item.stairwell === "B");
    assert.ok(incident);

    const result = await call(server, admin, "POST", `/incidents/${incident.id}/interpret`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.deepEqual(result.data.ai, interpretation);
    const prompt = JSON.stringify(request.messages);
    assert.match(prompt, /Asunnossa on kylmä/);
    assert.doesNotMatch(prompt, /raskaana/);
  });
});
