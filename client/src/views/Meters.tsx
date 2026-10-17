import { type FormEvent, useEffect, useState } from "react";
import { Dropdown, usePaged } from "../components/common";
import { type DetailField, DetailEditor, DetailFacts, detailValue, detailValues, sourceLabel } from "../components/FormDetails";
import { ReporterCell, ReporterField } from "../components/Reporter";
import { formatDay } from "../format";
import { api, errorMessage } from "../session";
import type { Company } from "../types";
import type { Apartment } from "./Keys";
import { locale, t } from "../i18n";

export type MeterReading = {
  id: string;
  company_id: string;
  apartment_id: string | null;
  meter_type: "cold_water" | "hot_water" | "electricity";
  reading_date: string;
  value: number;
  source: "portal" | "office" | "email";
  // Verkkosivun lomakkeen ilmoittajan tiedot (nimi, puhelin, sähköposti, osoite, huoneisto).
  details?: DetailField[];
  recorded_by: string;
  note: string;
  created_at: string;
  apartment_number?: string | null;
  address?: string | null;
  resident_id?: string | null;
  resident_name?: string | null;
  resident_email?: string | null;
  // Saman asunnon ja mittarin edellinen lukema; puuttuu ensimmäiseltä lukemalta.
  previous_value?: number | null;
  previous_date?: string | null;
};

export const METER_TYPES: MeterReading["meter_type"][] = ["cold_water", "hot_water", "electricity"];

export function meterLabel(type: string) {
  return { cold_water: t("Kylmä vesi"), hot_water: t("Lämmin vesi"), electricity: t("Sähkö") }[type] || type;
}

export function meterUnit(type: string) {
  return type === "electricity" ? "kWh" : "m³";
}

export function formatReading(value: number, type: string) {
  return `${value.toLocaleString(locale, { maximumFractionDigits: 3 })} ${meterUnit(type)}`;
}

// Lukemakenttä hyväksyy sekä pilkun että pisteen desimaalierottimena.
export function parseReading(text: string): number | null {
  const value = Number(text.trim().replace(/\s/g, "").replace(",", "."));
  return text.trim() && Number.isFinite(value) && value >= 0 ? value : null;
}

const todayText = () => new Date().toLocaleDateString("sv-SE");

// Toimiston näkymä: asuntojen kulutuslukemat ja niistä laskettu kulutus.
export function MeterReadings({ companies, defaultCompanyId }: { companies: Company[]; defaultCompanyId: string }) {
  const [readings, setReadings] = useState<MeterReading[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [companyFilter, setCompanyFilter] = useState(companies.some(company => company.id === defaultCompanyId) ? defaultCompanyId : "all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [formCompany, setFormCompany] = useState(defaultCompanyId);
  const [apartments, setApartments] = useState<Apartment[]>([]);
  const [apartmentId, setApartmentId] = useState("");
  const [meterType, setMeterType] = useState<string>(METER_TYPES[0]);
  const [valueText, setValueText] = useState("");
  const [readingDate, setReadingDate] = useState(todayText);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Avatun lukeman muokkaus.
  const [editing, setEditing] = useState<{
    apartmentId: string; meterType: string; valueText: string; readingDate: string; note: string; details: Record<string, string>;
  } | null>(null);

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";

  async function loadReadings() {
    try {
      const lists = await Promise.all(companies.map(company =>
        api<MeterReading[]>(`/companies/${encodeURIComponent(company.id)}/meter-readings`)));
      setReadings(lists.flat().sort((a, b) => b.reading_date.localeCompare(a.reading_date) || b.created_at.localeCompare(a.created_at)));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadReadings();
  }, [companies.length]);

  const open = readings.find(reading => reading.id === openId) ?? null;
  // Asunnot uudelle lukemalle tai muokattavan lukeman taloyhtiöstä.
  const apartmentCompany = creating ? formCompany : editing && open ? open.company_id : "";
  useEffect(() => {
    if (!apartmentCompany) return;
    api<Apartment[]>(`/companies/${encodeURIComponent(apartmentCompany)}/apartments`).then(setApartments).catch(() => setApartments([]));
  }, [apartmentCompany]);

  function startEdit(reading: MeterReading) {
    setError("");
    setEditing({
      apartmentId: reading.apartment_id ?? "", meterType: reading.meter_type, valueText: String(reading.value).replace(".", ","),
      readingDate: reading.reading_date, note: reading.note, details: detailValues(reading.details)
    });
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!open || !editing) return;
    const value = parseReading(editing.valueText);
    if (value === null) {
      setError(t("Anna lukema numerona."));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api(`/meter-readings/${encodeURIComponent(open.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          apartmentId: editing.apartmentId || null, meterType: editing.meterType, value, readingDate: editing.readingDate,
          note: editing.note.trim(), details: editing.details
        })
      });
      setEditing(null);
      await loadReadings();
    } catch (saveError) {
      setError(errorMessage(saveError, t("Lukeman tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  function openCreate() {
    setCreating(true);
    setOpenId(null);
    setFormCompany(companyFilter !== "all" ? companyFilter : defaultCompanyId);
    setApartmentId("");
    setMeterType(typeFilter !== "all" ? typeFilter : METER_TYPES[0]);
    setValueText("");
    setReadingDate(todayText());
    setNote("");
    setError("");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const value = parseReading(valueText);
    if (value === null || !apartmentId) {
      setError(t("Valitse asunto ja anna lukema numerona."));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api(`/companies/${encodeURIComponent(formCompany)}/meter-readings`, {
        method: "POST",
        body: JSON.stringify({ apartmentId, meterType, value, readingDate, note: note.trim() })
      });
      setCreating(false);
      await loadReadings();
    } catch (saveError) {
      setError(errorMessage(saveError, t("Lukeman tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(reading: MeterReading) {
    if (!window.confirm(t("Poistetaanko lukema?"))) return;
    setSaving(true);
    setError("");
    try {
      await api(`/meter-readings/${encodeURIComponent(reading.id)}`, { method: "DELETE" });
      setOpenId(null);
      await loadReadings();
    } catch (deleteError) {
      setError(errorMessage(deleteError, t("Lukeman poistaminen epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  const visible = readings.filter(reading => (companyFilter === "all" || reading.company_id === companyFilter)
    && (typeFilter === "all" || reading.meter_type === typeFilter));
  const paged = usePaged(visible, `${companyFilter}|${typeFilter}`);
  const consumption = (reading: MeterReading) => reading.previous_value == null
    ? "–"
    : formatReading(Math.round((reading.value - reading.previous_value) * 1000) / 1000, reading.meter_type);

  function downloadCsv() {
    const lines = [
      [t("Taloyhtiö"), t("Asunto"), t("Osoite"), t("Mittari"), t("Lukupäivä"), t("Lukema"), t("Yksikkö"), t("Edellinen lukema"), t("Kulutus"), t("Kirjaaja"), t("Lisätieto")],
      ...visible.map(reading => [
        companyName(reading.company_id),
        reading.apartment_number ?? "",
        reading.address ?? "",
        meterLabel(reading.meter_type),
        formatDay(reading.reading_date),
        String(reading.value).replace(".", ","),
        meterUnit(reading.meter_type),
        reading.previous_value == null ? "" : String(reading.previous_value).replace(".", ","),
        reading.previous_value == null ? "" : String(Math.round((reading.value - reading.previous_value) * 1000) / 1000).replace(".", ","),
        reading.recorded_by,
        reading.note
      ])
    ];
    const csv = lines.map(cells => cells.map(cell => `"${cell.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    // BOM, jotta Excel avaa ääkköset oikein.
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `kulutuslukemat-${todayText()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="content">
      <a className="back-link" href="#/companies">{t("← Taloyhtiöt")}</a>

      <div className="ticket-filters">
        <Dropdown
          label={t("Taloyhtiö")}
          value={companyFilter}
          options={[{ value: "all", label: t("Kaikki") }, ...companies.map(company => ({ value: company.id, label: company.name }))]}
          onChange={setCompanyFilter}
        />
        <Dropdown
          label={t("Mittari")}
          value={typeFilter}
          options={[{ value: "all", label: t("Kaikki") }, ...METER_TYPES.map(option => ({ value: option, label: meterLabel(option) }))]}
          onChange={setTypeFilter}
        />
      </div>

      <div className="residents-toolbar">
        <span>{visible.length}{" "}{t("lukemaa")}</span>
        <div className="draft-actions">
          <button onClick={downloadCsv} disabled={visible.length === 0}>{t("Lataa CSV")}</button>
          <button className="secondary" onClick={openCreate}>{t("Lisää lukema")}</button>
        </div>
      </div>

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <div className="empty">{t("Lukemien lataus epäonnistui.")}</div>
        : visible.length === 0 ? <div className="empty">{readings.length === 0 ? t("Ei lukemia. Asukas ilmoittaa lukeman asukasportaalissa tai toimisto kirjaa sen tässä.") : t("Ei suodattimia vastaavia lukemia.")}</div>
        : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("Asunto")}</th>
                  <th>{t("Taloyhtiö")}</th>
                  <th>{t("Mittari")}</th>
                  <th>{t("Lukupäivä")}</th>
                  <th>{t("Lukema")}</th>
                  <th>{t("Kulutus edellisestä")}</th>
                  <th>{t("Ilmoittaja")}</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(reading => (
                  <tr
                    key={reading.id}
                    className="clickable"
                    title={t("Avaa lukema")}
                    role="button"
                    tabIndex={0}
                    onClick={() => { setOpenId(reading.id); setCreating(false); setEditing(null); setError(""); }}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenId(reading.id);
                        setCreating(false);
                        setEditing(null);
                        setError("");
                      }
                    }}
                  >
                    <td>
                      <strong>{reading.apartment_number || "–"}</strong>
                      {!reading.apartment_id && <span className="late-note">{t("Valitse asunto")}</span>}
                    </td>
                    <td>{companyName(reading.company_id)}</td>
                    <td><span className="type">{meterLabel(reading.meter_type)}</span></td>
                    <td>{formatDay(reading.reading_date)}</td>
                    <td>{formatReading(reading.value, reading.meter_type)}</td>
                    <td>{consumption(reading)}</td>
                    <td>
                      <ReporterCell
                        name={reading.resident_name || detailValue(reading.details, "name") || reading.recorded_by}
                        email={reading.resident_email || detailValue(reading.details, "email")}
                      />
                      <span>{sourceLabel(reading.source)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {!loading && !loadError && paged.pager}

      {open && (
        <div className="overlay">
          <aside className="drawer form-drawer">
            <button type="button" className="drawer-back" onClick={() => { setOpenId(null); setEditing(null); }} disabled={saving}>{t("← Takaisin")}</button>
            <button className="close" onClick={() => { setOpenId(null); setEditing(null); }} disabled={saving}>×</button>
            <h2>{meterLabel(open.meter_type)} · {open.apartment_number || "–"}</h2>
            <p className="muted">{companyName(open.company_id)}{open.address ? ` · ${open.address}` : ""}</p>
            <ReporterField
              companyId={open.company_id}
              reporter={{
                id: open.resident_id, name: open.resident_name, email: open.resident_email,
                apartment_number: open.resident_id ? open.apartment_number : null, address: open.resident_id ? open.address : null
              }}
              fallbackName={open.recorded_by}
              onChange={async residentId => {
                await api(`/meter-readings/${encodeURIComponent(open.id)}/reporter`, { method: "PUT", body: JSON.stringify({ residentId }) });
                await loadReadings();
              }}
            />
            <dl className="ticket-facts">
              <div>
                <dt>{t("Lukema")}</dt>
                <dd>{formatReading(open.value, open.meter_type)}</dd>
              </div>
              <div>
                <dt>{t("Lukupäivä")}</dt>
                <dd>{formatDay(open.reading_date)}</dd>
              </div>
              <div>
                <dt>{t("Edellinen lukema")}</dt>
                <dd>{open.previous_value == null ? "–" : `${formatReading(open.previous_value, open.meter_type)} · ${formatDay(open.previous_date)}`}</dd>
              </div>
              <div>
                <dt>{t("Kulutus edellisestä")}</dt>
                <dd>{consumption(open)}</dd>
              </div>
              <div>
                <dt>{t("Kirjaaja")}</dt>
                <dd>{open.recorded_by} · {sourceLabel(open.source)}</dd>
              </div>
              <div>
                <dt>{t("Lisätieto")}</dt>
                <dd>{open.note || "–"}</dd>
              </div>
            </dl>
            <DetailFacts title={t("Ilmoittajan tiedot lomakkeelta")} fields={open.details} />
            {editing && (
              <form className="ticket-form record-edit" onSubmit={saveEdit}>
                <h3>{t("Muokkaa lukemaa")}</h3>
                <Dropdown
                  label={t("Asunto")}
                  value={editing.apartmentId}
                  options={[
                    { value: "", label: t("Ei valittu") },
                    ...apartments.map(apartment => ({ value: apartment.id, label: `${apartment.apartment_number} · ${apartment.address}` }))
                  ]}
                  onChange={apartmentId => setEditing({ ...editing, apartmentId })}
                />
                <Dropdown
                  label={t("Mittari")}
                  value={editing.meterType}
                  options={METER_TYPES.map(option => ({ value: option, label: meterLabel(option) }))}
                  onChange={meterType => setEditing({ ...editing, meterType })}
                />
                <label>
                  <span>{t("Lukema (")}{meterUnit(editing.meterType)})</span>
                  <input value={editing.valueText} onChange={event => setEditing({ ...editing, valueText: event.target.value })} inputMode="decimal" />
                </label>
                <label>
                  <span>{t("Lukupäivä")}</span>
                  <input type="date" value={editing.readingDate} max={todayText()} onChange={event => setEditing({ ...editing, readingDate: event.target.value })} required />
                </label>
                <label>
                  <span>{t("Lisätieto")}</span>
                  <input value={editing.note} onChange={event => setEditing({ ...editing, note: event.target.value })} maxLength={300} />
                </label>
                <DetailEditor
                  title={t("Ilmoittajan tiedot lomakkeelta")}
                  fields={open.details ?? []}
                  values={editing.details}
                  onChange={details => setEditing({ ...editing, details })}
                />
                {error && <p className="send-error">{error}</p>}
                <div className="drawer-actions compact-actions">
                  <button type="button" onClick={() => setEditing(null)} disabled={saving}>{t("Peruuta")}</button>
                  <button className="primary" type="submit" disabled={saving}>{saving ? t("Tallennetaan…") : t("Tallenna")}</button>
                </div>
              </form>
            )}
            {!editing && error && <p className="send-error">{error}</p>}
            {!editing && (
              <div className="draft-actions">
                <button className="secondary" onClick={() => startEdit(open)} disabled={saving}>{t("Muokkaa")}</button>
                <button className="danger" onClick={() => void handleDelete(open)} disabled={saving}>{t("Poista lukema")}</button>
              </div>
            )}
          </aside>
        </div>
      )}

      {creating && (
        <div className="overlay">
          <aside className="drawer form-drawer resident-drawer">
            <button type="button" className="drawer-back" onClick={() => setCreating(false)} disabled={saving}>{t("← Takaisin")}</button>
            <button className="close" onClick={() => setCreating(false)} disabled={saving}>×</button>
            <h2>{t("Lisää lukema")}</h2>
            <p className="muted">{t("Kirjaa mittarin lukema asunnolle. Kulutus lasketaan edellisestä lukemasta.")}</p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              <Dropdown
                label={t("Taloyhtiö")}
                value={formCompany}
                options={companies.map(company => ({ value: company.id, label: company.name }))}
                onChange={value => { setFormCompany(value); setApartmentId(""); }}
              />
              <Dropdown
                label={t("Asunto")}
                value={apartmentId}
                options={[
                  { value: "", label: t("Valitse asunto") },
                  ...apartments.map(apartment => ({ value: apartment.id, label: `${apartment.apartment_number} · ${apartment.address}` }))
                ]}
                onChange={setApartmentId}
              />
              <Dropdown
                label={t("Mittari")}
                value={meterType}
                options={METER_TYPES.map(option => ({ value: option, label: meterLabel(option) }))}
                onChange={setMeterType}
              />
              <label>
                <span>{t("Lukema (")}{meterUnit(meterType)})</span>
                <input value={valueText} onChange={event => setValueText(event.target.value)} inputMode="decimal" placeholder={t("Esim. 123,45")} />
              </label>
              <label>
                <span>{t("Lukupäivä")}</span>
                <input type="date" value={readingDate} max={todayText()} onChange={event => setReadingDate(event.target.value)} required />
              </label>
              <label>
                <span>{t("Lisätieto")}</span>
                <input value={note} onChange={event => setNote(event.target.value)} maxLength={300} placeholder={t("Valinnainen, esim. mittari vaihdettu")} />
              </label>

              {error && <p className="send-error">{error}</p>}

              <div className="drawer-actions compact-actions">
                <button type="button" onClick={() => setCreating(false)}>{t("Peruuta")}</button>
                <button className="primary" type="submit" disabled={saving || !apartmentId || !valueText.trim()}>
                  {saving ? t("Tallennetaan…") : t("Lisää lukema")}
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </section>
  );
}
