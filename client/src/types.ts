

export type Ticket = {
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
  // 1, kun tehtävälle on pyydetty AI-ehdotus.
  ai_suggested?: number;
  knowledge_source_id?: string | null;
  knowledge_source_title?: string | null;
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
  created_at: string;
};

export type KnowledgeDetail = KnowledgeEntry & {
  status: string;
  company_name: string;
  versions: KnowledgeEntry[];
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
  attachments: { id: string; filename: string; mime_type: string; size: number; created_at: string; direction?: string }[];
  // Sähköpostiosoite, josta vastaus lähtee; tyhjä, jos postitiliä ei ole yhdistetty.
  replyFrom?: string;
};

export type TicketTab = "queue" | "unassigned" | "tickets" | "my-tickets" | "ai-handled" | "knowledge" | "knowledge-ai" | "knowledge-internal" | "reports" | "companies" | "residents" | "sauna" | "laundry" | "parking" | "announcements" | "moves" | "renovations" | "keys" | "meters" | "waitlist" | "settings" | "log";

export type Resident = {
  id: string;
  name: string;
  email?: string;
  apartment_number: string;
  address: string;
  // 1, kun asukkaalle on asetettu salasana ja hän voi kirjautua asukasportaaliin.
  has_password?: number;
  // Täytetään selaimessa, kun asukkaat haetaan kaikista taloyhtiöistä.
  company_id?: string;
  company_name?: string;
};
