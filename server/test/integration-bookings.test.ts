import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { tempDir } from "./helpers.js";

// Varaukset ERP-integraatiossa ilman palvelinta: varaukset ja peruutukset jonoon, AI-agentin odottava varaus
// (requested) vahvistuu ERP:n 201-vastauksesta ja 409 perii sen. Mock-ERP ja lähetyskierrokset annetulla ajalla.

let db: typeof import("../src/db.js").db;
let processOutbox: typeof import("../src/integration/dispatcher.js").processOutbox;
let MockErpAdapter: typeof import("../src/integration/mock-adapter.js").MockErpAdapter;
let createBookings: typeof import("../src/routes/bookings.js").createBookings;
let deleteBookingsAndRelease: typeof import("../src/booking-queue.js").deleteBookingsAndRelease;
let listAlerts: typeof import("../src/alerts.js").listAlerts;

const DELAY = 1_000;
const later = () => Date.now() + DELAY + 100;
let seq = 0;
const day = (offset: number, hour: number) => {
  const date = new Date(Date.now() + offset * 86_400_000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};
const hourAfter = (iso: string) => new Date(Date.parse(iso) + 3_600_000).toISOString();

type Row = { event_id: string; event_type: string; status: string; payload: string; last_status_code: number | null };
const rows = (bookingId: string) => db.prepare("SELECT * FROM integration_outbox WHERE entity_type = 'booking' AND entity_id = ? ORDER BY rowid").all(bookingId) as Row[];
const audit = (ticketId: string) => (db.prepare("SELECT action FROM audit_log WHERE ticket_id = ?").all(ticketId) as { action: string }[]).map(row => row.action);

function book(startsAt: string, options: { createdBy?: string; status?: "requested" | "confirmed"; ticketId?: string | null; residentId?: string } = {}) {
  const result = createBookings({
    companyId: "demo-company", resource: "sauna", occurrences: [{ startsAt, endsAt: hourAfter(startsAt) }],
    residentId: options.residentId ?? "resident-1", note: "", createdBy: options.createdBy ?? "Matti Meikäläinen",
    status: options.status, ticketId: options.ticketId
  });
  assert.equal(result.created, 1);
  return result.ids[0];
}

// AI-agentin portaalitehtävä, jolta varaus tehdään.
function agentTicket() {
  const ticketId = `ticket-booking-${++seq}`;
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO tickets (id, company_id, apartment_id, resident_id, type, priority, status, subject, summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at)
    VALUES (?, 'demo-company', 'apt-12', 'resident-1', 'Pyyntö', 'normal', 'waiting_third_party', 'Sauna', 'Saunavuoro', 'portal', 'ai', '', '', ?, ?)
  `).run(ticketId, timestamp, timestamp);
  return ticketId;
}

describe("varaukset ERP-integraatiossa", () => {
  before(async () => {
    process.env.DATA_DIR = await tempDir("kotilo-bookings-");
    process.env.GMAIL_DISABLED = "1";
    process.env.INITIAL_PASSWORD = "Testi-salasana1";
    process.env.INTEGRATION_ADAPTER = "mock";
    process.env.INTEGRATION_SEND_DELAY_MS = String(DELAY);
    delete process.env.ANTHROPIC_API_KEY;
    ({ db } = await import("../src/db.js"));
    await import("../src/startup.js");
    await import("../src/integration/outbox.js");
    ({ processOutbox } = await import("../src/integration/dispatcher.js"));
    ({ MockErpAdapter } = await import("../src/integration/mock-adapter.js"));
    ({ createBookings } = await import("../src/routes/bookings.js"));
    ({ deleteBookingsAndRelease } = await import("../src/booking-queue.js"));
    ({ listAlerts } = await import("../src/alerts.js"));
    // AI-agentti rekisteröi vahvistuksen ja hylkäyksen käsittelyn.
    await import("../src/ai-agent.js");
  });

  it("asukkaan varaus ja peruutus lähtevät ERP:hen kanonisessa muodossa", async () => {
    const erp = new MockErpAdapter();
    const bookingId = book(day(3, 15));
    const [created] = rows(bookingId);
    assert.equal(created.event_type, "booking.created");
    const payload = JSON.parse(created.payload);
    assert.deepEqual(
      [payload.id, payload.resource, payload.residentId, payload.apartmentId, payload.createdBy, payload.channel, payload.status, payload.taskId],
      [bookingId, "sauna", "resident-1", "apt-12", "resident", "web_form", "confirmed", null]
    );
    assert.match(payload.startsAt, /\+0[23]:00$/);
    await processOutbox(erp, later());
    assert.equal(rows(bookingId)[0].status, "sent");
    const erpId = (db.prepare("SELECT external_id FROM integration_refs WHERE entity_type = 'booking' AND entity_id = ?").get(bookingId) as { external_id: string }).external_id;
    assert.match(erpId, /^ERP-B-/);

    deleteBookingsAndRelease("id = ?", [bookingId]);
    const cancelled = rows(bookingId)[1];
    assert.equal(cancelled.event_type, "booking.cancelled");
    assert.equal(JSON.parse(cancelled.payload).status, "cancelled");
    await processOutbox(erp, later());
    assert.deepEqual(erp.calls.filter(call => call.method.endsWith("Booking")).map(call => [call.method, call.erpId]), [["createBooking", null], ["cancelBooking", erpId]]);
    assert.equal(erp.bookings.get(erpId)!.cancelled, true);
  });

  it("ennen lähetystä peruttu varaus ei mene ERP:hen lainkaan", async () => {
    const erp = new MockErpAdapter();
    const bookingId = book(day(4, 15));
    deleteBookingsAndRelease("id = ?", [bookingId]);
    await processOutbox(erp, later());
    assert.deepEqual(rows(bookingId).map(row => row.status), ["superseded", "superseded"]);
    assert.ok(!erp.calls.some(call => call.method.endsWith("Booking")));
  });

  it("AI-agentin varaus odottaa ERP:n vahvistusta; 201 vahvistaa sen ja asukas saa vahvistuksen samaan ketjuun", async () => {
    const erp = new MockErpAdapter();
    const ticketId = agentTicket();
    const bookingId = book(day(5, 15), { createdBy: "Pleissi AI-agentti", status: "requested", ticketId });
    const payload = JSON.parse(rows(bookingId)[0].payload);
    assert.deepEqual([payload.status, payload.createdBy, payload.channel, payload.taskId], ["requested", "ai", "web_form", ticketId]);
    await processOutbox(erp, later());
    assert.equal((db.prepare("SELECT status FROM bookings WHERE id = ?").get(bookingId) as { status: string }).status, "confirmed");
    const reply = db.prepare("SELECT body FROM messages WHERE ticket_id = ? AND direction = 'outbound'").get(ticketId) as { body: string };
    assert.match(reply.body, /varauksesi on nyt vahvistettu: sauna/);
    assert.equal((db.prepare("SELECT status FROM tickets WHERE id = ?").get(ticketId) as { status: string }).status, "closed");
    assert.ok(audit(ticketId).includes("ai_agent_booking_confirmed"));
  });

  it("409: ERP:ssä jo varattu vuoro perii agentin varauksen, eikä peruutusta lähetetä ERP:hen", async () => {
    const erp = new MockErpAdapter();
    const startsAt = day(6, 15);
    erp.blockSlot("sauna", startsAt, hourAfter(startsAt));
    const ticketId = agentTicket();
    const bookingId = book(startsAt, { createdBy: "Pleissi AI-agentti", status: "requested", ticketId });
    await processOutbox(erp, later());
    assert.equal(db.prepare("SELECT 1 FROM bookings WHERE id = ?").get(bookingId), undefined, "varaus perutaan Pleississä");
    const [created, cancelled] = rows(bookingId);
    assert.deepEqual([created.status, created.last_status_code], ["failed", 409]);
    assert.ok(audit(ticketId).includes("ai_agent_booking_rejected"));
    // AI ei ole käytettävissä testissä, joten asia siirtyy henkilökunnalle tarjoamaan uutta vuoroa.
    const ticket = db.prepare("SELECT ai_action, status FROM tickets WHERE id = ?").get(ticketId) as { ai_action: string; status: string };
    assert.deepEqual([ticket.ai_action, ticket.status], ["pending_decision", "open"]);
    assert.ok(audit(ticketId).includes("ai_agent_handover"));
    await processOutbox(erp, later());
    assert.equal(rows(bookingId)[1].status, "superseded");
    assert.equal(cancelled.event_type, "booking.cancelled");
    assert.ok(!erp.calls.some(call => call.method === "cancelBooking"));
  });

  it("409 muulle kuin agentin varaukselle: varaus jää, ja henkilökunta saa hälytyksen", async () => {
    const erp = new MockErpAdapter();
    const startsAt = day(7, 15);
    erp.blockSlot("sauna", startsAt, hourAfter(startsAt));
    const bookingId = book(startsAt);
    await processOutbox(erp, later());
    assert.ok(db.prepare("SELECT 1 FROM bookings WHERE id = ?").get(bookingId));
    assert.equal(rows(bookingId)[0].status, "failed");
    assert.ok(listAlerts().some(alert => alert.kind === `integration:booking:${bookingId}`));
  });
});
