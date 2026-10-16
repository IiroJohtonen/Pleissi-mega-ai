import { ADMIN_ROLE } from "./auth.js";
import { db, seed } from "./db.js";
import { migrateBookingRequests } from "./booking-queue.js";
import { migrateRenovationNotices } from "./routes/renovations.js";

seed();
migrateRenovationNotices();
migrateBookingRequests();

// Vanhat "Osoitettu minulle" -tehtävät saavat käsittelijän lokin perusteella; jos tekijää ei
// tunnisteta, tehtävä osoitetaan pääkäyttäjälle, jotta se ei katoa kenenkään Omista tehtävistä.
{
  const unassigned = db.prepare("SELECT id FROM tickets WHERE assignee_id IS NULL AND status = 'waiting_manager'").all() as { id: string }[];
  const admin = db.prepare("SELECT id FROM users WHERE role = ? ORDER BY created_at LIMIT 1").get(ADMIN_ROLE) as { id: string } | undefined;
  const byActor = db.prepare(`
    SELECT u.id FROM audit_log l JOIN users u ON u.name = l.actor
    WHERE l.ticket_id = ? AND l.action IN ('decision_human', 'ticket_created_manual')
    ORDER BY l.created_at DESC LIMIT 1
  `);
  for (const ticket of unassigned) {
    const assignee = (byActor.get(ticket.id) as { id: string } | undefined) ?? admin;
    if (assignee) db.prepare("UPDATE tickets SET assignee_id = ? WHERE id = ?").run(assignee.id, ticket.id);
  }
}

// Huoltoyhtiölle lähetetyt viestit erotetaan asukkaalle lähetetyistä kanavalla 'contractor', jotta
// niitä ei näytetä asukkaalle portaalissa. Ennen tätä muutosta lähetetyt tunnistetaan otsikosta.
db.prepare(`
  UPDATE messages SET channel = 'contractor'
  WHERE direction = 'outbound' AND channel = 'email' AND (subject LIKE 'Työtilaus:%' OR subject LIKE 'Re: Työtilaus:%')
`).run();
