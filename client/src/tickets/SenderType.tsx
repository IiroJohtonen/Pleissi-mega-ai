import { useEffect, useState } from "react";
import { t } from "../i18n";
import { api, errorMessage } from "../session";
import type { Ticket } from "../types";

// Lähettäjätyypit samassa järjestyksessä kuin palvelimella (server/src/sender-types.ts).
export const senderTypeLabels: Record<string, string> = {
  resident: t("Asukas"),
  owner: t("Osakas"),
  board: t("Hallitus"),
  contractor: t("Huolto tai urakoitsija"),
  broker: t("Välittäjä"),
  authority: t("Viranomainen"),
  other: t("Muu")
};

export const senderTypeOptions = Object.entries(senderTypeLabels).map(([value, label]) => ({ value, label }));

export function senderTypeLabel(type?: string | null) {
  return type ? senderTypeLabels[type] ?? type : t("Ei tiedossa");
}

const sourceLabels: Record<string, string> = {
  ai: t("AI:n arvio"),
  domain: t("tunnettu domain"),
  register: t("asukasrekisteri"),
  manual: t("käsittelijän valinta")
};

// Jonon merkki muille kuin asukkaille: viranomainen, välittäjä, urakoitsija, hallitus, osakas tai muu.
export function SenderTypeBadge({ ticket }: { ticket: Ticket }) {
  if (!ticket.sender_type || ticket.sender_type === "resident") return null;
  return (
    <em className={`sender-type-tag sender-${ticket.sender_type}`} title={t("Lähettäjän tyyppi")}>
      {senderTypeLabel(ticket.sender_type)}
    </em>
  );
}

// Tehtävän lähettäjätyyppi: AI:n tai domainlistan arvio, jonka käsittelijä voi korjata.
export function SenderTypeField({ ticket, onChanged }: { ticket: Ticket; onChanged: () => void | Promise<unknown> }) {
  const [value, setValue] = useState(ticket.sender_type ?? "");
  const [error, setError] = useState("");
  useEffect(() => setValue(ticket.sender_type ?? ""), [ticket.id, ticket.sender_type]);
  // Kenttä näkyy, kun tyyppi on arvioitu (AI, domainlista tai asukasrekisteri); käsittelijä korjaa arviota.
  if (!ticket.sender_type) return null;

  async function save(senderType: string) {
    setValue(senderType);
    setError("");
    try {
      await api(`/tickets/${encodeURIComponent(ticket.id)}/sender-type`, { method: "PUT", body: JSON.stringify({ senderType }) });
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught, t("Tallennus epäonnistui.")));
    }
  }

  return (
    <div className="sender-type-field">
      <label>
        <span>{t("Lähettäjän tyyppi")}</span>
        <select value={value} onChange={event => void save(event.target.value)}>
          {senderTypeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      {ticket.sender_type_source && <small className="muted">{sourceLabels[ticket.sender_type_source] ?? ""}</small>}
      {ticket.sender_type === "authority" && (
        <small className="muted">{t("Viranomaisen asia on kiireellinen ja kuuluu aina henkilökunnalle.")}</small>
      )}
      {error && <p className="send-error">{error}</p>}
    </div>
  );
}

type KnownDomain = { domain: string; type: string };

// Asetukset: toimiston tuntemat lähettäjädomainit. Domain ohittaa AI:n arvion lähettäjästä.
export function SenderDomainsCard({ editable }: { editable: boolean }) {
  const [domains, setDomains] = useState<KnownDomain[]>([]);
  const [draft, setDraft] = useState<KnownDomain>({ domain: "", type: "authority" });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<KnownDomain[]>("/office/sender-domains")
      .then(found => setDomains(Array.isArray(found) ? found : []))
      .catch(() => setError(t("Domainien lataus epäonnistui.")));
  }, []);

  async function save(next: KnownDomain[]) {
    setError("");
    setSaved(false);
    try {
      const result = await api<KnownDomain[]>("/office/sender-domains", { method: "PUT", body: JSON.stringify(next) });
      setDomains(result);
      setSaved(true);
      return true;
    } catch (caught) {
      setError(errorMessage(caught, t("Tallennus epäonnistui.")));
      return false;
    }
  }

  async function add() {
    if (!draft.domain.trim()) return;
    if (await save([...domains.filter(item => item.domain !== draft.domain.trim().toLowerCase()), draft])) {
      setDraft({ domain: "", type: draft.type });
    }
  }

  return (
    <div className="settings-card" id="section-sender-domains">
      <h2>{t("Tunnetut lähettäjät")}</h2>
      <p className="muted">
        {t("Kun saapuvan viestin lähettäjän domain on listalla, lähettäjän tyyppi tulee listalta eikä AI:n arviosta. Esimerkiksi kaupungin tai pelastuslaitoksen domain = viranomainen, huoltoyhtiön domain = huolto tai urakoitsija. Käsittelijä voi aina korjata tyypin tehtävällä.")}
      </p>
      {error && <p className="send-error">{error}</p>}
      {domains.length === 0 ? <p className="muted">{t("Ei tunnettuja domaineja.")}</p> : (
        <table className="data-table">
          <thead><tr><th>{t("Domain")}</th><th>{t("Lähettäjän tyyppi")}</th>{editable && <th />}</tr></thead>
          <tbody>
            {domains.map(item => (
              <tr key={item.domain}>
                <td>{item.domain}</td>
                <td>{senderTypeLabel(item.type)}</td>
                {editable && (
                  <td>
                    <button type="button" className="quiet-button" onClick={() => void save(domains.filter(other => other.domain !== item.domain))}>
                      {t("Poista")}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable && (
        <div className="sender-domain-form">
          <input
            placeholder={t("esim. hel.fi")}
            value={draft.domain}
            onChange={event => setDraft({ ...draft, domain: event.target.value })}
            aria-label={t("Domain")}
          />
          <select value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value })} aria-label={t("Lähettäjän tyyppi")}>
            {senderTypeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button type="button" className="secondary" onClick={() => void add()}>{t("Lisää")}</button>
          {saved && <small className="muted">{t("Tallennettu.")}</small>}
        </div>
      )}
    </div>
  );
}
