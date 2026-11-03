import { db } from "./db.js";
import { sendEmail } from "./mail.js";
import { getMasterData } from "./master-data.js";
import { formatTicketNumber } from "./numbers.js";
import { addDays, helsinkiParts, id, now, VALID_EMAIL } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Aikalupaus asukkaalle: kun AI-agentti siirtää tehtävän henkilökunnalle, asukkaalle kerrotaan päivä, johon
// mennessä asiaan palataan. Päivä tulee tehtävän määräajasta (perustietojen määräajat prioriteeteittain,
// esim. kiireellinen 1 pv ja normaali 5 pv). Lupaus on päivän tarkkuudella, ei koskaan kellonaikaa.
// - vastuuisännöitsijä saa muistutuksen päivää ennen lupauspäivää (remindPromises, ajastettu)
// - mittari: kuinka usein lupaus pitää (promiseStats). Lupaus pitää, kun henkilökunta vastasi asukkaalle
//   tai sulki tehtävän viimeistään lupauspäivänä (Suomen aikaa).
// ---------------------------------------------------------------------------------------------

{
  const columns = (db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[]).map(column => column.name);
  if (!columns.includes("promised_date")) db.exec("ALTER TABLE tickets ADD COLUMN promised_date TEXT");
  if (!columns.includes("promised_at")) db.exec("ALTER TABLE tickets ADD COLUMN promised_at TEXT");
  if (!columns.includes("promise_reminded_at")) db.exec("ALTER TABLE tickets ADD COLUMN promise_reminded_at TEXT");
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

// Tallentaa lupauksen tehtävälle (kerran) ja palauttaa asukkaalle lähetettävän viestin; null, jos lupaus on jo annettu.
export function makePromise(ticketId: string, actor: string): { day: string; message: string } | null {
  const ticket = db.prepare("SELECT priority, due_date, promised_date FROM tickets WHERE id = ?").get(ticketId) as
    { priority: string; due_date: string | null; promised_date: string | null } | undefined;
  if (!ticket || ticket.promised_date) return null;
  const day = promiseDay(ticket);
  db.prepare("UPDATE tickets SET promised_date = ?, promised_at = ?, promise_reminded_at = NULL WHERE id = ?").run(day, now(), ticketId);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), ticketId, actor, "time_promise_made", JSON.stringify({ day }), now());
  return { day, message: promiseMessage(day) };
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

// Muistutus vastuuisännöitsijälle lupauspäivää edeltävänä päivänä (tai lupauspäivänä, jos lupaus annettiin
// samana päivänä), kun asukkaalle ei ole vielä vastattu. Kerran tehtävää kohden. Varahenkilöä ei vielä ole.
export async function remindPromises(agentActor = "Pleissi AI-agentti") {
  const limit = addDays(helsinkiToday(), 1);
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT t.id, t.ticket_number, t.promised_date, t.promised_at, t.sensitive, t.subject, c.name AS company,
             u.name AS manager_name, u.email AS manager_email, ${FULFILLED_AT_SQL} AS fulfilled_at
      FROM tickets t JOIN companies c ON c.id = t.company_id LEFT JOIN users u ON u.id = c.manager_id
      WHERE t.promised_date IS NOT NULL AND t.promise_reminded_at IS NULL AND t.status != 'closed' AND t.promised_date <= ?
    ) WHERE fulfilled_at = '9999'
  `).all(agentActor, limit) as { id: string; ticket_number: number | null; promised_date: string; sensitive: number; subject: string;
    company: string; manager_name: string | null; manager_email: string | null }[];
  const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string };
  for (const row of rows) {
    const log = (action: string, details: Record<string, string>) =>
      db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), row.id, "system", action, JSON.stringify(details), now());
    db.prepare("UPDATE tickets SET promise_reminded_at = ? WHERE id = ?").run(now(), row.id);
    const email = (row.manager_email ?? "").trim();
    if (!VALID_EMAIL.test(email)) {
      log("time_promise_reminder_failed", { error: "Vastuuisännöitsijän sähköpostiosoite puuttuu." });
      continue;
    }
    const subject = row.sensitive ? "Arkaluonteinen tehtävä" : row.subject;
    try {
      await sendEmail({
        to: email,
        notification: true,
        subject: `Muistutus: asukkaalle luvattu vastaus ${promiseDayLabel(row.promised_date)} (${row.company})`,
        body: [
          `Hei ${row.manager_name ?? ""},`,
          "",
          `asukkaalle on luvattu, että tehtävään palataan viimeistään ${promiseDayLabel(row.promised_date)}, eikä asukkaalle ole vielä vastattu.`,
          "",
          `Tehtävä: #${formatTicketNumber(row.ticket_number)} ${subject} (${row.company})`,
          "",
          `Avaa tehtävä Pleississä: ${process.env.APP_URL || "http://localhost:5173"}`,
          "",
          office.name
        ].join("\n")
      });
      log("time_promise_reminder_sent", { to: row.manager_name || email });
    } catch (error: any) {
      console.error("Lupausmuistutus epäonnistui:", error?.message ?? error);
      log("time_promise_reminder_failed", { to: row.manager_name || email, error: String(error?.message ?? error) });
    }
  }
}
