import { type FormEvent, useEffect, useState } from "react";
import { Dropdown, NoticeFilters, usePaged } from "../components/common";
import { formatDateOnly, formatDay, formatTicketNumber, noticeStatusClass } from "../format";
import { navigate } from "../routing";
import { api, errorMessage, isManager } from "../session";
import type { Company } from "../types";
import { t } from "../i18n";

export type RenovationStatus = "pending" | "approved" | "rejected" | "started" | "completed" | "inspected";

export type RenovationNotice = {
  id: string;
  company_id: string;
  ticket_id?: string | null;
  ticket_number?: number | null;
  ticket_status?: string | null;
  assignee_name?: string | null;
  apartment_id?: string | null;
  resident_id?: string | null;
  reporter_name?: string;
  work_type: string;
  description: string;
  start_date: string | null;
  end_date: string | null;
  contractor: string;
  contractor_contact?: string;
  supervisor?: string;
  impact_structures?: string;
  impact_water?: string;
  impact_sewer?: string;
  impact_electric?: string;
  impact_ventilation?: string;
  waterproofing?: string;
  hazmat_survey?: string;
  status: RenovationStatus;
  // Hyväksynnän ehdot tai hylkäämisen perustelu.
  decision_note: string;
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  inspected_at?: string | null;
  resident_name?: string | null;
  resident_email?: string | null;
  apartment_number?: string | null;
  address?: string | null;
};

// Muutostyöilmoituksen työn tyypit (asunto-osakeyhtiölain 4. luku).
export const RENOVATION_WORK_TYPES = ["Märkätila", "Keittiö", "Sähkö", "LVI", "Rakenteet", "Muu"];

export const renovationStatusLabels: Record<RenovationStatus, string> = {
  pending: t("Odottaa käsittelyä"),
  approved: t("Hyväksytty"),
  rejected: t("Hylätty"),
  started: t("Aloitettu"),
  completed: t("Valmis"),
  inspected: t("Tarkastettu")
};

// Lomakkeen kentät: sarake, lomakkeen avain ja otsikko. Kaikki ovat valinnaisia.
type FieldKey = "contractor" | "contractor_contact" | "supervisor" | "impact_structures" | "impact_water" | "impact_sewer"
  | "impact_electric" | "impact_ventilation" | "waterproofing" | "hazmat_survey";
const TEXT_FIELDS: { column: FieldKey; key: string; label: string; multiline?: boolean; hint?: string }[] = [
  { column: "contractor", key: "contractor", label: t("Urakoitsija") },
  { column: "contractor_contact", key: "contractorContact", label: t("Urakoitsijan yhteystiedot") },
  { column: "supervisor", key: "supervisor", label: t("Vastuuhenkilö / valvoja") },
  { column: "impact_structures", key: "impactStructures", label: t("Vaikutukset rakenteisiin"), multiline: true },
  { column: "impact_water", key: "impactWater", label: t("Vaikutukset vesijärjestelmään"), multiline: true },
  { column: "impact_sewer", key: "impactSewer", label: t("Vaikutukset viemäröintiin"), multiline: true },
  { column: "impact_electric", key: "impactElectric", label: t("Vaikutukset sähköjärjestelmään"), multiline: true },
  { column: "impact_ventilation", key: "impactVentilation", label: t("Vaikutukset ilmanvaihtoon"), multiline: true },
  { column: "waterproofing", key: "waterproofing", label: t("Vedeneristys (märkätilat)"), multiline: true,
    hint: t("Vedeneristeen tuote ja asentaja sekä mahdollinen sertifikaatti.") },
  { column: "hazmat_survey", key: "hazmatSurvey", label: t("Haitta-ainekartoitus (ennen vuotta 1994 rakennetut)"), multiline: true,
    hint: t("Esim. asbestikartoituksen tulos tai tieto siitä, ettei kartoitusta tarvita.") }
];

export type RenovationValues = { work_type: string; description: string; start_date: string; end_date: string } & Record<FieldKey, string>;

export function renovationValues(notice?: Partial<RenovationNotice>): RenovationValues {
  return {
    work_type: notice?.work_type ?? "",
    description: notice?.description ?? "",
    start_date: notice?.start_date ?? "",
    end_date: notice?.end_date ?? "",
    ...Object.fromEntries(TEXT_FIELDS.map(field => [field.column, notice?.[field.column] ?? ""])) as Record<FieldKey, string>
  };
}

// Lomakkeen arvot rajapinnan muotoon.
export function renovationPayload(values: RenovationValues) {
  return {
    workType: values.work_type,
    description: values.description.trim(),
    startDate: values.start_date || null,
    endDate: values.end_date || null,
    ...Object.fromEntries(TEXT_FIELDS.map(field => [field.key, values[field.column].trim()]))
  };
}

export function renovationFieldsError(values: RenovationValues) {
  if (values.start_date && values.end_date && values.end_date < values.start_date) return t("Päättymispäivä ei voi olla ennen alkamispäivää.");
  return "";
}

// Muutostyöilmoituksen kentät. Sama lomake asukkaalle portaalissa ja toimistolle.
export function RenovationFields({ values, onChange }: { values: RenovationValues; onChange: (values: RenovationValues) => void }) {
  const set = (key: keyof RenovationValues, value: string) => onChange({ ...values, [key]: value });
  // Vanhan ilmoituksen tyyppi, jota ei enää ole listassa, näytetään valinnaksi, jotta se ei katoa.
  const workTypes = values.work_type && !RENOVATION_WORK_TYPES.includes(values.work_type)
    ? [values.work_type, ...RENOVATION_WORK_TYPES] : RENOVATION_WORK_TYPES;
  return (
    <>
      <label>
        <span>{t("Työn tyyppi")}</span>
        <select value={values.work_type} onChange={event => set("work_type", event.target.value)}>
          <option value="">{t("Valitse")}</option>
          {workTypes.map(option => <option key={option} value={option}>{t(option)}</option>)}
        </select>
      </label>
      <label>
        <span>{t("Työn kuvaus")}</span>
        <textarea
          value={values.description}
          onChange={event => set("description", event.target.value)}
          maxLength={5000}
          rows={5}
          placeholder={t("Kerro, mitä tehdään ja mihin rakenteisiin tai putkiin työ vaikuttaa.")}
        />
      </label>
      <div className="form-row">
        <label>
          <span>{t("Työ alkaa")}</span>
          <input type="date" value={values.start_date} onChange={event => set("start_date", event.target.value)} />
        </label>
        <label>
          <span>{t("Työ päättyy")}</span>
          <input type="date" value={values.end_date} min={values.start_date || undefined} onChange={event => set("end_date", event.target.value)} />
        </label>
      </div>
      {TEXT_FIELDS.map(field => (
        <label key={field.column}>
          <span>{field.label}</span>
          {field.multiline ? (
            <textarea value={values[field.column]} onChange={event => set(field.column, event.target.value)} maxLength={2000} rows={2} />
          ) : (
            <input value={values[field.column]} onChange={event => set(field.column, event.target.value)} maxLength={300} />
          )}
          {field.hint && <small className="field-hint">{field.hint}</small>}
        </label>
      ))}
    </>
  );
}

// Täytetyt kentät luettavaksi listaksi.
export function RenovationFacts({ notice }: { notice: RenovationNotice }) {
  const rows: [string, string][] = [
    [t("Työ"), notice.work_type ? t(notice.work_type) : ""],
    [t("Ajankohta"), renovationPeriod(notice)],
    ...TEXT_FIELDS.map(field => [field.label, notice[field.column] ?? ""] as [string, string])
  ];
  const filled = rows.filter(([, value]) => value);
  if (filled.length === 0) return <p className="muted">{t("Ilmoitukseen ei ole täytetty tietoja.")}</p>;
  return (
    <dl className="ticket-facts renovation-facts">
      {filled.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function renovationPeriod(notice: Pick<RenovationNotice, "start_date" | "end_date">) {
  if (!notice.start_date && !notice.end_date) return "";
  return `${notice.start_date ? formatDay(notice.start_date) : ""}–${notice.end_date ? formatDay(notice.end_date) : ""}`;
}

// Hyväksytty tai aloitettu remontti, jonka päättymispäivä on mennyt mutta jota ei ole merkitty valmiiksi.
export function isUnconfirmed(notice: Pick<RenovationNotice, "status" | "end_date">) {
  return (notice.status === "approved" || notice.status === "started")
    && Boolean(notice.end_date) && (notice.end_date ?? "") < new Date().toLocaleDateString("sv-SE");
}

// Seuraavat kirjattavat vaiheet remontin tilan mukaan.
const NEXT_PHASES: Partial<Record<RenovationStatus, { phase: string; label: string }[]>> = {
  approved: [
    { phase: "started", label: t("Merkitse aloitetuksi") },
    { phase: "supervision", label: t("Kirjaa valvontakäynti") },
    { phase: "completed", label: t("Merkitse valmiiksi") }
  ],
  started: [
    { phase: "supervision", label: t("Kirjaa valvontakäynti") },
    { phase: "completed", label: t("Merkitse valmiiksi") }
  ],
  completed: [{ phase: "inspected", label: t("Merkitse tarkastetuksi") }]
};

// Remonttitehtävän osio tehtäväsivulla: ilmoituksen tiedot, päätös ja vaiheiden kirjaus.
export function RenovationPanel({ notice, onChanged }: { notice: RenovationNotice; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(() => renovationValues(notice));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!editing) setValues(renovationValues(notice));
  }, [notice, editing]);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setSaving(true);
    setError("");
    try {
      await action();
      setNote("");
      await onChanged();
      return true;
    } catch (actionError) {
      setError(errorMessage(actionError, fallback));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const invalid = renovationFieldsError(values);
    if (invalid) {
      setError(invalid);
      return;
    }
    const ok = await run(() => api(`/renovations/${encodeURIComponent(notice.id)}`, {
      method: "PUT", body: JSON.stringify(renovationPayload(values))
    }), t("Remontti-ilmoituksen tallennus epäonnistui."));
    if (ok) setEditing(false);
  }

  function decide(decision: "approve" | "reject") {
    if (decision === "reject" && !note.trim()) {
      setError(t("Kirjoita hylkäämisen perustelu."));
      return;
    }
    void run(() => api(`/renovations/${encodeURIComponent(notice.id)}/${decision}`, {
      method: "POST", body: JSON.stringify({ note: note.trim() })
    }), t("Remontti-ilmoituksen käsittely epäonnistui."));
  }

  function phase(next: string) {
    void run(() => api(`/renovations/${encodeURIComponent(notice.id)}/phase`, {
      method: "POST", body: JSON.stringify({ phase: next, note: note.trim() })
    }), t("Vaiheen kirjaus epäonnistui."));
  }

  const phases = NEXT_PHASES[notice.status] ?? [];

  return (
    <section className="drawer-section renovation-panel">
      <div className="suggest-header">
        <h3>{t("Remontti-ilmoitus")}</h3>
        <span className={`status-badge renovation-${notice.status}`}>{renovationStatusLabels[notice.status] ?? notice.status}</span>
      </div>
      {notice.reporter_name && !notice.resident_id && <p className="muted">{t("Ilmoittaja:")}{" "}{notice.reporter_name}</p>}

      {editing ? (
        <form className="ticket-form" onSubmit={save}>
          <RenovationFields values={values} onChange={setValues} />
          <div className="draft-actions">
            <button type="submit" className="primary" disabled={saving}>{saving ? t("Tallennetaan…") : t("Tallenna")}</button>
            <button type="button" onClick={() => setEditing(false)} disabled={saving}>{t("Peruuta")}</button>
          </div>
        </form>
      ) : (
        <>
          <RenovationFacts notice={notice} />
          <button type="button" className="link-button" onClick={() => setEditing(true)}>{t("Muokkaa ilmoituksen tietoja")}</button>
        </>
      )}

      {notice.decision_note && (
        <>
          <h4>{notice.status === "rejected" ? t("Hylkäämisen perustelu") : t("Hyväksynnän ehdot")}</h4>
          <p className="announcement-body">{notice.decision_note}</p>
        </>
      )}

      {!editing && (notice.status === "pending" || phases.length > 0) && (
        <div className="ticket-form">
          <label>
            <span>{notice.status === "pending" ? t("Ehdot tai perustelu") : t("Merkintä (valinnainen)")}</span>
            <textarea
              value={note}
              onChange={event => setNote(event.target.value)}
              rows={3}
              maxLength={3000}
              placeholder={notice.status === "pending"
                ? t("Esim. valvoja tarkastaa vesieristyksen ennen laatoitusta. Hylkäys vaatii perustelun.")
                : t("Esim. valvontakäynnin havainnot. Merkintä näkyy tehtävän aikajanalla.")}
            />
          </label>
          {notice.status === "pending" && (
            isManager() ? (
              <>
                <p className="reply-hint">{t("Asukas saa päätöksestä sähköpostin, jossa ehdot tai perustelu ovat mukana.")}</p>
                <div className="draft-actions">
                  <button className="primary" onClick={() => decide("approve")} disabled={saving}>{saving ? t("Käsitellään…") : t("Hyväksy")}</button>
                  <button onClick={() => decide("reject")} disabled={saving}>{t("Hylkää")}</button>
                </div>
              </>
            ) : <p className="reply-hint">{t("Remontti-ilmoituksen hyväksyy tai hylkää isännöitsijä tai pääkäyttäjä.")}</p>
          )}
          {phases.length > 0 && (
            <div className="draft-actions">
              {phases.map((item, index) => (
                <button key={item.phase} className={index === phases.length - 1 ? "primary" : ""} onClick={() => phase(item.phase)} disabled={saving}>
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p className="send-error">{error}</p>}
    </section>
  );
}

// Toimiston oma remontti-ilmoitus, esim. puhelimitse tullut. Kaikki kentät ovat valinnaisia.
function NewRenovationModal({ companies, defaultCompanyId, onClose, onCreated }: {
  companies: Company[];
  defaultCompanyId: string;
  onClose: () => void;
  onCreated: (ticketId: string) => void;
}) {
  const [companyId, setCompanyId] = useState(defaultCompanyId || companies[0]?.id || "");
  const [apartments, setApartments] = useState<{ id: string; apartment_number: string; address: string }[]>([]);
  const [apartmentId, setApartmentId] = useState("");
  const [reporterName, setReporterName] = useState("");
  const [values, setValues] = useState(() => renovationValues());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setApartmentId("");
    if (!companyId) return;
    api<{ id: string; apartment_number: string; address: string }[]>(`/companies/${encodeURIComponent(companyId)}/apartments`)
      .then(setApartments)
      .catch(() => setApartments([]));
  }, [companyId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const invalid = renovationFieldsError(values);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const created = await api<{ ticketId: string }>(`/companies/${encodeURIComponent(companyId)}/renovations`, {
        method: "POST",
        body: JSON.stringify({ ...renovationPayload(values), apartmentId: apartmentId || null, reporterName: reporterName.trim() })
      });
      onCreated(created.ticketId);
    } catch (createError) {
      setError(errorMessage(createError, t("Remontti-ilmoituksen tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay">
      <aside className="drawer form-drawer">
        <button type="button" className="drawer-back" onClick={onClose} disabled={saving}>{t("← Takaisin")}</button>
        <button className="close" onClick={onClose} disabled={saving}>×</button>
        <h2>{t("Uusi remontti-ilmoitus")}</h2>
        <p className="muted">{t("Kirjaa esimerkiksi puhelimitse tullut ilmoitus. Kaikki kentät ovat valinnaisia.")}</p>
        <form className="ticket-form" onSubmit={submit}>
          {companies.length > 1 && (
            <Dropdown
              label={t("Taloyhtiö")}
              value={companyId}
              options={companies.map(company => ({ value: company.id, label: company.name }))}
              onChange={setCompanyId}
            />
          )}
          <label>
            <span>{t("Asunto")}</span>
            <select value={apartmentId} onChange={event => setApartmentId(event.target.value)}>
              <option value="">{t("Ei valittu")}</option>
              {apartments.map(apartment => (
                <option key={apartment.id} value={apartment.id}>{apartment.apartment_number}{apartment.address ? `, ${apartment.address}` : ""}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("Ilmoittaja")}</span>
            <input value={reporterName} onChange={event => setReporterName(event.target.value)} maxLength={200} placeholder={t("Esim. osakkaan nimi ja puhelinnumero")} />
          </label>
          <RenovationFields values={values} onChange={setValues} />
          {error && <p className="send-error">{error}</p>}
          <div className="draft-actions">
            <button type="submit" className="primary" disabled={saving || !companyId}>{saving ? t("Tallennetaan…") : t("Luo remontti-ilmoitus")}</button>
            <button type="button" onClick={onClose} disabled={saving}>{t("Peruuta")}</button>
          </div>
        </form>
      </aside>
    </div>
  );
}

const ALL_STATUSES: RenovationStatus[] = ["pending", "approved", "started", "completed", "inspected", "rejected"];

// Toimiston näkymä: remonttitehtävät. Rivi avaa tehtävän, jolla ilmoitus käsitellään.
export function RenovationNotices({ companies, defaultCompanyId = "", onChanged }: { companies: Company[]; defaultCompanyId?: string; onChanged?: () => void }) {
  const [notices, setNotices] = useState<RenovationNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [companyFilter, setCompanyFilter] = useState(companies.some(company => company.id === defaultCompanyId) ? defaultCompanyId : "all");
  // Oletuksena näytetään keskeneräiset: käsittelyä odottavat ja käynnissä olevat remontit.
  const [statusFilter, setStatusFilter] = useState("open");

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";

  async function loadNotices() {
    try {
      const lists = await Promise.all(companies.map(company =>
        api<RenovationNotice[]>(`/companies/${encodeURIComponent(company.id)}/renovations`)));
      setNotices(lists.flat().sort((a, b) =>
        Number(b.status === "pending") - Number(a.status === "pending") || b.created_at.localeCompare(a.created_at)));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadNotices();
  }, [companies.length]);

  const isOpen = (notice: RenovationNotice) => notice.status !== "rejected" && notice.status !== "inspected";
  const inCompany = notices.filter(notice => companyFilter === "all" || notice.company_id === companyFilter);
  const visible = inCompany.filter(notice => statusFilter === "all" || (statusFilter === "open" ? isOpen(notice) : notice.status === statusFilter));
  const paged = usePaged(visible, `${companyFilter}|${statusFilter}`);
  const showCompany = companies.length > 1;
  const pendingCount = inCompany.filter(notice => notice.status === "pending").length;
  const openCount = inCompany.filter(isOpen).length;

  function openNotice(notice: RenovationNotice) {
    if (notice.ticket_id) navigate("tickets", notice.ticket_id);
  }

  return (
    <section className="content">
      <a className="back-link" href="#/companies">{t("← Taloyhtiöt")}</a>

      <NoticeFilters
        companies={companies}
        company={companyFilter}
        onCompany={setCompanyFilter}
        status={statusFilter}
        onStatus={setStatusFilter}
        statuses={[{ value: "open", label: t("Keskeneräiset") }, ...ALL_STATUSES.map(value => ({ value, label: renovationStatusLabels[value] }))]}
      />

      <div className="residents-toolbar">
        <span>{openCount}{" "}{t("keskeneräistä remonttia ·")}{" "}{pendingCount}{" "}{t("odottaa käsittelyä")}</span>
        <button className="primary" onClick={() => setCreating(true)}>{t("Uusi remontti-ilmoitus")}</button>
      </div>

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <p className="send-error">{t("Remontti-ilmoitusten lataus epäonnistui.")}</p>
        : notices.length === 0 ? <div className="empty">{t("Ei remontti-ilmoituksia. Asukas tekee ilmoituksen asukasportaalissa, tai voit kirjata sen itse.")}</div>
        : visible.length === 0 ? <div className="empty">{t("Ei suodattimia vastaavia remontti-ilmoituksia.")}</div>
        : (
          <div className="table-card">
            <table className="data-table report-topics notice-table">
              <thead>
                <tr>
                  <th>{t("Tehtävä")}</th>
                  <th>{t("Ilmoittaja")}</th>
                  {showCompany && <th>{t("Taloyhtiö")}</th>}
                  <th>{t("Asunto")}</th>
                  <th>{t("Työ")}</th>
                  <th>{t("Ajankohta")}</th>
                  <th>{t("Tila")}</th>
                  <th>{t("Ilmoitettu")}</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(notice => (
                  <tr
                    key={notice.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title={t("Avaa remonttitehtävä")}
                    onClick={() => openNotice(notice)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openNotice(notice);
                      }
                    }}
                  >
                    <td>#{formatTicketNumber(notice.ticket_number)}</td>
                    <td>
                      <strong>{notice.resident_name || t("Ei ilmoittajaa")}</strong>
                      {notice.description && <span>{notice.description.length > 110 ? `${notice.description.slice(0, 110)}…` : notice.description}</span>}
                    </td>
                    {showCompany && <td>{companyName(notice.company_id)}</td>}
                    <td>{notice.apartment_number || "–"}</td>
                    <td>{notice.work_type ? <span className="type">{t(notice.work_type)}</span> : "–"}</td>
                    <td>
                      {renovationPeriod(notice) || "–"}
                      {isUnconfirmed(notice) && <span className="late-note">{t("Päättynyt, valmistumista ei ole kuitattu")}</span>}
                    </td>
                    <td>
                      <span className={`work-order-status ${noticeStatusClass(notice.status)}`}>{renovationStatusLabels[notice.status] ?? notice.status}</span>
                      {notice.assignee_name && <span>{notice.assignee_name}</span>}
                    </td>
                    <td>{formatDateOnly(notice.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {paged.pager}

      {creating && (
        <NewRenovationModal
          companies={companies}
          defaultCompanyId={companyFilter === "all" ? defaultCompanyId : companyFilter}
          onClose={() => setCreating(false)}
          onCreated={ticketId => {
            setCreating(false);
            onChanged?.();
            navigate("tickets", ticketId);
          }}
        />
      )}
    </section>
  );
}

