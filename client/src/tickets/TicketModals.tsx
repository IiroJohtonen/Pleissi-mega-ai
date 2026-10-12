import { type FormEvent, useState } from "react";
import type { Company } from "../types";

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
        <h2>Sulje tehtävä</h2>
        <p className="muted">Tehtävä suljetaan ilman muita toimenpiteitä. Valitse sulkemisen syy.</p>
        <form className="ticket-form" onSubmit={handleSubmit}>
          <label>
            <span>Syy <em className="required-label">Pakollinen</em></span>
            <select required value={reason} onChange={event => setReason(event.target.value)}>
              <option value="">Valitse syy</option>
              <option value="already_handled">Jo hoidettu</option>
              <option value="no_action_required">Ei vaadi toimia</option>
              <option value="spam">Roskaposti</option>
            </select>
          </label>
          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>Peruuta</button>
            <button className="primary" type="submit" disabled={!reason || submitting}>
              {submitting ? "Suljetaan…" : "Sulje tehtävä"}
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
        <h2>Luo uusi tehtävä</h2>
        <p className="muted">Lisää manuaalinen tehtävä omiin tehtäviin.</p>

        <form className="ticket-form" onSubmit={handleSubmit}>
          <label>
            <span>Taloyhtiö</span>
            <select value={companyId} onChange={e => setCompanyId(e.target.value)}>
              {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>

          <label>
            <span>Aihe</span>
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Esim. Käytävävalot" />
          </label>

          <label>
            <span>Luokka</span>
            <select value={type} onChange={e => setType(e.target.value)}>
              <option>Ilmoitus</option>
              <option>Kysymys</option>
              <option>Pyyntö</option>
              <option>Toimenpide</option>
            </select>
          </label>

          <label>
            <span>Prioriteetti</span>
            <select value={priority} onChange={e => setPriority(e.target.value)}>
              <option value="normal">Normaali</option>
              <option value="urgent">Kiireellinen</option>
              <option value="low">Matala</option>
              <option value="emergency">Hätä</option>
            </select>
          </label>

          <label>
            <span>Asukkaan nimi</span>
            <input value={residentName} onChange={e => setResidentName(e.target.value)} placeholder="Valinnainen" />
          </label>

          <label>
            <span>Asunto</span>
            <input value={apartmentNumber} onChange={e => setApartmentNumber(e.target.value)} placeholder="Valinnainen, esim. A 12" />
          </label>

          <label>
            <span>Kuvaus</span>
            <textarea value={summary} onChange={e => setSummary(e.target.value)} rows={6} placeholder="Kerro tehtävän sisältö..." />
          </label>

          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>Peruuta</button>
            <button className="primary" type="submit" disabled={submitting || !subject.trim() || !summary.trim()}>
              {submitting ? "Luodaan…" : "Luo tehtävä"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
