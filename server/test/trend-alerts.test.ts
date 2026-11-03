import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { tempDir } from "./helpers.js";

// Trendihälytykset ilman AI:ta: aihe, jonka ilmoitukset ovat kaksinkertaistuneet kolmessa kuukaudessa (vähintään 5),
// näkyy hälytyksenä ja vastuuisännöitsijän viikkoraportissa.

let db: typeof import("../src/db.js").db;
let trends: typeof import("../src/trend-alerts.js");
let memory: typeof import("../src/memory.js");

describe("trendihälytykset ja viikkoraportti", () => {
  before(async () => {
    process.env.DATA_DIR = await tempDir("kotilo-trends-");
    process.env.GMAIL_DISABLED = "1";
    process.env.INITIAL_PASSWORD = "Testi-salasana1";
    delete process.env.ANTHROPIC_API_KEY;
    ({ db } = await import("../src/db.js"));
    await import("../src/startup.js");
    trends = await import("../src/trend-alerts.js");
    memory = await import("../src/memory.js");
  });

  let number = 0;
  function tickets(topic: string, count: number, daysAgo: number) {
    const insert = db.prepare(`INSERT INTO tickets (id, company_id, type, priority, status, subject, summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at, topic)
      VALUES (?, 'demo-company', 'Vikailmoitus', 'normal', 'open', 'Testi', '', 'email', 'pending_decision', '', '', ?, ?, ?)`);
    for (let index = 0; index < count; index++) {
      const at = new Date(Date.now() - (daysAgo + index * 0.1) * 86_400_000).toISOString();
      insert.run(`trend-ticket-${++number}`, at, at, topic);
    }
  }

  it("kaksinkertaistunut aihe hälyttää; pieni tai tasainen määrä ei", () => {
    tickets("heating", 6, 10); // nyt 6
    tickets("heating", 2, 120); // edellinen jakso 2
    tickets("elevator", 4, 10); // alle 5
    tickets("drain", 6, 10); // 6 vs 4: ei kaksinkertainen
    tickets("drain", 4, 120);
    const alerts = trends.topicTrendAlerts(["demo-company"]);
    assert.deepEqual(alerts.map(alert => [alert.topic, alert.current, alert.previous]), [["heating", 6, 2]]);
    assert.equal(alerts[0].firstSeenAt, null);

    // Ensimmäinen havainto on uusi, seuraava ei.
    assert.deepEqual(trends.refreshTrendAlerts(["demo-company"]).map(alert => alert.topic), ["heating"]);
    assert.deepEqual(trends.refreshTrendAlerts(["demo-company"]), []);
    assert.ok(trends.topicTrendAlerts(["demo-company"])[0].firstSeenAt);
  });

  it("viikkoraportti kokoaa trendit ja viikon luvut vastuuisännöitsijälle; asetus on oletuksena pois", async () => {
    const manager = db.prepare("SELECT id FROM users WHERE email = 'hanna.lehtonen@pohjantahti-isannointi.fi'").get() as { id: string };
    db.prepare("UPDATE companies SET manager_id = ? WHERE id = 'demo-company'").run(manager.id);
    const before = memory.weeklyDigestFor(manager.id).report.created;
    tickets("waste", 2, 1);
    const digest = memory.weeklyDigestFor(manager.id);
    assert.deepEqual(digest.trends.map(trend => trend.topic), ["heating"]);
    assert.equal(digest.report.created, before + 2, "viikon uudet tehtävät");

    assert.equal(memory.weeklyReportEnabled(), false);
    // Päällä: lähetys yritetään (posti ei ole käytössä testissä, joten viikkoa ei merkitä lähetetyksi).
    db.prepare("UPDATE office_settings SET weekly_report = 1 WHERE id = 1").run();
    await memory.weeklyMemoryProposals();
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM weekly_digests").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM ai_usage").get() as { count: number }).count, 0, "ei AI-kutsuja");
  });
});
