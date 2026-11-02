import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { tempDir } from "./helpers.js";

// Viikkoajo ilman AI:ta: kooste lasketaan vastuuisännöitsijän taloyhtiöistä, eikä ajo kaadu, vaikka posti
// ja AI eivät ole käytössä.

let db: typeof import("../src/db.js").db;
let memory: typeof import("../src/memory.js");

describe("viikkoajo ja viikkokooste", () => {
  before(async () => {
    process.env.DATA_DIR = await tempDir("kotilo-weekly-");
    process.env.GMAIL_DISABLED = "1";
    process.env.INITIAL_PASSWORD = "Testi-salasana1";
    delete process.env.ANTHROPIC_API_KEY;
    ({ db } = await import("../src/db.js"));
    await import("../src/startup.js");
    memory = await import("../src/memory.js");
  });

  it("viikkotunnus on ISO-viikko", () => {
    assert.equal(memory.isoWeek(Date.parse("2026-11-02T10:00:00Z")), "2026-W45");
    assert.equal(memory.isoWeek(Date.parse("2027-01-01T10:00:00Z")), "2026-W53");
  });

  it("kooste laskee ehdotukset, viikon osaamisaukot ja pian tarkistettavat ohjeet", async () => {
    const manager = db.prepare("SELECT id FROM users WHERE email = 'hanna.lehtonen@pohjantahti-isannointi.fi'").get() as { id: string };
    db.prepare("UPDATE companies SET manager_id = ? WHERE id = 'demo-company'").run(manager.id);
    const timestamp = new Date().toISOString();
    const note = db.prepare(`INSERT INTO company_memory (id, company_id, text, status, origin, created_at, updated_at, target) VALUES (?, 'demo-company', 'x', 'proposed', 'ai', ?, ?, ?)`);
    note.run("m1", timestamp, timestamp, "documentation");
    note.run("m2", timestamp, timestamp, "documentation");
    note.run("m3", timestamp, timestamp, "memory");
    const gap = db.prepare("INSERT INTO knowledge_gaps (id, company_id, ticket_id, question, created_at) VALUES (?, 'demo-company', 'ticket-1', ?, ?)");
    gap.run("g1", "Onko uima-allas?", timestamp);
    gap.run("g2", "onko uima-allas?", timestamp);
    gap.run("g3", "Vanha kysymys", new Date(Date.now() - 10 * 86_400_000).toISOString());
    db.prepare("UPDATE knowledge SET review_at = date('now', '+10 days') WHERE company_id = 'demo-company'").run();
    const reviews = (db.prepare("SELECT COUNT(*) AS count FROM knowledge WHERE company_id = 'demo-company' AND status = 'active'").get() as { count: number }).count;

    const digest = memory.weeklyDigestFor(manager.id);
    assert.deepEqual([digest.documentation, digest.memory, digest.gaps, digest.reviews], [2, 1, 1, reviews]);
    assert.deepEqual(digest.companies, ["As Oy Koivikko"]);

    // Muistiehdotukset ovat pois: ajo ei tee mitään.
    await memory.weeklyMemoryProposals();
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM weekly_digests").get() as { count: number }).count, 0);
    // Päällä mutta ilman AI:ta ja postia: AI-kutsuja ei tehdä, ja epäonnistunut lähetys yritetään myöhemmin uudelleen.
    db.prepare("UPDATE office_settings SET memory_auto = 1 WHERE id = 1").run();
    await memory.weeklyMemoryProposals();
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM weekly_digests").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM ai_usage").get() as { count: number }).count, 0);
  });
});
