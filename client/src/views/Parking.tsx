import { type FormEvent, useEffect, useState } from "react";
import { Dropdown, usePaged } from "../components/common";
import { api, errorMessage } from "../session";
import type { Company, Resident } from "../types";
import { t } from "../i18n";

export type ParkingSpace = {
  id: string;
  company_id: string;
  label: string;
  type: string;
  resident_id: string | null;
  note: string;
  resident_name: string | null;
  apartment_number: string | null;
};

export const PARKING_TYPES = ["Autotalli", "Ulkopaikka", "Hallipaikka"];

// Autopaikat: kaikkien taloyhtiöiden paikat yhdessä taulukossa. Riviä klikkaamalla paikkaa voi muokata.
export function ParkingSpaces({
  companies,
  defaultCompanyId,
  embedded = false
}: {
  companies: Company[];
  defaultCompanyId: string;
  // embedded = näytetään taloyhtiön tietueen sisällä, jolloin yhtiö on jo valittu.
  embedded?: boolean;
}) {
  const [spaces, setSpaces] = useState<ParkingSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Lomake: editing = muokattava paikka, creating = uusi paikka.
  const [editing, setEditing] = useState<ParkingSpace | null>(null);
  const [creating, setCreating] = useState(false);
  const [formCompany, setFormCompany] = useState(defaultCompanyId);
  const [label, setLabel] = useState("");
  const [type, setType] = useState(PARKING_TYPES[0]);
  const [residentId, setResidentId] = useState("");
  const [note, setNote] = useState("");
  const [residents, setResidents] = useState<Resident[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";

  async function loadSpaces() {
    try {
      const lists = await Promise.all(companies.map(company =>
        api<ParkingSpace[]>(`/companies/${encodeURIComponent(company.id)}/parking`)));
      setSpaces(lists.flat());
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSpaces();
  }, [companies.length]);

  // Haltijaksi voi valita lomakkeen taloyhtiön asukkaan.
  const formOpen = creating || Boolean(editing);
  useEffect(() => {
    if (!formOpen || !formCompany) return;
    api<Resident[]>(`/companies/${encodeURIComponent(formCompany)}/residents`)
      .then(setResidents)
      .catch(() => setResidents([]));
  }, [formOpen, formCompany]);

  function openForm(space: ParkingSpace | null) {
    setEditing(space);
    setCreating(!space);
    setFormCompany(space?.company_id ?? (companyFilter !== "all" ? companyFilter : defaultCompanyId));
    setLabel(space?.label ?? "");
    setType(space?.type ?? PARKING_TYPES[0]);
    setResidentId(space?.resident_id ?? "");
    setNote(space?.note ?? "");
    setFormError("");
  }

  function closeForm() {
    setEditing(null);
    setCreating(false);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      await api(editing ? `/parking/${encodeURIComponent(editing.id)}` : `/companies/${encodeURIComponent(formCompany)}/parking`, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({ label, type, residentId: residentId || null, note })
      });
      closeForm();
      await loadSpaces();
    } catch (error) {
      setFormError(errorMessage(error, t("Autopaikan tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editing || !window.confirm(t("Poistetaanko autopaikka {0}?", editing.label))) return;
    setSaving(true);
    try {
      await api(`/parking/${encodeURIComponent(editing.id)}`, { method: "DELETE" });
      closeForm();
      await loadSpaces();
    } catch (error) {
      setFormError(errorMessage(error, t("Autopaikan poistaminen epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  const visible = spaces
    .filter(space => (typeFilter === "all" || space.type === typeFilter)
      && (companyFilter === "all" || space.company_id === companyFilter)
      && (statusFilter === "all" || (statusFilter === "free") === !space.resident_id))
    .sort((a, b) => companyName(a.company_id).localeCompare(companyName(b.company_id), "fi")
      || a.label.localeCompare(b.label, "fi", { numeric: true }));
  const paged = usePaged(visible, `${typeFilter}|${companyFilter}|${statusFilter}`);
  const free = visible.filter(space => !space.resident_id).length;
  const parkingFilters: { key: string; label: string; value: string; clear: () => void }[] = [
    ...(companyFilter !== "all"
      ? [{ key: "company", label: t("Taloyhtiö"), value: companyName(companyFilter), clear: () => setCompanyFilter("all") }]
      : []),
    ...(typeFilter !== "all" ? [{ key: "type", label: t("Tyyppi"), value: t(typeFilter), clear: () => setTypeFilter("all") }] : []),
    ...(statusFilter !== "all"
      ? [{ key: "status", label: t("Tila"), value: statusFilter === "free" ? t("Vapaat") : t("Varatut"), clear: () => setStatusFilter("all") }]
      : [])
  ];

  return (
    <section className="content">
      {!embedded && <a className="back-link" href="#/companies">{t("← Taloyhtiöt")}</a>}

      {filtersOpen && (
        <div className="ticket-filters">
          {!embedded && (
            <Dropdown
              label={t("Taloyhtiö")}
              value={companyFilter}
              options={[{ value: "all", label: t("Kaikki") }, ...companies.map(company => ({ value: company.id, label: company.name }))]}
              onChange={setCompanyFilter}
            />
          )}
          <Dropdown
            label={t("Tyyppi")}
            value={typeFilter}
            options={[{ value: "all", label: t("Kaikki") }, ...PARKING_TYPES.map(option => ({ value: option, label: t(option) }))]}
            onChange={setTypeFilter}
          />
          <Dropdown
            label={t("Tila")}
            value={statusFilter}
            options={[
              { value: "all", label: t("Kaikki") },
              { value: "free", label: t("Vapaat") },
              { value: "taken", label: t("Varatut") }
            ]}
            onChange={setStatusFilter}
          />
          {parkingFilters.length > 0 && (
            <button className="clear-filters" onClick={() => {
              setCompanyFilter("all");
              setTypeFilter("all");
              setStatusFilter("all");
            }}>{t("Tyhjennä suodattimet")}</button>
          )}
        </div>
      )}

      <div className="residents-toolbar">
        <div className="filter-chips">
          <button
            className={`filter-toggle ${filtersOpen || parkingFilters.length > 0 ? "active" : ""}`}
            onClick={() => setFiltersOpen(!filtersOpen)}
            title={filtersOpen ? t("Piilota suodattimet") : t("Näytä suodattimet")}
            aria-label={filtersOpen ? t("Piilota suodattimet") : t("Näytä suodattimet")}
            aria-expanded={filtersOpen}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.200"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 5h18l-7 8.500V19l-4 2v-7.500z" />
            </svg>
            {parkingFilters.length > 0 && <i />}
          </button>
          <span>{visible.length}{" "}{t("autopaikkaa ·")}{" "}{free}{" "}{t("vapaana")}</span>
          {parkingFilters.map(filter => (
            <span className="filter-chip" key={filter.key}>
              <small>{filter.label}</small>
              {filter.value}
              <button onClick={filter.clear} title={t("Poista suodatin")} aria-label={t("Poista suodatin {0}", filter.label)}>×</button>
            </span>
          ))}
        </div>
        <button className="secondary" onClick={() => openForm(null)}>{t("Lisää autopaikka")}</button>
      </div>

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <div className="empty">{t("Autopaikkojen lataus epäonnistui.")}</div>
        : visible.length === 0 ? <div className="empty">{spaces.length === 0 ? t("Ei autopaikkoja.") : t("Ei suodattimia vastaavia autopaikkoja.")}</div>
        : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("Paikka")}</th>
                  <th>{t("Tyyppi")}</th>
                  {!embedded && <th>{t("Taloyhtiö")}</th>}
                  <th>{t("Haltija")}</th>
                  <th>{t("Asunto")}</th>
                  <th>{t("Lisätieto")}</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(space => (
                  <tr
                    key={space.id}
                    className="clickable"
                    title={t("Muokkaa autopaikkaa")}
                    role="button"
                    tabIndex={0}
                    onClick={() => openForm(space)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openForm(space);
                      }
                    }}
                  >
                    <td><strong>{space.label}</strong></td>
                    <td><span className="type">{t(space.type)}</span></td>
                    {!embedded && <td>{companyName(space.company_id)}</td>}
                    <td>{space.resident_name || <span className="muted">{t("Vapaa")}</span>}</td>
                    <td>{space.apartment_number || "–"}</td>
                    <td>{space.note || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {!loading && !loadError && paged.pager}

      {formOpen && (
        <div className="overlay">
          <aside className="drawer form-drawer resident-drawer">
            <button className="close" onClick={closeForm}>×</button>
            <h2>{editing ? t("Autopaikka {0}", editing.label) : t("Lisää autopaikka")}</h2>
            <p className="muted">{editing ? companyName(editing.company_id) : t("Valitse taloyhtiö ja anna paikan tiedot.")}</p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              {!editing && !embedded && (
                <Dropdown
                  label={t("Taloyhtiö")}
                  value={formCompany}
                  options={companies.map(company => ({ value: company.id, label: company.name }))}
                  onChange={value => { setFormCompany(value); setResidentId(""); }}
                />
              )}

              <label>
                <span>{t("Paikan tunnus")}</span>
                <input value={label} onChange={event => setLabel(event.target.value)} placeholder={t("Esim. 14 tai AT 3")} />
              </label>

              <Dropdown
                label={t("Tyyppi")}
                value={type}
                options={(PARKING_TYPES.includes(type) ? PARKING_TYPES : [type, ...PARKING_TYPES])
                  .map(option => ({ value: option, label: t(option) }))}
                onChange={setType}
              />

              <Dropdown
                label={t("Haltija")}
                value={residentId}
                options={[
                  { value: "", label: t("Vapaa (ei haltijaa)") },
                  ...residents.map(resident => ({
                    value: resident.id,
                    label: [resident.name, resident.apartment_number].filter(Boolean).join(" · ")
                  }))
                ]}
                onChange={setResidentId}
              />

              <label>
                <span>{t("Lisätieto")}</span>
                <input value={note} onChange={event => setNote(event.target.value)} placeholder={t("Valinnainen, esim. lämmitystolppa")} />
              </label>

              {formError && <p className="send-error">{formError}</p>}

              <div className="drawer-actions compact-actions">
                {editing && (
                  <button className="danger" type="button" onClick={handleDelete} disabled={saving}>{t("Poista")}</button>
                )}
                <button type="button" onClick={closeForm}>{t("Peruuta")}</button>
                <button className="primary" type="submit" disabled={saving || !label.trim()}>
                  {saving ? t("Tallennetaan…") : editing ? t("Tallenna muutokset") : t("Lisää autopaikka")}
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </section>
  );
}
