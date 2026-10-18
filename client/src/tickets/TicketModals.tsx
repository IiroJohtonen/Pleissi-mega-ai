import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "../session";
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
        <button type="button" className="drawer-back" onClick={onClose}>{t("← Takaisin")}</button>
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

type Apartment = { id: string; apartment_number: string; address: string };

// Uusi asukas tehtävän sähköpostin lähettäjästä. Nimi ja sähköposti täytetään viestistä valmiiksi;
// taloyhtiö kysytään aina, ja asunto valitaan sen asunnoista tai kirjoitetaan uusi.
export function CreateResidentModal({
  companyId: initialCompanyId,
  companies,
  initialName,
  initialEmail,
  onClose,
  onCreated
}: {
  // Tehtävän taloyhtiö; tyhjä, jos taloyhtiötä ei ole tunnistettu.
  companyId: string;
  companies: Company[];
  initialName: string;
  initialEmail: string;
  onClose: () => void;
  onCreated: (residentId: string, companyId: string) => Promise<void>;
}) {
  const [companyId, setCompanyId] = useState(initialCompanyId);
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [apartments, setApartments] = useState<Apartment[]>([]);
  // Valitun asunnon tunniste; "new" = uusi asunto, jonka osoite ja numero kirjoitetaan.
  const [apartmentId, setApartmentId] = useState("new");
  const [address, setAddress] = useState("");
  const [apartmentNumber, setApartmentNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setApartments([]);
    setApartmentId("new");
    if (!companyId) return;
    api<Apartment[]>(`/companies/${encodeURIComponent(companyId)}/apartments`)
      .then(loaded => {
        setApartments(loaded);
        if (loaded.length > 0) setApartmentId(loaded[0].id);
      })
      .catch(() => setApartments([]));
  }, [companyId]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && !submitting && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, submitting]);

  const apartment = apartments.find(item => item.id === apartmentId);
  const finalAddress = apartment ? apartment.address : address.trim();
  const finalNumber = apartment ? apartment.apartment_number : apartmentNumber.trim();
  const ready = companyId && name.trim() && finalAddress && finalNumber;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setError("");
    try {
      const created = await api<{ residentId: string }>(`/companies/${encodeURIComponent(companyId)}/residents`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), email: email.trim(), address: finalAddress, apartmentNumber: finalNumber })
      });
      await onCreated(created.residentId, companyId);
    } catch (submitError) {
      setError(errorMessage(submitError, t("Asukkaan lisääminen epäonnistui.")));
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay skip-overlay" onClick={() => !submitting && onClose()}>
      <aside
        className="drawer skip-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-resident-title"
        onClick={event => event.stopPropagation()}
      >
        <button className="close" onClick={onClose} disabled={submitting} aria-label={t("Sulje")}>×</button>
        <h2 id="create-resident-title">{t("Uusi asukas")}</h2>
        <p className="muted">
          {t("Asukas liitetään tämän tehtävän ilmoittajaksi. Jos valitset toisen taloyhtiön, tehtävä siirretään siihen.")}
        </p>
        <form className="ticket-form" onSubmit={handleSubmit}>
          <label>
            <span>{t("Taloyhtiö")}</span>
            <select value={companyId} onChange={event => setCompanyId(event.target.value)}>
              {!companyId && <option value="">{t("Valitse taloyhtiö")}</option>}
              {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>
          <label>
            <span>{t("Nimi")}</span>
            <input value={name} onChange={event => setName(event.target.value)} autoFocus maxLength={200} />
          </label>
          <label>
            <span>{t("Sähköposti")}</span>
            <input type="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={200} />
          </label>
          <label>
            <span>{t("Asunto")}</span>
            <select value={apartmentId} onChange={event => setApartmentId(event.target.value)}>
              {apartments.map(item => (
                <option key={item.id} value={item.id}>{item.apartment_number} · {item.address}</option>
              ))}
              <option value="new">{t("Uusi asunto…")}</option>
            </select>
          </label>
          {!apartment && (
            <div className="signature-fields">
              <label>
                <span>{t("Osoite")}</span>
                <input value={address} onChange={event => setAddress(event.target.value)} placeholder={t("Esim. Koivikkotie 10")} maxLength={200} />
              </label>
              <label>
                <span>{t("Asunto")}</span>
                <input value={apartmentNumber} onChange={event => setApartmentNumber(event.target.value)} placeholder={t("Esim. A 12")} maxLength={40} />
              </label>
            </div>
          )}
          {error && <p className="send-error">{error}</p>}
          <div className="draft-actions">
            <button className="primary" type="submit" disabled={submitting || !ready}>
              {submitting ? t("Tallennetaan…") : t("Lisää asukas")}
            </button>
            <button type="button" onClick={onClose} disabled={submitting}>{t("Peruuta")}</button>
          </div>
        </form>
      </aside>
    </div>
  );
}

// AI-ehdotuksen pyyntö: käsittelijä voi kertoa tehtävästä lisätietoa, jonka AI ottaa luonnoksessa
// huomioon, esimerkiksi sovitun huoltokäynnin tai jo tehdyt toimenpiteet.
export function AiSuggestModal({
  onClose,
  onSubmit
}: {
  onClose: () => void;
  onSubmit: (context: string) => void;
}) {
  const [context, setContext] = useState("");

  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSubmit(context.trim());
  }

  return (
    <div className="overlay skip-overlay" onClick={onClose}>
      <aside
        className="drawer skip-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-suggest-title"
        onClick={event => event.stopPropagation()}
      >
        <button className="close" onClick={onClose} aria-label={t("Sulje")}>×</button>
        <h2 id="ai-suggest-title">{t("Pyydä AI-ehdotus")}</h2>
        <p className="muted">
          {t("AI kirjoittaa vastausluonnoksen tehtävän viestien ja taloyhtiön dokumentaation perusteella. Voit kertoa lisätietoa, jonka AI ottaa huomioon.")}
        </p>
        <form className="ticket-form" onSubmit={handleSubmit}>
          <label>
            <span>{t("Lisätietoa AI:lle (valinnainen)")}</span>
            <textarea
              value={context}
              onChange={event => setContext(event.target.value)}
              rows={5}
              maxLength={2000}
              autoFocus
              placeholder={t("Esim. Huoltomies käy torstaina klo 10. Asukkaan ei tarvitse olla paikalla.")}
            />
          </label>
          <p className="reply-hint">{t("AI-ehdotuksen voi pyytää tehtävälle vain kerran. Lisätieto ei näy asukkaalle sellaisenaan.")}</p>
          <div className="draft-actions">
            <button className="primary" type="submit">{t("Pyydä ehdotus")}</button>
            <button type="button" onClick={onClose}>{t("Peruuta")}</button>
          </div>
        </form>
      </aside>
    </div>
  );
}
