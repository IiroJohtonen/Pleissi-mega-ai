import { db } from "./db.js";
import { getMasterData } from "./master-data.js";
import { id, now } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Muiden kuin asukkaiden yhteydenotot:
// - lähettäjätyyppi (asukas, osakas, hallitus, huolto/urakoitsija, välittäjä, viranomainen, muu): AI luokittelee
//   saman kutsun aikana kuin prioriteetin, toimiston tuntemat domainit ohittavat AI:n, käsittelijä voi korjata
// - viranomainen: vähintään kiireellinen, määräaika viestistä, aina henkilökunnalle
// - välittäjän, asuntoa koskevan ja osakkaalle kuuluvan pyynnön vastausluonnos haetaan dokumentaatiosta
// ---------------------------------------------------------------------------------------------

export const SENDER_TYPES = ["resident", "owner", "board", "contractor", "broker", "authority", "other"] as const;
export type SenderType = (typeof SENDER_TYPES)[number];
// general = yleinen kysymys, apartment_specific = koskee yksittäistä asuntoa, owner_matter = kuuluu osakkaalle.
export const SENDER_REQUESTS = ["general", "apartment_specific", "owner_matter", "none"] as const;
export type SenderRequest = (typeof SENDER_REQUESTS)[number];

export const isSenderType = (value: unknown): value is SenderType => SENDER_TYPES.includes(value as SenderType);
export const isSenderRequest = (value: unknown): value is SenderRequest => SENDER_REQUESTS.includes(value as SenderRequest);

// Lähettäjät, joiden tehtäviä AI-agentti voi hoitaa: vain tunnistetut taloyhtiön asukkaat ja osakkaat.
export const AGENT_SENDER_TYPES: SenderType[] = ["resident", "owner", "board"];

export type KnownDomain = { domain: string; type: SenderType };

export const normalizeDomain = (value: string) => value.trim().toLowerCase().replace(/^.*@/, "").replace(/^www\./, "").replace(/\.$/, "");

// Toimiston tuntemat lähettäjädomainit (asetuksissa). Domain ohittaa AI:n luokittelun.
export function knownSenderDomains(): KnownDomain[] {
  const row = db.prepare("SELECT known_sender_domains FROM office_settings WHERE id = 1").get() as { known_sender_domains: string } | undefined;
  try {
    const list = JSON.parse(row?.known_sender_domains ?? "[]") as unknown;
    return Array.isArray(list)
      ? list.filter((item): item is KnownDomain => typeof item?.domain === "string" && isSenderType(item?.type))
      : [];
  } catch {
    return [];
  }
}

export function saveKnownSenderDomains(list: KnownDomain[]) {
  const unique = new Map<string, KnownDomain>();
  for (const item of list) {
    const domain = normalizeDomain(item.domain);
    if (domain) unique.set(domain, { domain, type: item.type });
  }
  const saved = [...unique.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  db.prepare("UPDATE office_settings SET known_sender_domains = ? WHERE id = 1").run(JSON.stringify(saved));
  return saved;
}

// Lähettäjän osoitteen domain listalta; myös aliverkkotunnus (posti.hel.fi → hel.fi) kelpaa.
export function domainSenderType(senderEmail: string | undefined | null): SenderType | null {
  const email = (senderEmail ?? "").toLowerCase().replace(/^.*</, "").replace(/>.*$/, "").trim();
  if (!email.includes("@")) return null;
  const domain = normalizeDomain(email);
  const match = knownSenderDomains().find(item => domain === item.domain || domain.endsWith(`.${item.domain}`));
  return match?.type ?? null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function helsinkiDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" });
}

export type SenderClassification = { senderType?: string | null; request?: string | null; deadline?: string | null };

// Tallentaa lähettäjätyypin ja ohjaa tehtävän sen mukaan. Järjestys: toimiston domainlista, AI, asukasrekisteri.
// Viranomaisen tehtävä on vähintään kiireellinen ja sen määräaika tulee viestistä.
export function applySenderType(ticketId: string, result: SenderClassification, senderEmail: string | undefined, actor = "ai") {
  const ticket = db.prepare("SELECT resident_id, priority, due_date FROM tickets WHERE id = ?").get(ticketId) as
    { resident_id: string | null; priority: string; due_date: string | null } | undefined;
  if (!ticket) return;
  const byDomain = domainSenderType(senderEmail);
  const byAi = isSenderType(result.senderType) ? result.senderType : null;
  const type = byDomain ?? byAi ?? (ticket.resident_id ? "resident" : null);
  if (!type) return;
  const source = byDomain ? "domain" : byAi ? "ai" : "register";
  const request = isSenderRequest(result.request) && result.request !== "none" ? result.request : null;
  db.prepare("UPDATE tickets SET sender_type = ?, sender_type_source = ?, sender_request = ? WHERE id = ?").run(type, source, request, ticketId);
  if (type === "authority") routeAuthority(ticketId, ticket, result.deadline ?? null);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), ticketId, actor, "sender_type_classified", JSON.stringify({ sender_type: type, source, request }), now()
  );
}

function routeAuthority(ticketId: string, ticket: { priority: string; due_date: string | null }, deadline: string | null) {
  const priority = ticket.priority === "emergency" ? "emergency" : "urgent";
  const urgentDue = helsinkiDay(getMasterData().priorityDays.urgent);
  // Viestissä mainittu määräaika on tehtävän määräaika, kun se on oikea päivä eikä ole mennyt. Muuten kiireellisen
  // tehtävän määräaika (tai aiempi, jos tehtävä oli jo kiireellinen tai hätä).
  const fromMessage = deadline && ISO_DAY.test(deadline) && !Number.isNaN(Date.parse(deadline)) && deadline >= helsinkiDay() ? deadline : null;
  const due = fromMessage ?? (ticket.priority === priority && ticket.due_date ? ticket.due_date : urgentDue);
  db.prepare("UPDATE tickets SET priority = ?, due_date = ? WHERE id = ?").run(priority, due, ticketId);
}

// Käsittelijä korjaa lähettäjätyypin. Viranomaiseksi korjattu tehtävä nostetaan kiireelliseksi.
export function setSenderType(ticketId: string, type: SenderType, actor: string) {
  const ticket = db.prepare("SELECT priority, due_date, sender_type FROM tickets WHERE id = ?").get(ticketId) as
    { priority: string; due_date: string | null; sender_type: string | null } | undefined;
  if (!ticket) return;
  db.prepare("UPDATE tickets SET sender_type = ?, sender_type_source = 'manual', updated_at = ? WHERE id = ?").run(type, now(), ticketId);
  if (type === "authority" && ticket.sender_type !== "authority") routeAuthority(ticketId, ticket, null);
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), ticketId, actor, "sender_type_changed", JSON.stringify({ from: ticket.sender_type, to: type }), now()
  );
}

// Vastausluonnoksen ohje lähettäjän mukaan. query täydentää dokumentaatiohakua (ohjeteksti tulee dokumentaatiosta,
// ei koodista) ja note kertoo AI:lle tilanteen. null = tavallinen asukkaan tehtävä.
export function senderGuidance(type: string | null, request: string | null, residentIdentified: boolean): { query: string; note: string } | null {
  const notResident = !residentIdentified || (type !== null && !AGENT_SENDER_TYPES.includes(type as SenderType));
  if (type === "broker" && request !== "apartment_specific") {
    return {
      query: "isännöitsijäntodistus kiinteistönvälittäjä tilaus toimitusaika hinta",
      note: "Lähettäjä on kiinteistönvälittäjä ja kysyy yleistä asiaa. Vastaa vain dokumentaation ohjeen mukaan (esim. isännöitsijäntodistuksen tilaaminen). Älä kerro mitään yksittäisestä asunnosta tai asukkaasta."
    };
  }
  if (request === "apartment_specific" && notResident) {
    return {
      query: "osakkaan valtuutus valtakirja asunnon tietojen luovutus",
      note: "Pyyntö koskee yksittäistä asuntoa, eikä lähettäjää ole tunnistettu asunnon osakkaaksi. Kerro dokumentaation ohjeen mukaan, että tietojen luovuttamiseen tarvitaan osakkaan valtuutus. Älä kerro asunnosta tai sen asukkaista mitään."
    };
  }
  if (request === "owner_matter" && type === "resident") {
    return {
      query: "osakkaan kunnossapitovastuu vuokralainen vuokranantaja",
      note: "Lähettäjä on asukas (vuokralainen), ja asia kuuluu asunnon omistajalle. Kerro dokumentaation ohjeen mukaan, että asia kuuluu osakkaalle ja vuokralaisen kannattaa olla yhteydessä vuokranantajaansa."
    };
  }
  return null;
}

// Rivi AI:lle siitä, kuka lähettäjä on. Tunnistamattomalle lähettäjälle ei kerrota mitään asukkaista tai asunnoista.
export function senderLineForAi(type: string | null, residentIdentified: boolean) {
  if (residentIdentified && (type === null || AGENT_SENDER_TYPES.includes(type as SenderType))) {
    return "Identified resident or shareholder of the housing company.";
  }
  return `NOT identified as a resident of the housing company (sender type: ${type ?? "unknown"}). Never reveal anything about any resident or apartment.`;
}
