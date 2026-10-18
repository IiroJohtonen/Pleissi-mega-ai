import { useState } from "react";
import { t } from "../i18n";
import { api, errorMessage } from "../session";

const featureLabels: Record<string, string> = {
  assess: t("saapuvan viestin arviointi"),
  suggest: t("vastausehdotus"),
  chunking: t("dokumentin pilkonta"),
  format: t("tiedon muotoilu"),
  compare: t("dokumenttiversioiden vertailu"),
  topics: t("toistuvien aiheiden raportti")
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

// AI:lle lähetetty sisältö sellaisenaan (malli, ohje ja viestit). Haetaan vasta avattaessa, koska
// esimerkiksi dokumentin pilkonnassa sisältö voi olla pitkä.
export function AiRequestDetails({ auditId }: { auditId: string }) {
  const [payload, setPayload] = useState<string | null>(null);
  const [error, setError] = useState("");

  return (
    <details
      className="audit-email ai-request"
      onToggle={event => {
        if (!(event.target as HTMLDetailsElement).open || payload !== null) return;
        api<{ payload: string }>(`/audit/${encodeURIComponent(auditId)}/ai-request`)
          .then(request => setPayload(request.payload))
          .catch(fetchError => setError(errorMessage(fetchError, t("Sisällön haku epäonnistui."))));
      }}
    >
      <summary>{t("Näytä AI:lle lähetetty tieto")}</summary>
      {error ? <p className="send-error">{error}</p>
        : payload === null ? <p>{t("Ladataan…")}</p>
        : (
          <>
            <pre>{readable(payload)}</pre>
            <details className="ai-request-raw">
              <summary>{t("Näytä pyyntö JSON-muodossa")}</summary>
              <pre>{payload}</pre>
            </details>
          </>
        )}
    </details>
  );
}
