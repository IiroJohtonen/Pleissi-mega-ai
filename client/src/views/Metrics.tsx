import { useEffect, useState } from "react";
import { Dropdown } from "../components/common";
import { channelLabel, priorityLabel, statusLabel, ticketPriorities, ticketStatuses, ticketTypeOptions } from "../format";
import { locale, t } from "../i18n";
import { api, errorMessage, session } from "../session";
import type { Company, Ticket } from "../types";
import { Reports } from "./Reports";

// ---------------------------------------------------------------------------------------------
// Raporttien pääsivu: mittarit kaikista taloyhtiöistä, omat (tallennettavat) raportit ja
// yksittäisen taloyhtiön raportit. Luvut lasketaan palvelimella (POST /reports/query).
// ---------------------------------------------------------------------------------------------

type GroupBy = "company" | "type" | "status" | "priority" | "assignee" | "channel" | "month" | "week";
type Range = "7d" | "30d" | "90d" | "365d" | "month" | "lastMonth" | "year" | "custom";
type Metric = "total" | "open" | "closed" | "answered" | "overdue" | "avgFirstResponseHours" | "avgResolutionHours" | "share";

type ReportRow = {
  key: string; label: string; total: number; open: number; closed: number; answered: number; overdue: number;
  avgFirstResponseHours: number | null; avgResolutionHours: number | null;
};
type ReportResult = { rows: ReportRow[]; totals: Omit<ReportRow, "key" | "label">; companyCount: number };

export type ReportConfig = {
  range: Range; from?: string; to?: string; groupBy: GroupBy;
  companyIds: string[]; types: string[]; statuses: string[]; priorities: string[]; metrics: Metric[];
};
type SavedReport = { id: string; name: string; config: ReportConfig; createdBy: string; createdByName: string; updatedAt: string };

const metricLabels: Record<Metric, string> = {
  total: t("Saapuneet"),
  open: t("Kesken"),
  closed: t("Suljetut"),
  answered: t("Vastatut"),
  overdue: t("Myöhästyneet"),
  avgFirstResponseHours: t("Ensimmäinen vastaus"),
  avgResolutionHours: t("Ratkaisuaika"),
  share: t("Osuus")
};
const allMetrics = Object.keys(metricLabels) as Metric[];

const groupLabels: Record<GroupBy, string> = {
  company: t("Taloyhtiö"),
  type: t("Tyyppi"),
  status: t("Tila"),
  priority: t("Prioriteetti"),
  assignee: t("Käsittelijä"),
  channel: t("Kanava"),
  month: t("Kuukausi"),
  week: t("Viikko")
};

const rangeLabels: Record<Range, string> = {
  "7d": t("Viimeiset 7 päivää"),
  "30d": t("Viimeiset 30 päivää"),
  "90d": t("Viimeiset 90 päivää"),
  "365d": t("Viimeiset 12 kuukautta"),
  month: t("Tämä kuukausi"),
  lastMonth: t("Edellinen kuukausi"),
  year: t("Tämä vuosi"),
  custom: t("Oma aikaväli")
};

const day = (date: Date) => date.toLocaleDateString("sv-SE");

// Aikaväli päivinä (alku ja loppu mukaan lukien).
export function rangeDates(config: Pick<ReportConfig, "range" | "from" | "to">, now = new Date()): { from: string; to: string } {
  const back = (days: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() - days);
    return day(date);
  };
  switch (config.range) {
    case "7d": return { from: back(6), to: day(now) };
    case "30d": return { from: back(29), to: day(now) };
    case "90d": return { from: back(89), to: day(now) };
    case "365d": return { from: back(364), to: day(now) };
    case "month": return { from: day(new Date(now.getFullYear(), now.getMonth(), 1)), to: day(now) };
    case "lastMonth": return {
      from: day(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: day(new Date(now.getFullYear(), now.getMonth(), 0))
    };
    case "year": return { from: day(new Date(now.getFullYear(), 0, 1)), to: day(now) };
    case "custom": return { from: config.from || back(29), to: config.to || day(now) };
  }
}

// Tunnit luettavaksi: alle kahden vuorokauden tunteina, muuten päivinä.
export function formatDuration(hours: number | null) {
  if (hours === null) return "–";
  if (hours < 1) return t("{0} min", Math.max(1, Math.round(hours * 60)));
  if (hours < 48) return t("{0} h", hours.toLocaleString(locale, { maximumFractionDigits: 1 }));
  return t("{0} pv", (hours / 24).toLocaleString(locale, { maximumFractionDigits: 1 }));
}

function rowLabel(groupBy: GroupBy, row: ReportRow) {
  switch (groupBy) {
    case "status": return statusLabel(row.key);
    case "priority": return priorityLabel(row.key);
    case "type": return t(row.key);
    case "channel": return channelLabel(row.key);
    case "assignee": return row.label || t("Ei käsittelijää");
    case "month": {
      const [year, month] = row.key.split("-").map(Number);
      return new Date(year, month - 1, 1).toLocaleDateString(locale, { month: "long", year: "numeric" });
    }
    default: return row.label;
  }
}

function metricValue(metric: Metric, row: Omit<ReportRow, "key" | "label">, total: number): string {
  if (metric === "avgFirstResponseHours" || metric === "avgResolutionHours") return formatDuration(row[metric]);
  if (metric === "share") return total ? `${Math.round((row.total / total) * 100)} %` : "–";
  return String(row[metric]);
}

// Lataa raportin taulukon CSV-tiedostona (puolipiste-erotin ja BOM, jotta Excel avaa sen oikein).
function downloadReportCsv(fileName: string, groupBy: GroupBy, metrics: Metric[], result: ReportResult) {
  const lines = [
    [groupLabels[groupBy], ...metrics.map(metric => metricLabels[metric])],
    ...result.rows.map(row => [rowLabel(groupBy, row), ...metrics.map(metric => metricValue(metric, row, result.totals.total))]),
    [t("Yhteensä"), ...metrics.map(metric => metricValue(metric, result.totals, result.totals.total))]
  ];
  const csv = lines.map(cells => cells.map(cell => `"${cell.replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileName.replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-|-$/g, "") || "raportti"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function useReport(config: ReportConfig | null) {
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const body = config ? JSON.stringify({
    ...rangeDates(config),
    groupBy: config.groupBy,
    companyIds: config.companyIds,
    types: config.types,
    statuses: config.statuses,
    priorities: config.priorities
  }) : "";

  useEffect(() => {
    if (!body) return;
    let current = true;
    setLoading(true);
    setError("");
    api<ReportResult>("/reports/query", { method: "POST", body })
      .then(found => current && setResult(found))
      .catch(queryError => current && setError(errorMessage(queryError, t("Raportin lataus epäonnistui."))))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [body]);

  return { result, error, loading };
}

function ReportTable({ groupBy, metrics, result }: { groupBy: GroupBy; metrics: Metric[]; result: ReportResult }) {
  if (result.rows.length === 0) return <p className="muted">{t("Valitulla aikavälillä ja rajauksilla ei ole tehtäviä.")}</p>;
  return (
    <div className="table-card">
      <table className="data-table metrics-table">
        <thead>
          <tr>
            <th>{groupLabels[groupBy]}</th>
            {metrics.map(metric => <th key={metric} className="num">{metricLabels[metric]}</th>)}
          </tr>
        </thead>
        <tbody>
          {result.rows.map(row => (
            <tr key={row.key}>
              <td><strong>{rowLabel(groupBy, row)}</strong></td>
              {metrics.map(metric => (
                <td key={metric} className={`num${metric === "overdue" && row.overdue > 0 ? " metric-alert" : ""}`}>
                  {metricValue(metric, row, result.totals.total)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {result.rows.length > 1 && (
          <tfoot>
            <tr>
              <td>{t("Yhteensä")}</td>
              {metrics.map(metric => <td key={metric} className="num">{metricValue(metric, result.totals, result.totals.total)}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function ReportActions({ fileName, groupBy, metrics, result }: { fileName: string; groupBy: GroupBy; metrics: Metric[]; result: ReportResult | null }) {
  return (
    <div className="metrics-actions no-print">
      <button type="button" className="secondary" disabled={!result?.rows.length} onClick={() => result && downloadReportCsv(fileName, groupBy, metrics, result)}>
        {t("Lataa CSV")}
      </button>
      <button type="button" className="secondary" disabled={!result?.rows.length} onClick={() => window.print()}>{t("Tulosta")}</button>
    </div>
  );
}

const overviewMetrics: Metric[] = ["total", "open", "closed", "overdue", "avgFirstResponseHours", "avgResolutionHours"];

// Mittarit: tehtävien määrä taloyhtiöittäin, vastausajat ja myöhästyneet kaikista yhtiöistä.
function MetricsOverview() {
  const [range, setRange] = useState<Range>("30d");
  const config: ReportConfig = {
    range, groupBy: "company", companyIds: [], types: [], statuses: [], priorities: [], metrics: overviewMetrics
  };
  const { result, error, loading } = useReport(config);
  const dates = rangeDates(config);

  return (
    <div className="metrics">
      <div className="ticket-filters metrics-filters no-print">
        <Dropdown
          label={t("Aikaväli")}
          value={range}
          options={(["7d", "30d", "90d", "365d", "month", "lastMonth", "year"] as Range[]).map(value => ({ value, label: rangeLabels[value] }))}
          onChange={value => setRange(value as Range)}
        />
        <ReportActions fileName={`mittarit-${dates.from}-${dates.to}`} groupBy="company" metrics={overviewMetrics} result={result} />
      </div>
      <h2 className="print-only">{t("Mittarit")} {formatRange(dates)}</h2>
      {error && <p className="send-error">{error}</p>}
      {result && (
        <>
          <div className="queue-summary metrics-summary">
            <div>
              <span>{t("Saapuneet tehtävät")}</span>
              <strong>{result.totals.total}</strong>
              <small>{rangeLabels[range].toLocaleLowerCase(locale)}</small>
            </div>
            <div>
              <span>{t("Ensimmäinen vastaus")}</span>
              <strong>{formatDuration(result.totals.avgFirstResponseHours)}</strong>
              <small>{t("keskimäärin, {0} vastattua", result.totals.answered)}</small>
            </div>
            <div>
              <span>{t("Ratkaisuaika")}</span>
              <strong>{formatDuration(result.totals.avgResolutionHours)}</strong>
              <small>{t("keskimäärin, {0} suljettua", result.totals.closed)}</small>
            </div>
            <div className={result.totals.overdue > 0 ? "summary-alert" : ""}>
              <span>{t("Myöhästyneet")}</span>
              <strong>{result.totals.overdue}</strong>
              <small>{t("määräaika ylittynyt")}</small>
            </div>
          </div>
          <div className="report-card">
            <h2>{t("Tehtävät taloyhtiöittäin")}</h2>
            <p className="muted">
              {t("Aikavälillä {0} saapuneet tehtävät. Kesken = tehtävä on yhä auki. Myöhästynyt = määräaika on mennyt tai tehtävä suljettiin määräajan jälkeen.", formatRange(dates))}
            </p>
            <ReportTable groupBy="company" metrics={overviewMetrics} result={result} />
          </div>
        </>
      )}
      {loading && !result && <div className="empty">{t("Ladataan…")}</div>}
    </div>
  );
}

function formatRange({ from, to }: { from: string; to: string }) {
  const format = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString(locale);
  return `${format(from)}–${format(to)}`;
}

const emptyConfig: ReportConfig = {
  range: "30d", groupBy: "company", companyIds: [], types: [], statuses: [], priorities: [],
  metrics: ["total", "open", "overdue", "avgFirstResponseHours"]
};

// Valintanapit monivalintaan: tyhjä valinta = kaikki.
function ChipSelect({ label, options, value, onChange }: {
  label: string; options: { value: string; label: string }[]; value: string[]; onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="chip-select">
      <legend>{label}</legend>
      <div>
        <button type="button" className={value.length === 0 ? "active" : ""} onClick={() => onChange([])}>{t("Kaikki")}</button>
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value.includes(option.value)}
            className={value.includes(option.value) ? "active" : ""}
            onClick={() => onChange(value.includes(option.value) ? value.filter(item => item !== option.value) : [...value, option.value])}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

// Omat raportit: käyttäjä valitsee aikavälin, ryhmittelyn, rajaukset ja sarakkeet, ja voi tallentaa
// raportin koko toimiston käyttöön.
function CustomReports({ companies }: { companies: Company[] }) {
  const [saved, setSaved] = useState<SavedReport[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<ReportConfig>(emptyConfig);
  const [shown, setShown] = useState<ReportConfig | null>(null);
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const { result, error, loading } = useReport(shown);

  useEffect(() => {
    api<SavedReport[]>("/reports/saved").then(setSaved).catch(() => undefined);
  }, []);

  const selected = saved.find(report => report.id === selectedId) ?? null;
  const canEdit = !selected || selected.createdBy === session?.user.id || session?.user.role === "Pääkäyttäjä";
  const update = (patch: Partial<ReportConfig>) => setConfig(current => ({ ...current, ...patch }));

  function open(report: SavedReport | null) {
    setSelectedId(report?.id ?? "");
    setName(report?.name ?? "");
    const next = report ? { ...emptyConfig, ...report.config } : emptyConfig;
    setConfig(next);
    setShown(report ? next : null);
    setNotice("");
    setSaveError("");
  }

  async function save(asNew: boolean) {
    setSaving(true);
    setSaveError("");
    try {
      const body = JSON.stringify({ name: name.trim(), config });
      const report = selected && !asNew
        ? await api<SavedReport>(`/reports/saved/${encodeURIComponent(selected.id)}`, { method: "PUT", body })
        : await api<SavedReport>("/reports/saved", { method: "POST", body });
      setSaved(current => [...current.filter(item => item.id !== report.id), report].sort((a, b) => a.name.localeCompare(b.name, locale)));
      setSelectedId(report.id);
      setShown(config);
      setNotice(t("Raportti tallennettu."));
    } catch (error) {
      setSaveError(errorMessage(error, t("Raportin tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selected || !window.confirm(t("Poistetaanko raportti ”{0}”?", selected.name))) return;
    try {
      await api(`/reports/saved/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      setSaved(current => current.filter(item => item.id !== selected.id));
      open(null);
    } catch (error) {
      setSaveError(errorMessage(error, t("Raportin poisto epäonnistui.")));
    }
  }

  const dates = rangeDates(config);
  const shownMetrics = (shown ?? config).metrics.filter(metric => allMetrics.includes(metric));

  return (
    <div className="custom-reports">
      <aside className="saved-reports no-print">
        <button type="button" className={`saved-report-new${selectedId ? "" : " active"}`} onClick={() => open(null)}>+ {t("Uusi raportti")}</button>
        {saved.length === 0 && <p className="muted">{t("Tallennetut raportit näkyvät tässä koko toimistolle.")}</p>}
        {saved.map(report => (
          <button key={report.id} type="button" className={report.id === selectedId ? "active" : ""} onClick={() => open(report)}>
            <strong>{report.name}</strong>
            <small>{report.createdByName}</small>
          </button>
        ))}
      </aside>

      <div className="custom-report-main">
        <form
          className="report-card report-builder ticket-form no-print"
          onSubmit={event => {
            event.preventDefault();
            setShown({ ...config });
          }}
        >
          <label className="report-name">
            <span>{t("Raportin nimi")}</span>
            <input value={name} onChange={event => setName(event.target.value)} placeholder={t("esim. Hallituksen kokous, vikailmoitukset")} maxLength={120} disabled={!canEdit} />
          </label>

          <div className="report-builder-row">
            <Dropdown
              label={t("Aikaväli")}
              value={config.range}
              options={(Object.keys(rangeLabels) as Range[]).map(value => ({ value, label: rangeLabels[value] }))}
              onChange={value => update({ range: value as Range, ...(value === "custom" ? rangeDates(config) : {}) })}
            />
            {config.range === "custom" && (
              <>
                <label className="report-date">
                  <span>{t("Alkaen")}</span>
                  <input type="date" value={dates.from} max={dates.to} onChange={event => update({ from: event.target.value })} />
                </label>
                <label className="report-date">
                  <span>{t("Päättyen")}</span>
                  <input type="date" value={dates.to} min={dates.from} onChange={event => update({ to: event.target.value })} />
                </label>
              </>
            )}
            <Dropdown
              label={t("Ryhmittele")}
              value={config.groupBy}
              options={(Object.keys(groupLabels) as GroupBy[]).map(value => ({ value, label: groupLabels[value] }))}
              onChange={value => update({ groupBy: value as GroupBy })}
            />
          </div>

          <ChipSelect
            label={t("Taloyhtiöt")}
            options={companies.map(company => ({ value: company.id, label: company.name }))}
            value={config.companyIds}
            onChange={companyIds => update({ companyIds })}
          />
          <ChipSelect
            label={t("Tyypit")}
            options={ticketTypeOptions.map(type => ({ value: type, label: t(type) }))}
            value={config.types}
            onChange={types => update({ types })}
          />
          <ChipSelect
            label={t("Tilat")}
            options={ticketStatuses.map(status => ({ value: status, label: statusLabel(status) }))}
            value={config.statuses}
            onChange={statuses => update({ statuses })}
          />
          <ChipSelect
            label={t("Prioriteetit")}
            options={ticketPriorities.map(priority => ({ value: priority, label: priorityLabel(priority) }))}
            value={config.priorities}
            onChange={priorities => update({ priorities })}
          />

          <fieldset className="chip-select">
            <legend>{t("Sarakkeet")}</legend>
            <div>
              {allMetrics.map(metric => (
                <button
                  key={metric}
                  type="button"
                  aria-pressed={config.metrics.includes(metric)}
                  className={config.metrics.includes(metric) ? "active" : ""}
                  onClick={() => update({
                    metrics: config.metrics.includes(metric)
                      ? config.metrics.filter(item => item !== metric)
                      : allMetrics.filter(item => item === metric || config.metrics.includes(item))
                  })}
                >
                  {metricLabels[metric]}
                </button>
              ))}
            </div>
          </fieldset>

          {saveError && <p className="send-error">{saveError}</p>}
          {notice && <p className="ai-reason created">{notice}</p>}
          <div className="report-builder-actions">
            <button type="submit" className="primary" disabled={config.metrics.length === 0}>{t("Näytä raportti")}</button>
            {canEdit && (
              <button type="button" className="secondary" disabled={saving || !name.trim() || config.metrics.length === 0} onClick={() => void save(false)}>
                {selected ? t("Tallenna muutokset") : t("Tallenna raportti")}
              </button>
            )}
            {selected && (
              <button type="button" className="secondary" disabled={saving || !name.trim()} onClick={() => void save(true)}>{t("Tallenna kopiona")}</button>
            )}
            {selected && canEdit && <button type="button" className="danger-link" onClick={() => void remove()}>{t("Poista raportti")}</button>}
          </div>
          {!canEdit && <p className="reply-hint">{t("Raportin on tehnyt {0}. Voit muuttaa valintoja ja tallentaa kopion omaksi raportiksesi.", selected?.createdByName ?? "")}</p>}
        </form>

        {shown && (
          <div className="report-card">
            <div className="suggest-header report-ai-head">
              <h2>{name.trim() || t("Raportti")}</h2>
              <ReportActions fileName={name.trim() || "raportti"} groupBy={shown.groupBy} metrics={shownMetrics} result={result} />
            </div>
            <p className="muted">
              {formatRange(rangeDates(shown))} · {t("ryhmitelty: {0}", groupLabels[shown.groupBy].toLocaleLowerCase(locale))}
              {shown.companyIds.length > 0 && ` · ${shown.companyIds.map(companyId => companies.find(company => company.id === companyId)?.name ?? "").filter(Boolean).join(", ")}`}
            </p>
            {error && <p className="send-error">{error}</p>}
            {loading && !result && <div className="empty">{t("Ladataan…")}</div>}
            {result && <ReportTable groupBy={shown.groupBy} metrics={shownMetrics} result={result} />}
          </div>
        )}
      </div>
    </div>
  );
}

export type ReportsTab = "metrics" | "custom" | "company";

export function ReportsHub({
  tab,
  tickets,
  loading,
  companyId,
  companies,
  onCompanyChange
}: {
  // Alasivu valitaan sivupalkista (#/reports/<alasivu>).
  tab: ReportsTab;
  tickets: Ticket[];
  loading: boolean;
  companyId: string;
  companies: Company[];
  onCompanyChange: (companyId: string) => void;
}) {
  return (
    <section className="content reports-hub">
      {tab === "metrics" && <MetricsOverview />}
      {tab === "custom" && <CustomReports companies={companies} />}
      {tab === "company" && (
        <Reports tickets={tickets} loading={loading} companyId={companyId} companies={companies} onCompanyChange={onCompanyChange} />
      )}
    </section>
  );
}
