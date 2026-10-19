import { type FormEvent, useEffect, useState } from "react";
import { usePaged } from "../components/common";
import { formatDate, formatDay } from "../format";
import { api, errorMessage, isManager } from "../session";
import type { Resident } from "../types";
import { t } from "../i18n";
import { renovationStatusLabels, type RenovationStatus } from "./Renovations";

export type ApartmentRow = { id: string; apartment_number: string; address: string; staircase: string; resident_count: number };

type ApartmentDetail = {
  id: string; company_id: string; company_name: string; apartment_number: string; address: string; staircase: string;
  residents: { id: string; name: string; email: string | null; roles: string }[];
  keys: { id: string; code: string; type: string; status: string; holder_name: string | null }[];
  parking: { id: string; label: string; type: string; resident_name: string }[];
  bookings: { id: string; resource: string; starts_at: string; ends_at: string; resident_name: string }[];
  renovations: { id: string; work_type: string; start_date: string; end_date: string; status: RenovationStatus; resident_name: string | null }[];
};

type CompanyKey = { id: string; code: string; type: string; apartment_id: string | null };

// Asunnon tunnus listoissa ja valinnoissa: numero, rappu ja osoite.
export function apartmentLabel(apartment: Pick<ApartmentRow, "apartment_number" | "staircase" | "address">) {
  return [apartment.apartment_number, apartment.staircase ? t("rappu {0}", apartment.staircase) : "", apartment.address]
    .filter(Boolean).join(" · ");
}

// Henkilön roolit tägeinä (Osakas, Asukas).
export function RoleTags({ roles }: { roles?: string }) {
  const list = (roles ?? "").split(",").filter(Boolean);
  if (!list.length) return null;
  return (
    <span className="role-tags">
      {list.map(role => <span key={role} className={`role-tag role-${role}`}>{role === "osakas" ? t("Osakas") : t("Asukas")}</span>)}
    </span>
  );
}

// Taloyhtiön asunnot. Ilman avausta (embedded) lista näytetään taloyhtiön tiedoissa; asunnon avaus vie Asunnot-sivulle.
export function Apartments({ companyId, openApartmentId, onOpenApartment, onOpenResident, embedded }: {
  companyId: string;
  openApartmentId?: string | null;
  onOpenApartment: (apartmentId: string | null) => void;
  onOpenResident?: (residentId: string) => void;
  embedded?: boolean;
}) {
  const [apartments, setApartments] = useState<ApartmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);

  async function load() {
    try {
      setApartments(await api<ApartmentRow[]>(`/companies/${encodeURIComponent(companyId)}/apartments`));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void load();
  }, [companyId, openApartmentId]);

  const searchText = search.trim().toLowerCase();
  const visible = searchText
    ? apartments.filter(apartment => apartmentLabel(apartment).toLowerCase().includes(searchText))
    : apartments;
  const paged = usePaged(visible, `${companyId}|${searchText}`);

  if (openApartmentId && !embedded) {
    return (
      <section className="content">
        <ApartmentRecord
          apartmentId={openApartmentId}
          onClose={() => onOpenApartment(null)}
          onOpenResident={onOpenResident}
        />
      </section>
    );
  }

  return (
    <section className={embedded ? "apartments-embedded" : "content"}>
      <div className="residents-toolbar">
        <span>{apartments.length}{" "}{t("asuntoa")}</span>
        <div className="toolbar-actions">
          {!embedded && (
            <input
              className="toolbar-search"
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder={t("Hae asuntoa")}
              aria-label={t("Hae asuntoa")}
            />
          )}
          {isManager() && <button className="secondary" onClick={() => setAdding(true)}>{t("Lisää asunto")}</button>}
        </div>
      </div>

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <div className="empty">{t("Asuntojen lataus epäonnistui.")}</div>
        : visible.length === 0 ? <div className="empty">{apartments.length ? t("Ei hakua vastaavia asuntoja.") : t("Ei asuntoja. Lisää taloyhtiön asunnot.")}</div>
        : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("Asunto")}</th>
                  <th>{t("Rappu")}</th>
                  <th>{t("Osoite")}</th>
                  <th>{t("Henkilöt")}</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(apartment => (
                  <tr
                    key={apartment.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title={t("Avaa asunto")}
                    onClick={() => onOpenApartment(apartment.id)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenApartment(apartment.id);
                      }
                    }}
                  >
                    <td><strong>{apartment.apartment_number}</strong></td>
                    <td>{apartment.staircase || "–"}</td>
                    <td>{apartment.address}</td>
                    <td>{apartment.resident_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {!loading && !loadError && paged.pager}

      {adding && (
        <ApartmentForm
          companyId={companyId}
          onClose={() => setAdding(false)}
          onSaved={async apartmentId => {
            setAdding(false);
            await load();
            onOpenApartment(apartmentId);
          }}
        />
      )}
    </section>
  );
}

// Uuden asunnon lisäys.
function ApartmentForm({ companyId, onClose, onSaved }: {
  companyId: string;
  onClose: () => void;
  onSaved: (apartmentId: string) => Promise<void>;
}) {
  const [apartmentNumber, setApartmentNumber] = useState("");
  const [staircase, setStaircase] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await api<{ apartmentId: string }>(`/companies/${encodeURIComponent(companyId)}/apartments`, {
        method: "POST",
        body: JSON.stringify({ apartmentNumber, staircase, address })
      });
      await onSaved(result.apartmentId);
    } catch (caught) {
      setError(errorMessage(caught, t("Asunnon lisääminen epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay">
      <aside className="drawer form-drawer">
        <button type="button" className="drawer-back" onClick={onClose}>{t("← Takaisin")}</button>
        <button className="close" onClick={onClose}>×</button>
        <h2>{t("Lisää asunto")}</h2>
        <form className="ticket-form" onSubmit={submit}>
          <ApartmentFields
            apartmentNumber={apartmentNumber} staircase={staircase} address={address}
            onChange={(field, value) => ({ apartmentNumber: setApartmentNumber, staircase: setStaircase, address: setAddress })[field](value)}
          />
          {error && <p className="send-error">{error}</p>}
          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>{t("Peruuta")}</button>
            <button className="primary" type="submit" disabled={saving || !apartmentNumber.trim() || !address.trim()}>
              {saving ? t("Lisätään…") : t("Lisää asunto")}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function ApartmentFields({ apartmentNumber, staircase, address, onChange, readOnly }: {
  apartmentNumber: string; staircase: string; address: string; readOnly?: boolean;
  onChange: (field: "apartmentNumber" | "staircase" | "address", value: string) => void;
}) {
  return (
    <>
      <div className="form-columns">
        <label>
          <span>{t("Asunnon numero")}</span>
          <input value={apartmentNumber} readOnly={readOnly} onChange={event => onChange("apartmentNumber", event.target.value)} placeholder={t("Esim. A 12")} maxLength={40} />
        </label>
        <label>
          <span>{t("Rappu")}</span>
          <input value={staircase} readOnly={readOnly} onChange={event => onChange("staircase", event.target.value)} placeholder={t("Esim. A")} maxLength={20} />
        </label>
      </div>
      <label>
        <span>{t("Osoite")}</span>
        <input value={address} readOnly={readOnly} onChange={event => onChange("address", event.target.value)} placeholder={t("Esim. Koivikkotie 10")} maxLength={200} />
      </label>
    </>
  );
}

type RecordTab = "parking" | "bookings" | "renovations";

// Asunnon tietue: tiedot, henkilöt, avaimet ja väliotsikoista valittavat autopaikat, vuorot ja remontit.
function ApartmentRecord({ apartmentId, onClose, onOpenResident }: {
  apartmentId: string;
  onClose: () => void;
  onOpenResident?: (residentId: string) => void;
}) {
  const [detail, setDetail] = useState<ApartmentDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [fields, setFields] = useState({ apartmentNumber: "", staircase: "", address: "" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<RecordTab>("parking");
  const [companyResidents, setCompanyResidents] = useState<Resident[]>([]);
  const [companyKeys, setCompanyKeys] = useState<CompanyKey[]>([]);
  const [residentToAdd, setResidentToAdd] = useState("");
  const [keyToAdd, setKeyToAdd] = useState("");
  const canEdit = isManager();

  async function load() {
    try {
      const loaded = await api<ApartmentDetail>(`/apartments/${encodeURIComponent(apartmentId)}`);
      setDetail(loaded);
      setFields({ apartmentNumber: loaded.apartment_number, staircase: loaded.staircase, address: loaded.address });
      setFailed(false);
      if (canEdit) {
        const company = encodeURIComponent(loaded.company_id);
        setCompanyResidents(await api<Resident[]>(`/companies/${company}/residents`).catch(() => []));
        setCompanyKeys(await api<CompanyKey[]>(`/companies/${company}/keys`).catch(() => []));
      }
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    setDetail(null);
    void load();
  }, [apartmentId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await api(`/apartments/${encodeURIComponent(apartmentId)}`, { method: "PUT", body: JSON.stringify(fields) });
      setSaved(true);
      await load();
    } catch (caught) {
      setError(errorMessage(caught, t("Asunnon tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function run(action: () => Promise<unknown>, failure: string) {
    setError("");
    try {
      await action();
      await load();
    } catch (caught) {
      setError(errorMessage(caught, failure));
    }
  }

  const addResident = () => run(async () => {
    const resident = companyResidents.find(item => item.id === residentToAdd);
    if (resident?.apartment_id && !window.confirm(t("{0} asuu nyt asunnossa {1}. Siirretäänkö hänet tähän asuntoon?", resident.name, resident.apartment_number))) return;
    await api(`/apartments/${encodeURIComponent(apartmentId)}/residents`, { method: "POST", body: JSON.stringify({ residentId: residentToAdd }) });
    setResidentToAdd("");
  }, t("Henkilön lisääminen epäonnistui."));

  const linkKey = (keyId: string, linked: boolean) => run(async () => {
    await api(`/apartments/${encodeURIComponent(apartmentId)}/keys/${encodeURIComponent(keyId)}`, { method: "PUT", body: JSON.stringify({ linked }) });
    setKeyToAdd("");
  }, t("Avaimen liittäminen epäonnistui."));

  const changeField = (field: keyof typeof fields, value: string) => {
    setFields(current => ({ ...current, [field]: value }));
    setSaved(false);
  };

  return (
    <section className="record-page">
      <aside className="drawer form-drawer apartment-record">
        <button type="button" className="drawer-back" onClick={onClose}>{t("← Takaisin")}</button>
        {failed ? <p className="send-error">{t("Asunnon lataus epäonnistui.")}</p>
          : !detail ? <p className="muted">{t("Ladataan…")}</p> : (
          <>
            <h2>{t("Asunto {0}", detail.apartment_number)}</h2>
            <p className="muted">{[detail.staircase ? t("Rappu {0}", detail.staircase) : "", detail.address].filter(Boolean).join(" · ")}</p>

            <form className="ticket-form" onSubmit={save}>
              <ApartmentFields
                apartmentNumber={fields.apartmentNumber} staircase={fields.staircase} address={fields.address}
                readOnly={!canEdit} onChange={changeField}
              />
              <label>
                <span>{t("Taloyhtiö")}</span>
                <input value={detail.company_name} readOnly />
              </label>
              {canEdit && (
                <div className="draft-actions">
                  <button className="primary" type="submit" disabled={saving || !fields.apartmentNumber.trim() || !fields.address.trim()}>
                    {saving ? t("Tallennetaan…") : t("Tallenna muutokset")}
                  </button>
                  {saved && <span className="saved-indicator">{t("Tallennettu")}</span>}
                </div>
              )}
            </form>
            {error && <p className="send-error">{error}</p>}

            <section className="apartment-section">
              <h3>{t("Henkilöt")}</h3>
              {detail.residents.length === 0 ? <p className="muted">{t("Asunnossa ei ole henkilöitä.")}</p> : (
                <ul className="apartment-list">
                  {detail.residents.map(resident => (
                    <li key={resident.id}>
                      {onOpenResident
                        ? <button type="button" className="back-link" onClick={() => onOpenResident(resident.id)}>{resident.name}</button>
                        : <strong>{resident.name}</strong>}
                      <RoleTags roles={resident.roles} />
                      {resident.email && <small>{resident.email}</small>}
                    </li>
                  ))}
                </ul>
              )}
              {canEdit && (
                <div className="apartment-link">
                  <select value={residentToAdd} onChange={event => setResidentToAdd(event.target.value)} aria-label={t("Lisättävä henkilö")}>
                    <option value="">{t("Valitse asukas…")}</option>
                    {companyResidents
                      .filter(resident => !detail.residents.some(item => item.id === resident.id))
                      .map(resident => (
                        <option key={resident.id} value={resident.id}>
                          {resident.name}{resident.apartment_number ? ` (${resident.apartment_number})` : ""}
                        </option>
                      ))}
                  </select>
                  <button type="button" className="secondary" disabled={!residentToAdd} onClick={() => void addResident()}>{t("Lisää henkilö")}</button>
                </div>
              )}
            </section>

            <section className="apartment-section">
              <h3>{t("Avaimet")}</h3>
              {detail.keys.length === 0 ? <p className="muted">{t("Asuntoon ei ole liitetty avaimia.")}</p> : (
                <ul className="apartment-list">
                  {detail.keys.map(key => (
                    <li key={key.id}>
                      <strong>{key.code}</strong>
                      <small>
                        {t(key.type)}
                        {key.status === "lost" ? ` · ${t("kadonnut")}` : key.holder_name ? ` · ${t("lainassa: {0}", key.holder_name)}` : ""}
                      </small>
                      {canEdit && (
                        <button type="button" className="link-remove" onClick={() => void linkKey(key.id, false)} title={t("Poista avain asunnosta")}>
                          {t("Poista")}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canEdit && (
                <div className="apartment-link">
                  <select value={keyToAdd} onChange={event => setKeyToAdd(event.target.value)} aria-label={t("Liitettävä avain")}>
                    <option value="">{t("Valitse avain…")}</option>
                    {companyKeys.filter(key => key.apartment_id !== detail.id).map(key => (
                      <option key={key.id} value={key.id}>{key.code} · {t(key.type)}{key.apartment_id ? ` (${t("toisessa asunnossa")})` : ""}</option>
                    ))}
                  </select>
                  <button type="button" className="secondary" disabled={!keyToAdd} onClick={() => void linkKey(keyToAdd, true)}>{t("Liitä avain")}</button>
                </div>
              )}
            </section>

            <div className="card-tabs apartment-tabs" role="tablist">
              {([["parking", t("Autopaikat"), detail.parking.length], ["bookings", t("Sauna- ja pyykkivuorot"), detail.bookings.length],
                ["renovations", t("Remontit"), detail.renovations.length]] as [RecordTab, string, number][]).map(([key, label, count]) => (
                <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
                  {label}{" "}<b>{count}</b>
                </button>
              ))}
            </div>
            {tab === "parking" && (detail.parking.length === 0 ? <p className="muted">{t("Asunnon henkilöillä ei ole autopaikkoja.")}</p> : (
              <ul className="apartment-list">
                {detail.parking.map(space => <li key={space.id}><strong>{space.label}</strong><small>{t(space.type)} · {space.resident_name}</small></li>)}
              </ul>
            ))}
            {tab === "bookings" && (detail.bookings.length === 0 ? <p className="muted">{t("Ei tulevia vuoroja.")}</p> : (
              <ul className="apartment-list">
                {detail.bookings.map(booking => (
                  <li key={booking.id}>
                    <strong>{booking.resource === "sauna" ? t("Sauna") : t("Pyykkitupa")}</strong>
                    <small>{formatDate(booking.starts_at)} · {booking.resident_name}</small>
                  </li>
                ))}
              </ul>
            ))}
            {tab === "renovations" && (detail.renovations.length === 0 ? <p className="muted">{t("Ei remontti-ilmoituksia.")}</p> : (
              <ul className="apartment-list">
                {detail.renovations.map(renovation => (
                  <li key={renovation.id}>
                    <strong>{t(renovation.work_type)}</strong>
                    <small>
                      {formatDay(renovation.start_date)}–{formatDay(renovation.end_date)} · {renovationStatusLabels[renovation.status] ?? renovation.status}
                      {renovation.resident_name ? ` · ${renovation.resident_name}` : ""}
                    </small>
                  </li>
                ))}
              </ul>
            ))}
          </>
        )}
      </aside>
    </section>
  );
}

// Asunnon valinta asukkaan tiedoissa: kirjoita numero, rappu tai osoite ja valitse listasta.
export function ApartmentPicker({ apartments, value, onChange }: {
  apartments: ApartmentRow[];
  value: string;
  onChange: (apartmentId: string) => void;
}) {
  const selected = apartments.find(apartment => apartment.id === value);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = apartments
    .filter(apartment => words.every(word => apartmentLabel(apartment).toLowerCase().includes(word)))
    .slice(0, 50);

  return (
    <div className="apartment-picker">
      <input
        type="search"
        value={open ? query : selected ? apartmentLabel(selected) : ""}
        placeholder={open && selected ? apartmentLabel(selected) : t("Hae asuntoa numerolla, rapulla tai osoitteella")}
        aria-label={t("Asunto")}
        role="combobox"
        aria-expanded={open}
        onFocus={() => { setQuery(""); setOpen(true); }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={event => { setQuery(event.target.value); setOpen(true); }}
        onKeyDown={event => {
          if (event.key === "Enter" && matches[0]) {
            event.preventDefault();
            onChange(matches[0].id);
            setOpen(false);
          }
        }}
      />
      {open && (
        <div className="apartment-picker-list" role="listbox" aria-label={t("Asunnot")}>
          {matches.length === 0 && <p className="muted">{t("Ei hakua vastaavia asuntoja.")}</p>}
          {matches.map(apartment => (
            <button
              key={apartment.id}
              type="button"
              role="option"
              aria-selected={apartment.id === value}
              onMouseDown={event => event.preventDefault()}
              onClick={() => { onChange(apartment.id); setOpen(false); }}
            >
              <strong>{apartment.apartment_number}</strong>
              <small>{[apartment.staircase ? t("rappu {0}", apartment.staircase) : "", apartment.address].filter(Boolean).join(" · ")}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
