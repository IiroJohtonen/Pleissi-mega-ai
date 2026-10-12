import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export type TriageResult = {
  type: string;
  priority: "emergency" | "urgent" | "normal" | "low";
  summary: string;
  suggestedAction: string;
  reason: string;
  draft: string;
  emergency: boolean;
  // Tietopankin tietue, johon luonnos nojaa.
  sourceId?: string | null;
};

export type KnowledgeItem = {
  id: string;
  title: string;
  content: string;
  kind: string;
  // Pilkuilla erotetut avainsanat; auttavat tietueen löytymistä samantapaisille kysymyksille.
  tags?: string;
};

export type KnowledgeAnswer = {
  answer: string;
  sourceId: string;
  sourceTitle: string;
};

const STOPWORDS = new Set([
  "että", "joka", "jotka", "mikä", "mitä", "miten", "missä", "milloin", "miksi", "kuka",
  "onko", "voiko", "voinko", "saako", "saanko", "pitääkö", "olla", "ovat", "olen", "olisi",
  "olisiko", "tämä", "tuo", "nämä", "siitä", "siihen", "sitä", "sen", "niin", "kuin", "myös",
  "vain", "vielä", "kun", "jos", "tai", "sekä", "mutta", "koska", "hei", "moi", "terve",
  "kiitos", "terveisin", "ystävällisin", "haluaisin", "tietää", "kysyä", "kysyisin", "asia",
  "asiaa", "koskien", "liittyen", "meidän", "minun", "teidän", "minä", "sinä", "voisitteko",
  "voisitko", "kertoa", "saada", "saan", "voin", "pitää", "täytyy", "ole", "ei", "kyllä"
]);

// Karkea vartalo, jotta taivutusmuodot osuvat samaan sanaan (saunavuoron ~ saunavuorot).
function stem(word: string): string {
  return word.length <= 5 ? word : word.slice(0, Math.min(word.length - 2, 8));
}

function stems(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-zåäö0-9]+/g) || [];
  return new Set(
    words
      .filter(word => word.length >= 4 && !STOPWORDS.has(word))
      .map(stem)
  );
}

function overlap(query: Set<string>, text: string): string[] {
  const target = stems(text);
  return [...query].filter(word => target.has(word));
}

function chunks(content: string): string[] {
  const paragraphs = content
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .map(paragraph => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const result: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= 600) {
      result.push(paragraph);
      continue;
    }
    let current = "";
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      if (current && (current + " " + sentence).length > 600) {
        result.push(current);
        current = "";
      }
      current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) result.push(current.slice(0, 900));
  }
  return result;
}

// Paikallinen haku: paras osuma tietopankista tai null, jos varmaa osumaa ei ole.
export function findKnowledgeAnswer(
  question: string,
  items: KnowledgeItem[]
): KnowledgeAnswer | null {
  const query = stems(question);
  if (query.size === 0) return null;

  let best: { score: number; answer: string; item: KnowledgeItem } | null = null;

  for (const item of items) {
    // Avainsana osuu myös taivutettuun muotoon (fillari ~ fillarin), ja osuma riittää yksinään,
    // koska avainsanat on annettu tietueelle juuri löytymistä varten.
    const tagStems = [...stems(item.tags ?? "")];
    const tagHits = [...query].filter(word =>
      tagStems.some(tag => word.startsWith(tag) || tag.startsWith(word)));
    const titleHits = [...new Set([...overlap(query, item.title), ...tagHits])];
    const candidates = item.kind === "document" ? chunks(item.content) : [item.content];

    for (const candidate of candidates) {
      const contentHits = overlap(query, candidate);
      const distinct = new Set([...titleHits, ...contentHits]);
      const strongTitleHit = tagHits.length > 0 || titleHits.some(word => word.length >= 7);

      if (distinct.size < 2 && !strongTitleHit) continue;
      if (item.kind === "document" && contentHits.length === 0 && tagHits.length === 0) continue;

      const score = titleHits.length * 2 + contentHits.length;
      if (!best || score > best.score) {
        best = { score, answer: candidate, item };
      }
    }
  }

  if (!best) return null;
  return {
    answer: best.answer.trim(),
    sourceId: best.item.id,
    sourceTitle: best.item.title
  };
}

// Claudea kutsutaan vain käsittelijän pyytämässä vastausehdotuksessa (suggestReply).
function claudeClient(): { client: Anthropic; model: string } | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return { client: new Anthropic(), model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5" };
}

function knowledgePrompt(items: KnowledgeItem[]): string {
  return items
    .map(item => `[${item.id}] ${item.title}${item.tags ? `\nKeywords: ${item.tags}` : ""}\n${item.content.slice(0, 6000)}`)
    .join("\n---\n");
}

// Vastaa kysymykseen vain yhtiön tietopankin pohjalta paikallisella haulla. Null = vastausta ei löydy.
export async function answerFromKnowledge(
  question: string,
  items: KnowledgeItem[]
): Promise<KnowledgeAnswer | null> {
  return findKnowledgeAnswer(question, items);
}

export type ReplySuggestion = {
  draft: string;
  reason: string;
  sourceId: string | null;
  // false = Claude ei ollut käytössä tai kutsu epäonnistui, ehdotus tehtiin paikallisella haulla.
  usedAi: boolean;
};

const SuggestionSchema = z.object({
  draft: z.string(),
  reason: z.string(),
  sourceId: z.string().nullable()
});

function localSuggestion(question: string, knowledge: KnowledgeItem[]): ReplySuggestion {
  const answer = findKnowledgeAnswer(question, knowledge);
  if (answer) {
    return {
      draft: `Hei! ${answer.answer}\n\nYstävällisin terveisin\nIsännöinti`,
      reason: `Vastaus löytyy yhtiön dokumentaatiosta (${answer.sourceTitle}).`,
      sourceId: answer.sourceId,
      usedAi: false
    };
  }
  return {
    draft: "Hei! Kiitos viestistäsi. Selvitämme asian ja palaamme siihen mahdollisimman pian.\n\nYstävällisin terveisin\nIsännöinti",
    reason: "Yhtiön dokumentaatiosta ei löytynyt tähän sopivaa tietoa.",
    sourceId: null,
    usedAi: false
  };
}

// Ehdottaa käsittelijälle vastausluonnoksen ja dokumentin, johon se nojaa.
export async function suggestReply(
  subject: string,
  conversation: string,
  knowledge: KnowledgeItem[]
): Promise<ReplySuggestion> {
  const ai = claudeClient();
  if (!ai) return localSuggestion(`${subject}\n${conversation}`, knowledge);

  const system = `
You are Kotilo, an AI secretary for Finnish housing companies. A property manager is handling a
resident's ticket and needs a reply draft they can edit and send to the resident.

draft: a polite, concise reply in Finnish, written as the property manager, ready to send.
Use only the supplied company knowledge for facts about the company, because the manager sends
the reply in the company's name: never invent facts, dates, prices, phone numbers or resident
identity. If the knowledge does not cover the matter, write a short reply that acknowledges the
message and says the matter will be looked into.
reason: one short Finnish sentence telling the manager what the draft is based on.
sourceId: the id in square brackets of the single knowledge entry the draft relies on most, or
null if the draft does not rely on the company knowledge.
`;

  const user = `
Company knowledge:
${knowledgePrompt(knowledge) || "(none)"}

Ticket subject:
${subject}

Conversation so far:
${conversation}
`;

  try {
    const response = await ai.client.beta.messages.parse({
      model: ai.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: betaZodOutputFormat(SuggestionSchema) }
    });
    if (response.stop_reason === "refusal") throw new Error("Claude declined the request");
    const parsed = response.parsed_output;
    if (!parsed?.draft.trim()) throw new Error("Empty draft");
    return {
      draft: parsed.draft.trim(),
      reason: parsed.reason.trim() || "AI laati luonnoksen tehtävän viestien perusteella.",
      sourceId: knowledge.some(item => item.id === parsed.sourceId) ? parsed.sourceId : null,
      usedAi: true
    };
  } catch (error) {
    console.error("AI-ehdotus epäonnistui, käytetään paikallista hakua:", error);
    return localSuggestion(`${subject}\n${conversation}`, knowledge);
  }
}

export type TopicTicket = {
  id: string;
  ticket_number: number | null;
  type: string;
  subject: string;
  summary: string;
  // Toimiston tehtävälle lähettämä vastaus, jos sellainen on.
  reply?: string | null;
};

export type RecurringTopic = {
  title: string;
  summary: string;
  // Luonnos dokumentaatiotietueen sisällöksi; käyttäjä tarkistaa sen ennen tallennusta.
  documentation: string;
  ticketIds: string[];
};

const TopicsSchema = z.object({
  topics: z.array(z.object({
    title: z.string(),
    summary: z.string(),
    documentation: z.string(),
    tickets: z.array(z.number())
  }))
});

export function aiAvailable(): boolean {
  return claudeClient() !== null;
}

// Ryhmittelee tehtävät toistuviksi aiheiksi merkityksen perusteella. Heittää virheen, jos AI ei vastaa.
export async function analyzeRecurringTopics(tickets: TopicTicket[]): Promise<RecurringTopic[]> {
  const ai = claudeClient();
  if (!ai) throw new Error("AI ei ole käytössä");

  const system = `
You analyse support tickets of a Finnish housing company for its property management office.
The office wants to know which matters residents raise repeatedly, so that the most common ones
can later be answered automatically or prevented with better resident communication.

Group the tickets into recurring topics by what the resident actually needs, not by shared words:
"sauna ei lämpene" and "löylyhuone kylmä" are the same topic. A topic needs at least two tickets;
leave one-off tickets out, and do not force unrelated tickets together. A ticket belongs to at
most one topic. If nothing recurs, return an empty list.

For each topic give, in Finnish:
title: a short name for the topic (2 to 5 words).
summary: one sentence describing what residents ask or report.
documentation: a draft knowledge-base entry for this topic, 2 to 5 sentences. The office saves it
after review, and an AI assistant then uses it as fact when drafting replies to similar tickets, so
it must read as the housing company's own instruction to residents: what to do, and whom to contact.
Base it only on the tickets and on the replies the office has already sent (marked "Office reply").
Never invent facts such as phone numbers, names, schedules, prices or responsibilities. Where a
needed fact is not in the tickets or replies, write a bracketed placeholder for the office to fill
in, for example "[täydennä: huoltoyhtiön puhelinnumero]".
tickets: the list numbers (the number before the colon) of the tickets in the topic.

Order the topics from most to fewest tickets.
`;

  const user = tickets
    .map((ticket, index) =>
      `${index + 1}: [${ticket.type}] ${ticket.subject} — ${ticket.summary.slice(0, 300)}`
      + (ticket.reply ? `\n   Office reply: ${ticket.reply.replace(/\s+/g, " ").slice(0, 400)}` : ""))
    .join("\n");

  const response = await ai.client.beta.messages.parse({
    model: ai.model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: `Tickets:\n${user}` }],
    output_config: { format: betaZodOutputFormat(TopicsSchema) }
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined the request");
  if (!response.parsed_output) throw new Error("AI:n vastausta ei voitu lukea");

  const used = new Set<number>();
  return response.parsed_output.topics
    .map(topic => {
      // Vain olemassa olevat tehtävät, kukin enintään yhdessä aiheessa.
      const indexes = [...new Set(topic.tickets)]
        .filter(number => Number.isInteger(number) && number >= 1 && number <= tickets.length && !used.has(number));
      indexes.forEach(number => used.add(number));
      return {
        title: topic.title.trim(),
        summary: topic.summary.trim(),
        documentation: topic.documentation.trim(),
        ticketIds: indexes.map(number => tickets[number - 1].id)
      };
    })
    .filter(topic => topic.title && topic.ticketIds.length >= 2)
    .sort((a, b) => b.ticketIds.length - a.ticketIds.length);
}

function localTriage(
  subject: string,
  body: string,
  knowledge: KnowledgeItem[],
  emergencyPhone?: string
): TriageResult {
  const text = `${subject}\n${body}`.toLowerCase();

  const emergencyWords = [
    "vesivuoto", "vesi valuu", "sähköt poikki", "sähkökatko",
    "lukko", "ovi ei aukea", "putkirikko", "tulvii"
  ];

  if (emergencyWords.some(word => text.includes(word))) {
    return {
      type: "Vikailmoitus",
      priority: "emergency",
      summary: `${subject}: mahdollinen päivystysasia.`,
      suggestedAction: "Ohjaa huoltoyhtiön päivystykseen heti.",
      reason: "Viestissä havaittiin mahdollinen hätätilanne.",
      draft: emergencyPhone
        ? `Hei! Kiireellinen asia on havaittu. Olethan yhteydessä huoltoyhtiön päivystykseen: ${emergencyPhone}. Terveisin Kotilo-sihteeri.`
        : "Hei! Kiireellinen asia on havaittu. Olethan heti yhteydessä huoltoyhtiön päivystykseen. Terveisin Kotilo-sihteeri.",
      emergency: true,
      sourceId: null
    };
  }

  const answer = findKnowledgeAnswer(`${subject}\n${body}`, knowledge);
  if (answer) {
    return {
      type: "Kysymys",
      priority: "normal",
      summary: subject || body.slice(0, 140),
      suggestedAction: "Vastaa yhtiön tietojen perusteella.",
      reason: `Vastaus löytyy yhtiön tiedoista (${answer.sourceTitle}).`,
      draft: `Hei! ${answer.answer}\n\nTerveisin Kotilo-sihteeri.`,
      emergency: false,
      sourceId: answer.sourceId
    };
  }

  if (text.includes("muutto") || text.includes("muutan")) {
    return {
      type: "Muutto",
      priority: "normal",
      summary: "Asukas ilmoittaa muuttoon liittyvästä asiasta.",
      suggestedAction: "Tarkista muuttoon liittyvät tiedot ja käsittele isännöitsijän päätösjonossa.",
      reason: "Muutto vaatii yleensä ihmisen vahvistuksen.",
      draft: "Hei! Kiitos ilmoituksesta. Isännöitsijä käsittelee asian.",
      emergency: false,
      sourceId: null
    };
  }

  return {
    type: text.includes("?") ? "Kysymys" : "Muu",
    priority: "normal",
    summary: subject || body.slice(0, 140),
    suggestedAction: "Tarkista viesti ja pyydä tarvittaessa AI-ehdotus.",
    reason: "Odottaa käsittelyä. AI-ehdotuksen voi pyytää tehtävältä.",
    draft: "Hei! Kiitos viestistä. Kotilo-sihteeri on vastaanottanut asian ja se käsitellään mahdollisimman pian.",
    emergency: false,
    sourceId: null
  };
}

export async function triage(
  subject: string,
  body: string,
  knowledge: KnowledgeItem[],
  emergencyPhone?: string
): Promise<TriageResult> {
  // Saapuvat viestit luokitellaan toistaiseksi paikallisesti; AI:ta käytetään vain pyydettäessä.
  return localTriage(subject, body, knowledge, emergencyPhone);
}
