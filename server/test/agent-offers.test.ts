import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { tempDir } from "./helpers.js";

// Luonnostilan tarjoukset: agentin luonnoksessa tarjoamat vuorot tulevat voimaan vasta, kun käsittelijä lähettää
// luonnoksen (tai muokattuna). Kokonaan uudelleen kirjoitettu vastaus ei ota tarjousta käyttöön.
describe("luonnostilan tarjoukset", () => {
  let db: typeof import("../src/db.js").db;
  let activateDraftOffers: typeof import("../src/ai-agent.js").activateDraftOffers;

  before(async () => {
    process.env.DATA_DIR = await tempDir("kotilo-offers-");
    process.env.GMAIL_DISABLED = "1";
    ({ db } = await import("../src/db.js"));
    ({ activateDraftOffers } = await import("../src/ai-agent.js"));
    db.prepare("INSERT INTO companies (id, name, email_address) VALUES ('offer-company', 'As Oy Tarjous', 'tarjous@example.com')").run();
  });

  function ticketWithDraftOffer(ticketId: string) {
    db.prepare(`INSERT INTO tickets (id, company_id, type, priority, status, subject, summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at, agent_state)
      VALUES (?, 'offer-company', 'Pyyntö', 'normal', 'answered', 'Sauna', '', 'portal', 'pending_decision', '', '', ?, ?, 'offer_drafted')`)
      .run(ticketId, new Date().toISOString(), new Date().toISOString());
    db.prepare("INSERT INTO ai_agent_draft_offers (ticket_id, resource, starts_at) VALUES (?, 'sauna', '2030-01-01T16:00:00.000Z')").run(ticketId);
  }

  it("lähetetty luonnos ottaa tarjouksen käyttöön ja agentti jatkaa asukkaan vastauksesta", () => {
    ticketWithDraftOffer("ticket-offer-sent");
    activateDraftOffers("ticket-offer-sent", false);
    const ticket = db.prepare("SELECT ai_action, agent_state FROM tickets WHERE id = 'ticket-offer-sent'").get() as { ai_action: string; agent_state: string | null };
    assert.deepEqual([ticket.ai_action, ticket.agent_state], ["ai", null]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM ai_agent_offers WHERE ticket_id = 'ticket-offer-sent'").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM ai_agent_draft_offers WHERE ticket_id = 'ticket-offer-sent'").get() as { count: number }).count, 0);
  });

  it("uudelleen kirjoitettu vastaus ei ota tarjousta käyttöön", () => {
    ticketWithDraftOffer("ticket-offer-rewritten");
    activateDraftOffers("ticket-offer-rewritten", true);
    const ticket = db.prepare("SELECT ai_action, agent_state FROM tickets WHERE id = 'ticket-offer-rewritten'").get() as { ai_action: string; agent_state: string | null };
    assert.deepEqual([ticket.ai_action, ticket.agent_state], ["pending_decision", null]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM ai_agent_offers WHERE ticket_id = 'ticket-offer-rewritten'").get() as { count: number }).count, 0);
  });

  it("AI-allekirjoitus kertoo, että vastauksen kirjoitti tekoäly, ja käsittelijän lähettämässä myös tarkistajan", async () => {
    const { agentSignature } = await import("../src/agent-autonomy.js");
    assert.match(agentSignature(), /^Ystävällisin terveisin\nAino-AI, tekoälyavustaja/);
    assert.match(agentSignature(), /Tämän vastauksen kirjoitti tekoäly\./);
    assert.match(agentSignature("Hanna Lehtonen"), /kirjoitti tekoäly, ja sen tarkisti Hanna Lehtonen\./);
  });
});
