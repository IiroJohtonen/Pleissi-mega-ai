import { db } from "./db.js";
import { sendEmail } from "./mail.js";
import { id, now, VALID_EMAIL } from "./util.js";

// Hätätapauksesta lähtee heti sähköposti taloyhtiön vastuuisännöitsijälle. Lähetys tehdään taustalla,
// ja tulos kirjataan tehtävän lokiin, jotta käsittelijä näkee, tavoittiko hälytys ketään.
// Hälytystä ei lähetetä, kun vastuuisännöitsijä on itse merkinnyt tehtävän hätätapaukseksi (actorId).
const ALERT_MESSAGE_MAX = 2000;

export async function alertEmergency(ticketId: string, actorId?: string) {
  const ticket = db.prepare(`
    SELECT t.ticket_number, t.subject, c.name AS company, c.maintenance_emergency_phone AS emergency_phone,
           u.id AS manager_id, u.name AS manager_name, u.email AS manager_email,
           r.name AS resident, a.apartment_number AS apartment,
           (SELECT m.sender FROM messages m WHERE m.ticket_id = t.id ORDER BY m.created_at LIMIT 1) AS sender,
           (SELECT m.body FROM messages m WHERE m.ticket_id = t.id ORDER BY m.created_at LIMIT 1) AS message,
           t.summary
    FROM tickets t
    JOIN companies c ON c.id = t.company_id
    LEFT JOIN users u ON u.id = c.manager_id
    LEFT JOIN residents r ON r.id = t.resident_id
    LEFT JOIN apartments a ON a.id = t.apartment_id
    WHERE t.id = ?
  `).get(ticketId) as {
    ticket_number: number | null; subject: string; company: string; emergency_phone: string | null;
    manager_id: string | null; manager_name: string | null; manager_email: string | null;
    resident: string | null; apartment: string | null; sender: string | null; message: string | null;
    summary: string;
  } | undefined;
  if (!ticket || (ticket.manager_id && ticket.manager_id === actorId)) return;

  const log = (action: string, details: Record<string, string>) =>
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), ticketId, "system", action, JSON.stringify(details), now()
    );

  const email = (ticket.manager_email ?? "").trim();
  if (!ticket.manager_id) return log("emergency_alert_failed", { error: "Taloyhtiöllä ei ole vastuuisännöitsijää." });
  if (!VALID_EMAIL.test(email)) {
    return log("emergency_alert_failed", { to: ticket.manager_name ?? "", error: "Vastuuisännöitsijän sähköpostiosoite puuttuu." });
  }

  const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string };
  const number = String(ticket.ticket_number ?? "").padStart(4, "0");
  const reporter = [ticket.resident ?? ticket.sender, ticket.apartment && `asunto ${ticket.apartment}`].filter(Boolean).join(", ");
  const message = (ticket.message ?? ticket.summary).trim();
  try {
    await sendEmail({
      to: email,
      notification: true,
      subject: `HÄTÄTAPAUS: ${ticket.subject} (${ticket.company})`,
      body: [
        `Hei ${ticket.manager_name},`,
        "",
        `taloyhtiössä ${ticket.company} on kirjattu hätätapaus.`,
        "",
        `Tehtävä: #${number} ${ticket.subject}`,
        ...(reporter ? [`Ilmoittaja: ${reporter}`] : []),
        ...(ticket.emergency_phone ? [`Huoltoyhtiön päivystys: ${ticket.emergency_phone}`] : []),
        "",
        "Viesti:",
        message.length > ALERT_MESSAGE_MAX ? `${message.slice(0, ALERT_MESSAGE_MAX)}…` : message,
        "",
        `Avaa tehtävä Pleississä: ${process.env.APP_URL || "http://localhost:5173"}`,
        "",
        office.name
      ].join("\n")
    });
    log("emergency_alert_sent", { to: ticket.manager_name ?? email });
  } catch (error: any) {
    console.error("Hätätapauksen hälytys epäonnistui:", error?.message ?? error);
    log("emergency_alert_failed", { to: ticket.manager_name ?? email, error: String(error?.message ?? error) });
  }
}

// Ilmoitus asukkaalle sähköpostilla. Lähetys tehdään taustalla: epäonnistuminen kirjataan lokiin,
// mutta ei kaada varsinaista toimintoa. Asukkaalle ilman kelvollista osoitetta ei lähetetä mitään.
export async function notifyResident(residentId: string, subject: string, lines: string[]) {
  const resident = db.prepare(`
    SELECT r.name, r.email, r.company_id, c.name AS company FROM residents r JOIN companies c ON c.id = r.company_id WHERE r.id = ?
  `).get(residentId) as { name: string; email: string | null; company: string; company_id: string } | undefined;
  const email = (resident?.email ?? "").trim();
  if (!resident || !/^[^\s<>,;@]+@[^\s<>,;@]+$/.test(email)) return;
  const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string };
  try {
    await sendEmail({
      to: email,
      companyId: resident.company_id,
      subject: `${subject} (${resident.company})`,
      body: [`Hei ${resident.name},`, "", ...lines, "", "Ystävällisin terveisin", office.name].join("\n")
    });
  } catch (error: any) {
    console.error(`Ilmoituksen lähetys asukkaalle epäonnistui (${subject}):`, error?.message ?? error);
  }
}
