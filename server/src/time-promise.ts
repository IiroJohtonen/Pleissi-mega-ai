import { db } from "./db.js";
import { sendEmail } from "./mail.js";
import { getMasterData } from "./master-data.js";
import { formatTicketNumber } from "./numbers.js";
import { addDays, helsinkiParts, id, now, VALID_EMAIL } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Aikalupaus asukkaalle (asetus, oletuksena pois; käytössä vain, kun AI-agentin automaattinen käynnistys on päällä):
// kun AI-agentti ei osaa vastata ja siirtää tehtävän henkilökunnalle, tehtävän luonnokseksi tulee viesti, jossa
// kerrotaan päivä, johon mennessä asiaan palataan. Käsittelijä lähettää sen. Päivä tulee tehtävän määräajasta
// (perustietojen määräajat prioriteeteittain, esim. kiireellinen 1 pv ja normaali 5 pv), ei koskaan kellonaikaa.
// - lupaus kirjataan, kun käsittelijä lähettää viestin, jossa luvattu päivä on (recordSentPromise)
// - kun käsittelijä siirtää määräaikaa, luonnokseen tulee ilmoitus uudesta päivästä (draftDueDateChange)
// - vastuuisännöitsijä ja taloyhtiön varahenkilöt saavat muistutuksen päivää ennen lupauspäivää (remindPromises)
// - mittari: kuinka usein lupaus pitää (promiseStats). Lupaus pitää, kun henkilökunta vastasi asukkaalle
//   tai sulki tehtävän viimeistään lupauspäivänä (Suomen aikaa).
// ---------------------------------------------------------------------------------------------

{
  const columns = (db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[]).map(column => column.name);
  if (!columns.includes("promised_date")) db.exec("ALTER TABLE tickets ADD COLUMN promised_date TEXT");
  if (!columns.includes("promised_at")) db.exec("ALTER TABLE tickets ADD COLUMN promised_at TEXT");
  if (!columns.includes("promise_reminded_at")) db.exec("ALTER TABLE tickets ADD COLUMN promise_reminded_at TEXT");
  // Luonnoksessa oleva, vielä lähettämätön lupauspäivä.
  if (!columns.includes("promise_draft_date")) db.exec("ALTER TABLE tickets ADD COLUMN promise_draft_date TEXT");
  const office = (db.prepare("PRAGMA table_info(office_settings)").all() as { name: string }[]).map(column => column.name);
  if (!office.includes("time_promise")) db.exec("ALTER TABLE office_settings ADD COLUMN time_promise INTEGER NOT NULL DEFAULT 0");
  // Taloyhtiön muista isännöitsijöistä merkityt varahenkilöt saavat lupausmuistutuksen.
  const managers = (db.prepare("PRAGMA table_info(company_managers)").all() as { name: string }[]).map(column => column.name);
  if (!managers.includes("backup")) db.exec("ALTER TABLE company_managers ADD COLUMN backup INTEGER NOT NULL DEFAULT 0");
}

export function timePromiseEnabled(): boolean {
  const row = db.prepare("SELECT time_promise FROM office_settings WHERE id = 1").get() as { time_promise: number } | undefined;
  return Boolean(row?.time_promise);
}

export function setTimePromiseEnabled(value: boolean) {
  db.prepare("UPDATE office_settings SET time_promise = ? WHERE id = 1").run(value ? 1 : 0);
}

const WEEKDAYS = ["su", "ma", "ti", "ke", "to", "pe", "la"];
const helsinkiToday = () => helsinkiParts(now()).day;

// "pe 7.11." päivämäärästä VVVV-KK-PP.
export function promiseDayLabel(day: string) {
  const date = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()}.${date.getUTCMonth() + 1}.`;
}

// Lupauspäivä: tehtävän määräaika, jos se ei ole mennyt; muuten tästä päivästä prioriteetin määräajan verran.
// Hätä- ja saman päivän määräajat lupaavat aikaisintaan huomisen, koska kellonaikaa ei luvata.
export function promiseDay(ticket: { priority: string; due_date: string | null }) {
  const todayDay = helsinkiToday();
  const days = getMasterData().priorityDays as Record<string, number>;
  const fromPriority = addDays(todayDay, Math.max(1, days[ticket.priority] ?? days.normal ?? 5));
  const due = ticket.due_date && ticket.due_date > todayDay ? ticket.due_date : null;
  return due ?? fromPriority;
}

export function promiseMessage(day: string) {
  return `Kiitos viestistäsi. Asiasi on siirretty isännöitsijätoimiston henkilökunnalle, ja palaamme siihen viimeistään ${promiseDayLabel(day)}`;
}

export function rescheduleMessage(day: string) {
  return `Asiasi käsittely on siirtynyt. Palaamme siihen viimeistään ${promiseDayLabel(day)}`;
}

// Lisää tekstin tehtävän luonnokseen (tyhjään luonnokseen sellaisenaan, muuten loppuun omaksi kappaleekseen).
function addToDraft(ticketId: string, text: string) {
  const current = ((db.prepare("SELECT draft FROM tickets WHERE id = ?").get(ticketId) as { draft: string | null } | undefined)?.draft ?? "").trim();
  if (current.includes(text)) return;
  db.prepare("UPDATE tickets SET draft = ?, updated_at = ? WHERE id = ?").run(current ? `${current}\n\n${text}` : text, now(), ticketId);
}

// AI-agentti ei osannut vastata: lupausviesti tehtävän luonnokseksi käsittelijän lähetettäväksi (kerran tehtävää
// kohden). Vain kun asetus on päällä; kutsuja tarkistaa, että automaattinen käynnistys on taloyhtiössä päällä.
export function draftPromise(ticketId: string, actor: string): string | null {
  const ticket = db.prepare("SELECT priority, due_date, promised_date, promise_draft_date FROM tickets WHERE id = ?").get(ticketId) as
    { priority: string; due_date: string | null; promised_date: string | null; promise_draft_date: string | null } | undefined;
  if (!ticket || !timePromiseEnabled() || ticket.promised_date || ticket.promise_draft_date) return null;
  const day = promiseDay(ticket);
  addToDraft(ticketId, promiseMessage(day));
  db.prepare("UPDATE tickets SET promise_draft_date = ? WHERE id = ?").run(day, ticketId);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), ticketId, actor, "time_promise_drafted", JSON.stringify({ day }), now());
  return day;
}

// Käsittelijä siirsi annetun lupauksen tehtävän määräaikaa: ilmoitus uudesta päivästä luonnokseen.
export function draftDueDateChange(ticketId: string, dueDate: string | null, actor: string) {
  const ticket = db.prepare("SELECT promised_date FROM tickets WHERE id = ?").get(ticketId) as { promised_date: string | null } | undefined;
  if (!ticket?.promised_date || !dueDate || dueDate === ticket.promised_date || dueDate <= helsinkiToday()) return;
  addToDraft(ticketId, rescheduleMessage(dueDate));
  db.prepare("UPDATE tickets SET promise_draft_date = ? WHERE id = ?").run(dueDate, ticketId);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), ticketId, actor, "time_promise_drafted", JSON.stringify({ day: dueDate, rescheduled: true }), now());
}

// Käsittelijä lähetti vastauksen: jos siinä on luonnoksen lupauspäivä, lupaus kirjataan lähetyshetkellä.
// sentAt on lähetetyn viestin aikaleima, joten itse lupausviesti ei täytä lupausta.
export function recordSentPromise(ticketId: string, body: string, sentAt: string, actor: string) {
  const row = db.prepare("SELECT promise_draft_date FROM tickets WHERE id = ?").get(ticketId) as { promise_draft_date: string | null } | undefined;
  if (!row?.promise_draft_date) return false;
  const day = row.promise_draft_date;
  db.prepare("UPDATE tickets SET promise_draft_date = NULL WHERE id = ?").run(ticketId);
  if (!body.includes(promiseDayLabel(day))) return false;
  db.prepare("UPDATE tickets SET promised_date = ?, promised_at = ?, promise_reminded_at = NULL WHERE id = ?").run(day, sentAt, ticketId);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), ticketId, actor, "time_promise_made", JSON.stringify({ day }), now());
  return true;
}

// Lupaus on täytetty, kun henkilökunta (ei AI-agentti) vastasi asukkaalle lupauksen jälkeen tai tehtävä suljettiin.
const FULFILLED_AT_SQL = `
  MIN(
    COALESCE((SELECT MIN(m.created_at) FROM messages m WHERE m.ticket_id = t.id AND m.direction = 'outbound'
      AND m.channel != 'contractor' AND m.sender != ? AND m.created_at > t.promised_at), '9999'),
    COALESCE(CASE WHEN t.status = 'closed' THEN t.closed_at END, '9999')
  )`;

type PromiseRow = { id: string; promised_date: string; promised_at: string; fulfilled_at: string };

function promiseRows(where: string, params: unknown[], agentActor: string) {
  return db.prepare(`
    SELECT t.id, t.promised_date, t.promised_at, ${FULFILLED_AT_SQL} AS fulfilled_at
    FROM tickets t WHERE t.promised_date IS NOT NULL AND ${where}
  `).all(agentActor, ...params) as PromiseRow[];
}

const kept = (row: PromiseRow) => row.fulfilled_at !== "9999" && helsinkiParts(row.fulfilled_at).day <= row.promised_date;

// Mittari: lupaukset jaksolla ja niistä pidetyt, rikotut ja vielä avoimet.
export function promiseStats(companyIds: string[], since: string, agentActor = "Pleissi AI-agentti") {
  if (!companyIds.length) return { promises: 0, kept: 0, broken: 0, open: 0, keptShare: null as number | null };
  const rows = promiseRows(`t.company_id IN (${companyIds.map(() => "?").join(", ")}) AND t.promised_at >= ?`, [...companyIds, since], agentActor);
  const todayDay = helsinkiToday();
  let keptCount = 0, broken = 0, open = 0;
  for (const row of rows) {
    if (kept(row)) keptCount++;
    else if (row.promised_date < todayDay || row.fulfilled_at !== "9999") broken++;
    else open++;
  }
  const decided = keptCount + broken;
  return { promises: rows.length, kept: keptCount, broken, open, keptShare: decided ? Math.round((keptCount / decided) * 1000) / 1000 : null };
}

// Muistutus vastuuisännöitsijälle ja varahenkilöille lupauspäivää edeltävänä päivänä (tai lupauspäivänä, jos lupaus annettiin
// samana päivänä), kun asukkaalle ei ole vielä vastattu. Kerran tehtävää kohden.
export async function remindPromises(agentActor = "Pleissi AI-agentti") {
  const limit = addDays(helsinkiToday(), 1);
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT t.id, t.company_id, t.ticket_number, t.promised_date, t.promised_at, t.sensitive, t.subject, c.name AS company,
             u.name AS manager_name, u.email AS manager_email, ${FULFILLED_AT_SQL} AS fulfilled_at
      FROM tickets t JOIN companies c ON c.id = t.company_id LEFT JOIN users u ON u.id = c.manager_id
      WHERE t.promised_date IS NOT NULL AND t.promise_reminded_at IS NULL AND t.status != 'closed' AND t.promised_date <= ?
    ) WHERE fulfilled_at = '9999'
  `).all(agentActor, limit) as { id: string; company_id: string; ticket_number: number | null; promised_date: string; sensitive: number;
    subject: string; company: string; manager_name: string | null; manager_email: string | null }[];
  const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string };
  for (const row of rows) {
    const log = (action: string, details: Record<string, string>) =>
      db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), row.id, "system", action, JSON.stringify(details), now());
    db.prepare("UPDATE tickets SET promise_reminded_at = ? WHERE id = ?").run(now(), row.id);
    // Vastuuisännöitsijä ja taloyhtiön varahenkilöt (muut isännöitsijät, jotka on merkitty varahenkilöiksi).
    const backups = db.prepare(`
      SELECT u.name, u.email FROM company_managers cm JOIN users u ON u.id = cm.user_id WHERE cm.company_id = ? AND cm.backup = 1
    `).all(row.company_id) as { name: string; email: string }[];
    const recipients = [{ name: row.manager_name ?? "", email: (row.manager_email ?? "").trim() }, ...backups.map(user => ({ name: user.name, email: (user.email ?? "").trim() }))]
      .filter((recipient, index, list) => VALID_EMAIL.test(recipient.email) && list.findIndex(other => other.email === recipient.email) === index);
    if (!recipients.length) {
      log("time_promise_reminder_failed", { error: "Vastuuisännöitsijällä tai varahenkilöillä ei ole sähköpostiosoitetta." });
      continue;
    }
    const subject = row.sensitive ? "Arkaluonteinen tehtävä" : row.subject;
    for (const recipient of recipients) {
      try {
        await sendEmail({
          to: recipient.email,
          notification: true,
          subject: `Muistutus: asukkaalle luvattu vastaus ${promiseDayLabel(row.promised_date)} (${row.company})`,
          body: [
            `Hei ${recipient.name},`,
            "",
            `asukkaalle on luvattu, että tehtävään palataan viimeistään ${promiseDayLabel(row.promised_date)}, eikä asukkaalle ole vielä vastattu.`,
            ...(recipient.email !== (row.manager_email ?? "").trim() ? ["Saat muistutuksen taloyhtiön varahenkilönä."] : []),
            "",
            `Tehtävä: #${formatTicketNumber(row.ticket_number)} ${subject} (${row.company})`,
            "",
            `Avaa tehtävä Pleississä: ${process.env.APP_URL || "http://localhost:5173"}`,
            "",
            office.name
          ].join("\n")
        });
        log("time_promise_reminder_sent", { to: recipient.name || recipient.email });
      } catch (error: any) {
        console.error("Lupausmuistutus epäonnistui:", error?.message ?? error);
        log("time_promise_reminder_failed", { to: recipient.name || recipient.email, error: String(error?.message ?? error) });
      }
    }
  }
}
