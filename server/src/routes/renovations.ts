import express, { type Router } from "express";
import { z } from "zod";
import { companyIdFromContext } from "../access.js";
import { requireManager } from "../auth.js";
import { db } from "../db.js";
import { notifyResident } from "../notify.js";
import { id, now } from "../util.js";
import { portalResident, savePortalAttachments, portalAttachmentsSchema } from "./portal.js";

export const renovationsRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Remontti-ilmoitukset (muutostyöilmoitukset, asunto-osakeyhtiölain 4. luku). Jokainen ilmoitus on
// tehtävä (tickets.kind = 'renovation'), jolla on samat viestit, muistiinpanot, liitteet ja loki kuin
// muillakin tehtävillä. Ilmoituksen tiedot ovat renovation_notices-rivillä. Remonttitehtävät ovat
// auki pitkään, joten ne eivät mene päätösjonoon vaan Remontit-osioon ja Kaikkiin tehtäviin.
//
// Vaiheet: pending (ilmoitettu) → approved (hyväksytty, mahdollisesti ehdoin) tai rejected →
// started (aloitettu) → completed (valmis) → inspected (tarkastettu). Valvontakäynti kirjataan
// lokiin tilaa muuttamatta, ja sen voi kirjata useasti.
// ---------------------------------------------------------------------------------------------
export const RENOVATION_WORK_TYPES = ["Märkätila", "Keittiö", "Sähkö", "LVI", "Rakenteet", "Muu"] as const;
export const RENOVATION_STATUSES = ["pending", "approved", "rejected", "started", "completed", "inspected"] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const fiDay = (day: string | null) => (day ? day.split("-").reverse().join(".") : "");

// Lomakkeen kentät. Mikään ei ole pakollinen, jotta toimisto voi käyttää lomaketta haluamallaan tavalla.
// Vanhoissa ilmoituksissa voi olla työn tyyppi, jota ei enää ole listassa; se säilyy sellaisenaan.
const text = (max: number) => z.string().trim().max(max).default("");
const optionalDay = z.union([z.literal(""), z.string().regex(DAY)]).nullable().default(null)
  .transform(value => value || null);
export const renovationFieldsSchema = z.object({
  workType: z.string().trim().max(60).default(""),
  description: text(5000),
  startDate: optionalDay,
  endDate: optionalDay,
  contractor: text(300),
  contractorContact: text(300),
  supervisor: text(300),
  impactStructures: text(2000),
  impactWater: text(2000),
  impactSewer: text(2000),
  impactElectric: text(2000),
  impactVentilation: text(2000),
  waterproofing: text(2000),
  hazmatSurvey: text(2000)
});
type RenovationFields = z.infer<typeof renovationFieldsSchema>;

// Lomakkeen kenttä → tietokannan sarake.
const FIELD_COLUMNS: Record<keyof RenovationFields, string> = {
  workType: "work_type",
  description: "description",
  startDate: "start_date",
  endDate: "end_date",
  contractor: "contractor",
  contractorContact: "contractor_contact",
  supervisor: "supervisor",
  impactStructures: "impact_structures",
  impactWater: "impact_water",
  impactSewer: "impact_sewer",
  impactElectric: "impact_electric",
  impactVentilation: "impact_ventilation",
  waterproofing: "waterproofing",
  hazmatSurvey: "hazmat_survey"
};

// currentWorkType: muokattavan ilmoituksen nykyinen tyyppi, joka saa säilyä, vaikka sitä ei enää ole listassa.
function fieldsError(fields: RenovationFields, currentWorkType = "") {
  if (fields.workType && fields.workType !== currentWorkType && !(RENOVATION_WORK_TYPES as readonly string[]).includes(fields.workType)) {
    return "Valitse työn tyyppi listasta.";
  }
  if (fields.startDate && fields.endDate && fields.endDate < fields.startDate) return "Päättymispäivä ei voi olla ennen alkamispäivää.";
  return null;
}

export type RenovationNotice = {
  id: string; company_id: string; apartment_id: string | null; resident_id: string | null; reporter_name: string;
  work_type: string; description: string; start_date: string | null; end_date: string | null; status: string;
  decision_note: string; created_at: string; ticket_id: string | null; decided_at: string | null; completed_at: string | null;
};

function audit(ticketId: string, actor: string, action: string, details: Record<string, unknown>, timestamp = now()) {
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), ticketId, actor, action, JSON.stringify(details), timestamp);
}

function apartmentNumber(apartmentId: string | null) {
  if (!apartmentId) return "";
  return (db.prepare("SELECT apartment_number FROM apartments WHERE id = ?").get(apartmentId) as { apartment_number: string } | undefined)
    ?.apartment_number ?? "";
}

function ticketSubject(notice: Pick<RenovationNotice, "work_type" | "apartment_id">) {
  const apartment = apartmentNumber(notice.apartment_id);
  return ["Remontti-ilmoitus", [notice.work_type, apartment && `asunto ${apartment}`].filter(Boolean).join(", ")]
    .filter(Boolean).join(": ");
}

// Ilmoituksen tiedot tekstinä: tehtävän kuvaus ja asukkaan portaalissa näkemä viesti.
function noticeText(notice: Record<string, string | null>) {
  const rows: [string, string | null][] = [
    ["Työn tyyppi", notice.work_type],
    ["Ajankohta", notice.start_date || notice.end_date ? `${fiDay(notice.start_date)}–${fiDay(notice.end_date)}` : ""],
    ["Urakoitsija", notice.contractor],
    ["Urakoitsijan yhteystiedot", notice.contractor_contact],
    ["Vastuuhenkilö / valvoja", notice.supervisor]
  ];
  const facts = rows.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`);
  return [notice.description, facts.join("\n")].filter(Boolean).join("\n\n") || "Remontti-ilmoitus";
}

// Tilan mukainen tehtävän tila: hylätty ja tarkastettu remontti on hoidettu, muut ovat kesken.
function ticketStatusFor(renovationStatus: string, assigneeId: string | null) {
  if (renovationStatus === "rejected" || renovationStatus === "inspected") return "closed";
  return assigneeId ? "waiting_manager" : "open";
}

// Luo ilmoitukselle tehtävän, joka osoitetaan taloyhtiön vastuuisännöitsijälle. Käytetään uudelle
// ilmoitukselle ja vanhojen ilmoitusten siirrossa tehtäviksi.
export function createRenovationTicket(notice: RenovationNotice & Record<string, string | null>, options: {
  actor: string; channel: "portal" | "manual"; assigneeId?: string | null;
}) {
  const ticketId = id("ticket");
  const manager = db.prepare("SELECT manager_id FROM companies WHERE id = ?").get(notice.company_id) as { manager_id: string | null } | undefined;
  const assigneeId = options.assigneeId ?? manager?.manager_id ?? null;
  db.prepare(`
    INSERT INTO tickets
    (id, company_id, apartment_id, resident_id, type, priority, status, subject, summary,
     source_channel, ai_action, ai_reason, draft, created_at, updated_at, assignee_id, kind, due_date)
    VALUES (?, ?, ?, ?, 'Remontti-ilmoitus', 'normal', ?, ?, ?, ?, 'human', 'Remontti-ilmoitus', '', ?, ?, ?, 'renovation', ?)
  `).run(
    ticketId, notice.company_id, notice.apartment_id, notice.resident_id,
    ticketStatusFor(notice.status, assigneeId), ticketSubject(notice), noticeText(notice).slice(0, 5000), options.channel,
    notice.created_at, notice.created_at, assigneeId, notice.end_date ?? "",
  );
  // Määräaika on remontin päättymispäivä. Ilman päättymispäivää määräaikaa ei aseteta.
  if (!notice.end_date) db.prepare("UPDATE tickets SET due_date = NULL WHERE id = ?").run(ticketId);
  if (notice.resident_id) {
    db.prepare("INSERT OR IGNORE INTO ticket_reporters (ticket_id, resident_id) VALUES (?, ?)").run(ticketId, notice.resident_id);
  }
  db.prepare("UPDATE renovation_notices SET ticket_id = ? WHERE id = ?").run(ticketId, notice.id);
  audit(ticketId, options.actor, "renovation_reported", {}, notice.created_at);
  return ticketId;
}

function insertNotice(input: {
  companyId: string; apartmentId: string | null; residentId: string | null; reporterName: string; fields: RenovationFields;
}) {
  const noticeId = id("renovation");
  const columns = Object.values(FIELD_COLUMNS);
  db.prepare(`
    INSERT INTO renovation_notices (id, company_id, apartment_id, resident_id, reporter_name, created_at, ${columns.join(", ")})
    VALUES (?, ?, ?, ?, ?, ?, ${columns.map(() => "?").join(", ")})
  `).run(noticeId, input.companyId, input.apartmentId, input.residentId, input.reporterName, now(),
    ...(Object.keys(FIELD_COLUMNS) as (keyof RenovationFields)[]).map(key => input.fields[key]));
  return db.prepare("SELECT * FROM renovation_notices WHERE id = ?").get(noticeId) as RenovationNotice & Record<string, string | null>;
}

// Asukkaan ilmoitus portaalissa. Liitteiksi kelpaavat kuvat ja PDF:t (suunnitelmat, piirustukset, todistukset).
renovationsRouter.post("/portal/renovations", async (req, res) => {
  const resident = portalResident(res);
  const parsed = renovationFieldsSchema.extend({ attachments: portalAttachmentsSchema }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Tarkista ilmoituksen tiedot." });
  const { attachments, ...fields } = parsed.data;
  const invalid = fieldsError(fields);
  if (invalid) return res.status(400).json({ error: invalid });

  const notice = insertNotice({
    companyId: resident.companyId, apartmentId: resident.apartmentId ?? null, residentId: resident.id, reporterName: resident.name, fields
  });
  const ticketId = createRenovationTicket(notice, { actor: resident.name, channel: "portal" });
  // Ilmoitus näkyy asukkaalle tehtävän ensimmäisenä viestinä portaalissa.
  db.prepare("INSERT INTO messages VALUES (?, ?, 'inbound', ?, ?, ?, ?, 'portal')").run(
    id("message"), ticketId, resident.name, ticketSubject(notice), noticeText(notice), notice.created_at
  );
  const attachmentError = await savePortalAttachments(ticketId, attachments, notice.created_at);
  res.status(201).json({ ok: true, renovationId: notice.id, ticketId, attachmentError });
});

renovationsRouter.get("/portal/renovations", (_req, res) => {
  res.json(db.prepare(`
    SELECT n.*, t.ticket_number FROM renovation_notices n LEFT JOIN tickets t ON t.id = n.ticket_id
    WHERE n.resident_id = ? ORDER BY n.created_at DESC LIMIT 50
  `).all(portalResident(res).id));
});

// Toimisto kirjaa ilmoituksen itse, esim. puhelimitse tulleen. Asukas ja asunto ovat valinnaisia.
renovationsRouter.post("/companies/:companyId/renovations", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  const parsed = renovationFieldsSchema.extend({
    residentId: z.string().nullable().default(null),
    apartmentId: z.string().nullable().default(null),
    reporterName: text(200)
  }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Tarkista ilmoituksen tiedot." });
  const { residentId, apartmentId, reporterName, ...fields } = parsed.data;
  const invalid = fieldsError(fields);
  if (invalid) return res.status(400).json({ error: invalid });

  const resident = residentId
    ? db.prepare("SELECT id, name, apartment_id FROM residents WHERE id = ? AND company_id = ?").get(residentId, companyId) as
      { id: string; name: string; apartment_id: string | null } | undefined
    : undefined;
  if (residentId && !resident) return res.status(404).json({ error: "Asukasta ei löytynyt tästä taloyhtiöstä." });
  const apartment = apartmentId
    ? db.prepare("SELECT id FROM apartments WHERE id = ? AND company_id = ?").get(apartmentId, companyId) as { id: string } | undefined
    : undefined;
  if (apartmentId && !apartment) return res.status(404).json({ error: "Asuntoa ei löytynyt tästä taloyhtiöstä." });

  const notice = insertNotice({
    companyId,
    apartmentId: apartment?.id ?? resident?.apartment_id ?? null,
    residentId: resident?.id ?? null,
    reporterName: reporterName || resident?.name || "",
    fields
  });
  // Käsin kirjattu ilmoitus on kirjaajansa käsittelyssä, kuten muutkin käsin luodut tehtävät.
  const ticketId = createRenovationTicket(notice, {
    actor: res.locals.user?.name ?? "Isännöitsijä", channel: "manual", assigneeId: res.locals.user?.id ?? null
  });
  res.status(201).json({ ok: true, renovationId: notice.id, ticketId });
});

renovationsRouter.get("/companies/:companyId/renovations", (req, res) => {
  const companyId = companyIdFromContext(req.params.companyId);
  if (!companyId) return res.status(403).json({ error: "Company not authorized" });
  res.json(db.prepare(`
    SELECT n.*, COALESCE(r.name, NULLIF(n.reporter_name, '')) AS resident_name, r.email AS resident_email,
           a.apartment_number, a.address, t.ticket_number, t.status AS ticket_status, u.name AS assignee_name
    FROM renovation_notices n
    LEFT JOIN residents r ON r.id = n.resident_id
    LEFT JOIN apartments a ON a.id = n.apartment_id
    LEFT JOIN tickets t ON t.id = n.ticket_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE n.company_id = ?
    ORDER BY n.status = 'pending' DESC, n.created_at DESC
  `).all(companyId));
});

// Remontti-ilmoitus, jonka taloyhtiöön käyttäjällä on oikeus. Tunniste voi olla ilmoituksen tai tehtävän.
function authorizedNotice(noticeId: string) {
  const notice = db.prepare("SELECT * FROM renovation_notices WHERE id = ? OR ticket_id = ?").get(noticeId, noticeId) as
    | (RenovationNotice & Record<string, string | null>)
    | undefined;
  if (!notice || !companyIdFromContext(notice.company_id)) return null;
  return notice;
}

// Ilmoituksen tietojen muokkaus tehtävällä. Lokiin kirjataan muuttuneet kentät.
renovationsRouter.put("/renovations/:id", (req, res) => {
  const notice = authorizedNotice(req.params.id);
  if (!notice) return res.status(404).json({ error: "Remontti-ilmoitusta ei löytynyt." });
  const parsed = renovationFieldsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Tarkista ilmoituksen tiedot." });
  const invalid = fieldsError(parsed.data, notice.work_type);
  if (invalid) return res.status(400).json({ error: invalid });

  const changed = (Object.keys(FIELD_COLUMNS) as (keyof RenovationFields)[])
    .filter(key => (notice[FIELD_COLUMNS[key]] ?? null) !== (parsed.data[key] ?? null)
      && !((notice[FIELD_COLUMNS[key]] ?? "") === "" && (parsed.data[key] ?? "") === ""));
  if (changed.length === 0) return res.json({ ok: true });

  const timestamp = now();
  db.prepare(`UPDATE renovation_notices SET ${changed.map(key => `${FIELD_COLUMNS[key]} = ?`).join(", ")} WHERE id = ?`)
    .run(...changed.map(key => parsed.data[key]), notice.id);
  if (notice.ticket_id) {
    const updated = { ...notice, ...Object.fromEntries(changed.map(key => [FIELD_COLUMNS[key], parsed.data[key]])) };
    db.prepare("UPDATE tickets SET subject = ?, summary = ?, due_date = COALESCE(?, due_date), updated_at = ? WHERE id = ?")
      .run(ticketSubject(updated), noticeText(updated).slice(0, 5000), changed.includes("endDate") ? parsed.data.endDate : null,
        timestamp, notice.ticket_id);
    audit(notice.ticket_id, res.locals.user?.name ?? "Isännöitsijä", "renovation_updated", { fields: changed.map(key => FIELD_COLUMNS[key]) }, timestamp);
  }
  res.json({ ok: true });
});

const decisionSchema = z.object({ note: z.string().trim().max(3000).default("") });

// Vaiheen kirjaus: päivittää ilmoituksen ja tehtävän tilan ja lisää vaiheen tehtävän lokiin.
function recordPhase(notice: RenovationNotice, phase: string, status: string | null, actor: string, note: string) {
  const timestamp = now();
  db.transaction(() => {
    if (status) {
      const stamp = status === "started" ? "started_at" : status === "completed" ? "completed_at" : status === "inspected" ? "inspected_at" : null;
      db.prepare(`UPDATE renovation_notices SET status = ?${stamp ? `, ${stamp} = ?` : ""} WHERE id = ?`)
        .run(...(stamp ? [status, timestamp, notice.id] : [status, notice.id]));
    }
    if (notice.ticket_id) {
      const ticket = db.prepare("SELECT status, assignee_id FROM tickets WHERE id = ?").get(notice.ticket_id) as
        { status: string; assignee_id: string | null } | undefined;
      if (ticket && status) {
        const next = ticketStatusFor(status, ticket.assignee_id);
        // Keskeneräistä tehtävää ei siirretä takaisin päätösjonon tilaan, jos käsittely on jo edennyt.
        const ticketStatus = next === "closed" ? "closed" : ticket.status === "closed" ? next : ticket.status;
        db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(ticketStatus, timestamp, notice.ticket_id);
      } else {
        db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(timestamp, notice.ticket_id);
      }
      audit(notice.ticket_id, actor, `renovation_${phase}`, note ? { note } : {}, timestamp);
    }
  })();
}

// Hyväksyntä ja hylkäys ovat isännöitsijän päätöksiä; asukas saa niistä sähköpostin.
renovationsRouter.post("/renovations/:id/approve", requireManager, (req, res) => {
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Ehdot ovat liian pitkät." });
  const notice = authorizedNotice(req.params.id);
  if (!notice) return res.status(404).json({ error: "Remontti-ilmoitusta ei löytynyt." });
  if (notice.status !== "pending") return res.status(409).json({ error: "Remontti-ilmoitus on jo käsitelty." });

  const actor = res.locals.user?.name ?? "Isännöitsijä";
  db.prepare("UPDATE renovation_notices SET decision_note = ?, decided_by = ?, decided_at = ? WHERE id = ?")
    .run(parsed.data.note, actor, now(), notice.id);
  recordPhase(notice, "approved", "approved", actor, parsed.data.note);
  if (notice.resident_id) {
    void notifyResident(notice.resident_id, "Remontti-ilmoitus on hyväksytty", [
      `remontti-ilmoituksesi (${[notice.work_type, period(notice)].filter(Boolean).join(", ")}) on hyväksytty.`,
      ...(parsed.data.note ? ["", "Hyväksynnän ehdot:", parsed.data.note] : [])
    ]);
  }
  res.json({ ok: true });
});

renovationsRouter.post("/renovations/:id/reject", requireManager, (req, res) => {
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success || !parsed.data.note) return res.status(400).json({ error: "Kirjoita hylkäämisen perustelu." });
  const notice = authorizedNotice(req.params.id);
  if (!notice) return res.status(404).json({ error: "Remontti-ilmoitusta ei löytynyt." });
  if (notice.status !== "pending") return res.status(409).json({ error: "Remontti-ilmoitus on jo käsitelty." });

  const actor = res.locals.user?.name ?? "Isännöitsijä";
  db.prepare("UPDATE renovation_notices SET decision_note = ?, decided_by = ?, decided_at = ? WHERE id = ?")
    .run(parsed.data.note, actor, now(), notice.id);
  recordPhase(notice, "rejected", "rejected", actor, parsed.data.note);
  if (notice.resident_id) {
    void notifyResident(notice.resident_id, "Remontti-ilmoitusta ei hyväksytty", [
      `remontti-ilmoitustasi (${[notice.work_type, period(notice)].filter(Boolean).join(", ")}) ei hyväksytty. Työtä ei saa aloittaa.`,
      "",
      "Perustelu:",
      parsed.data.note
    ]);
  }
  res.json({ ok: true });
});

function period(notice: Pick<RenovationNotice, "start_date" | "end_date">) {
  return notice.start_date || notice.end_date ? `${fiDay(notice.start_date)}–${fiDay(notice.end_date)}` : "";
}

// Vaiheet hyväksynnän jälkeen. Jokainen vaihe vaatii, että edellinen on kirjattu; valvontakäynnin voi
// kirjata hyväksytylle tai aloitetulle remontille.
const PHASES: Record<string, { from: string[]; status: string | null }> = {
  started: { from: ["approved"], status: "started" },
  supervision: { from: ["approved", "started"], status: null },
  completed: { from: ["approved", "started"], status: "completed" },
  inspected: { from: ["completed"], status: "inspected" }
};

renovationsRouter.post("/renovations/:id/phase", (req, res) => {
  const parsed = decisionSchema.extend({ phase: z.enum(["started", "supervision", "completed", "inspected"]) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Tarkista vaihe." });
  const notice = authorizedNotice(req.params.id);
  if (!notice) return res.status(404).json({ error: "Remontti-ilmoitusta ei löytynyt." });
  const phase = PHASES[parsed.data.phase];
  if (!phase.from.includes(notice.status)) return res.status(409).json({ error: "Vaihetta ei voi kirjata remontin nykyisessä tilassa." });
  recordPhase(notice, parsed.data.phase, phase.status, res.locals.user?.name ?? "Isännöitsijä", parsed.data.note);
  res.json({ ok: true });
});

// Aiempi rajapinta valmistuneeksi merkitsemiseen.
renovationsRouter.post("/renovations/:id/complete", requireManager, (req, res) => {
  const notice = authorizedNotice(req.params.id);
  if (!notice) return res.status(404).json({ error: "Remontti-ilmoitusta ei löytynyt." });
  if (!PHASES.completed.from.includes(notice.status)) return res.status(409).json({ error: "Vain hyväksytyn remontin voi merkitä valmistuneeksi." });
  recordPhase(notice, "completed", "completed", res.locals.user?.name ?? "Isännöitsijä", "");
  res.json({ ok: true });
});

// Ennen tätä muutosta tehdyt ilmoitukset siirretään tehtäviksi kerran. Tila ja päätösteksti säilyvät,
// ja päätös ja valmistuminen kirjataan tehtävän lokiin alkuperäisin ajoin.
export function migrateRenovationNotices() {
  const pending = db.prepare("SELECT * FROM renovation_notices WHERE ticket_id IS NULL ORDER BY created_at").all() as
    (RenovationNotice & Record<string, string | null>)[];
  for (const notice of pending) {
    db.transaction(() => {
      const ticketId = createRenovationTicket(notice, { actor: "system", channel: notice.resident_id ? "portal" : "manual" });
      if (notice.decided_at && (notice.status !== "pending")) {
        const decision = notice.status === "rejected" ? "rejected" : "approved";
        audit(ticketId, notice.decided_by ?? "Isännöitsijä", `renovation_${decision}`,
          notice.decision_note ? { note: notice.decision_note } : {}, notice.decided_at);
      }
      if (notice.completed_at) audit(ticketId, "system", "renovation_completed", {}, notice.completed_at);
    })();
  }
}
