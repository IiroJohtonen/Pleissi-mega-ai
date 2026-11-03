import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { tempDir } from "./helpers.js";

// Lupaus kirjataan vasta, kun käsittelijä lähettää viestin, jossa luonnoksen luvattu päivä on. Lupausviesti itse ei
// täytä lupausta.
describe("aikalupauksen kirjaus lähetyksessä", () => {
  let db: typeof import("../src/db.js").db;
  let promise: typeof import("../src/time-promise.js");

  before(async () => {
    process.env.DATA_DIR = await tempDir("kotilo-promise-");
    process.env.GMAIL_DISABLED = "1";
    ({ db } = await import("../src/db.js"));
    promise = await import("../src/time-promise.js");
    db.prepare("INSERT INTO companies (id, name, email_address) VALUES ('promise-company', 'As Oy Lupaus', 'lupaus@example.com')").run();
  });

  function ticket(ticketId: string, draftDay: string) {
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO tickets (id, company_id, type, priority, status, subject, summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at, promise_draft_date)
      VALUES (?, 'promise-company', 'Pyyntö', 'normal', 'open', 'Asia', '', 'email', 'pending_decision', '', '', ?, ?, ?)`).run(ticketId, at, at, draftDay);
  }

  it("lähetetty lupauspäivä kirjataan; muokattu päivä ei", () => {
    const day = "2030-03-08";
    ticket("ticket-promise-1", day);
    const sentAt = new Date().toISOString();
    assert.equal(promise.recordSentPromise("ticket-promise-1", promise.promiseMessage(day), sentAt, "Hanna"), true);
    const row = db.prepare("SELECT promised_date, promised_at, promise_draft_date FROM tickets WHERE id = 'ticket-promise-1'").get();
    assert.deepEqual(row, { promised_date: day, promised_at: sentAt, promise_draft_date: null });
    assert.equal(promise.promiseDayLabel(day), "pe 8.3.");

    ticket("ticket-promise-2", day);
    assert.equal(promise.recordSentPromise("ticket-promise-2", "Palaamme asiaan ensi viikolla.", sentAt, "Hanna"), false);
    const other = db.prepare("SELECT promised_date, promise_draft_date FROM tickets WHERE id = 'ticket-promise-2'").get();
    assert.deepEqual(other, { promised_date: null, promise_draft_date: null });
  });

  it("asetus on oletuksena pois, eikä lupausta tehdä luonnokseksi", () => {
    ticket("ticket-promise-3", "");
    db.prepare("UPDATE tickets SET promise_draft_date = NULL WHERE id = 'ticket-promise-3'").run();
    assert.equal(promise.timePromiseEnabled(), false);
    assert.equal(promise.draftPromise("ticket-promise-3", "Testi"), null);
  });
});
