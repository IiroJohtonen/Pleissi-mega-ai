import { type FormEvent, useState } from "react";
import type { Company } from "../types";
import { t } from "../i18n";

// Sulkemisen syyt ja se, mitä kukin tarkoittaa asukkaan kannalta.
const SKIP_REASONS = [
  { value: "already_handled", label: t("Jo hoidettu"), hint: t("Asia on kunnossa. Asukkaalle ilmoitetaan sulkemisesta.") },
  { value: "no_action_required", label: t("Ei vaadi toimia"), hint: t("Viesti oli tiedoksi tai ei kuulu toimistolle. Asukkaalle ilmoitetaan sulkemisesta.") },
  { value: "spam", label: t("Roskaposti"), hint: t("Mainos tai asiaton viesti. Lähettäjälle ei ilmoiteta mitään.") }
];

export function SkipTicketModal({
  onClose,
  onSubmit
}: {
  onClose: () => void;
  onSubmit: (reason: string, comment: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!reason) return;
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(reason, comment.trim());
    } catch {
      setError(t("Tehtävän sulkeminen epäonnistui. Yritä uudelleen."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay skip-overlay">
      <aside className="drawer skip-drawer" role="dialog" aria-modal="true" aria-labelledby="skip-title">
        <button className="close" onClick={onClose} disabled={submitting}>×</button>
        <h2 id="skip-title">{t("Sulje tehtävä")}</h2>
        <p className="muted">{t("Tehtävä suljetaan ilman muita toimenpiteitä.")}</p>
        <form className="ticket-form" onSubmit={handleSubmit}>
          <fieldset className="reason-options">
            <legend>{t("Sulkemisen syy")}</legend>
            {SKIP_REASONS.map(option => (
              <label key={option.value} className={`reason-option ${reason === option.value ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="skip-reason"
                  value={option.value}
                  checked={reason === option.value}
                  onChange={() => setReason(option.value)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>

          <label>
            <span>{t("Kommentti (valinnainen)")}</span>
            <textarea
              value={comment}
              onChange={event => setComment(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder={t("Esim. sovittu puhelimessa, huolto käy torstaina.")}
            />
          </label>
          <p className="reply-hint">{t("Kommentti tallentuu tehtävän sisäiseksi muistiinpanoksi. Asukas ei näe sitä.")}</p>

          {error && <p className="send-error">{error}</p>}

          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose} disabled={submitting}>{t("Peruuta")}</button>
            <button className="primary" type="submit" disabled={!reason || submitting}>
              {submitting ? t("Suljetaan…") : t("Sulje tehtävä")}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

export function TicketCreateModal({
  companies,
  defaultCompanyId,
  onClose,
  onSubmit
}: {
  companies: Company[];
  defaultCompanyId: string;
  onClose: () => void;
  onSubmit: (payload: {
    companyId: string;
    subject: string;
    summary: string;
    type: string;
    priority: string;
    residentName?: string;
    apartmentNumber?: string;
  }) => Promise<void>;
}) {
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const [subject, setSubject] = useState("");
  const [summary, setSummary] = useState("");
  const [type, setType] = useState("Ilmoitus");
  const [priority, setPriority] = useState("normal");
  const [residentName, setResidentName] = useState("");
  const [apartmentNumber, setApartmentNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!subject.trim() || !summary.trim()) return;

    setSubmitting(true);
    try {
      await onSubmit({
        companyId,
        subject: subject.trim(),
        summary: summary.trim(),
        type,
        priority,
        residentName: residentName.trim() || undefined,
        apartmentNumber: apartmentNumber.trim() || undefined
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay">
      <aside className="drawer form-drawer">
        <button className="close" onClick={onClose}>×</button>
        <h2>{t("Luo uusi tehtävä")}</h2>
        <p className="muted">{t("Lisää manuaalinen tehtävä omiin tehtäviin.")}</p>

        <form className="ticket-form" onSubmit={handleSubmit}>
          <label>
            <span>{t("Taloyhtiö")}</span>
            <select value={companyId} onChange={e => setCompanyId(e.target.value)}>
              {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>

          <label>
            <span>{t("Aihe")}</span>
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder={t("Esim. Käytävävalot")} />
          </label>

          <label>
            <span>{t("Luokka")}</span>
            <select value={type} onChange={e => setType(e.target.value)}>
              <option value="Ilmoitus">{t("Ilmoitus")}</option>
              <option value="Kysymys">{t("Kysymys")}</option>
              <option value="Pyyntö">{t("Pyyntö")}</option>
              <option value="Toimenpide">{t("Toimenpide")}</option>
            </select>
          </label>

          <label>
            <span>{t("Prioriteetti")}</span>
            <select value={priority} onChange={e => setPriority(e.target.value)}>
              <option value="normal">{t("Normaali")}</option>
              <option value="urgent">{t("Kiireellinen")}</option>
              <option value="low">{t("Matala")}</option>
              <option value="emergency">{t("Hätä")}</option>
            </select>
          </label>

          <label>
            <span>{t("Asukkaan nimi")}</span>
            <input value={residentName} onChange={e => setResidentName(e.target.value)} placeholder={t("Valinnainen")} />
          </label>

          <label>
            <span>{t("Asunto")}</span>
            <input value={apartmentNumber} onChange={e => setApartmentNumber(e.target.value)} placeholder={t("Valinnainen, esim. A 12")} />
          </label>

          <label>
            <span>{t("Kuvaus")}</span>
            <textarea value={summary} onChange={e => setSummary(e.target.value)} rows={6} placeholder={t("Kerro tehtävän sisältö...")} />
          </label>

          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>{t("Peruuta")}</button>
            <button className="primary" type="submit" disabled={submitting || !subject.trim() || !summary.trim()}>
              {submitting ? t("Luodaan…") : t("Luo tehtävä")}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
