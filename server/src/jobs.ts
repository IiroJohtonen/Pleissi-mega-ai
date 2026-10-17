import { AUTHORIZED_COMPANY_IDS } from "./access.js";
import { refreshBudgetAlerts } from "./ai-budget.js";
import { raiseAlert, resolveAlert } from "./alerts.js";
import { createBackup, hasBackupToday } from "./backup.js";
import { processPendingErasures } from "./resident-erasure.js";
import { db } from "./db.js";
import { sendEmail } from "./mail.js";
import { deleteTicket } from "./routes/tickets.js";
import { id, now, today, WAITING_SINCE_SQL } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Muistutukset: käsittelijä saa kerran päivässä koosteen tehtävistään, joiden määräaika on mennyt tai
// lähestyy tai joissa asukas on odottanut vastausta asetetun päivämäärän verran. Käsittelijän
// puuttuessa kooste menee taloyhtiön vastuuisännöitsijälle. Lähetys on päällä vain, kun se on
// kytketty asetuksista.
// ---------------------------------------------------------------------------------------------
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString("sv-SE");
}

const finnishDate = (day: string) => day.split("-").reverse().join(".");

async function sendReminderDigests() {
  const office = db.prepare("SELECT name, reminder_emails, reply_reminder_days, due_reminder_days FROM office_settings WHERE id = 1").get() as
    { name: string; reminder_emails: number; reply_reminder_days: number; due_reminder_days: number };
  const hour = new Date().getHours();
  if (!office.reminder_emails || hour < 7 || hour >= 18) return;

  const day = today();
  const dueLimit = addDays(day, office.due_reminder_days);
  const replyDays = office.reply_reminder_days;
  const replyCutoff = new Date(Date.now() - replyDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = (db.prepare(`
    SELECT * FROM (
      SELECT t.company_id, t.ticket_number,
             CASE WHEN t.sensitive = 1 THEN 'Arkaluonteinen tehtävä' ELSE t.subject END AS subject, t.due_date, c.name AS company,
             -- Tunnistamattoman yhtiön tehtävästä muistutetaan vain sen käsittelijää, ei oletusyhtiön isännöitsijää.
             CASE WHEN t.company_pending = 1 THEN t.assignee_id ELSE COALESCE(t.assignee_id, c.manager_id) END AS user_id,
             ${WAITING_SINCE_SQL} AS waiting_since
      FROM tickets t
      JOIN companies c ON c.id = t.company_id
      WHERE t.status != 'closed'
    )
    WHERE (due_date IS NOT NULL AND due_date <= ?) OR waiting_since < ?
    ORDER BY due_date IS NULL, due_date, waiting_since
  `).all(dueLimit, replyCutoff) as {
    company_id: string; ticket_number: number | null; subject: string; due_date: string | null;
    company: string; user_id: string | null; waiting_since: string | null;
  }[]).filter(row => row.user_id && AUTHORIZED_COMPANY_IDS.has(row.company_id));

  for (const userId of new Set(rows.map(row => row.user_id as string))) {
    if (db.prepare("SELECT 1 FROM reminder_log WHERE user_id = ? AND day = ?").get(userId, day)) continue;
    const user = db.prepare("SELECT name, email FROM users WHERE id = ?").get(userId) as { name: string; email: string } | undefined;
    if (!user) continue;

    const lines = rows.filter(row => row.user_id === userId).map(row => {
      const number = String(row.ticket_number ?? "").padStart(4, "0");
      const reasons = [
        ...(row.due_date && row.due_date < day ? [`määräaika oli ${finnishDate(row.due_date)}`] : []),
        ...(row.due_date && row.due_date >= day && row.due_date <= dueLimit ? [`määräaika ${finnishDate(row.due_date)}`] : []),
        ...(row.waiting_since && row.waiting_since < replyCutoff ? [`asukas on odottanut vastausta yli ${replyDays} päivää`] : [])
      ];
      return `#${number} ${row.subject} (${row.company}) – ${reasons.join(", ")}`;
    });
    try {
      await sendEmail({
        to: user.email,
        subject: `Pleissi: ${lines.length} tehtävää odottaa toimenpiteitäsi`,
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
// Poistettujen tehtävien sähköpostitunnisteita tarvitaan vain, kunnes viestit ovat vanhempia kuin
// postin tarkistuksen aikaikkuna; 90 päivää riittää reilusti.
function purgeDeletedMailIds() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM deleted_mail_messages WHERE deleted_at < ?").run(cutoff);
}

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
// Epäonnistumisesta tulee hälytys, joka kuittautuu seuraavan onnistuneen kopion jälkeen.
async function backupDaily() {
  const targetDir = process.env.BACKUP_DIR;
  if (!targetDir || await hasBackupToday(targetDir)) return;
  try {
    console.log(`Kotilo: varmuuskopio tallennettu kansioon ${await createBackup(targetDir)}`);
    resolveAlert("backup");
  } catch (error: any) {
    raiseAlert("backup", "Varmuuskopiointi epäonnistui", String(error?.message ?? error));
    throw error;
  }
}

export function startMaintenanceJobs() {
  const run = () => {
    sendReminderDigests().catch(error => console.error("Muistutusten käsittely epäonnistui:", error?.message ?? error));
    purgeDeletedMailIds();
    purgeExpiredData().catch(error => console.error("Säilytysajan poistot epäonnistuivat:", error?.message ?? error));
    backupDaily().catch(error => console.error("Varmuuskopiointi epäonnistui:", error?.message ?? error));
    refreshBudgetAlerts();
  };
  run();
  setInterval(run, 60 * 60 * 1000);

  // Poistopyynnön vuoksi säilytetyt tehtävät anonymisoidaan pian sulkemisen jälkeen.
  const erasures = () => {
    processPendingErasures().catch(error => console.error("Säilytettyjen tehtävien anonymisointi epäonnistui:", error?.message ?? error));
  };
  erasures();
  setInterval(erasures, 5 * 60 * 1000);
}
