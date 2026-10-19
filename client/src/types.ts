import type { RenovationNotice } from "./views/Renovations";



export type Ticket = {
  // Taloyhtiön nimi; palvelin liittää sen tehtävälistaan.
  company_name?: string;
  // 1 = taloyhtiötä ei tunnistettu: tehtävä on Taloyhtiö tunnistamatta -jonossa.
  company_pending?: number;
  id: string;
  ticket_number?: number;
  company_id: string;
  // Käsittelijä: toimiston käyttäjän tunniste.
  assignee_id?: string | null;
  // Käsittelijän nimi tehtävälistoissa.
  assignee_name?: string | null;
  apartment_number?: string;
  resident_name?: string;
  type: string;
  // renovation = remonttitehtävä, joka ei mene päätösjonoon; muut tehtävät ovat "ticket".
  kind?: "ticket" | "renovation";
  priority: string;
  status: string;
  subject: string;
  summary: string;
  source_channel: string;
  ai_action: string;
  ai_reason: string;
  // Määräaika muodossa VVVV-KK-PP; puuttuu, jos sitä ei ole asetettu.
  due_date?: string | null;
  // 1, kun asukas on vastannut eikä hänelle ole vielä vastattu.
  has_new_reply?: number;
  // Milloin asukas alkoi odottaa vastausta; tyhjä, kun toimisto on vastannut viimeisimpään viestiin.
  waiting_since?: string | null;
  // 1, kun tehtävälle on pyydetty AI-ehdotus.
  ai_suggested?: number;
  knowledge_source_id?: string | null;
  knowledge_source_title?: string | null;
  knowledge_source_chunk_id?: string | null;
  // 1 = arkaluonteinen tehtävä, jota ei lähetetä AI:lle.
  sensitive?: number;
  sensitive_source?: string | null;
  // Arkaluonteinen tehtävä, jonka sisältö on rajattu tältä käyttäjältä.
  restricted?: boolean;
  knowledge_source_page?: string | number | null;
  draft?: string;
  created_at: string;
  updated_at?: string;
};

export type Company = {
  id: string;
  name: string;
  email_address: string;
  business_id?: string;
  address?: string;
  phone?: string;
  maintenance_name?: string;
  maintenance_phone?: string;
  maintenance_email?: string;
  maintenance_emergency_phone?: string;
  // Vastuuisännöitsijä: toimiston käyttäjän tunniste ja nimi.
  manager_id?: string | null;
  manager_name?: string | null;
  // Taloyhtiön muut isännöitsijät (ilman vastuuisännöitsijää).
  manager_ids?: string[];
  resident_count?: number;
};

export type KnowledgeEntry = {
  id: string;
  title: string;
  // Pilkuilla erotetut avainsanat.
  tags?: string;
  content: string;
  content_length: number;
  kind: "fact" | "document";
  // ai = AI käyttää vastausehdotuksissa, internal = vain henkilökunnalle.
  audience: "ai" | "internal";
  valid_from: string | null;
  valid_until: string | null;
  file_name: string | null;
  version: number;
  state: string;
  status?: string;
  created_at: string;
  // Dokumentin uusi versio, joka odottaa hyväksyntää.
  pending_version_id?: string | null;
  // Dokumentin pilkonta taustalla: processing | ready | failed.
  processing_state?: string;
  // Dokumenttinumero (näytetään muodossa #K000123); sama kaikilla versioilla.
  doc_number?: number | null;
};

// Tietopala: dokumentista tai vakiotiedosta poimittu yksi tieto.
export type KnowledgeChunk = {
  id: string;
  knowledge_id: string;
  title: string;
  content: string;
  page: number | null;
  tags: string;
  // ai = AI poimi, local = kappalejako, manual = isännöitsijän kirjoittama.
  origin: "ai" | "local" | "manual";
  verified: number;
  needs_review: number;
  suggested_valid_until: string | null;
};

export type KnowledgeDetail = KnowledgeEntry & {
  status: string;
  company_id: string;
  company_name: string;
  versions: KnowledgeEntry[];
  // Dokumentin muotoiltu teksti (otsikot, lihavoinnit, luettelot).
  formatted?: string | null;
};

export type MailProvider = "gmail" | "microsoft" | "imap";

export type MailStatus = {
  connected: boolean;
  provider?: MailProvider;
  emailAddress?: string;
  canSend?: boolean;
  // Viimeisimmän postin tarkistuksen virhe, jos yhteys ei toimi.
  error?: string;
  // Taloyhtiön oma tili; muuten taloyhtiön posti kulkee toimiston tilin kautta.
  own?: boolean;
};

export type WorkOrder = {
  id: string;
  ticket_id: string;
  contractor_name: string;
  contractor_email: string;
  description: string;
  status: "ordered" | "done";
  email_sent: number;
  ordered_by: string;
  ordered_at: string;
  done_by: string | null;
  done_at: string | null;
  ticket_subject?: string;
  ticket_number?: number;
};

export type ReplyAccount = { id: string; email: string; kind: "own" | "office" | "company"; arrived: boolean };

export type TicketDetail = {
  ticket: Ticket & { company_name?: string };
  messages: { id: string; direction: string; sender: string; subject: string; body: string; created_at: string; channel?: string }[];
  audit: { id: string; actor: string; action: string; details: string; created_at: string }[];
  reporters: { id: string; name: string; email?: string; apartment_number?: string }[];
  apartments: { id: string; apartment_number: string; address: string }[];
  notes: { id: string; author: string; body: string; created_at: string }[];
  workOrders: WorkOrder[];
  // Taloyhtiön huoltoyhtiö, jolle työtilaus lähetetään.
  contractor: { name: string; email: string; phone: string } | null;
  // message_id: viesti, jonka mukana liite tuli; liite näytetään aikajanalla sen alla.
  attachments: { id: string; filename: string; mime_type: string; size: number; created_at: string; direction?: string; message_id?: string | null }[];
  // Postitilit, joilta vastauksen voi lähettää; ensimmäinen on oletus (tili, johon viesti saapui).
  replyAccounts: ReplyAccount[];
  // Käyttäjän allekirjoitus, joka lisätään vastauksen loppuun; tyhjä, jos sitä ei ole.
  signature: string;
  // Remonttitehtävän muutostyöilmoitus; muilla tehtävillä null.
  renovation?: RenovationNotice | null;
  // Asukasportaalin lomakkeen kentät otsikoineen (huoltotyötilaus, häiriöilmoitus jne.); muilla null.
  form?: { form: string; title: string; fields: { label: string; value: string }[]; source?: "email" | "portal"; createdAt: string } | null;
  // Asukas on pyytänyt tietojensa poistoa, mutta tehtävä säilytetään perusteella; anonymisoidaan suljettaessa.
  erasurePending?: { reason: string; requested_by: string; created_at: string } | null;
};

export type TicketTab = "queue" | "unassigned" | "unidentified" | "tickets" | "my-tickets" | "ai-handled" | "knowledge" | "knowledge-ai" | "knowledge-internal" | "reports" | "companies" | "residents" | "apartments" | "sauna" | "laundry" | "parking" | "announcements" | "moves" | "renovations" | "keys" | "meters" | "waitlist" | "settings" | "log" | "search";

export type Resident = {
  id: string;
  name: string;
  email?: string;
  // Asunto, johon asukas kuuluu.
  apartment_id?: string;
  // Roolit asunnossa pilkuilla eroteltuina: osakas, asukas tai molemmat.
  roles?: string;
  apartment_number: string;
  address: string;
  // Asunnon rappu (esim. A).
  staircase?: string;
  // Autopaikat, joiden haltija asukas on.
  parking?: { id: string; label: string; type: string }[];
  // 1, kun asukkaalle on asetettu salasana ja hän voi kirjautua asukasportaaliin.
  has_password?: number;
  // Täytetään selaimessa, kun asukkaat haetaan kaikista taloyhtiöistä.
  company_id?: string;
  company_name?: string;
};
