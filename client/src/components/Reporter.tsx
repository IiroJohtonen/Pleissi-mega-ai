import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { navigate } from "../routing";
import { api, errorMessage } from "../session";
import { initials } from "./Topbar";

export type ReporterInfo = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  apartment_number?: string | null;
  address?: string | null;
};

type ResidentOption = { id: string; name: string; email: string | null; apartment_number: string; address: string };

// Kysyy ennen siirtymistä asukkaan tietueelle, koska avoin näkymä jää taakse.
export function OpenResidentButton({ residentId, name, className }: { residentId: string; name: string; className?: string }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`open-resident ${className ?? ""}`}
        title={t("Avaa asukkaan tietue")}
        aria-label={t("Avaa asukkaan {0} tietue", name)}
        onClick={() => setAsking(true)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
          <path d="M9.5 11a4 4 0 1 0 0-8a4 4 0 0 0 0 8z" />
          <path d="M17 8h5M19.5 5.5L22 8l-2.5 2.5" />
        </svg>
      </button>
      {asking && (
        <div className="overlay skip-overlay confirm-overlay" onClick={() => setAsking(false)}>
          <div
            className="drawer skip-drawer confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="open-resident-title"
            onClick={event => event.stopPropagation()}
          >
            <h2 id="open-resident-title">{t("Siirrytäänkö asukkaan tietueelle?")}</h2>
            <p className="muted">{t("Avataan asukkaan {0} tiedot asukastaulussa. Tämä näkymä suljetaan.", name)}</p>
            <div className="draft-actions">
              <button
                type="button"
                className="primary"
                autoFocus
                onClick={() => {
                  setAsking(false);
                  navigate("residents", residentId);
                }}
              >
                {t("Kyllä, siirry")}
              </button>
              <button type="button" onClick={() => setAsking(false)}>{t("Peruuta")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Ilmoittajan tiedot tietueella: nimi, asunto, osoite ja sähköposti selvästi näkyvissä, painike
// asukkaan tietueelle ja haku, jolla ilmoittajan voi vaihtaa taloyhtiön asukkaista.
export function ReporterField({
  companyId,
  reporter,
  fallbackName,
  onChange,
  disabled,
  label
}: {
  // Kentän otsikko; oletuksena Ilmoittaja (esim. avaimella Haltija).
  label?: string;
  companyId: string;
  reporter: ReporterInfo;
  // Nimi, kun ilmoittajaa ei ole liitetty asukkaaseen (esim. puhelimitse kirjattu).
  fallbackName?: string | null;
  // Annettuna ilmoittajan voi vaihtaa; tallennus tehdään kutsujan funktiolla.
  onChange?: (residentId: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [residents, setResidents] = useState<ResidentOption[] | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (query === null || residents !== null) return;
    api<ResidentOption[]>(`/companies/${encodeURIComponent(companyId)}/residents`)
      .then(setResidents)
      .catch(() => setResidents([]));
  }, [query, residents, companyId]);

  const search = (query ?? "").trim().toLowerCase();
  const matches = (residents ?? [])
    .filter(resident => [resident.name, resident.apartment_number, resident.email].some(value => value?.toLowerCase().includes(search)))
    .slice(0, 30);

  async function choose(residentId: string) {
    setQuery(null);
    if (!onChange || residentId === reporter.id) return;
    setSaving(true);
    setError("");
    try {
      await onChange(residentId);
    } catch (changeError) {
      setError(errorMessage(changeError, t("Ilmoittajan vaihto epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  const name = reporter.name || fallbackName || "";
  const place = [reporter.apartment_number && t("Asunto {0}", reporter.apartment_number), reporter.address].filter(Boolean).join(" · ");

  return (
    <section className="reporter-card" aria-label={label ?? t("Ilmoittaja")}>
      <span className="reporter-label">{label ?? t("Ilmoittaja")}</span>
      <div className="reporter-main">
        <span className={`reporter-avatar${name ? "" : " empty"}`} aria-hidden="true">{name ? initials(name) : "?"}</span>
        <div className="reporter-text">
          <strong>{name || t("Ilmoittajaa ei ole liitetty asukkaaseen")}</strong>
          {place && <span>{place}</span>}
          {reporter.email
            ? <span className="reporter-email">{reporter.email}</span>
            : reporter.id ? <span className="muted">{t("Ei sähköpostia")}</span> : null}
          {!reporter.id && name && <span className="muted">{t("Ei liitetty asukastauluun")}</span>}
        </div>
        {reporter.id && <OpenResidentButton residentId={reporter.id} name={name} />}
      </div>
      {onChange && (
        <div className="fact-search reporter-search">
          <input
            ref={input}
            value={query ?? ""}
            placeholder={reporter.id ? t("Vaihda ilmoittaja: hae asukasta…") : t("Valitse ilmoittaja asukastaulusta…")}
            aria-label={t("Hae ilmoittajaksi asukasta")}
            disabled={disabled || saving}
            onFocus={() => setQuery("")}
            onChange={event => setQuery(event.target.value)}
            onBlur={() => setQuery(null)}
            onKeyDown={event => {
              if (event.key === "Escape") event.currentTarget.blur();
              if (event.key === "Enter" && matches.length > 0) {
                event.preventDefault();
                void choose(matches[0].id);
                event.currentTarget.blur();
              }
            }}
          />
          <button
            type="button"
            className="fact-search-button"
            title={t("Hae asukasta")}
            aria-label={t("Hae asukasta")}
            disabled={disabled || saving}
            onMouseDown={event => event.preventDefault()}
            onClick={() => input.current?.focus()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0" />
              <path d="M21 21l-4.300-4.300" />
            </svg>
          </button>
          {query !== null && (
            <ul>
              {residents === null && <li className="empty-option">{t("Ladataan…")}</li>}
              {matches.map(resident => (
                <li key={resident.id} onMouseDown={() => void choose(resident.id)}>
                  <strong>{resident.name}</strong>
                  <span>{[resident.apartment_number, resident.email].filter(Boolean).join(" · ")}</span>
                </li>
              ))}
              {residents !== null && matches.length === 0 && <li className="empty-option">{t("Ei hakua vastaavia asukkaita")}</li>}
            </ul>
          )}
        </div>
      )}
      {saving && <span className="muted">{t("Tallennetaan…")}</span>}
      {error && <p className="send-error">{error}</p>}
    </section>
  );
}

// Ilmoittaja listan solussa: nimi ja sen alla asunto ja sähköposti.
export function ReporterCell({ name, apartment, email, fallback }: {
  name?: string | null; apartment?: string | null; email?: string | null; fallback?: string;
}) {
  const meta = [apartment && t("Asunto {0}", apartment), email].filter(Boolean).join(" · ");
  return (
    <span className="reporter-cell">
      <strong>{name || fallback || t("Tuntematon asukas")}</strong>
      {meta && <small>{meta}</small>}
    </span>
  );
}
