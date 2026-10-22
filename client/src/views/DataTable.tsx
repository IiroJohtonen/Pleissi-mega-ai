import { useEffect, useMemo, useState } from "react";
import { usePaged } from "../components/common";
import { dataCellText, dataColumns, type DataColumn, type DataRow } from "../data-tables";
import { t } from "../i18n";
import { api } from "../session";
import type { TicketTab } from "../types";

type Sort = { key: string; descending: boolean };

const companyColumn: DataColumn = { key: "company_name", label: t("Taloyhtiö") };

// Data-osion taulu: taloyhtiön alasivun jokainen tietue kaikista taloyhtiöistä ilman suodatusta.
// Haku rajaa näkyviä rivejä, ja sarakkeen otsikko järjestää taulun.
export function DataTable({ table, onOpenCompany }: { table: TicketTab; onOpenCompany: (companyId: string) => void }) {
  const [rows, setRows] = useState<DataRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort | null>(null);
  const columns = [companyColumn, ...(dataColumns[table] ?? [])];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    api<DataRow[]>(`/data/${encodeURIComponent(table)}`)
      .then(data => { if (!cancelled) setRows(data); })
      .catch(() => { if (!cancelled) setLoadError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [table]);

  const searchText = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const matching = searchText
      ? rows.filter(row => columns.some(column => dataCellText(column, row).toLowerCase().includes(searchText)))
      : rows;
    if (!sort) return matching;
    const column = columns.find(item => item.key === sort.key);
    if (!column) return matching;
    // Numerot ja päivät järjestetään raaka-arvosta, muut näkyvästä tekstistä.
    const value = (row: DataRow) => typeof row[sort.key] === "number" || /_at$|_date$|^starts_at$|^ends_at$/.test(sort.key)
      ? String(row[sort.key] ?? "")
      : dataCellText(column, row);
    return [...matching].sort((a, b) => {
      const order = value(a).localeCompare(value(b), undefined, { numeric: true, sensitivity: "base" });
      return sort.descending ? -order : order;
    });
  }, [rows, searchText, sort, table]);
  const paged = usePaged(visible, `${table}|${searchText}|${sort?.key}|${sort?.descending}`);
  const companyCount = new Set(rows.map(row => row.company_id)).size;

  return (
    <section className="content data-view">
      <div className="residents-toolbar">
        <span>{t("{0} riviä · {1} taloyhtiötä", rows.length, companyCount)}</span>
        <div className="toolbar-actions">
          <input
            className="toolbar-search"
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={t("Hae taulusta")}
            aria-label={t("Hae taulusta")}
          />
        </div>
      </div>

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <div className="empty">{t("Taulun lataus epäonnistui.")}</div>
        : visible.length === 0 ? <div className="empty">{rows.length ? t("Ei hakua vastaavia rivejä.") : t("Taulussa ei ole rivejä.")}</div>
        : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  {columns.map(column => {
                    const active = sort?.key === column.key;
                    return (
                      <th key={column.key} aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}>
                        <button
                          type="button"
                          className={`data-sort ${active ? "active" : ""}`}
                          onClick={() => setSort(current => current?.key === column.key
                            ? { key: column.key, descending: !current.descending }
                            : { key: column.key, descending: false })}
                          title={t("Järjestä sarakkeen {0} mukaan", column.label)}
                        >
                          {column.label}
                          {active && <span aria-hidden="true">{sort.descending ? " ↓" : " ↑"}</span>}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {paged.items.map(row => (
                  <tr key={row.id}>
                    <td>
                      <button type="button" className="data-company-link" onClick={() => onOpenCompany(row.company_id)} title={t("Avaa taloyhtiö")}>
                        {row.company_name}
                      </button>
                    </td>
                    {columns.slice(1).map(column => <td key={column.key}>{dataCellText(column, row)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {paged.pager}
    </section>
  );
}
