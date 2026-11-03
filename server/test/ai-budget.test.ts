import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { tempDir } from "./helpers.js";

// AI:n rajat ilman palvelinta: päiväraja, toimintoryhmien osuudet kuukausirajasta, lähettäjän tuntiraja ja
// agentin ajot tehtävää kohden.

let db: typeof import("../src/db.js").db;
let budget: typeof import("../src/ai-budget.js");

const usage = (feature: string, costUsd: number, createdAt = new Date().toISOString()) =>
  db.prepare(`INSERT INTO ai_usage (id, month, feature, model, input_tokens, output_tokens, cost_usd, created_at)
    VALUES (?, ?, ?, 'claude-opus-5-5', 0, 0, ?, ?)`).run(`u-${Math.random()}`, createdAt.slice(0, 7), feature, costUsd, createdAt);

describe("AI:n rajat", () => {
  before(async () => {
    process.env.DATA_DIR = await tempDir("kotilo-budget-");
    process.env.GMAIL_DISABLED = "1";
    ({ db } = await import("../src/db.js"));
    budget = await import("../src/ai-budget.js");
  });

  it("oletukset: päiväraja 10 $, agentti 40 % ja muut 30 %, agentti 5 ajoa ja arviointi 10 tunnissa", () => {
    const limits = budget.aiLimits();
    assert.deepEqual(
      [limits.monthlyLimit, limits.dailyLimit, limits.featureLimits, limits.agentRunsPerDay, limits.assessPerSenderHour],
      [50, 10, { agent: 40, assess: 0, suggest: 0, other: 30 }, 5, 10]
    );
    assert.equal(budget.aiBudgetBlocked("agent"), null);
  });

  it("agentin osuus täyttyy ilman, että arviointi ja vastausehdotukset estyvät", () => {
    usage("agent", 20);
    assert.equal(budget.aiBudgetBlocked("assess"), "day", "päiväraja 10 $ on täynnä");
    budget.saveAiLimits({ dailyLimit: 0 });
    assert.equal(budget.aiBudgetBlocked("agent"), "feature");
    assert.equal(budget.aiBudgetBlocked("assess"), null);
    assert.equal(budget.aiBudgetBlocked("suggest"), null);
    assert.equal(budget.aiBudgetExhausted(), false);
    usage("topics", 15);
    assert.equal(budget.aiBudgetBlocked("memory"), "feature", "raportit, dokumentit ja muisti jakavat osuuden");
    assert.equal(budget.aiBudgetBlocked("draft_change"), null, "luonnosten luokittelu kuuluu vastausehdotuksiin");
  });

  it("päiväraja lasketaan vain tämän päivän kuluista, ja kuukausiraja estää kaiken", () => {
    budget.saveAiLimits({ dailyLimit: 5, featureLimits: { agent: 0, assess: 0, suggest: 0, other: 0 } });
    assert.equal(budget.aiBudgetBlocked("assess"), "day");
    db.prepare("UPDATE ai_usage SET created_at = ?").run(new Date(Date.now() - 2 * 86_400_000).toISOString());
    // Kuukausi voi vaihtua kahden päivän aikana; testi koskee vain päivärajaa.
    db.prepare("UPDATE ai_usage SET month = ?").run(new Date().toISOString().slice(0, 7));
    assert.equal(budget.aiBudgetBlocked("assess"), null);
    usage("assess", 20);
    assert.equal(budget.aiBudgetBlocked("suggest"), "month");
    assert.equal(budget.aiBudgetExhausted(), true);
  });

  it("lähettäjän arvioinnit rajoitetaan tunnissa ilman, että osoite tallentuu", () => {
    budget.saveAiLimits({ assessPerSenderHour: 2 });
    const at = Date.now();
    assert.equal(budget.allowAssessFor("Liisa@Example.com", at), true);
    assert.equal(budget.allowAssessFor("liisa@example.com", at + 1000), true);
    assert.equal(budget.allowAssessFor("liisa@example.com", at + 2000), false);
    assert.equal(budget.allowAssessFor("matti@example.com", at + 2000), true);
    assert.equal(budget.allowAssessFor("liisa@example.com", at + 61 * 60_000), true, "tunnin jälkeen taas sallittu");
    const stored = db.prepare("SELECT sender_hash FROM ai_sender_calls").all() as { sender_hash: string }[];
    assert.ok(stored.every(row => !row.sender_hash.includes("@")));
  });

  it("agentin ajot lasketaan tehtävän AI-pyynnöistä viimeisen vuorokauden ajalta", () => {
    const log = (ticketId: string, feature: string, createdAt: string) =>
      db.prepare("INSERT INTO audit_log VALUES (?, ?, 'ai', 'ai_request', ?, ?)").run(`a-${Math.random()}`, ticketId, JSON.stringify({ feature, model: "x" }), createdAt);
    const nowIso = new Date().toISOString();
    log("t-1", "agent", nowIso);
    log("t-1", "agent", nowIso);
    log("t-1", "suggest", nowIso);
    log("t-1", "agent", new Date(Date.now() - 25 * 3600_000).toISOString());
    log("t-2", "agent", nowIso);
    assert.equal(budget.agentRunsToday("t-1"), 2);
  });
});
