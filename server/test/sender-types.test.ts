import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, inbound, localDate, login, PASSWORD, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

// Muiden kuin asukkaiden yhteydenotot: AI:n lähettäjätyyppi samasta arviointikutsusta, toimiston domainlista,
// viranomaisen ohjaus, käsittelijän korjaus, agentin rajaus ja vastausehdotuksen ohjeet. Claude korvataan
// paikallisella palvelimella.
describe("lähettäjätyypit", () => {
  let server: TestServer;
  let claude: http.Server;
  let admin: string;
  let service: string;
  const requests: any[] = [];
  const deadline = localDate(2);

  before(async () => {
    claude = http.createServer((req, res) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        requests.push(body);
        const system = JSON.stringify(body.system ?? "");
        const message = JSON.stringify(body.messages);
        const reply = (value: unknown) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "msg_test", type: "message", role: "assistant", model: body.model,
            content: [{ type: "text", text: JSON.stringify(value) }],
            stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }
          }));
        };
        if (system.includes("reply draft")) {
          reply({ draft: "Isännöitsijäntodistuksen voi tilata toimistolta.", reason: "Dokumentaation ohje.", sourceId: null });
          return;
        }
        const authority = message.includes("Rakennusvalvonta");
        const broker = message.includes("Kiinteistönvälitys");
        reply({
          relevant: true, relevanceReason: "Koskee taloyhtiötä.", priority: "normal", reason: "Tavallinen asia.",
          topic: "other", targetApartment: null,
          senderType: authority ? "authority" : broker ? "broker" : message.includes("Kaupunki") ? "other" : "resident",
          request: broker ? (message.includes("asunnon A 12") ? "apartment_specific" : "general") : "none",
          deadline: authority ? deadline : null
        });
      });
    });
    await new Promise<void>(resolve => claude.listen(0, "127.0.0.1", resolve));
    const { port } = claude.address() as AddressInfo;
    server = await startServer({ env: { ANTHROPIC_API_KEY: "testiavain", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } });
    admin = await login(server, ADMIN_EMAIL);
    service = await login(server, SERVICE_EMAIL);
    await call(server, admin, "PUT", "/office", { name: "Testitoimisto", aiPriority: true, aiAgent: true });
    await call(server, admin, "PUT", "/residents/resident-1", {
      name: "Matti Meikäläinen", email: "matti@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12", password: PASSWORD
    });
  });

  after(async () => {
    await server.stop();
    await new Promise(resolve => claude.close(resolve));
  });

  async function receive(senderEmail: string, subject: string, body: string) {
    const created = await inbound(server, admin, { companyId: "demo-company", senderName: "Lähettäjä", senderEmail, subject, body, channel: "email" });
    assert.equal(created.status, 201);
    return (await call(server, admin, "GET", `/tickets/${created.data.ticketId}`)).data;
  }

  it("viranomainen: kiireellinen, määräaika viestistä ja agentti ei käsittele", async () => {
    const detail = await receive("tarkastaja@example.org", "Rakennusvalvonta: selvityspyyntö", `Rakennusvalvonta pyytää selvitystä ${deadline} mennessä.`);
    assert.deepEqual([detail.ticket.sender_type, detail.ticket.sender_type_source], ["authority", "ai"]);
    assert.equal(detail.ticket.priority, "urgent");
    assert.equal(detail.ticket.due_date, deadline);
    assert.ok(detail.audit.some((entry: any) => entry.action === "sender_type_classified"));
    // Arviointikutsu pyysi lähettäjätyypin samassa kutsussa kuin prioriteetin.
    assert.ok(requests.some(request => JSON.stringify(request.system).includes("senderType")));
  });

  it("asukasrekisterin rooli ratkaisee asukkaan ja osakkaan, vaikka AI arvioisi toisin", async () => {
    const roles = (value: string[]) => call(server, admin, "PUT", "/residents/resident-1", {
      name: "Matti Meikäläinen", email: "matti@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12", roles: value
    });
    try {
      assert.equal((await roles(["osakas"])).status, 200);
      // AI arvioi lähettäjän asukkaaksi, mutta rekisterissä hän on vain osakas.
      const owner = await receive("matti@example.com", "Vuokralainen", "Miten ilmoitan uuden vuokralaisen?");
      assert.deepEqual([owner.ticket.sender_type, owner.ticket.sender_type_source], ["owner", "register"]);
      assert.equal((await roles(["osakas", "asukas"])).status, 200);
      // Molempia: AI:n arvio asukkaan ja osakkaan välillä ratkaisee.
      const both = await receive("matti@example.com", "Sauna", "Saunan lauteet ovat rikki.");
      assert.equal(both.ticket.sender_type, "resident");
    } finally {
      await roles(["asukas"]);
    }
  });

  it("tunnistettu asukas saa tyypin asukas; korjaus viranomaiseksi estää agentin", async () => {
    const detail = await receive("matti@example.com", "Saunavuoro", "Voisinko varata saunavuoron perjantaille?");
    assert.deepEqual([detail.ticket.sender_type, detail.ticket.sender_type_source], ["resident", "register"]);
    assert.equal((await call(server, admin, "PUT", `/tickets/${detail.ticket.id}/sender-type`, { senderType: "nobody" })).status, 400);
    assert.equal((await call(server, admin, "PUT", `/tickets/${detail.ticket.id}/sender-type`, { senderType: "authority" })).status, 200);
    const after = (await call(server, admin, "GET", `/tickets/${detail.ticket.id}`)).data;
    assert.deepEqual([after.ticket.sender_type, after.ticket.sender_type_source, after.ticket.priority], ["authority", "manual", "urgent"]);
    assert.ok(after.audit.some((entry: any) => entry.action === "sender_type_changed"));
    const agent = await call(server, admin, "POST", `/tickets/${detail.ticket.id}/agent`);
    assert.equal(agent.status, 400);
    assert.match(agent.data.error, /Viranomaisen/);
  });

  it("toimiston tuntema domain ohittaa AI:n arvion; vain pääkäyttäjä muuttaa listaa", async () => {
    assert.equal((await call(server, service, "PUT", "/office/sender-domains", [{ domain: "hel.fi", type: "authority" }])).status, 403);
    assert.equal((await call(server, admin, "PUT", "/office/sender-domains", [{ domain: "ei domain", type: "authority" }])).status, 400);
    const saved = await call(server, admin, "PUT", "/office/sender-domains", [{ domain: "@HEL.fi", type: "authority" }]);
    assert.deepEqual(saved.data, [{ domain: "hel.fi", type: "authority" }]);
    assert.deepEqual((await call(server, service, "GET", "/office/sender-domains")).data, saved.data);

    const detail = await receive("kirjaamo@posti.hel.fi", "Kaupunki tiedottaa", "Kaupunki tiedottaa katutöistä.");
    assert.deepEqual([detail.ticket.sender_type, detail.ticket.sender_type_source], ["authority", "domain"]);
    assert.equal(detail.ticket.priority, "urgent");
  });

  it("välittäjän yleinen kysymys: luonnos dokumentaatiosta eikä asukkaiden tietoja AI:lle", async () => {
    const detail = await receive("myynti@valitys.example", "Isännöitsijäntodistus", "Kiinteistönvälitys: miten tilaan isännöitsijäntodistuksen?");
    assert.deepEqual([detail.ticket.sender_type, detail.ticket.sender_request], ["broker", "general"]);
    const before = requests.length;
    const suggested = await call(server, admin, "POST", `/tickets/${detail.ticket.id}/suggest`, {});
    assert.equal(suggested.status, 200);
    const prompt = JSON.stringify(requests.slice(before).find(request => JSON.stringify(request.system).includes("reply draft"))?.messages);
    assert.match(prompt, /NOT identified as a resident/);
    assert.match(prompt, /kiinteistönvälittäjä/);
    // Tunnistamattomalle lähettäjälle ei anneta taloyhtiön muistia.
    assert.match(prompt, /Housing company memory[^]*?\(none\)/);
  });

  it("välittäjän asuntoa koskeva pyyntö: luonnos pyytää osakkaan valtuutuksen", async () => {
    const detail = await receive("myynti@valitys.example", "Asunnon tiedot", "Kiinteistönvälitys: kertoisitteko asunnon A 12 remonteista?");
    assert.equal(detail.ticket.sender_request, "apartment_specific");
    const before = requests.length;
    await call(server, admin, "POST", `/tickets/${detail.ticket.id}/suggest`, {});
    const prompt = JSON.stringify(requests.slice(before).find(request => JSON.stringify(request.system).includes("reply draft"))?.messages);
    assert.match(prompt, /osakkaan valtuutus/);
  });
});
