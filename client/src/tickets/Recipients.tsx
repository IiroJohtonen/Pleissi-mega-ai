import { type KeyboardEvent, useEffect, useState } from "react";
import { t } from "../i18n";
import { api, errorMessage } from "../session";

const EMAIL = /^[^\s<>,;@]+@[^\s<>,;@]+\.[^\s<>,;@]+$/;

export async function saveRecipients(ticketId: string, recipients: string[]) {
  return api<{ recipients: string[]; custom: boolean }>(`/tickets/${encodeURIComponent(ticketId)}/recipients`, {
    method: "PUT", body: JSON.stringify({ recipients })
  });
}

// Vastauksen vastaanottajat kuten sähköpostissa: osoitteet "lappuina", joita voi lisätä ja poistaa. Muutos tallentuu
// tehtävälle heti, ja kaikki vastaukset menevät sen jälkeen näihin osoitteisiin.
export function RecipientsField({ ticketId, recipients, onChanged }: {
  ticketId: string; recipients: string[]; onChanged: () => void | Promise<unknown>;
}) {
  const [list, setList] = useState(recipients);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setList(recipients), [ticketId, recipients.join(",")]);

  async function save(next: string[]) {
    setError("");
    try {
      const result = await saveRecipients(ticketId, next);
      setList(result.recipients);
      await onChanged();
    } catch (problem) {
      setError(errorMessage(problem, t("Vastaanottajien tallennus epäonnistui.")));
    }
  }

  async function add() {
    const emails = draft.split(/[,;\s]+/).map(item => item.trim()).filter(Boolean);
    if (!emails.length) return;
    const invalid = emails.find(email => !EMAIL.test(email));
    if (invalid) {
      setError(t("{0} ei ole kelvollinen sähköpostiosoite.", invalid));
      return;
    }
    setDraft("");
    await save([...list, ...emails.filter(email => !list.some(existing => existing.toLowerCase() === email.toLowerCase()))]);
  }

  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "," || event.key === ";") {
      event.preventDefault();
      void add();
    } else if (event.key === "Backspace" && !draft && list.length > 1) {
      void save(list.slice(0, -1));
    }
  }

  return (
    <div className="reply-cc reply-to">
      <div className="reply-to-field">
        <span>{t("Vastaanottajat")}</span>
        <div className="recipient-chips">
          {list.map(email => (
            <span key={email} className="recipient-chip">
              {email}
              {list.length > 1 && (
                <button type="button" aria-label={t("Poista vastaanottaja {0}", email)} onClick={() => void save(list.filter(item => item !== email))}>×</button>
              )}
            </span>
          ))}
          <input
            type="email"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKey}
            onBlur={() => void add()}
            placeholder={list.length ? t("Lisää vastaanottaja") : t("Sähköpostiosoite")}
            aria-label={t("Lisää vastaanottaja")}
          />
        </div>
      </div>
      {error && <p className="send-error">{error}</p>}
    </div>
  );
}
