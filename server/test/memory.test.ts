import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, PASSWORD, startServer, type TestServer } from "./helpers.js";

// Valepalvelin Anthropicin tilalle: muistiehdotus palauttaa yhden tiedon, vastausehdotus luonnoksen.
// Pyynnöt tallennetaan, jotta nähdään, mitä AI:lle lähti.
function fakeAnthropic(requests: any[]) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body);
      requests.push(request);
      const prompt = JSON.stringify(request);
      const output = prompt.includes("long-term memory")
        ? { notes: [{ text: "B-portaan lämmityslinjan pumppu vaihdettiin, kun portaassa oli kylmä.", topic: "heating", stairwell: "B", sources: [1, 2], validMonths: 12 }] }
        : { draft: "Hei, katsomme asian.", reason: "Luonnos.", sourceId: null };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5",
        content: [{ type: "text", text: JSON.stringify(output) }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 }
      }));
    });
  });
  return new Promise<http.Server>(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("vikahistoria, trendit ja taloyhtiön muisti", () => {
  let server: TestServer;
  let fake: http.Server;
  let admin: string;
  const requests: any[] = [];
  const residents: Record<string, string> = {};
  const tickets: string[] = [];

  before(async () => {
    fake = await fakeAnthropic(requests);
    server = await startServer({ env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` } });
    admin = await login(server, ADMIN_EMAIL);
    for (const apartment of ["B 1", "B 2"]) {
      const email = `memory-${apartment.replace(" ", "").toLowerCase()}@example.com`;
      await call(server, admin, "POST", "/companies/demo-company/residents", {
        name: `Asukas ${apartment}`, email, address: "Koivikkotie 10", apartmentNumber: apartment, password: PASSWORD
      });
      residents[apartment] = await login(server, email);
    }
  });

  after(async () => {
    await server.stop();
    await new Promise(resolve => fake.close(resolve));
  });

  const report = async (apartment: string, description: string) => {
    const created = await call(server, residents[apartment], "POST", "/portal/tickets", { subject: "Kylmä", description, type: "Vikailmoitus", attachments: [] });
    await call(server, admin, "POST", "/incidents/detect");
    return created.data.ticketId as string;
  };

  it("sulkemisen yhteydessä kirjattu ratkaisu tallentuu ja näkyy saman asunnon ja portaan historiassa", async () => {
    tickets.push(await report("B 1", "Patterit kylmiä."));
    const closed = await call(server, admin, "POST", `/tickets/${tickets[0]}/decision`, {
      decision: "skip", reason: "already_handled", resolution: "Huoltoyhtiö ilmasi B-portaan linjan."
    });
    assert.equal(closed.status, 200);
    const detail = (await call(server, admin, "GET", `/tickets/${tickets[0]}`)).data;
    assert.equal(detail.ticket.resolution, "Huoltoyhtiö ilmasi B-portaan linjan.");
    assert.ok(detail.audit.some((entry: any) => entry.action === "resolution_set"));

    tickets.push(await report("B 1", "Taas kylmä."));
    tickets.push(await report("B 2", "Asunnossa on kylmä."));
    const ownHistory = (await call(server, admin, "GET", `/tickets/${tickets[1]}/history`)).data;
    assert.equal(ownHistory.stairwell, "B");
    assert.ok(ownHistory.apartment.some((item: any) => item.id === tickets[0] && item.resolution === "Huoltoyhtiö ilmasi B-portaan linjan."));
    const neighbour = (await call(server, admin, "GET", `/tickets/${tickets[2]}/history`)).data;
    assert.ok(neighbour.stair.some((item: any) => item.id === tickets[0]));
    assert.ok(!neighbour.apartment.length);

    // Ratkaisun voi kirjata ja poistaa myös myöhemmin.
    assert.equal((await call(server, admin, "PUT", `/tickets/${tickets[1]}/resolution`, { resolution: "Termostaatti avattiin." })).status, 200);
    assert.equal((await call(server, admin, "PUT", `/tickets/${tickets[1]}/resolution`, { resolution: "x".repeat(501) })).status, 400);
  });

  it("trendiraportti laskee aiheet kuukausittain ja toistuvat viat", async () => {
    const result = await call(server, admin, "GET", "/reports/trends?companyId=demo-company&months=6");
    assert.equal(result.status, 200);
    assert.equal(result.data.months.length, 6);
    const heating = result.data.topics.find((item: any) => item.topic === "heating");
    assert.ok(heating.series[5] >= 3);
    const repeat = result.data.repeats.find((item: any) => item.kind === "stairwell" && item.place === "B" && item.topic === "heating");
    assert.ok(repeat && repeat.count >= 3);
    assert.ok(result.data.resolution.some((item: any) => item.topic === "heating" && item.closed >= 1));
    assert.equal((await call(server, admin, "GET", "/reports/trends?companyId=other-company")).status, 403);
  });

  it("AI ehdottaa muistiin tiedon ratkaisuista, ja vasta hyväksytty tieto menee vastausehdotukseen", async () => {
    const before = (await call(server, admin, "GET", "/companies/demo-company/memory")).data;
    assert.ok(before.newCases >= 2);

    const proposed = await call(server, admin, "POST", "/companies/demo-company/memory/propose");
    assert.equal(proposed.status, 200, JSON.stringify(proposed.data));
    assert.equal(proposed.data.proposed, 1);
    const memoryPrompt = JSON.stringify(requests.find(request => JSON.stringify(request).includes("long-term memory")));
    assert.match(memoryPrompt, /Huoltoyhtiö ilmasi B-portaan linjan/);

    const listed = (await call(server, admin, "GET", "/companies/demo-company/memory")).data;
    assert.equal(listed.newCases, 0);
    const note = listed.notes[0];
    assert.deepEqual([note.status, note.topic, note.stairwell], ["proposed", "heating", "B"]);
    assert.ok(note.sources.length >= 1);
    assert.ok(note.validUntil);

    // Ehdotus ei vielä vaikuta AI:hin.
    await call(server, admin, "POST", `/tickets/${tickets[2]}/suggest`, {});
    assert.doesNotMatch(JSON.stringify(requests[requests.length - 1]), /pumppu vaihdettiin/);

    // Hyväksytty (ja muokattu) tieto tulee mukaan saman aiheen ja portaan vastausehdotukseen.
    const approved = await call(server, admin, "PUT", `/memory/${note.id}`, {
      text: "B-portaan lämmityslinjan pumppu vaihdettiin 10/2026.", topic: "heating", stairwell: "B", validUntil: null, status: "approved"
    });
    assert.equal(approved.status, 200);
    await call(server, admin, "POST", `/tickets/${tickets[2]}/suggest`, {});
    assert.match(JSON.stringify(requests[requests.length - 1]), /pumppu vaihdettiin 10\/2026/);

    // Ilman uusia ratkaisuja AI:ta ei kutsuta.
    const calls = requests.length;
    const again = await call(server, admin, "POST", "/companies/demo-company/memory/propose");
    assert.deepEqual([again.data.proposed, again.data.cases], [0, 0]);
    assert.equal(requests.length, calls);
  });

  it("isännöitsijä voi lisätä, hylätä ja poistaa tietoja", async () => {
    const added = await call(server, admin, "POST", "/companies/demo-company/memory", {
      text: "Hissin huolto on joka kuukauden ensimmäinen maanantai.", topic: "elevator", stairwell: "", validUntil: null
    });
    assert.equal(added.status, 201);
    assert.deepEqual([added.data.status, added.data.origin], ["approved", "manual"]);
    assert.equal((await call(server, admin, "POST", "/companies/demo-company/memory", { text: "x", topic: null, stairwell: "", validUntil: null })).status, 400);
    const rejected = await call(server, admin, "PUT", `/memory/${added.data.id}`, { ...added.data, status: "rejected" });
    assert.equal(rejected.data.status, "rejected");
    assert.equal((await call(server, admin, "DELETE", `/memory/${added.data.id}`)).status, 200);
    const listed = (await call(server, admin, "GET", "/companies/demo-company/memory")).data;
    assert.ok(!listed.notes.some((item: any) => item.id === added.data.id));
  });
});
