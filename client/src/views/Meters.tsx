import { type FormEvent, useEffect, useState } from "react";
import { Dropdown, usePaged } from "../components/common";
import { formatDay } from "../format";
import { api, errorMessage } from "../session";
import type { Company } from "../types";
import type { Apartment } from "./Keys";
import { locale, t } from "../i18n";

export type MeterReading = {
  id: string;
  company_id: string;
  apartment_id: string;
  meter_type: "cold_water" | "hot_water" | "electricity";
  reading_date: string;
  value: number;
  source: "portal" | "office";
  recorded_by: string;
  note: string;
  created_at: string;
  apartment_number?: string | null;
  address?: string | null;
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
  const [companyFilter, setCompanyFilter] = useState("all");
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

  useEffect(() => {
    if (!creating || !formCompany) return;
    api<Apartment[]>(`/companies/${encodeURIComponent(formCompany)}/apartments`).then(setApartments).catch(() => setApartments([]));
  }, [creating, formCompany]);

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
  const open = readings.find(reading => reading.id === openId) ?? null;
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
                  <th>{t("Kirjaaja")}</th>
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
                    onClick={() => { setOpenId(reading.id); setCreating(false); setError(""); }}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenId(reading.id);
                        setCreating(false);
                        setError("");
                      }
                    }}
                  >
                    <td><strong>{reading.apartment_number || "–"}</strong></td>
                    <td>{companyName(reading.company_id)}</td>
                    <td><span className="type">{meterLabel(reading.meter_type)}</span></td>
                    <td>{formatDay(reading.reading_date)}</td>
                    <td>{formatReading(reading.value, reading.meter_type)}</td>
                    <td>{consumption(reading)}</td>
                    <td>{reading.recorded_by}{reading.source === "portal" ? t(" · portaali") : ""}</td>
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
            <button type="button" className="drawer-back" onClick={() => setOpenId(null)} disabled={saving}>{t("← Takaisin")}</button>
            <button className="close" onClick={() => setOpenId(null)} disabled={saving}>×</button>
            <h2>{meterLabel(open.meter_type)} · {open.apartment_number || "–"}</h2>
            <p className="muted">{companyName(open.company_id)}{open.address ? ` · ${open.address}` : ""}</p>
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
                <dd>{open.recorded_by} · {open.source === "portal" ? t("asukasportaali") : t("toimisto")}</dd>
              </div>
              <div>
                <dt>{t("Lisätieto")}</dt>
                <dd>{open.note || "–"}</dd>
              </div>
            </dl>
            {error && <p className="send-error">{error}</p>}
            <div className="draft-actions">
              <button className="danger" onClick={() => void handleDelete(open)} disabled={saving}>{t("Poista lukema")}</button>
            </div>
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
