import { useEffect, useState } from "react";
import { api, errorMessage, type OfficeUser } from "../session";
import type { Company, Ticket } from "../types";
import { t } from "../i18n";

type Suggestion = { companyId: string; companyName: string; reason: string } | null;

// Taloyhtiö tunnistamatta: jonon käsittelijä valitsee tehtävälle taloyhtiön ja halutessaan käsittelijän.
// Pleissi ehdottaa todennäköistä yhtiötä, mutta valinta tehdään aina käsin.
export function UnidentifiedCompanyPanel({ ticket, companies, users, onChanged }: {
  ticket: Ticket;
  companies: Company[];
  users: OfficeUser[];
  onChanged: () => Promise<void>;
}) {
  const [suggestion, setSuggestion] = useState<Suggestion>(null);
  const [companyId, setCompanyId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setCompanyId("");
    setAssigneeId("");
    api<{ suggestion: Suggestion }>(`/tickets/${ticket.id}/company-suggestion`)
      .then(result => {
        setSuggestion(result.suggestion);
        if (result.suggestion) setCompanyId(result.suggestion.companyId);
      })
      .catch(() => setSuggestion(null));
  }, [ticket.id]);

  async function save() {
    if (!companyId) return;
    setSaving(true);
    setError("");
    try {
      await api(`/tickets/${ticket.id}/company`, {
        method: "PUT",
        body: JSON.stringify(assigneeId ? { companyId, assigneeId } : { companyId })
      });
      await onChanged();
    } catch (problem) {
      setError(errorMessage(problem, t("Taloyhtiön valinta epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="unidentified-panel">
      <strong>{t("Taloyhtiötä ei tunnistettu")}</strong>
      <p>{t("Viestin vastaanottajasta tai lähettäjästä ei selvinnyt, mitä taloyhtiötä se koskee. Valitse taloyhtiö, niin tehtävä siirtyy sen käsittelijälle.")}</p>
      {suggestion && (
        <p className="unidentified-suggestion">
          {t("Ehdotus: {0}. {1}", suggestion.companyName, t(suggestion.reason))}
        </p>
      )}
      <div className="unidentified-fields">
        <label>
          <span>{t("Taloyhtiö")}</span>
          <select value={companyId} onChange={event => setCompanyId(event.target.value)}>
            <option value="">{t("Valitse taloyhtiö")}</option>
            {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </label>
        <label>
          <span>{t("Käsittelijä")}</span>
          <select value={assigneeId} onChange={event => setAssigneeId(event.target.value)}>
            <option value="">{t("Taloyhtiön vastuuisännöitsijä")}</option>
            {users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </label>
        <button type="button" className="primary" disabled={saving || !companyId} onClick={() => void save()}>
          {saving ? t("Tallennetaan…") : t("Siirrä taloyhtiöön")}
        </button>
      </div>
      {error && <p className="send-error">{error}</p>}
    </div>
  );
}

// Väärään taloyhtiöön mennyt tehtävä siirretään oikeaan. Siirron jälkeen tehtävä menee uuden yhtiön
// vastuuisännöitsijälle ja saa sen yhtiön tehtävänumeron.
export function MoveCompanyControl({ ticket, companies, onChanged }: {
  ticket: Ticket;
  companies: Company[];
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [companyId, setCompanyId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const others = companies.filter(company => company.id !== ticket.company_id);

  useEffect(() => {
    setOpen(false);
    setCompanyId("");
    setError("");
  }, [ticket.id]);

  async function move() {
    const target = companies.find(company => company.id === companyId);
    if (!target) return;
    if (!window.confirm(t("Siirretäänkö tehtävä taloyhtiöön {0}? Se menee yhtiön vastuuisännöitsijälle ja saa uuden tehtävänumeron.", target.name))) return;
    setSaving(true);
    setError("");
    try {
      await api(`/tickets/${ticket.id}/company`, { method: "PUT", body: JSON.stringify({ companyId }) });
      await onChanged();
    } catch (problem) {
      setError(errorMessage(problem, t("Siirto epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  if (others.length === 0) return null;
  if (!open) {
    return (
      <button type="button" className="back-link move-company-link" onClick={() => setOpen(true)}>
        {t("Väärä yhtiö? Siirrä")}
      </button>
    );
  }
  return (
    <span className="move-company">
      <select value={companyId} onChange={event => setCompanyId(event.target.value)} aria-label={t("Uusi taloyhtiö")}>
        <option value="">{t("Valitse taloyhtiö")}</option>
        {others.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
      </select>
      <button type="button" className="primary" disabled={saving || !companyId} onClick={() => void move()}>{t("Siirrä")}</button>
      <button type="button" className="secondary" onClick={() => setOpen(false)}>{t("Peru")}</button>
      {error && <span className="send-error">{error}</span>}
    </span>
  );
}
