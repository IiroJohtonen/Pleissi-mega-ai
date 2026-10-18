import { type FormEvent, useEffect, useState } from "react";
import { Dropdown, usePaged } from "../components/common";
import { api, errorMessage, isManager } from "../session";
import type { Company, Resident } from "../types";
import { t } from "../i18n";
import { OpenResidentButton } from "../components/Reporter";

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

// Taloyhtiön autopaikkavaihtoehto ja sen kuukausihinta (taloyhtiön tiedoissa).
export type ParkingOption = { type: string; monthly_price: number };

export function formatParkingOption(option: ParkingOption) {
  return option.monthly_price > 0
    ? `${t(option.type)} · ${option.monthly_price.toLocaleString("fi-FI", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${t("€/kk")}`
    : t(option.type);
}

// Taloyhtiön autopaikkavaihtoehdot: isännöitsijä lisää vaihtoehtoja omalla hinnallaan, muuttaa hintaa ja poistaa niitä.
// Vaihtoehdot näkyvät paikkojen tyyppinä, asukkaan autopaikkajonossa ja autopaikkatilauksissa.
export function ParkingOptionsEditor({ companyId }: { companyId: string }) {
  const [options, setOptions] = useState<ParkingOption[] | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [newType, setNewType] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const editable = isManager();
  const base = `/companies/${encodeURIComponent(companyId)}/parking-options`;

  function show(next: ParkingOption[]) {
    setOptions(next);
    setPrices(Object.fromEntries(next.map(option => [option.type, String(option.monthly_price)])));
  }

  useEffect(() => {
    api<ParkingOption[]>(base).then(show).catch(() => setError(t("Autopaikkavaihtoehtojen lataus epäonnistui.")));
  }, [companyId]);

  const amount = (value: string) => Math.max(0, Number(value.replace(",", ".")) || 0);

  async function run(action: () => Promise<ParkingOption[]>, failure: string) {
    setSaving(true);
    setError("");
    try {
      show(await action());
      return true;
    } catch (problem) {
      setError(errorMessage(problem, failure));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function savePrice(option: ParkingOption) {
    const price = amount(prices[option.type] ?? "");
    if (price === option.monthly_price) return;
    await run(() => api<ParkingOption[]>(`${base}/${encodeURIComponent(option.type)}`, {
      method: "PUT", body: JSON.stringify({ monthlyPrice: price })
    }), t("Hinnan tallennus epäonnistui."));
  }

  async function remove(option: ParkingOption) {
    if (!window.confirm(t("Poistetaanko autopaikkavaihtoehto {0}? Sen tyyppiset paikat säilyvät.", t(option.type)))) return;
    await run(() => api<ParkingOption[]>(`${base}/${encodeURIComponent(option.type)}`, { method: "DELETE" }),
      t("Vaihtoehdon poistaminen epäonnistui."));
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!newType.trim()) return;
    const added = await run(() => api<ParkingOption[]>(base, {
      method: "POST", body: JSON.stringify({ type: newType.trim(), monthlyPrice: amount(newPrice) })
    }), t("Vaihtoehdon lisääminen epäonnistui."));
    if (added) {
      setNewType("");
      setNewPrice("");
    }
  }

  return (
    <div className="parking-options">
      {options === null ? <p className="muted">{error || t("Ladataan…")}</p> : (
        <>
          {options.length === 0 && <p className="muted">{t("Ei autopaikkavaihtoehtoja.")}</p>}
          {options.map(option => (
            <div className="booking-settings-duration parking-option" key={option.type}>
              <span>
                <strong>{t(option.type)}</strong>
                <small>{t("Paikan hinta kuukaudessa.")}</small>
              </span>
              <span className="price-input">
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={prices[option.type] ?? ""}
                  disabled={!editable || saving}
                  aria-label={t("Hinta: {0}", t(option.type))}
                  onChange={event => setPrices({ ...prices, [option.type]: event.target.value })}
                  onBlur={() => void savePrice(option)}
                />
                {t("€/kk")}
              </span>
              {editable && (
                <button type="button" className="secondary" onClick={() => void remove(option)} disabled={saving}>
                  {t("Poista")}
                </button>
              )}
            </div>
          ))}
          {editable && (
            <form className="parking-option-add" onSubmit={add}>
              <input value={newType} onChange={event => setNewType(event.target.value)} placeholder={t("Uusi vaihtoehto, esim. Sähköautopaikka")} maxLength={60} aria-label={t("Uuden vaihtoehdon nimi")} />
              <span className="price-input">
                <input type="number" min="0" step="0.5" value={newPrice} onChange={event => setNewPrice(event.target.value)} placeholder="0" aria-label={t("Uuden vaihtoehdon hinta")} />
                {t("€/kk")}
              </span>
              <button type="submit" className="secondary" disabled={saving || !newType.trim()}>{t("Lisää vaihtoehto")}</button>
            </form>
          )}
          {error && <p className="send-error">{error}</p>}
        </>
      )}
    </div>
  );
}

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
  const [companyFilter, setCompanyFilter] = useState(companies.some(company => company.id === defaultCompanyId) ? defaultCompanyId : "all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Lomake: editing = muokattava paikka, creating = uusi paikka.
  const [editing, setEditing] = useState<ParkingSpace | null>(null);
  const [creating, setCreating] = useState(false);
  const [formCompany, setFormCompany] = useState(defaultCompanyId);
  const [label, setLabel] = useState("");
  const [type, setType] = useState("");
  // Taloyhtiöiden autopaikkavaihtoehdot yhtiöittäin (paikan tyyppi valitaan näistä).
  const [companyOptions, setCompanyOptions] = useState<Record<string, ParkingOption[]>>({});
  const [residentId, setResidentId] = useState("");
  const [note, setNote] = useState("");
  const [residents, setResidents] = useState<Resident[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";

  async function loadSpaces() {
    try {
      const [lists, optionLists] = await Promise.all([
        Promise.all(companies.map(company => api<ParkingSpace[]>(`/companies/${encodeURIComponent(company.id)}/parking`))),
        Promise.all(companies.map(company =>
          api<ParkingOption[]>(`/companies/${encodeURIComponent(company.id)}/parking-options`).catch(() => [] as ParkingOption[])))
      ]);
      setSpaces(lists.flat());
      setCompanyOptions(Object.fromEntries(companies.map((company, index) => [company.id, optionLists[index]])));
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
    const company = space?.company_id ?? (companyFilter !== "all" ? companyFilter : defaultCompanyId);
    setFormCompany(company);
    setLabel(space?.label ?? "");
    setType(space?.type ?? companyOptions[company]?.[0]?.type ?? "");
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
  // Tyyppisuodattimen vaihtoehdot: näkyvien yhtiöiden autopaikkavaihtoehdot ja paikoilla jo olevat tyypit.
  const typeOptions = [...new Set([
    ...companies.filter(company => companyFilter === "all" || company.id === companyFilter)
      .flatMap(company => (companyOptions[company.id] ?? []).map(option => option.type)),
    ...spaces.map(space => space.type)
  ])];
  const formTypes = (companyOptions[formCompany] ?? []).map(option => option.type);
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
            options={[{ value: "all", label: t("Kaikki") }, ...typeOptions.map(option => ({ value: option, label: t(option) }))]}
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
            <button type="button" className="drawer-back" onClick={closeForm}>{t("← Takaisin")}</button>
            <button className="close" onClick={closeForm}>×</button>
            <h2>{editing ? t("Autopaikka {0}", editing.label) : t("Lisää autopaikka")}</h2>
            <p className="muted">{editing ? companyName(editing.company_id) : t("Valitse taloyhtiö ja anna paikan tiedot.")}</p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              {!editing && !embedded && (
                <Dropdown
                  label={t("Taloyhtiö")}
                  value={formCompany}
                  options={companies.map(company => ({ value: company.id, label: company.name }))}
                  onChange={value => { setFormCompany(value); setResidentId(""); setType(companyOptions[value]?.[0]?.type ?? ""); }}
                />
              )}

              <label>
                <span>{t("Paikan tunnus")}</span>
                <input value={label} onChange={event => setLabel(event.target.value)} placeholder={t("Esim. 14 tai AT 3")} />
              </label>

              <Dropdown
                label={t("Tyyppi")}
                value={type}
                options={(formTypes.includes(type) || !type ? formTypes : [type, ...formTypes])
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
              {(() => {
                const holder = residents.find(resident => resident.id === residentId);
                return holder ? (
                  <div className="holder-link">
                    <span>{[holder.name, holder.apartment_number && t("Asunto {0}", holder.apartment_number), holder.email].filter(Boolean).join(" · ")}</span>
                    <OpenResidentButton residentId={holder.id} name={holder.name} />
                  </div>
                ) : null;
              })()}

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
                <button className="primary" type="submit" disabled={saving || !label.trim() || !type}>
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
