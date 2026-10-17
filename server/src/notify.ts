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
           t.summary, t.sensitive
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
    summary: string; sensitive: number;
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
  // Arkaluonteisen tehtävän sisältöä ei lähetetä sähköpostilla; ilmoitus kertoo vain, mistä tehtävä löytyy.
  const sensitive = Boolean(ticket.sensitive);
  if (sensitive) ticket.subject = "Arkaluonteinen tehtävä";
  const reporter = [sensitive ? null : ticket.resident ?? ticket.sender, ticket.apartment && `asunto ${ticket.apartment}`].filter(Boolean).join(", ");
  const message = sensitive
    ? "Viesti sisältää arkaluonteisia tietoja, joten se näytetään vain Pleississä."
    : (ticket.message ?? ticket.summary).trim();
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

// ---------------------------------------------------------------------------------------------
// Tilapäivitykset asukkaalle: kun tehtävä etenee, sen ilmoittajat saavat lyhyen sähköpostin, jotta
// heidän ei tarvitse kysyä tilannetta. Viestit voi kytkeä pois asetuksista. Roskapostiksi tai
// AI:n suodattamiksi merkityistä tehtävistä ei ilmoiteta, eikä samaa päivitystä lähetetä samalle
// tehtävälle uudelleen 10 minuutin sisällä (esim. kun tilaa vaihdetaan edestakaisin).
// ---------------------------------------------------------------------------------------------
export type StatusEvent = "work_ordered" | "work_done" | "in_progress" | "third_party" | "closed";

const STATUS_REPEAT_MS = 10 * 60 * 1000;

export function residentStatusUpdatesEnabled(): boolean {
  const row = db.prepare("SELECT resident_status_updates FROM office_settings WHERE id = 1").get() as
    { resident_status_updates: number } | undefined;
  return Boolean(row?.resident_status_updates);
}

// Tehtävän tila, josta asukkaalle kerrotaan, kun käsittelijä vaihtaa sen itse.
export function statusEventFor(status: string): StatusEvent | null {
  return status === "waiting_manager" ? "in_progress"
    : status === "waiting_third_party" ? "third_party"
    : status === "closed" ? "closed"
    : null;
}

function statusMessage(event: StatusEvent, subject: string, number: string, detail: string): { title: string; lines: string[] } {
  const quoted = `"${subject}" (#${number})`;
  switch (event) {
    case "work_ordered":
      return {
        title: `Tehtävä #${number}: työ on tilattu`,
        lines: [
          `ilmoittamasi asia ${quoted} on edennyt: työ on tilattu${detail ? ` huoltoyhtiöltä ${detail}` : " huoltoyhtiöltä"}.`,
          "Huoltoyhtiö ottaa tarvittaessa yhteyttä. Saat viestin, kun työ on tehty."
        ]
      };
    case "work_done":
      return {
        title: `Tehtävä #${number}: työ on tehty`,
        lines: [
          `huoltoyhtiö on kuitannut ilmoittamasi asian ${quoted} työn tehdyksi.`,
          "Jos asia ei ole kunnossa, vastaa tähän viestiin."
        ]
      };
    case "in_progress":
      return {
        title: `Tehtävä #${number} on käsittelyssä`,
        lines: [`isännöitsijä käsittelee ilmoittamaasi asiaa ${quoted}. Saat viestin, kun asia etenee.`]
      };
    case "third_party":
      return {
        title: `Tehtävä #${number} odottaa ulkopuolista toimijaa`,
        lines: [
          `ilmoittamasi asia ${quoted} odottaa kolmatta osapuolta, esimerkiksi huoltoyhtiötä tai urakoitsijaa.`,
          "Saat viestin, kun asia etenee."
        ]
      };
    case "closed":
      return {
        title: `Tehtävä #${number} on valmis`,
        lines: [
          `ilmoittamasi tehtävä ${quoted} on käsitelty ja suljettu.`,
          "Jos asia ei ole kunnossa, vastaa tähän viestiin tai lähetä uusi viesti asukasportaalista, niin tehtävä avataan uudelleen."
        ]
      };
  }
}

// detail: esim. huoltoyhtiön nimi työtilauksessa.
export function notifyTicketStatus(ticketId: string, event: StatusEvent, actor: string, detail = ""): void {
  if (!residentStatusUpdatesEnabled()) return;
  const ticket = db.prepare("SELECT id, ticket_number, subject, resident_id, ai_action FROM tickets WHERE id = ?").get(ticketId) as
    | { id: string; ticket_number: number | null; subject: string; resident_id: string | null; ai_action: string }
    | undefined;
  if (!ticket || ticket.ai_action === "filtered") return;
  const skipped = db.prepare(`
    SELECT 1 FROM audit_log WHERE ticket_id = ? AND action = 'decision_skip' AND details LIKE '%"reason":"spam"%' LIMIT 1
  `).get(ticketId);
  if (skipped) return;

  const since = new Date(Date.now() - STATUS_REPEAT_MS).toISOString();
  const recent = db.prepare(`
    SELECT details FROM audit_log WHERE ticket_id = ? AND action = 'resident_notified' AND created_at > ?
  `).all(ticketId, since) as { details: string }[];
  if (recent.some(row => row.details.includes(`"event":"${event}"`))) return;

  const reporters = (db.prepare("SELECT resident_id FROM ticket_reporters WHERE ticket_id = ?").all(ticketId) as { resident_id: string }[])
    .map(row => row.resident_id);
  if (ticket.resident_id && !reporters.includes(ticket.resident_id)) reporters.push(ticket.resident_id);
  const recipients = reporters.filter(residentId => {
    const resident = db.prepare("SELECT email, erased_at FROM residents WHERE id = ?").get(residentId) as
      { email: string | null; erased_at: string | null } | undefined;
    return Boolean(resident && !resident.erased_at && VALID_EMAIL.test((resident.email ?? "").trim()));
  });
  if (recipients.length === 0) return;

  const number = String(ticket.ticket_number ?? "").padStart(4, "0");
  const message = statusMessage(event, ticket.subject, number, detail);
  const portal = process.env.APP_URL ? [`Näet tehtävän tilan myös asukasportaalista: ${process.env.APP_URL}`] : [];
  for (const residentId of recipients) void notifyResident(residentId, message.title, [...message.lines, ...portal]);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), ticketId, actor, "resident_notified", JSON.stringify({ event, recipients: recipients.length }), now()
  );
}
