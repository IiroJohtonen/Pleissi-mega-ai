import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  ADMIN_EMAIL, call, localDate, login, MANAGER_EMAIL, SERVICE_EMAIL, startServer, tempDir, type TestServer
} from "./helpers.js";

describe("AI-kulujen raja", () => {
  // Moduuli lukee tietokannan DATA_DIR-kansiosta, joten se ladataan vasta, kun kansio on asetettu.
  let budget: typeof import("../src/ai-budget.js");
  let alerts: typeof import("../src/alerts.js");
  let db: typeof import("../src/db.js")["db"];

  before(async () => {
    process.env.DATA_DIR = await tempDir();
    process.env.GMAIL_DISABLED = "1";
    process.env.ALERT_EMAIL = "";
    budget = await import("../src/ai-budget.js");
    alerts = await import("../src/alerts.js");
    ({ db } = await import("../src/db.js"));
  });

  it("arvioi kulun mallin hinnaston mukaan", () => {
    assert.equal(budget.estimateCost("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 100_000 }), 4 + 2);
    assert.equal(budget.estimateCost("claude-haiku-5-5", { input_tokens: 1_000_000 }), 0.1);
    // Välimuistista luettu syöte maksaa kymmenesosan.
    assert.ok(Math.abs(budget.estimateCost("claude-sonnet-5-5", { cache_read_input_tokens: 1_000_000 }) - 0.2) < 1e-9);
    // Tuntematon malli arvioidaan kalleimman mukaan.
    assert.equal(budget.estimateCost("tuntematon", { output_tokens: 1_000_000 }), 50);
  });

  it("varoittaa rajan lähestyessä ja sulkee AI:n, kun raja täyttyy", () => {
    db.prepare("UPDATE office_settings SET ai_monthly_limit = 10, ai_warning_percent = 80 WHERE id = 1").run();
    assert.equal(budget.aiBudgetExhausted(), false);

    // 1,5 M syötetokenia Opuksella = 6 $ (60 %): ei vielä varoitusta.
    budget.recordAiUsage("suggest", "claude-opus-5-5", { input_tokens: 1_500_000, output_tokens: 0 });
    assert.equal(alerts.listAlerts().length, 0);

    // +2,5 $ = 8,5 $ (85 %): varoitus.
    budget.recordAiUsage("assess", "claude-opus-5-5", { input_tokens: 625_000, output_tokens: 0 });
    assert.deepEqual(alerts.listAlerts().map(alert => alert.kind), ["ai-budget-warning"]);
    assert.equal(budget.aiBudgetExhausted(), false);

    // +2 $ = 10,5 $: raja täynnä, AI pois käytöstä ja oma hälytys.
    budget.recordAiUsage("topics", "claude-opus-5-5", { input_tokens: 0, output_tokens: 100_000 });
    assert.equal(budget.aiBudgetExhausted(), true);
    assert.ok(alerts.listAlerts().some(alert => alert.kind === "ai-budget-limit" && !alert.resolved_at));
    // Samaa ilmoitusta ei lähetetä uudelleen saman kuun aikana.
    budget.recordAiUsage("topics", "claude-opus-5-5", { input_tokens: 0, output_tokens: 1000 });
    assert.equal(alerts.listAlerts().filter(alert => alert.kind === "ai-budget-limit").length, 1);

    const summary = budget.aiUsageSummary();
    assert.equal(summary.calls, 4);
    assert.equal(summary.exhausted, true);
    assert.deepEqual(summary.byFeature.map(row => row.feature).sort(), ["assess", "suggest", "topics"]);

    // Rajan nosto palauttaa AI:n ja kuittaa rajahälytyksen.
    db.prepare("UPDATE office_settings SET ai_monthly_limit = 100 WHERE id = 1").run();
    budget.refreshBudgetAlerts();
    assert.equal(budget.aiBudgetExhausted(), false);
    assert.equal(alerts.listAlerts().filter(alert => !alert.resolved_at).length, 0);

    // 0 = ei rajaa.
    db.prepare("UPDATE office_settings SET ai_monthly_limit = 0 WHERE id = 1").run();
    assert.equal(budget.aiBudgetExhausted(), false);
  });

  it("toistuva hälytys päivittää avointa riviä eikä luo uutta", () => {
    alerts.raiseAlert("test", "Testihälytys", "eka");
    alerts.raiseAlert("test", "Testihälytys", "toka");
    const rows = alerts.listAlerts().filter(alert => alert.kind === "test");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
    assert.equal(rows[0].details, "toka");
    alerts.resolveAlert("test");
    alerts.raiseAlert("test", "Testihälytys", "uusi");
    assert.equal(alerts.listAlerts().filter(alert => alert.kind === "test").length, 2);
  });
});

describe("raportit, hallituksen näkymä ja järjestelmän tila", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;
  let service: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
    service = await login(server, SERVICE_EMAIL);
  });

  after(async () => {
    await server.stop();
  });

  async function inbound(subject: string, id: string) {
    return (await call(server, admin, "POST", "/inbound/messages", {
      companyId: "demo-company", senderName: "Matti", senderEmail: "matti@example.com",
      subject, body: `${subject}, korjatkaa pian.`, sourceMessageId: `<${id}@example.com>`
    })).data.ticketId as string;
  }

  it("laskee mittarit ryhmittäin ja suljettujen ratkaisuajan", async () => {
    const first = await inbound("Hana vuotaa", "mittari-1");
    await inbound("Ovi jumittaa", "mittari-2");
    const late = await inbound("Valo rikki", "mittari-3");
    await call(server, admin, "PUT", `/tickets/${first}/fields`, { status: "closed" });
    // Määräaika eilen: tehtävä on myöhässä.
    await call(server, admin, "PUT", `/tickets/${late}/fields`, { dueDate: localDate(-1) });

    const report = await call(server, admin, "POST", "/reports/query", { from: localDate(-1), to: localDate(), groupBy: "company" });
    assert.equal(report.status, 200);
    const company = report.data.rows.find((row: any) => row.key === "demo-company");
    assert.ok(company.total >= 3);
    assert.ok(company.closed >= 1);
    assert.ok(company.overdue >= 1);
    assert.equal(company.open, company.total - company.closed);
    assert.equal(typeof company.avgResolutionHours, "number");

    const byStatus = await call(server, admin, "POST", "/reports/query", {
      from: localDate(-1), to: localDate(), groupBy: "status", statuses: ["closed"]
    });
    assert.deepEqual(byStatus.data.rows.map((row: any) => row.key), ["closed"]);

    // Tulevaisuuden aikavälillä ei ole tehtäviä, ja väärinpäin annettu aikaväli hylätään.
    assert.equal((await call(server, admin, "POST", "/reports/query", { from: localDate(5), to: localDate(6) })).data.totals.total, 0);
    assert.equal((await call(server, admin, "POST", "/reports/query", { from: localDate(), to: localDate(-3) })).status, 400);
  });

  it("tallennetun raportin voi muuttaa vain tekijä tai pääkäyttäjä", async () => {
    const config = { range: "30d", groupBy: "type", metrics: ["total", "overdue"] };
    const created = await call(server, manager, "POST", "/reports/saved", { name: "Hallituksen kokous", config });
    assert.equal(created.status, 201);
    assert.equal(created.data.createdByName, "Hanna Lehtonen");

    // Koko toimisto näkee raportin.
    assert.ok((await call(server, service, "GET", "/reports/saved")).data.some((report: any) => report.id === created.data.id));
    assert.equal((await call(server, service, "PUT", `/reports/saved/${created.data.id}`, { name: "Muutettu", config })).status, 403);
    assert.equal((await call(server, service, "DELETE", `/reports/saved/${created.data.id}`)).status, 403);
    assert.equal((await call(server, admin, "PUT", `/reports/saved/${created.data.id}`, { name: "Kokous", config })).data.name, "Kokous");
    assert.equal((await call(server, manager, "POST", "/reports/saved", { name: "", config })).status, 400);
    assert.equal((await call(server, manager, "DELETE", `/reports/saved/${created.data.id}`)).status, 200);
  });

  it("hallituksen jäsen näkee oman yhtiönsä tiedot ilman asukkaiden henkilötietoja eikä muuta", async () => {
    assert.equal((await call(server, service, "POST", "/companies/demo-company/board-members", {
      name: "Pekka Puheenjohtaja", email: "pekka@example.com", password: "Hallitus-2026"
    })).status, 403);
    assert.equal((await call(server, manager, "POST", "/companies/demo-company/board-members", {
      name: "Pekka", email: "pekka@example.com", password: "lyhyt"
    })).status, 400);
    const created = await call(server, manager, "POST", "/companies/demo-company/board-members", {
      name: "Pekka Puheenjohtaja", email: "pekka@example.com", password: "Hallitus-2026"
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.password_hash, undefined);
    assert.equal((await call(server, manager, "POST", "/companies/demo-company/board-members", {
      name: "Pekka", email: "PEKKA@example.com", password: "Hallitus-2026"
    })).status, 409);

    const signIn = await call(server, null, "POST", "/auth/login", { email: "pekka@example.com", password: "Hallitus-2026" });
    assert.equal(signIn.status, 200);
    assert.equal(signIn.data.kind, "board");
    const board = signIn.data.token as string;

    const overview = await call(server, board, "GET", "/board/overview");
    assert.equal(overview.status, 200);
    assert.ok(overview.data.tickets.length > 0);
    assert.ok(overview.data.tickets.every((ticket: any) => !("resident_id" in ticket) && !("summary" in ticket)));
    assert.equal(typeof overview.data.stats.open, "number");
    assert.ok(Array.isArray(overview.data.renovations));
    assert.ok(Array.isArray(overview.data.announcements));

    // Henkilökunnan ja asukkaiden rajapinnat ovat kiinni, eikä henkilökunta pääse hallituksen rajapintaan.
    for (const route of ["/tickets", "/companies", "/portal/me", "/companies/demo-company/residents"]) {
      assert.equal((await call(server, board, "GET", route)).status, 403, route);
    }
    assert.equal((await call(server, admin, "GET", "/board/overview")).status, 403);

    // Tunnuksen poisto kirjaa jäsenen ulos.
    assert.equal((await call(server, manager, "DELETE", `/board-members/${created.data.id}`)).status, 200);
    assert.equal((await call(server, board, "GET", "/board/overview")).status, 401);
  });

  it("AI-kulut ja järjestelmän tila näkyvät vain pääkäyttäjälle, ja kuukausirajan voi asettaa", async () => {
    assert.equal((await call(server, manager, "GET", "/office/ai-usage")).status, 403);
    assert.equal((await call(server, manager, "GET", "/system/alerts")).status, 403);
    const usage = await call(server, admin, "GET", "/office/ai-usage");
    assert.equal(usage.status, 200);
    assert.equal(usage.data.limitUsd, 50);
    assert.equal(usage.data.costUsd, 0);

    const office = (await call(server, admin, "GET", "/office")).data;
    const saved = await call(server, admin, "PUT", "/office", { name: office.name, aiMonthlyLimit: 25.5, aiWarningPercent: 70 });
    assert.equal(saved.data.aiMonthlyLimit, 25.5);
    assert.equal(saved.data.aiWarningPercent, 70);
    assert.equal((await call(server, admin, "PUT", "/office", { name: office.name, aiWarningPercent: 150 })).status, 400);

    const alerts = await call(server, admin, "GET", "/system/alerts");
    assert.equal(alerts.status, 200);
    assert.ok(Array.isArray(alerts.data));
    assert.equal((await call(server, admin, "POST", "/system/alerts/olematon/resolve")).status, 404);
  });
});
