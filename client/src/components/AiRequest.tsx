import { useState } from "react";
import { t } from "../i18n";
import { api, errorMessage } from "../session";

const featureLabels: Record<string, string> = {
  assess: t("saapuvan viestin arviointi"),
  suggest: t("vastausehdotus"),
  chunking: t("dokumentin pilkonta"),
  format: t("tiedon muotoilu"),
  compare: t("dokumenttiversioiden vertailu"),
  topics: t("toistuvien aiheiden raportti"),
  agent: t("AI-agentti"),
  incident: t("yhteisen vian tulkinta"),
  memory: t("taloyhtiön muistin ehdotukset"),
  draft_change: t("luonnoksen muokkauksen luokittelu"),
  agent_guard: t("AI-agentin aiheen tarkistus")
};

// Lokimerkinnän otsikko: mihin AI:ta käytettiin.
export function aiRequestLabel(details: string) {
  try {
    const parsed = JSON.parse(details) as { feature?: string };
    return t("Lähetetty AI:lle: {0}", featureLabels[parsed.feature ?? ""] ?? parsed.feature ?? "");
  } catch {
    return t("Lähetetty AI:lle");
  }
}

type Block = string | { type?: string; text?: string } | Block[];
const blockText = (block: Block | undefined): string =>
  typeof block === "string" ? block
    : Array.isArray(block) ? block.map(blockText).join("\n\n")
    : block?.text ?? (block ? JSON.stringify(block) : "");

// Luettava esitys: tekstit rivinvaihtoineen; muuten täsmälleen sama sisältö kuin lähetetyssä pyynnössä.
function readable(payload: string) {
  try {
    const request = JSON.parse(payload) as { model?: string; max_tokens?: number; system?: Block; messages?: { role: string; content: Block }[] };
    return [
      `${t("Malli")}: ${request.model ?? "–"}${request.max_tokens ? ` · ${t("vastaus enintään {0} tokenia", request.max_tokens)}` : ""}`,
      ...(request.system ? [`——— ${t("Järjestelmäohje")} ———`, blockText(request.system).trim()] : []),
      ...(request.messages ?? []).flatMap(message => [`——— ${t("Viesti ({0})", message.role)} ———`, blockText(message.content).trim()])
    ].join("\n\n");
  } catch {
    return payload;
  }
}

// AI:n vastaus luettavana: rakenteinen tulos tai tekstit ja työkalukutsut. Agentilla vastauksia on useita.
function readableResponse(response: string) {
  try {
    const parsed = JSON.parse(response) as unknown;
    const items = (Array.isArray(parsed) ? parsed : [parsed]) as { stop_reason?: string; output?: unknown; content?: Block & { type?: string; name?: string; input?: unknown }[] }[];
    return items.map((item, index) => {
      const body = item.output !== undefined
        ? JSON.stringify(item.output, null, 2)
        : (item.content ?? []).map(block => block.type === "tool_use" ? `→ ${block.name} ${JSON.stringify(block.input)}` : blockText(block)).join("\n\n");
      return `${items.length > 1 ? `——— ${t("Vastaus {0}", index + 1)} ———\n` : ""}${body.trim()}${item.stop_reason && item.stop_reason !== "end_turn" ? `\n(${item.stop_reason})` : ""}`;
    }).join("\n\n");
  } catch {
    return response;
  }
}

type AiRequestPayload = { payload: string; response: string | null };

// AI:lle lähetetty sisältö sellaisenaan (malli, ohje ja viestit) ja AI:n vastaus sen rinnalla. Haetaan vasta
// avattaessa, koska esimerkiksi dokumentin pilkonnassa sisältö voi olla pitkä.
export function AiRequestDetails({ auditId }: { auditId: string }) {
  const [request, setRequest] = useState<AiRequestPayload | null>(null);
  const [error, setError] = useState("");

  return (
    <details
      className="audit-email ai-request"
      onToggle={event => {
        if (!(event.target as HTMLDetailsElement).open || request !== null) return;
        api<AiRequestPayload>(`/audit/${encodeURIComponent(auditId)}/ai-request`)
          .then(setRequest)
          .catch(fetchError => setError(errorMessage(fetchError, t("Sisällön haku epäonnistui."))));
      }}
    >
      <summary>{t("Näytä AI:lle lähetetty tieto ja vastaus")}</summary>
      {error ? <p className="send-error">{error}</p>
        : request === null ? <p>{t("Ladataan…")}</p>
        : (
          <div className="ai-request-pair">
            <div>
              <strong>{t("Lähetetty")}</strong>
              <pre>{readable(request.payload)}</pre>
            </div>
            <div>
              <strong>{t("AI:n vastaus")}</strong>
              <pre>{request.response ? readableResponse(request.response) : t("Vastausta ei tallennettu (kutsu epäonnistui tai on tehty ennen tätä muutosta).")}</pre>
            </div>
            <details className="ai-request-raw">
              <summary>{t("Näytä pyyntö JSON-muodossa")}</summary>
              <pre>{request.payload}</pre>
              {request.response && <pre>{request.response}</pre>}
            </details>
          </div>
        )}
    </details>
  );
}

type TraceStep = { tool: string; input: unknown; output: unknown; error?: string; at: string; ms: number };

// AI-agentin ajon jäljitys: työkalukutsut järjestyksessä syötteineen ja tuloksineen.
export function AgentTraceDetails({ auditId }: { auditId: string }) {
  const [trace, setTrace] = useState<{ outcome: string; steps: TraceStep[] } | null>(null);
  const [error, setError] = useState("");
  const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

  return (
    <details
      className="audit-email ai-request"
      onToggle={event => {
        if (!(event.target as HTMLDetailsElement).open || trace !== null) return;
        api<{ payload: string }>(`/audit/${encodeURIComponent(auditId)}/ai-request`)
          .then(request => setTrace(JSON.parse(request.payload)))
          .catch(fetchError => setError(errorMessage(fetchError, t("Sisällön haku epäonnistui."))));
      }}
    >
      <summary>{t("Näytä agentin työkalukutsut")}</summary>
      {error ? <p className="send-error">{error}</p>
        : trace === null ? <p>{t("Ladataan…")}</p>
        : trace.steps.length === 0 ? <p>{t("Agentti ei kutsunut työkaluja.")}</p>
        : (
          <ol className="agent-trace">
            {trace.steps.map((step, index) => (
              <li key={index}>
                <strong>{step.tool}</strong> <small>{step.ms} ms</small>
                <pre>{t("Syöte")}: {show(step.input)}</pre>
                <pre>{step.error ? `${t("Virhe")}: ${step.error}` : `${t("Tulos")}: ${show(step.output)}`}</pre>
              </li>
            ))}
          </ol>
        )}
    </details>
  );
}
