import { type FormEvent, useState } from "react";
import type { Company } from "../types";
import { t } from "../i18n";

export function SkipTicketModal({
  onClose,
  onSubmit
}: {
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!reason) return;
    setSubmitting(true);
    try {
      await onSubmit(reason);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay skip-overlay" onClick={onClose}>
      <aside className="drawer skip-drawer" onClick={event => event.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        <h2>{t("Sulje tehtävä")}</h2>
        <p className="muted">{t("Tehtävä suljetaan ilman muita toimenpiteitä. Valitse sulkemisen syy.")}</p>
        <form className="ticket-form" onSubmit={handleSubmit}>
          <label>
            <span>{t("Syy")}{" "}<em className="required-label">{t("Pakollinen")}</em></span>
            <select required value={reason} onChange={event => setReason(event.target.value)}>
              <option value="">{t("Valitse syy")}</option>
              <option value="already_handled">{t("Jo hoidettu")}</option>
              <option value="no_action_required">{t("Ei vaadi toimia")}</option>
              <option value="spam">{t("Roskaposti")}</option>
            </select>
          </label>
          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>{t("Peruuta")}</button>
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
    <div className="overlay" onClick={onClose}>
      <aside className="drawer form-drawer" onClick={e => e.stopPropagation()}>
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
