import { AUTHORIZED_COMPANY_IDS } from "./access.js";
import { createBackup, hasBackupToday } from "./backup.js";
import { db } from "./db.js";
import { sendGmailReply } from "./gmail.js";
import { deleteTicket } from "./routes/tickets.js";
import { id, NEW_REPLY_SQL, now, today } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Muistutukset: käsittelijä saa kerran päivässä koosteen tehtävistään, joiden määräaika on mennyt
// tai joissa asukkaan viesti on odottanut vastausta yli kaksi päivää. Käsittelijän puuttuessa kooste
// menee taloyhtiön vastuuisännöitsijälle. Lähetys on päällä vain, kun se on kytketty asetuksista.
// ---------------------------------------------------------------------------------------------
const REPLY_REMINDER_DAYS = 2;

async function sendReminderDigests() {
  const office = db.prepare("SELECT name, reminder_emails FROM office_settings WHERE id = 1").get() as
    { name: string; reminder_emails: number };
  const hour = new Date().getHours();
  if (!office.reminder_emails || hour < 7 || hour >= 18) return;

  const day = today();
  const replyCutoff = new Date(Date.now() - REPLY_REMINDER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = (db.prepare(`
    SELECT t.company_id, t.ticket_number, t.subject, t.due_date, c.name AS company,
           COALESCE(t.assignee_id, c.manager_id) AS user_id,
           (t.due_date IS NOT NULL AND t.due_date < ?) AS overdue
    FROM tickets t
    JOIN companies c ON c.id = t.company_id
    WHERE t.status != 'closed'
      AND ((t.due_date IS NOT NULL AND t.due_date < ?)
        OR (${NEW_REPLY_SQL} AND (SELECT MAX(m.created_at) FROM messages m WHERE m.ticket_id = t.id) < ?))
    ORDER BY t.due_date IS NULL, t.due_date, t.created_at
  `).all(day, day, replyCutoff) as {
    company_id: string; ticket_number: number | null; subject: string; due_date: string | null;
    company: string; user_id: string | null; overdue: number;
  }[]).filter(row => row.user_id && AUTHORIZED_COMPANY_IDS.has(row.company_id));

  for (const userId of new Set(rows.map(row => row.user_id as string))) {
    if (db.prepare("SELECT 1 FROM reminder_log WHERE user_id = ? AND day = ?").get(userId, day)) continue;
    const user = db.prepare("SELECT name, email FROM users WHERE id = ?").get(userId) as { name: string; email: string } | undefined;
    if (!user) continue;

    const lines = rows.filter(row => row.user_id === userId).map(row => {
      const number = String(row.ticket_number ?? "").padStart(4, "0");
      const reason = row.overdue
        ? `määräaika oli ${(row.due_date as string).split("-").reverse().join(".")}`
        : `asukkaan viesti on odottanut vastausta yli ${REPLY_REMINDER_DAYS} päivää`;
      return `#${number} ${row.subject} (${row.company}) – ${reason}`;
    });
    try {
      await sendGmailReply({
        to: user.email,
        subject: `Kotilo: ${lines.length} tehtävää odottaa toimenpiteitäsi`,
        body: [`Hei ${user.name},`, "", "nämä tehtävät odottavat toimenpiteitäsi:", "", ...lines, "", office.name].join("\n")
      });
      db.prepare("INSERT OR IGNORE INTO reminder_log (user_id, day) VALUES (?, ?)").run(userId, day);
    } catch (error: any) {
      console.error("Muistutuksen lähetys epäonnistui:", error?.message ?? error);
    }
  }
  db.prepare("DELETE FROM reminder_log WHERE day < ?").run(day);
}

// ---------------------------------------------------------------------------------------------
// Säilytysaika: kun pääkäyttäjä on asettanut säilytysajan, sitä kauemmin suljettuna olleet tehtävät
// poistetaan viesteineen ja liitteineen, samoin sitä vanhemmat lokimerkinnät. 0 = ei poisteta.
// ---------------------------------------------------------------------------------------------
async function purgeExpiredData() {
  const { retention_months: months } = db.prepare("SELECT retention_months FROM office_settings WHERE id = 1").get() as
    { retention_months: number };
  if (!months) return;

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);
  const cutoff = cutoffDate.toISOString();

  const tickets = db.prepare("SELECT id FROM tickets WHERE status = 'closed' AND updated_at < ?").all(cutoff) as { id: string }[];
  for (const ticket of tickets) await deleteTicket(ticket.id);
  const logRows = db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoff).changes;

  if (tickets.length > 0 || logRows > 0) {
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), null, "system", "retention_purge",
      JSON.stringify({ tickets: tickets.length, log_rows: logRows, months }), now()
    );
  }
}

// Kun BACKUP_DIR on asetettu, tietokannasta ja tiedostoista otetaan varmuuskopio kerran päivässä.
async function backupDaily() {
  const targetDir = process.env.BACKUP_DIR;
  if (!targetDir || await hasBackupToday(targetDir)) return;
  console.log(`Kotilo: varmuuskopio tallennettu kansioon ${await createBackup(targetDir)}`);
}

export function startMaintenanceJobs() {
  const run = () => {
    sendReminderDigests().catch(error => console.error("Muistutusten käsittely epäonnistui:", error?.message ?? error));
    purgeExpiredData().catch(error => console.error("Säilytysajan poistot epäonnistuivat:", error?.message ?? error));
    backupDaily().catch(error => console.error("Varmuuskopiointi epäonnistui:", error?.message ?? error));
  };
  run();
  setInterval(run, 60 * 60 * 1000);
}
