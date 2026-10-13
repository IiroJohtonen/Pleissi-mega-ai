import { type FormEvent, useEffect, useState } from "react";
import { Dropdown, usePaged } from "../components/common";
import { formatDate, formatDay } from "../format";
import { api, errorMessage, isManager } from "../session";
import type { Company, Resident } from "../types";
import { t } from "../i18n";

export type Apartment = { id: string; apartment_number: string; address: string };

type BuildingKey = {
  id: string;
  company_id: string;
  code: string;
  type: string;
  apartment_id: string | null;
  note: string;
  status: "active" | "lost";
  apartment_number: string | null;
  // Nykyinen luovutus; puuttuu, kun avain on toimistolla.
  loan_id: string | null;
  holder_name: string | null;
  handed_at: string | null;
  due_date: string | null;
  loan_note: string | null;
};

type KeyLoan = {
  id: string;
  holder_name: string;
  note: string;
  due_date: string | null;
  handed_at: string;
  handed_by: string;
  returned_at: string | null;
  received_by: string | null;
};

const KEY_TYPES = ["Asunto", "Yleisavain", "Yleiset tilat", "Autotalli", "Tekninen tila", "Muu"];

function keyState(key: BuildingKey) {
  if (key.status === "lost") return t("Kadonnut");
  return key.holder_name ? t("Luovutettu") : t("Toimistolla");
}

// Avainhallinta: taloyhtiöiden avaimet, niiden haltijat ja luovutushistoria.
// Avain, jonka sovittu palautuspäivä on mennyt.
export function isKeyLate(key: { loan_id: string | null; due_date: string | null }) {
  return Boolean(key.loan_id && key.due_date && key.due_date < new Date().toLocaleDateString("sv-SE"));
}

export function KeyRegister({ companies, defaultCompanyId, onChanged }: {
  companies: Company[];
  defaultCompanyId: string;
  onChanged?: () => void;
}) {
  const [keys, setKeys] = useState<BuildingKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [companyFilter, setCompanyFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  // Lomake: openId = avattu avain, creating = uusi avain.
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [formCompany, setFormCompany] = useState(defaultCompanyId);
  const [code, setCode] = useState("");
  const [type, setType] = useState(KEY_TYPES[0]);
  const [apartmentId, setApartmentId] = useState("");
  const [note, setNote] = useState("");
  const [lost, setLost] = useState(false);
  const [apartments, setApartments] = useState<Apartment[]>([]);
  const [residents, setResidents] = useState<Resident[]>([]);
  const [loans, setLoans] = useState<KeyLoan[]>([]);
  // Luovutus: asukas valitaan listasta tai vastaanottaja kirjoitetaan nimellä.
  const [residentId, setResidentId] = useState("");
  const [holderName, setHolderName] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [loanNote, setLoanNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";

  async function loadKeys() {
    try {
      const lists = await Promise.all(companies.map(company =>
        api<BuildingKey[]>(`/companies/${encodeURIComponent(company.id)}/keys`)));
      setKeys(lists.flat());
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadKeys();
  }, [companies.length]);

  const open = keys.find(key => key.id === openId) ?? null;
  const formOpen = creating || Boolean(open);

  useEffect(() => {
    if (!formOpen || !formCompany) return;
    api<Apartment[]>(`/companies/${encodeURIComponent(formCompany)}/apartments`).then(setApartments).catch(() => setApartments([]));
    api<Resident[]>(`/companies/${encodeURIComponent(formCompany)}/residents`).then(setResidents).catch(() => setResidents([]));
  }, [formOpen, formCompany]);

  async function loadLoans(keyId: string) {
    try {
      setLoans(await api<KeyLoan[]>(`/keys/${encodeURIComponent(keyId)}/loans`));
    } catch {
      setLoans([]);
    }
  }

  function openForm(key: BuildingKey | null) {
    setOpenId(key?.id ?? null);
    setCreating(!key);
    setFormCompany(key?.company_id ?? (companyFilter !== "all" ? companyFilter : defaultCompanyId));
    setCode(key?.code ?? "");
    setType(key?.type ?? KEY_TYPES[0]);
    setApartmentId(key?.apartment_id ?? "");
    setNote(key?.note ?? "");
    setLost(key?.status === "lost");
    setResidentId("");
    setHolderName("");
    setDueDate("");
    setLoanNote("");
    setLoans([]);
    setError("");
    if (key) void loadLoans(key.id);
  }

  function closeForm() {
    setOpenId(null);
    setCreating(false);
  }

  async function run(action: () => Promise<unknown>, fallback: string, close = false) {
    setSaving(true);
    setError("");
    try {
      await action();
      if (close) closeForm();
      await loadKeys();
      onChanged?.();
      if (!close && openId) await loadLoans(openId);
    } catch (actionError) {
      setError(errorMessage(actionError, fallback));
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void run(() => api(open ? `/keys/${encodeURIComponent(open.id)}` : `/companies/${encodeURIComponent(formCompany)}/keys`, {
      method: open ? "PUT" : "POST",
      body: JSON.stringify({ code, type, apartmentId: apartmentId || null, note, lost })
    }), t("Avaimen tallennus epäonnistui."), true);
  }

  function handOver(key: BuildingKey) {
    void run(async () => {
      await api(`/keys/${encodeURIComponent(key.id)}/hand-over`, {
        method: "POST",
        body: JSON.stringify({ residentId: residentId || null, holderName: holderName.trim(), dueDate: dueDate || null, note: loanNote.trim() })
      });
      setResidentId("");
      setHolderName("");
      setDueDate("");
      setLoanNote("");
    }, t("Avaimen luovutus epäonnistui."));
  }

  function handleDelete(key: BuildingKey) {
    if (!window.confirm(t("Poistetaanko avain {0} ja sen luovutushistoria?", key.code))) return;
    void run(() => api(`/keys/${encodeURIComponent(key.id)}`, { method: "DELETE" }), t("Avaimen poistaminen epäonnistui."), true);
  }

  const visible = keys
    .filter(key => (companyFilter === "all" || key.company_id === companyFilter)
      && (stateFilter === "all"
        || (stateFilter === "out" && Boolean(key.loan_id))
        || (stateFilter === "late" && isKeyLate(key))
        || (stateFilter === "office" && !key.loan_id && key.status !== "lost")
        || (stateFilter === "lost" && key.status === "lost")))
    .sort((a, b) => companyName(a.company_id).localeCompare(companyName(b.company_id), "fi")
      || a.code.localeCompare(b.code, "fi", { numeric: true }));
  const paged = usePaged(visible, `${companyFilter}|${stateFilter}`);
  const outCount = visible.filter(key => key.loan_id).length;
  const lateCount = visible.filter(isKeyLate).length;

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
          label={t("Tila")}
          value={stateFilter}
          options={[
            { value: "all", label: t("Kaikki") },
            { value: "out", label: t("Luovutetut") },
            { value: "late", label: t("Palautus myöhässä") },
            { value: "office", label: t("Toimistolla") },
            { value: "lost", label: t("Kadonneet") }
          ]}
          onChange={setStateFilter}
        />
      </div>

      <div className="residents-toolbar">
        <span>{visible.length}{" "}{t("avainta ·")}{" "}{outCount}{" "}{t("luovutettu")}{lateCount > 0 ? t(" · {0} myöhässä", lateCount) : ""}</span>
        <button className="secondary" onClick={() => openForm(null)}>{t("Lisää avain")}</button>
      </div>

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <div className="empty">{t("Avainten lataus epäonnistui.")}</div>
        : visible.length === 0 ? <div className="empty">{keys.length === 0 ? t("Ei avaimia. Lisää taloyhtiön avaimet rekisteriin.") : t("Ei suodattimia vastaavia avaimia.")}</div>
        : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("Tunnus")}</th>
                  <th>{t("Tyyppi")}</th>
                  <th>{t("Taloyhtiö")}</th>
                  <th>{t("Asunto")}</th>
                  <th>{t("Tila")}</th>
                  <th>{t("Haltija")}</th>
                  <th>{t("Palautus")}</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(key => (
                  <tr
                    key={key.id}
                    className="clickable"
                    title={t("Avaa avaimen tiedot")}
                    role="button"
                    tabIndex={0}
                    onClick={() => openForm(key)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openForm(key);
                      }
                    }}
                  >
                    <td><strong>{key.code}</strong></td>
                    <td><span className="type">{t(key.type)}</span></td>
                    <td>{companyName(key.company_id)}</td>
                    <td>{key.apartment_number || "–"}</td>
                    <td><span className={`work-order-status ${key.status === "lost" ? "rejected" : key.loan_id ? "" : "done"}`}>{keyState(key)}</span></td>
                    <td>{key.holder_name || "–"}</td>
                    <td>{key.loan_id && key.due_date ? `${formatDay(key.due_date)}${isKeyLate(key) ? t(" · myöhässä") : ""}` : "–"}</td>
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
            <button className="close" onClick={closeForm} disabled={saving}>×</button>
            <h2>{open ? t("Avain {0}", open.code) : t("Lisää avain")}</h2>
            <p className="muted">{open ? `${companyName(open.company_id)} · ${keyState(open)}` : t("Valitse taloyhtiö ja anna avaimen tiedot.")}</p>

            {open && open.loan_id && (
              <div className="ticket-form">
                <dl className="ticket-facts">
                  <div>
                    <dt>{t("Haltija")}</dt>
                    <dd>{open.holder_name}</dd>
                  </div>
                  <div>
                    <dt>{t("Luovutettu")}</dt>
                    <dd>{formatDate(open.handed_at ?? undefined)}</dd>
                  </div>
                  <div>
                    <dt>{t("Palautus viimeistään")}</dt>
                    <dd>{open.due_date ? `${formatDay(open.due_date)}${isKeyLate(open) ? t(" · myöhässä") : ""}` : t("Ei sovittu")}</dd>
                  </div>
                  <div>
                    <dt>{t("Lisätieto")}</dt>
                    <dd>{open.loan_note || "–"}</dd>
                  </div>
                </dl>
                <div className="draft-actions">
                  <button
                    className="primary"
                    disabled={saving}
                    onClick={() => void run(() => api(`/keys/${encodeURIComponent(open.id)}/return`, { method: "POST" }), t("Palautuksen kuittaus epäonnistui."))}
                  >
                    {t("Kuittaa palautetuksi")}
                  </button>
                </div>
              </div>
            )}

            {open && !open.loan_id && open.status !== "lost" && (
              <div className="ticket-form">
                <h3>{t("Luovuta avain")}</h3>
                <Dropdown
                  label={t("Asukas")}
                  value={residentId}
                  options={[
                    { value: "", label: t("Muu vastaanottaja") },
                    ...residents.map(resident => ({
                      value: resident.id,
                      label: [resident.name, resident.apartment_number].filter(Boolean).join(" · ")
                    }))
                  ]}
                  onChange={setResidentId}
                />
                {!residentId && (
                  <label>
                    <span>{t("Vastaanottajan nimi")}</span>
                    <input value={holderName} onChange={event => setHolderName(event.target.value)} maxLength={120} placeholder={t("Esim. Putki Oy, Matti Virtanen")} />
                  </label>
                )}
                <label>
                  <span>{t("Palautus viimeistään (valinnainen)")}</span>
                  <input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} />
                </label>
                <label>
                  <span>{t("Lisätieto (valinnainen)")}</span>
                  <input value={loanNote} onChange={event => setLoanNote(event.target.value)} maxLength={300} placeholder={t("Esim. kylpyhuoneremontin ajaksi")} />
                </label>
                <div className="draft-actions">
                  <button className="primary" disabled={saving || (!residentId && !holderName.trim())} onClick={() => handOver(open)}>
                    {t("Luovuta avain")}
                  </button>
                </div>
              </div>
            )}

            <form className="ticket-form" onSubmit={handleSubmit}>
              {open && <h3>{t("Avaimen tiedot")}</h3>}
              {!open && (
                <Dropdown
                  label={t("Taloyhtiö")}
                  value={formCompany}
                  options={companies.map(company => ({ value: company.id, label: company.name }))}
                  onChange={value => { setFormCompany(value); setApartmentId(""); }}
                />
              )}

              <label>
                <span>{t("Avaimen tunnus")}</span>
                <input value={code} onChange={event => setCode(event.target.value)} maxLength={60} placeholder={t("Esim. A12-1 tai Y-3")} />
              </label>

              <Dropdown
                label={t("Tyyppi")}
                value={type}
                options={(KEY_TYPES.includes(type) ? KEY_TYPES : [type, ...KEY_TYPES]).map(option => ({ value: option, label: t(option) }))}
                onChange={setType}
              />

              <Dropdown
                label={t("Asunto")}
                value={apartmentId}
                options={[
                  { value: "", label: t("Ei asuntoa") },
                  ...apartments.map(apartment => ({ value: apartment.id, label: `${apartment.apartment_number} · ${apartment.address}` }))
                ]}
                onChange={setApartmentId}
              />

              <label>
                <span>{t("Lisätieto")}</span>
                <input value={note} onChange={event => setNote(event.target.value)} maxLength={300} placeholder={t("Valinnainen, esim. sarjoitus tai säilytyspaikka")} />
              </label>

              {open && (
                <label className="switch-row">
                  <span>
                    <strong>{t("Avain on kadonnut")}</strong>
                    <small>{t("Kadonnutta avainta ei voi luovuttaa.")}</small>
                  </span>
                  <input type="checkbox" role="switch" checked={lost} onChange={() => setLost(!lost)} />
                  <i aria-hidden="true" />
                </label>
              )}

              {error && <p className="send-error">{error}</p>}

              <div className="drawer-actions compact-actions">
                {open && isManager() && (
                  <button className="danger" type="button" onClick={() => handleDelete(open)} disabled={saving}>{t("Poista")}</button>
                )}
                <button type="button" onClick={closeForm}>{t("Peruuta")}</button>
                <button className="primary" type="submit" disabled={saving || !code.trim()}>
                  {saving ? t("Tallennetaan…") : open ? t("Tallenna muutokset") : t("Lisää avain")}
                </button>
              </div>
            </form>

            {open && loans.length > 0 && (
              <>
                <h3>{t("Luovutushistoria")}</h3>
                <ul className="move-people">
                  {loans.map(loan => (
                    <li key={loan.id}>
                      <strong>{loan.holder_name}</strong> · {formatDate(loan.handed_at)} – {loan.returned_at ? formatDate(loan.returned_at) : t("ei palautettu")}
                      {loan.note ? ` · ${loan.note}` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
