import { AUTHORIZED_COMPANY_IDS } from "./access.js";
import { db } from "./db.js";
import { sendEmail } from "./mail.js";
import { formatTicketNumber } from "./numbers.js";
import { sendTicketReply } from "./ticket-reply.js";
import { id, now, stairwellOf, VALID_EMAIL } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Yhteisten vikojen tunnistus. Jokainen tehtävä saa aiheen (lämmitys, hissi, vesivuoto…) tekstin
// avainsanoista. Kun usea eri asunto ilmoittaa samasta aiheesta lyhyessä ajassa ja selvästi
// tavallista enemmän, syntyy poikkeama: isännöitsijä näkee sen päätösjonossa ja saa sähköpostin.
// Tunnistus on laskentaa eikä käytä AI:ta; AI-tulkinnan voi pyytää poikkeamalta erikseen.
// ---------------------------------------------------------------------------------------------

type TopicRule = {
  label: string;
  // Aihe elatiivissa lauseeseen "on ilmoittanut lämmityksestä".
  about: string;
  // Sanan alut, joista aihe tunnistetaan ($ lopussa = koko sana). Aiheet tarkistetaan järjestyksessä:
  // ensimmäinen osuva aihe voittaa.
  words: string[];
  // Seurataanko aihetta poikkeamina; esim. varaukset eivät ole vikoja.
  tracked: boolean;
  // Montako eri asuntoa ikkunan aikana tekee poikkeaman.
  threshold: number;
  windowHours: number;
  // Lyhyt selitys isännöitsijälle, miksi usea ilmoitus viittaa yhteiseen syyhyn.
  hint: string;
  // Työtilauksen pyyntö huoltoyhtiölle (paikka lisätään perään).
  request: string;
};

export const TOPIC_RULES = {
  booking: {
    label: "Varaukset", about: "varauksista",
    words: ["saunavuor", "pyykkivuor", "pesuvuor", "varata", "varaus", "varaan", "vuoron", "vuoroa", "autopaik", "lämmityspaik", "parkkipaik"],
    tracked: false, threshold: 0, windowHours: 0, hint: "", request: ""
  },
  hot_water: {
    label: "Lämmin vesi", about: "lämpimästä vedestä",
    words: ["lämmintä vettä", "lämmin vesi", "lämpimän veden", "lämmintä vesi", "kuumaa vettä", "kuuma vesi", "vain kylmää vettä", "lämminvesi"],
    tracked: true, threshold: 2, windowHours: 24,
    hint: "Lämmin vesi tulee yhteisestä järjestelmästä, joten usean asunnon ilmoitus viittaa lämmönjakokeskukseen tai kiertoon eikä yksittäisen asunnon hanoihin.",
    request: "Pyydämme tarkistamaan lämpimän käyttöveden tuoton ja kierron"
  },
  drain: {
    label: "Viemäri tai haju", about: "viemäristä tai hajusta",
    words: ["viemär", "lattiakaivo", "tukko", "tukossa", "ei vedä", "haju", "haisee", "löyhk", "kaivo"],
    tracked: true, threshold: 2, windowHours: 48,
    hint: "Kun saman portaan asunnot ilmoittavat viemäristä tai hajusta, tukos tai vika on todennäköisesti yhteisessä viemärilinjassa.",
    request: "Pyydämme tarkistamaan viemärilinjan"
  },
  water_leak: {
    label: "Vesivuoto", about: "vesivuodosta",
    words: ["vuoto", "vuota", "vuodo", "tulvi", "kosteus", "kostea", "kosteu", "läikkä", "tippuu", "tippu", "vesivahin", "valuu vettä"],
    tracked: true, threshold: 2, windowHours: 48,
    hint: "Usea vuoto tai kosteusläikkä samassa portaassa viittaa nousulinjan tai yläpuolisen asunnon vuotoon.",
    request: "Pyydämme tarkistamaan vuodon syyn ja nousulinjat"
  },
  heating: {
    label: "Lämmitys", about: "lämmityksestä",
    words: ["patteri", "lämmity", "lämmitt", "ei lämpene", "kylmä asun", "asunnossa kylmä", "asunnossa on kylmä", "on kylmä", "kylmää", "palelee",
      "astetta", "lämpötila", "viileä", "vilu"],
    tracked: true, threshold: 3, windowHours: 24,
    hint: "Kun useampi asunto ilmoittaa samaan aikaan, syy on todennäköisemmin yhteisessä lämmityksessä (esim. lämmönjakokeskus, pumppu tai portaan linja) kuin siinä, että patterit olisivat asunnoissa kiinni.",
    request: "Pyydämme tarkistamaan lämmityksen"
  },
  elevator: {
    label: "Hissi", about: "hissistä",
    words: ["hissi"],
    tracked: true, threshold: 2, windowHours: 24,
    hint: "Hissi on yhteinen, joten jo kaksi ilmoitusta kertoo, että vika on todellinen eikä yksittäinen havainto.",
    request: "Pyydämme tarkistamaan hissin"
  },
  electricity: {
    label: "Sähkö", about: "sähköstä",
    words: ["sähkö", "sulake", "valot", "valo ei", "valaistu", "pistorasi", "virta"],
    tracked: true, threshold: 2, windowHours: 24,
    hint: "Usean asunnon sähkövika viittaa yhteiseen syöttöön, pääkeskukseen tai verkkoyhtiön katkoon.",
    request: "Pyydämme tarkistamaan sähkönsyötön ja keskukset"
  },
  door: {
    label: "Ovi tai lukko", about: "ovesta tai lukosta",
    words: ["ulko-ov", "ulkoov", "porraskäytävän ov", "rappukäytävän ov", "summeri", "ovipuhel", "ovikoodi", "lukko", "lukon", "ovi$", "oven$", "ovea$", "ovesta$", "ovet$"],
    tracked: true, threshold: 2, windowHours: 48,
    hint: "Usea ilmoitus ovesta tai lukosta koskee yleensä yhteistä ovea, lukitusta tai ovipuhelinta.",
    request: "Pyydämme tarkistamaan yhteisten ovien lukituksen ja ovipuhelimen"
  },
  ventilation: {
    label: "Ilmanvaihto", about: "ilmanvaihdosta",
    words: ["ilmanvaih", "tuuletus", "tunkkai", "korvausilm", "huippuimur", "poistoilm"],
    tracked: true, threshold: 3, windowHours: 72,
    hint: "Usean asunnon ilmanvaihto-ongelma viittaa katon huippuimuriin tai yhteiseen kanavaan.",
    request: "Pyydämme tarkistamaan ilmanvaihdon ja huippuimurit"
  },
  common_room: {
    label: "Sauna tai pesutupa", about: "saunasta tai pesutuvasta",
    words: ["sauna", "kiuas", "kiukaa", "pesukone", "kuivausrum", "pesutupa", "pyykkitupa", "kuivaushuone"],
    tracked: true, threshold: 2, windowHours: 72,
    hint: "Kun usea asukas ilmoittaa samasta yhteisestä tilasta, vika on laitteessa eikä käyttäjässä.",
    request: "Pyydämme tarkistamaan yhteisen tilan laitteet"
  },
  pests: {
    label: "Tuholaiset", about: "tuholaisista",
    words: ["rotta", "rotat", "hiiri", "hiiriä", "hiiret", "lude", "torakka", "muurahai", "tuholai", "sokeritouk", "russakka"],
    tracked: true, threshold: 2, windowHours: 168,
    hint: "Tuholaiset leviävät asunnosta toiseen, joten usean asunnon havainto vaatii koko kiinteistön tarkastuksen.",
    request: "Pyydämme tuholaistarkastusta"
  },
  noise: {
    label: "Melu tai häiriö", about: "melusta tai häiriöstä",
    words: ["melu", "meteli", "häiri", "musiik", "bileet", "juhlat", "hiljaisuus", "kova ääni", "kovaa ääntä"],
    tracked: true, threshold: 3, windowHours: 72,
    hint: "Usea ilmoitus samasta häiriöstä vahvistaa, että asia koskee useampaa asukasta.",
    request: ""
  },
  waste: {
    label: "Jätehuolto", about: "jätehuollosta",
    words: ["roska", "jäte", "kierrätys", "biojäte", "pahvi", "tyhjennys"],
    tracked: true, threshold: 3, windowHours: 72,
    hint: "Usea ilmoitus jätehuollosta viittaa tyhjennyksen viivästymiseen.",
    request: "Pyydämme tarkistamaan jäteastioiden tyhjennyksen"
  },
  other: { label: "Muu", about: "muusta asiasta", words: [], tracked: false, threshold: 0, windowHours: 0, hint: "", request: "" }
} satisfies Record<string, TopicRule>;

export type TopicKey = keyof typeof TOPIC_RULES;
export const TOPIC_KEYS = Object.keys(TOPIC_RULES) as TopicKey[];
const rule = (topic: string): TopicRule => TOPIC_RULES[topic as TopicKey] ?? TOPIC_RULES.other;
export const isTopic = (value: string): value is TopicKey => value in TOPIC_RULES;

// Aiheet, joiden seurantaa ja rajoja isännöitsijä voi muuttaa (varaukset ja muu eivät ole vikoja).
export const ADJUSTABLE_TOPICS: TopicKey[] = TOPIC_KEYS.filter(topic => topic !== "booking" && topic !== "other");
export const RULE_LIMITS = { threshold: { min: 2, max: 50 }, windowHours: { min: 1, max: 720 } };

export type DetectionRule = { topic: TopicKey; label: string; tracked: boolean; threshold: number; windowHours: number;
  defaults: { tracked: boolean; threshold: number; windowHours: number } };

// Tunnistuksen rajat: oletukset, joiden päälle tulevat asetuksista muutetut arvot.
export function detectionRules(): DetectionRule[] {
  const row = db.prepare("SELECT incident_rules FROM office_settings WHERE id = 1").get() as { incident_rules: string } | undefined;
  let saved: Record<string, Partial<{ tracked: boolean; threshold: number; windowHours: number }>> = {};
  try {
    saved = JSON.parse(row?.incident_rules || "{}");
  } catch {
    saved = {};
  }
  return ADJUSTABLE_TOPICS.map(topic => {
    const base = TOPIC_RULES[topic];
    const custom = saved[topic] ?? {};
    const clamp = (value: unknown, fallback: number, { min, max }: { min: number; max: number }) =>
      Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : fallback;
    return {
      topic, label: base.label,
      tracked: typeof custom.tracked === "boolean" ? custom.tracked : base.tracked,
      threshold: clamp(custom.threshold, base.threshold, RULE_LIMITS.threshold),
      windowHours: clamp(custom.windowHours, base.windowHours, RULE_LIMITS.windowHours),
      defaults: { tracked: base.tracked, threshold: base.threshold, windowHours: base.windowHours }
    };
  });
}

// Tallentaa vain oletuksesta poikkeavat arvot, jotta oletusten muutos koodissa koskee muita aiheita.
export function saveDetectionRules(rules: { topic: string; tracked: boolean; threshold: number; windowHours: number }[]) {
  const changed: Record<string, { tracked?: boolean; threshold?: number; windowHours?: number }> = {};
  for (const item of rules) {
    if (!ADJUSTABLE_TOPICS.includes(item.topic as TopicKey)) continue;
    const base = TOPIC_RULES[item.topic as TopicKey];
    const diff = {
      ...(item.tracked !== base.tracked ? { tracked: item.tracked } : {}),
      ...(item.threshold !== base.threshold ? { threshold: item.threshold } : {}),
      ...(item.windowHours !== base.windowHours ? { windowHours: item.windowHours } : {})
    };
    if (Object.keys(diff).length) changed[item.topic] = diff;
  }
  db.prepare("UPDATE office_settings SET incident_rules = ? WHERE id = 1").run(JSON.stringify(changed));
}

// Tavallinen taso: montako eri asuntoa ilmoittaa aiheesta keskimäärin ikkunan mittaisessa ajassa
// edellisten 90 päivän aikana. Poikkeama vaatii vähintään kolminkertaisen määrän.
const BASELINE_DAYS = 90;
const BASELINE_FACTOR = 3;
// Uusi ilmoitus liitetään avoimeen poikkeamaan, jos siihen on ilmoitettu viimeisen viikon aikana.
const ATTACH_QUIET_DAYS = 7;

// Aihe tehtävän otsikosta ja ensimmäisestä viestistä. Sanat tunnistetaan sanan alusta, jotta esim.
// "kostea" osuu mutta "ovi" ei osu sanaan "kovin".
export function classifyTopic(text: string): TopicKey {
  const normalized = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  for (const topic of TOPIC_KEYS) {
    if (TOPIC_RULES[topic].words.some(word => wordAt(normalized, word))) return topic;
  }
  return "other";
}

function wordAt(text: string, pattern: string) {
  const whole = pattern.endsWith("$");
  const word = whole ? pattern.slice(0, -1) : pattern;
  const letter = /[a-zåäö0-9]/;
  let index = text.indexOf(word);
  while (index !== -1) {
    const startsWord = index === 0 || !letter.test(text[index - 1]);
    const endsWord = !whole || !letter.test(text[index + word.length] ?? " ");
    if (startsWord && endsWord) return true;
    index = text.indexOf(word, index + 1);
  }
  return false;
}

// Päättelee aiheen tehtäville, joilla sitä ei vielä ole. Käsittelijän valitsemaa aihetta ei muuteta.
export function classifyPendingTopics(ticketId?: string) {
  const rows = db.prepare(`
    SELECT t.id, t.subject, t.summary,
           (SELECT m.body FROM messages m WHERE m.ticket_id = t.id AND m.direction = 'inbound' ORDER BY m.created_at LIMIT 1) AS body
    FROM tickets t
    WHERE t.topic IS NULL ${ticketId ? "AND t.id = ?" : ""}
  `).all(...(ticketId ? [ticketId] : [])) as { id: string; subject: string; summary: string; body: string | null }[];
  const update = db.prepare("UPDATE tickets SET topic = ?, topic_source = 'keywords' WHERE id = ? AND topic IS NULL");
  // Otsikko ratkaisee ensin; viestin teksti vain, jos otsikosta ei löydy aihetta.
  for (const row of rows) {
    const fromSubject = classifyTopic(row.subject);
    update.run(fromSubject !== "other" ? fromSubject : classifyTopic(`${row.summary}\n${(row.body ?? "").slice(0, 2000)}`), row.id);
  }
}

export function incidentDetectionEnabled(): boolean {
  const row = db.prepare("SELECT incident_detection FROM office_settings WHERE id = 1").get() as { incident_detection: number } | undefined;
  return Boolean(row?.incident_detection);
}

type CandidateTicket = {
  id: string; created_at: string; apartment_id: string | null; resident_id: string | null;
  apartment_number: string | null; staircase: string | null; sender: string | null;
};

export type Incident = {
  id: string; company_id: string; topic: string; stairwell: string; status: string;
  first_report_at: string; last_report_at: string; created_at: string; updated_at: string;
  ai_summary: string | null; ai_summary_at: string | null; auto_reply: number; reply_message: string;
  announced_at: string | null; ordered_at: string | null; handled_by: string | null; handled_at: string | null;
  resolution: string | null;
};

const ACTIVE = "('open', 'ordered')";

// Tunnistukseen kelpaavat tehtävät: tavalliset tehtävät, joiden taloyhtiö on tunnistettu ja joita AI ei
// suodattanut pois.
const ELIGIBLE = "t.kind = 'ticket' AND COALESCE(t.company_pending, 0) = 0 AND t.ai_action != 'filtered'";

// Sama asunto (tai ilman asuntoa sama asukas tai lähettäjä) lasketaan yhdeksi ilmoittajaksi, jotta yksi
// asukas ei kolmella viestillään tee poikkeamaa.
const reporterKey = (row: CandidateTicket) =>
  row.apartment_id ?? row.resident_id ?? (row.sender ? row.sender.toLowerCase().replace(/^.*</, "").replace(/>.*$/, "").trim() : row.id);

function candidates(companyId: string, topic: string, since: string, until?: string, linked = false) {
  return db.prepare(`
    SELECT t.id, t.created_at, t.apartment_id, t.resident_id, a.apartment_number, a.staircase,
           (SELECT m.sender FROM messages m WHERE m.ticket_id = t.id AND m.direction = 'inbound' ORDER BY m.created_at LIMIT 1) AS sender
    FROM tickets t
    LEFT JOIN apartments a ON a.id = t.apartment_id
    WHERE t.company_id = ? AND t.topic = ? AND ${ELIGIBLE} AND t.created_at >= ? ${until ? "AND t.created_at < ?" : ""}
      ${linked ? "" : "AND NOT EXISTS (SELECT 1 FROM incident_tickets it WHERE it.ticket_id = t.id)"}
    ORDER BY t.created_at
  `).all(companyId, topic, since, ...(until ? [until] : [])) as CandidateTicket[];
}

const distinctReporters = (rows: CandidateTicket[]) => new Set(rows.map(reporterKey)).size;
const stairOf = (row: CandidateTicket) => stairwellOf(row.apartment_number, row.staircase);

function audit(ticketId: string | null, action: string, details: Record<string, unknown>) {
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), ticketId, "system", action, JSON.stringify(details), now());
}

function link(incidentId: string, ticketIds: string[]) {
  const insert = db.prepare("INSERT OR IGNORE INTO incident_tickets (ticket_id, incident_id, linked_at) VALUES (?, ?, ?)");
  for (const ticketId of ticketIds) {
    if (insert.run(ticketId, incidentId, now()).changes) audit(ticketId, "incident_linked", { incident: incidentId });
  }
}

// Liittää uudet samanaiheiset ilmoitukset avoimeen poikkeamaan. Jos ilmoitus tulee toisesta portaasta,
// poikkeama laajenee koskemaan koko taloyhtiötä. Palauttaa liitetyt tehtävät.
function attachToOpen(incident: Incident): string[] {
  const quietSince = new Date(Date.now() - ATTACH_QUIET_DAYS * 86_400_000).toISOString();
  if (incident.last_report_at < quietSince) return [];
  const rows = candidates(incident.company_id, incident.topic, incident.first_report_at);
  if (!rows.length) return [];
  const otherStair = incident.stairwell && rows.some(row => stairOf(row) && stairOf(row) !== incident.stairwell);
  const last = rows[rows.length - 1].created_at;
  db.prepare(`UPDATE incidents SET last_report_at = MAX(last_report_at, ?), stairwell = ?, updated_at = ? WHERE id = ?`)
    .run(last, otherStair ? "" : incident.stairwell, now(), incident.id);
  link(incident.id, rows.map(row => row.id));
  return rows.map(row => row.id);
}

// Etsii taloyhtiön uudet poikkeamat ja liittää ilmoitukset avoimiin. Palauttaa uudet poikkeamat ja
// avoimiin poikkeamiin liitetyt tehtävät.
export function detectIncidents(companyId?: string): { created: string[]; attached: { incidentId: string; ticketIds: string[] }[] } {
  const created: string[] = [];
  const attached: { incidentId: string; ticketIds: string[] }[] = [];
  if (!incidentDetectionEnabled()) return { created, attached };
  const companyIds = companyId ? [companyId] : [...AUTHORIZED_COMPANY_IDS];
  const rules = detectionRules();
  for (const company of companyIds) {
    for (const topicRule of rules) {
      const topic = topicRule.topic;
      if (!topicRule.tracked) continue;

      const open = db.prepare(`SELECT * FROM incidents WHERE company_id = ? AND topic = ? AND status IN ${ACTIVE} ORDER BY created_at DESC LIMIT 1`)
        .get(company, topic) as Incident | undefined;
      if (open) {
        const ticketIds = attachToOpen(open);
        if (ticketIds.length) attached.push({ incidentId: open.id, ticketIds });
        continue;
      }

      const since = new Date(Date.now() - topicRule.windowHours * 3_600_000).toISOString();
      const rows = candidates(company, topic, since);
      if (distinctReporters(rows) < topicRule.threshold) continue;

      // Tavallinen taso edellisiltä 90 päivältä ikkunan pituutta kohden (kaikki ilmoitukset, myös poikkeamiin liitetyt).
      const baselineSince = new Date(Date.parse(since) - BASELINE_DAYS * 86_400_000).toISOString();
      const baselineRows = candidates(company, topic, baselineSince, since, true);
      const perWindow = distinctReporters(baselineRows) / ((BASELINE_DAYS * 24) / topicRule.windowHours);

      // Jos ilmoitukset keskittyvät yhteen portaaseen, poikkeama koskee sitä; muuten koko taloyhtiötä.
      const byStair = new Map<string, CandidateTicket[]>();
      for (const row of rows) byStair.set(stairOf(row), [...(byStair.get(stairOf(row)) ?? []), row]);
      const [topStair, topRows] = [...byStair.entries()].filter(([stair]) => stair)
        .sort((a, b) => distinctReporters(b[1]) - distinctReporters(a[1]))[0] ?? ["", []];
      const stairwell = topStair && distinctReporters(topRows) === distinctReporters(rows) ? topStair : "";
      const count = distinctReporters(rows);
      if (count < BASELINE_FACTOR * perWindow) continue;

      const incidentId = id("incident");
      const timestamp = now();
      db.prepare(`
        INSERT INTO incidents (id, company_id, topic, stairwell, status, first_report_at, last_report_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)
      `).run(incidentId, company, topic, stairwell, rows[0].created_at, rows[rows.length - 1].created_at, timestamp, timestamp);
      link(incidentId, rows.map(row => row.id));
      audit(null, "incident_detected", { incident: incidentId, company, topic, stairwell, reporters: count, baseline: Number(perWindow.toFixed(2)) });
      created.push(incidentId);
    }
  }
  return { created, attached };
}

export type IncidentTicket = {
  id: string; ticket_number: number | null; subject: string; status: string; created_at: string; sensitive: number;
  apartment_number: string | null; staircase: string | null; resident_name: string | null; source_channel: string;
};

export function incidentTickets(incidentId: string): IncidentTicket[] {
  return db.prepare(`
    SELECT t.id, t.ticket_number, t.subject, t.status, t.created_at, t.sensitive, t.source_channel,
           a.apartment_number, a.staircase, r.name AS resident_name
    FROM incident_tickets it
    JOIN tickets t ON t.id = it.ticket_id
    LEFT JOIN apartments a ON a.id = t.apartment_id
    LEFT JOIN residents r ON r.id = t.resident_id
    WHERE it.incident_id = ?
    ORDER BY t.created_at
  `).all(incidentId) as IncidentTicket[];
}

// Paikka sanoina: "B-porras" tai "koko taloyhtiö".
export const placeText = (stairwell: string) => (stairwell ? `${stairwell}-porras` : "koko taloyhtiö");

const finnishTime = (iso: string) =>
  new Date(iso).toLocaleString("fi-FI", { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

// Aikaväli ilman toistoa: "24.10. klo 8.10–9.40" tai eri päivinä "23.10. klo 22.05–24.10. klo 7.30".
function timeRange(from: string, to: string) {
  const start = finnishTime(from);
  const end = finnishTime(to);
  if (start === end) return start;
  const [startDay] = start.split(" klo ");
  const [endDay, endTime] = end.split(" klo ");
  return startDay === endDay && endTime ? `${start}–${endTime}` : `${start}–${end}`;
}

const byNumber = (a: string, b: string) => a.localeCompare(b, "fi", { numeric: true });

// Poikkeaman kuvaus ilman AI:ta: määrät, asunnot ja portaat sekä aiheen selitys.
export function localSummary(incident: Incident, tickets = incidentTickets(incident.id)) {
  const topicRule = rule(incident.topic);
  const apartments = ([...new Set(tickets.map(ticket => ticket.apartment_number).filter(Boolean))] as string[]).sort(byNumber);
  const reporters = new Set(tickets.map(ticket => ticket.apartment_number ?? ticket.resident_name ?? ticket.id)).size;
  const stairs = [...new Set(tickets.map(ticket => stairwellOf(ticket.apartment_number, ticket.staircase)).filter(Boolean))].sort();
  const where = incident.stairwell
    ? `${incident.stairwell}-portaasta`
    : stairs.length > 1 ? `portaista ${stairs.join(", ")}` : "taloyhtiöstä";
  const facts = `${reporters} ${reporters === 1 ? "asunto" : "asuntoa"} ${where}${apartments.length ? ` (${apartments.join(", ")})` : ""} ` +
    `on ilmoittanut ${topicRule.about} ${timeRange(incident.first_report_at, incident.last_report_at)}.`;
  return [facts, topicRule.hint].filter(Boolean).join(" ");
}

// Työtilauksen ja tiedotteen pohjat, joita isännöitsijä voi muokata ennen lähetystä.
export function drafts(incident: Incident, tickets = incidentTickets(incident.id)) {
  const topicRule = rule(incident.topic);
  const apartments = ([...new Set(tickets.map(ticket => ticket.apartment_number).filter(Boolean))] as string[]).sort(byNumber).join(", ");
  const place = incident.stairwell ? `${incident.stairwell}-portaan` : "taloyhtiön";
  const from = incident.stairwell ? `${incident.stairwell}-portaasta` : "taloyhtiöstä";
  return {
    workOrder: [
      `Useampi asunto on ilmoittanut ${topicRule.about} lyhyen ajan sisällä${apartments ? `: ${apartments}` : ""}.`,
      `${topicRule.request || "Pyydämme tarkistamaan asian"} (${place} osalta) ja ilmoittamaan, mistä vika johtuu.`
    ].join("\n"),
    announcementTitle: `${topicRule.label}: vika selvityksessä`,
    announcementBody: [
      `Hyvä asukas,`,
      "",
      `olemme saaneet ${from} useita ilmoituksia ${topicRule.about}.`,
      "Vika on tiedossa ja sen selvittäminen on aloitettu. Tiedotamme, kun asia on korjattu.",
      "Sinun ei tarvitse tehdä erillistä ilmoitusta samasta asiasta."
    ].join("\n"),
    reply: `Kiitos ilmoituksestasi. Olemme saaneet ${from} useita ilmoituksia ${topicRule.about}, ja vian selvittäminen on aloitettu. Ilmoitamme, kun asia on korjattu.`
  };
}

// Ilmoitus isännöitsijälle uudesta poikkeamasta. Arkaluonteisten tehtävien otsikoita ei lähetetä.
export async function alertIncident(incidentId: string) {
  const incident = db.prepare("SELECT * FROM incidents WHERE id = ?").get(incidentId) as Incident | undefined;
  if (!incident) return;
  const company = db.prepare(`
    SELECT c.name, u.name AS manager_name, u.email AS manager_email
    FROM companies c LEFT JOIN users u ON u.id = c.manager_id WHERE c.id = ?
  `).get(incident.company_id) as { name: string; manager_name: string | null; manager_email: string | null } | undefined;
  const email = (company?.manager_email ?? "").trim();
  if (!company || !VALID_EMAIL.test(email)) {
    audit(null, "incident_alert_failed", { incident: incidentId, error: "Taloyhtiöllä ei ole vastuuisännöitsijää, jolla on sähköpostiosoite." });
    return;
  }
  const tickets = incidentTickets(incidentId);
  const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string };
  const label = rule(incident.topic).label;
  try {
    await sendEmail({
      to: email,
      notification: true,
      subject: `Mahdollinen yhteinen vika: ${label}, ${company.name}${incident.stairwell ? `, ${incident.stairwell}-porras` : ""}`,
      body: [
        `Hei ${company.manager_name ?? ""},`,
        "",
        localSummary(incident, tickets),
        "",
        "Ilmoitukset:",
        ...tickets.map(ticket => `#${formatTicketNumber(ticket.ticket_number)} ${ticket.sensitive ? "Arkaluonteinen tehtävä" : ticket.subject}` +
          `${ticket.apartment_number ? ` (asunto ${ticket.apartment_number})` : ""}`),
        "",
        `Avaa Pleissin päätösjono: ${process.env.APP_URL || "http://localhost:5173"}`,
        "",
        office.name
      ].join("\n")
    });
    audit(null, "incident_alert_sent", { incident: incidentId, to: company.manager_name ?? email });
  } catch (error: any) {
    console.error("Poikkeaman ilmoitus epäonnistui:", error?.message ?? error);
    audit(null, "incident_alert_failed", { incident: incidentId, error: String(error?.message ?? error) });
  }
}

// Vastaa asukkaalle poikkeaman viestillä. Tehtävä jää odottamaan
// vian korjausta (kolmannella osapuolella), jolloin se poistuu päätösjonosta.
export async function replyFromIncident(ticketId: string, message: string, actor: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ticket = db.prepare("SELECT id, company_id, subject, source_channel, status FROM tickets WHERE id = ?").get(ticketId) as
    { id: string; company_id: string; subject: string; source_channel: string; status: string } | undefined;
  if (!ticket) return { ok: false, error: "Tehtävää ei löytynyt." };
  // Portaalin ilmoitukseen vastataan portaalissa; muihin sähköpostilla (asukkaan viestiin tai käsin kirjatun
  // tehtävän ilmoittajan osoitteeseen).
  const email = db.prepare("SELECT 1 FROM messages WHERE ticket_id = ? AND direction = 'inbound' AND channel = 'email' LIMIT 1").get(ticketId);
  if (ticket.source_channel === "portal" && !email) {
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id("message"), ticketId, "outbound", actor, ticket.subject, message, now(), "portal");
    return { ok: true };
  }
  const sent = await sendTicketReply({ ticket, body: message, actor });
  return sent.ok ? { ok: true } : { ok: false, error: sent.error };
}

// Uusiin poikkeamaan liitettyihin ilmoituksiin vastataan heti, jos isännöitsijä on kytkenyt sen päälle.
async function autoReply(incidentId: string, ticketIds: string[]) {
  const incident = db.prepare("SELECT * FROM incidents WHERE id = ?").get(incidentId) as Incident | undefined;
  if (!incident?.auto_reply || !incident.reply_message.trim()) return;
  const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string };
  for (const ticketId of ticketIds) {
    const ticket = db.prepare("SELECT status, sensitive FROM tickets WHERE id = ?").get(ticketId) as { status: string; sensitive: number } | undefined;
    if (!ticket || ticket.status === "closed") continue;
    const result = await replyFromIncident(ticketId, `${incident.reply_message.trim()}\n\nYstävällisin terveisin\n${office.name}`, office.name);
    if (!result.ok) {
      audit(ticketId, "incident_reply_failed", { incident: incidentId, error: result.error });
      continue;
    }
    db.prepare("UPDATE tickets SET status = 'waiting_third_party', updated_at = ? WHERE id = ?").run(now(), ticketId);
    audit(ticketId, "incident_replied", { incident: incidentId });
  }
}

// Ajetaan uuden tehtävän jälkeen ja säännöllisesti: aihe, poikkeamat, ilmoitukset ja automaattiset vastaukset.
let running: Promise<void> | null = null;
// ticketId: uusi tehtävä; silloin käsitellään vain sen taloyhtiö.
export function processIncidents(ticketId?: string): Promise<void> {
  const run = async () => {
    classifyPendingTopics(ticketId);
    const company = ticketId
      ? (db.prepare("SELECT company_id FROM tickets WHERE id = ?").get(ticketId) as { company_id: string } | undefined)?.company_id
      : undefined;
    if (ticketId && !company) return;
    const { created, attached } = detectIncidents(company);
    for (const incidentId of created) await alertIncident(incidentId);
    for (const { incidentId, ticketIds } of attached) await autoReply(incidentId, ticketIds);
  };
  // Ajot jonotetaan, jotta sama ilmoitus ei päädy kahteen poikkeamaan.
  const next = (running ?? Promise.resolve()).then(run).catch(error => {
    console.error("Yhteisten vikojen tunnistus epäonnistui:", error?.message ?? error);
  });
  running = next;
  return next;
}

export function startIncidentJob() {
  void processIncidents();
  setInterval(() => void processIncidents(), 5 * 60 * 1000);
}
