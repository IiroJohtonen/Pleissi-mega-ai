import express, { type Router } from "express";
import { z } from "zod";
import { INTERNAL_TOKEN } from "../auth.js";
import { AUTHORIZED_COMPANY_IDS, companyIdForRecipients, companyIdFromContext, getAuthorizedTicket, visibleCompanyIds } from "../access.js";
import { triage } from "../ai.js";
import { attachAiLog, withAiLog } from "../ai-log.js";
import { db } from "../db.js";
import { apartmentForForm, detectEmailForm, formContact, formSubject, parseFormFields } from "../email-forms.js";
import { FORM_TYPES } from "../portal-form-data.js";
import { importSiteForm } from "../site-forms.js";
import { alertEmergency } from "../notify.js";
import { id, now, statusAfterResidentReply } from "../util.js";
import { sensitiveMatches } from "../privacy-filter.js";
import { detectSensitivity } from "../ticket-sensitivity.js";
import { aiPriorityEnabled, aiRelevanceEnabled } from "./office.js";
import { findResident } from "./residents.js";
import { assignToCompanyManager } from "./tickets.js";
import { scheduleAgent } from "../ai-agent.js";

export const inboundRouter: Router = express.Router();

const inboundSchema = z.object({
  companyId: z.string(),
  channel: z.enum(["email", "portal", "quick_note"]).default("email"),
  senderName: z.string().default("Tuntematon"),
  senderEmail: z.string().optional(),
  subject: z.string().default("Uusi yhteydenotto"),
  body: z.string().min(1),
  sourceMessageId: z.string().optional(),
  // Saman sähköpostiketjun aiempien viestien tunnisteet; niiden avulla vastaus löytää tehtävänsä.
  threadMessageIds: z.array(z.string()).max(200).optional(),
  recipientEmails: z.array(z.string()).optional(),
  // Isännöitsijän omaan postilaatikkoon tullut viesti annetaan suoraan hänelle, ja vastaukset
  // lähetetään samasta laatikosta.
  assigneeId: z.string().optional(),
  mailAccountId: z.string().optional(),
  // Postin tuonti ei tunnistanut taloyhtiötä: companyId on vain paikkamerkki.
  companyUnknown: z.boolean().optional()
});

// Taloyhtiö lähettäjän sähköpostiosoitteesta, jos osoite on täsmälleen yhden yhtiön asukkaalla.
function companyByResidentEmail(senderEmail: string | undefined, companyIds: string[]) {
  if (!senderEmail || companyIds.length === 0) return null;
  const rows = db.prepare(`
    SELECT DISTINCT company_id FROM residents
    WHERE lower(email) = lower(?) AND erased_at IS NULL AND company_id IN (${companyIds.map(() => "?").join(", ")})
  `).all(senderEmail, ...companyIds) as { company_id: string }[];
  return rows.length === 1 ? rows[0].company_id : null;
}

// Ketjuun (In-Reply-To/References) liitettävän vastauksen lähettäjä varmennetaan tehtävän osallistujaksi,
// jotta väärennetyllä In-Reply-To-otsakkeella ei voi kaapata ketjua ja saada isännöinnin vastauksia itselleen.
function threadEmail(sender: string): string {
  return (sender.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "").toLowerCase();
}
function knownThreadEmails(ticketId: string): Set<string> {
  const emails = new Set<string>();
  const residents = db.prepare(`
    SELECT lower(r.email) AS email FROM residents r
    WHERE r.email IS NOT NULL AND (
      r.id = (SELECT resident_id FROM tickets WHERE id = ?)
      OR r.id IN (SELECT resident_id FROM ticket_reporters WHERE ticket_id = ?))
  `).all(ticketId, ticketId) as { email: string | null }[];
  for (const row of residents) if (row.email) emails.add(row.email);
  const senders = db.prepare("SELECT sender FROM messages WHERE ticket_id = ?").all(ticketId) as { sender: string }[];
  for (const row of senders) { const email = threadEmail(row.sender); if (email) emails.add(email); }
  return emails;
}

inboundRouter.post("/inbound/messages", async (req, res) => {
  // Tämä reitti on vain palvelimen oman postintuonnin käyttöön (sisäinen tunniste). Kirjautunut henkilökunta
  // ei saa luoda viestejä tätä kautta: muuten käyttäjä voisi tehdä tehtäviä toisiin taloyhtiöihin ja väärentää
  // lähettäjän. Tehtävät luodaan reitillä POST /tickets.
  if (req.headers["x-internal-token"] !== INTERNAL_TOKEN) {
    return res.status(403).json({ error: "Ei käyttöoikeutta." });
  }
  const parsed = inboundSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const input = parsed.data;
  // Taloyhtiö vastaanottajan osoitteesta; jos postin tuonti ei tunnistanut yhtiötä, lähettäjästä. Muuten
  // tehtävä menee Taloyhtiö tunnistamatta -jonoon, eikä sitä anneta oletusyhtiön isännöitsijälle.
  const recipientCompany = companyIdForRecipients(input.recipientEmails);
  const residentCompany = !recipientCompany && input.companyUnknown ? companyByResidentEmail(input.senderEmail, visibleCompanyIds()) : null;
  let companyPending = !recipientCompany && !residentCompany && Boolean(input.companyUnknown);
  let companyId = recipientCompany ?? residentCompany ?? companyIdFromContext(input.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });

if (input.sourceMessageId) {
  const existing = db.prepare(
    "SELECT ticket_id FROM gmail_imports WHERE gmail_message_id = ?"
  ).get(input.sourceMessageId) as
    | { ticket_id: string }
    | undefined;

  if (existing) {
    return res.json({
      ticketId: existing.ticket_id,
      duplicate: true
    });
  }

  // Lomakeviestistä tehtiin jo tietue (lukema, muutto tai lämmityspaikka).
  if (db.prepare("SELECT 1 FROM form_imports WHERE message_id = ?").get(input.sourceMessageId)) {
    return res.json({ duplicate: true });
  }

  // Viesti kuului tehtävään, joka on poistettu: sitä ei tuoda uudelleen.
  if (db.prepare("SELECT 1 FROM deleted_mail_messages WHERE message_id = ?").get(input.sourceMessageId)) {
    return res.json({ duplicate: true, deleted: true });
  }
}

  // Vastaus ketjuun, jolla on jo tehtävä, lisätään sen tehtävän aikajanalle uuden tehtävän sijaan.
  const threadIds = input.threadMessageIds ?? [];
  if (threadIds.length > 0) {
    const linked = db.prepare(`
      SELECT ticket_id FROM gmail_imports
      WHERE gmail_message_id IN (${threadIds.map(() => "?").join(", ")})
      ORDER BY created_at
      LIMIT 1
    `).get(...threadIds) as { ticket_id: string } | undefined;
    const existingTicket = linked && getAuthorizedTicket(linked.ticket_id) as any;

    // Lähettäjän pitää olla ketjun osallistuja (sama sähköposti kuin ilmoittajalla tai aiemmalla viestillä).
    // Muuten viestiä ei liitetä olemassa olevaan tehtävään, vaan se käsitellään uutena (väärennetty ketju).
    const senderVerified = existingTicket
      && (input.senderEmail ?? "").toLowerCase() !== ""
      && knownThreadEmails(existingTicket.id).has((input.senderEmail ?? "").toLowerCase());

    if (existingTicket && senderVerified) {
      const timestamp = now();
      // Suljettu tehtävä avataan uudelleen päätösjonoon ja vastattu muuttuu avoimeksi; muuten se pysyy
      // nykyisellä käsittelijällään ennallaan.
      const nextStatus = statusAfterResidentReply(existingTicket.status);
      const reopened = nextStatus !== existingTicket.status;

      const appendedMessageId = id("message");
      db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        appendedMessageId,
        existingTicket.id,
        "inbound",
        input.senderEmail ? `${input.senderName} <${input.senderEmail}>` : input.senderName,
        input.subject,
        input.body,
        timestamp,
        input.channel
      );

      db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(
        nextStatus,
        timestamp,
        existingTicket.id
      );
      detectSensitivity(existingTicket.id, `${input.subject}\n${input.body}`);

      db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
        id("audit"),
        existingTicket.id,
        "system",
        reopened ? "reply_received_reopened" : "reply_received",
        JSON.stringify({ sender: input.senderEmail ?? input.senderName }),
        timestamp
      );

      if (input.sourceMessageId) {
        db.prepare(`
          INSERT INTO gmail_imports
            (gmail_message_id, ticket_id, created_at)
          VALUES (?, ?, ?)
        `).run(input.sourceMessageId, existingTicket.id, timestamp);
      }

      // AI-agentin hoitamassa tehtävässä agentti jatkaa asukkaan vastauksesta (esim. valittu vuoro).
      scheduleAgent(existingTicket.id, "reply");
      return res.status(201).json({ ticketId: existingTicket.id, messageId: appendedMessageId, appended: true, reopened });
    }
  }

  // Verkkosivun lomake (esim. Huoltotyötilaus) tunnistetaan otsikosta, ja sen kentät luetaan viestistä.
  // Lomakkeen osoite ratkaisee taloyhtiön ja asunnon, ja ilmoittaja haetaan lomakkeen yhteystiedoista,
  // koska viestin lähettäjä on yleensä verkkosivun oma osoite.
  const emailForm = input.channel === "email" ? detectEmailForm(input.subject) : null;
  const formFields = emailForm ? parseFormFields(emailForm, input.body) : [];
  const form = emailForm && formFields.length >= 2 ? emailForm : null;
  const formPlace = form ? apartmentForForm(formFields, [...AUTHORIZED_COMPANY_IDS]) : null;
  if (formPlace) {
    companyId = formPlace.companyId;
    // Lomakkeen asunnosta tunnistettiin taloyhtiö, joten tehtävä ei mene jonoon.
    companyPending = false;
  }
  const contact = form ? formContact(formFields) : null;

  // Mittarilukemat, muuttoilmoitukset ja lämmityspaikat menevät taloyhtiön tauluihin, eivät tehtäviksi.
  if (form === "meter" || form === "move" || form === "heating") {
    const fallbackCompany = db.prepare("SELECT 1 FROM companies WHERE id = ?").get(companyId) ? companyId : null;
    const record = fallbackCompany ? importSiteForm(form, formFields, fallbackCompany, input.senderName) : null;
    if (record) {
      if (input.sourceMessageId) {
        db.prepare("INSERT OR IGNORE INTO form_imports (message_id, record_kind, record_ids, created_at) VALUES (?, ?, ?, ?)")
          .run(input.sourceMessageId, record.kind, JSON.stringify(record.ids), now());
      }
      return res.status(201).json({ record: record.kind, recordIds: record.ids, companyId: record.companyId });
    }
  }

  const company = db.prepare("SELECT * FROM companies WHERE id = ?")
    .get(companyId) as any;
  if (!company) return res.status(404).json({ error: "Company not found" });

  const resident = (contact && findResident(companyId, contact.email || undefined, contact.name || undefined))
    ?? findResident(
      companyId,
      input.senderEmail,
      input.senderName
    );

  // Arkaluonteista viestiä ei lähetetä AI:lle, joten se luokitellaan avainsanoilla.
  const sensitiveWords = sensitiveMatches(`${input.subject}\n${input.body}`);

  // Saapuva viesti vain luokitellaan. Dokumentaatiota ei haeta eikä ehdoteta ennen kuin
  // käsittelijä pyytää tehtävällä AI-ehdotuksen.
  // AI:lle lähtevä tieto kirjataan lokiin ja liitetään tehtävään, kun se on luotu.
  const { result, auditIds: aiAuditIds } = await withAiLog(undefined, () => triage(
    input.subject,
    input.body,
    [],
    company.maintenance_emergency_phone || undefined,
    {
      // Lomakkeissa voi olla henkilötunnuksia ja tilinumeroita, joten niitä ei lähetetä AI:lle.
      aiPriority: aiPriorityEnabled() && sensitiveWords.length === 0 && !form,
      // Asiaankuuluvuus tarkistetaan vain sähköposteista; käsin kirjattu asia kuuluu aina jonoon.
      aiRelevance: input.channel === "email" && aiRelevanceEnabled() && sensitiveWords.length === 0 && !form,
      sender: input.senderEmail ? `${input.senderName} <${input.senderEmail}>` : input.senderName
    }
  ));
  // AI:n suodattama viesti tallennetaan suljettuna tehtävänä: se ei mene päätösjonoon eikä hälytä,
  // mutta löytyy kaikista tehtävistä ja sen voi avata uudelleen.
  const filtered = Boolean(result.filtered) && !form;

  const ticketId = id("ticket");
  const messageId = id("message");
  const auditId = id("audit");
  const timestamp = now();

  db.prepare(`
    INSERT INTO tickets
    (id, company_id, apartment_id, resident_id, type, priority, status, subject,
     summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticketId,
    companyId,
    // Lomakkeen asunto ratkaisee, vaikka ilmoittaja asuisi muualla (esim. omistaja ilmoittaa vuokra-asunnosta).
    formPlace?.apartmentId ?? resident?.apartment_id ?? null,
    resident?.id ?? null,
    // Tietueeksi kelpaamaton lukema-, muutto- tai lämmityspaikkalomake on tavallinen tehtävä lomakekortin kera.
    form && !["meter", "move", "heating"].includes(form) ? FORM_TYPES[form] : result.type,
    result.priority,
    filtered ? "closed" : "open",
    form ? formSubject(form, formFields, input.subject) : input.subject,
    result.summary,
    input.channel,
    filtered ? "filtered" : result.emergency ? "emergency" : "pending_decision",
    filtered ? result.filterReason ?? "" : result.reason,
    // Vastauskenttä alkaa tyhjänä; luonnos syntyy vasta käsittelijän tai AI-ehdotuksen kautta.
    "",
    timestamp,
    timestamp
  );
  attachAiLog(aiAuditIds, ticketId);

  const mailboxOwner = input.assigneeId
    ? db.prepare("SELECT id FROM users WHERE id = ?").get(input.assigneeId) as { id: string } | undefined
    : undefined;
  if (filtered) {
    // Suodatettu viesti ei mene kenenkään käsiteltäväksi.
  } else if (mailboxOwner) {
    db.prepare("UPDATE tickets SET assignee_id = ? WHERE id = ?").run(mailboxOwner.id, ticketId);
  } else if (!companyPending) {
    assignToCompanyManager(ticketId, companyId);
  }
  if (companyPending) {
    db.prepare("UPDATE tickets SET company_pending = 1, resident_id = NULL, apartment_id = NULL WHERE id = ?").run(ticketId);
    db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
      id("audit"), ticketId, "system", "company_unidentified", "{}", timestamp
    );
  }
  if (input.mailAccountId) {
    db.prepare("UPDATE tickets SET mail_account_id = ? WHERE id = ?").run(input.mailAccountId, ticketId);
  }

  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    messageId,
    ticketId,
    "inbound",
    input.senderEmail
      ? `${input.senderName} <${input.senderEmail}>`
      : input.senderName,
    input.subject,
    input.body,
    timestamp,
    input.channel
  );
  if (sensitiveWords.length) detectSensitivity(ticketId, `${input.subject}\n${input.body}`);
  if (form) {
    db.prepare("INSERT INTO portal_forms (ticket_id, form, resident_id, fields, source, created_at) VALUES (?, ?, ?, ?, 'email', ?)")
      .run(ticketId, form, resident?.id ?? null, JSON.stringify(formFields), timestamp);
  }

  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    auditId,
    ticketId,
    "ai",
    filtered ? "ai_filtered" : result.emergency ? "emergency_routed" : "triaged",
    JSON.stringify(result),
    timestamp
  );

if (input.sourceMessageId) {
  db.prepare(`
    INSERT INTO gmail_imports
      (gmail_message_id, ticket_id, created_at)
    VALUES (?, ?, ?)
  `).run(input.sourceMessageId, ticketId, timestamp);
}

  if (result.emergency && !filtered) void alertEmergency(ticketId);
  // AI-agentti hoitaa sauna-, pyykkitupa- ja autopaikka-asiat itse, kun toimisto on kytkenyt sen päälle.
  if (!filtered && !result.emergency && !form) scheduleAgent(ticketId, "new");

  res.status(201).json({
    ticketId,
    messageId,
    emergency: result.emergency && !filtered,
    filtered,
    action: filtered ? "filtered" : result.emergency ? "emergency_routed" : "decision_queue"
  });
});
