import { type FormEvent, useEffect, useState } from "react";
import { Dropdown, usePaged } from "../components/common";
import { formatDate, formatDay } from "../format";
import { api, errorMessage, isManager } from "../session";
import type { Company, Resident } from "../types";

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
  if (key.status === "lost") return "Kadonnut";
  return key.holder_name ? "Luovutettu" : "Toimistolla";
}

function isLate(key: BuildingKey) {
  return Boolean(key.loan_id && key.due_date && key.due_date < new Date().toLocaleDateString("sv-SE"));
}

// Avainhallinta: taloyhtiöiden avaimet, niiden haltijat ja luovutushistoria.
export function KeyRegister({ companies, defaultCompanyId }: { companies: Company[]; defaultCompanyId: string }) {
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
    }), "Avaimen tallennus epäonnistui.", true);
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
    }, "Avaimen luovutus epäonnistui.");
  }

  function handleDelete(key: BuildingKey) {
    if (!window.confirm(`Poistetaanko avain ${key.code} ja sen luovutushistoria?`)) return;
    void run(() => api(`/keys/${encodeURIComponent(key.id)}`, { method: "DELETE" }), "Avaimen poistaminen epäonnistui.", true);
  }

  const visible = keys
    .filter(key => (companyFilter === "all" || key.company_id === companyFilter)
      && (stateFilter === "all"
        || (stateFilter === "out" && Boolean(key.loan_id))
        || (stateFilter === "late" && isLate(key))
        || (stateFilter === "office" && !key.loan_id && key.status !== "lost")
        || (stateFilter === "lost" && key.status === "lost")))
    .sort((a, b) => companyName(a.company_id).localeCompare(companyName(b.company_id), "fi")
      || a.code.localeCompare(b.code, "fi", { numeric: true }));
  const paged = usePaged(visible, `${companyFilter}|${stateFilter}`);
  const outCount = visible.filter(key => key.loan_id).length;
  const lateCount = visible.filter(isLate).length;

  return (
    <section className="content">
      <a className="back-link" href="#/companies">← Taloyhtiöt</a>

      <div className="ticket-filters">
        <Dropdown
          label="Taloyhtiö"
          value={companyFilter}
          options={[{ value: "all", label: "Kaikki" }, ...companies.map(company => ({ value: company.id, label: company.name }))]}
          onChange={setCompanyFilter}
        />
        <Dropdown
          label="Tila"
          value={stateFilter}
          options={[
            { value: "all", label: "Kaikki" },
            { value: "out", label: "Luovutetut" },
            { value: "late", label: "Palautus myöhässä" },
            { value: "office", label: "Toimistolla" },
            { value: "lost", label: "Kadonneet" }
          ]}
          onChange={setStateFilter}
        />
      </div>

      <div className="residents-toolbar">
        <span>{visible.length} avainta · {outCount} luovutettu{lateCount > 0 ? ` · ${lateCount} myöhässä` : ""}</span>
        <button className="secondary" onClick={() => openForm(null)}>Lisää avain</button>
      </div>

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <div className="empty">Avainten lataus epäonnistui.</div>
        : visible.length === 0 ? <div className="empty">{keys.length === 0 ? "Ei avaimia. Lisää taloyhtiön avaimet rekisteriin." : "Ei suodattimia vastaavia avaimia."}</div>
        : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tunnus</th>
                  <th>Tyyppi</th>
                  <th>Taloyhtiö</th>
                  <th>Asunto</th>
                  <th>Tila</th>
                  <th>Haltija</th>
                  <th>Palautus</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(key => (
                  <tr
                    key={key.id}
                    className="clickable"
                    title="Avaa avaimen tiedot"
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
                    <td><span className="type">{key.type}</span></td>
                    <td>{companyName(key.company_id)}</td>
                    <td>{key.apartment_number || "–"}</td>
                    <td><span className={`work-order-status ${key.loan_id || key.status === "lost" ? "" : "done"}`}>{keyState(key)}</span></td>
                    <td>{key.holder_name || "–"}</td>
                    <td>{key.loan_id && key.due_date ? `${formatDay(key.due_date)}${isLate(key) ? " · myöhässä" : ""}` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {!loading && !loadError && paged.pager}

      {formOpen && (
        <div className="overlay" onClick={() => !saving && closeForm()}>
          <aside className="drawer form-drawer resident-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={closeForm} disabled={saving}>×</button>
            <h2>{open ? `Avain ${open.code}` : "Lisää avain"}</h2>
            <p className="muted">{open ? `${companyName(open.company_id)} · ${keyState(open)}` : "Valitse taloyhtiö ja anna avaimen tiedot."}</p>

            {open && open.loan_id && (
              <div className="ticket-form">
                <dl className="ticket-facts">
                  <div>
                    <dt>Haltija</dt>
                    <dd>{open.holder_name}</dd>
                  </div>
                  <div>
                    <dt>Luovutettu</dt>
                    <dd>{formatDate(open.handed_at ?? undefined)}</dd>
                  </div>
                  <div>
                    <dt>Palautus viimeistään</dt>
                    <dd>{open.due_date ? `${formatDay(open.due_date)}${isLate(open) ? " · myöhässä" : ""}` : "Ei sovittu"}</dd>
                  </div>
                  <div>
                    <dt>Lisätieto</dt>
                    <dd>{open.loan_note || "–"}</dd>
                  </div>
                </dl>
                <div className="draft-actions">
                  <button
                    className="primary"
                    disabled={saving}
                    onClick={() => void run(() => api(`/keys/${encodeURIComponent(open.id)}/return`, { method: "POST" }), "Palautuksen kuittaus epäonnistui.")}
                  >
                    Kuittaa palautetuksi
                  </button>
                </div>
              </div>
            )}

            {open && !open.loan_id && open.status !== "lost" && (
              <div className="ticket-form">
                <h3>Luovuta avain</h3>
                <Dropdown
                  label="Asukas"
                  value={residentId}
                  options={[
                    { value: "", label: "Muu vastaanottaja" },
                    ...residents.map(resident => ({
                      value: resident.id,
                      label: [resident.name, resident.apartment_number].filter(Boolean).join(" · ")
                    }))
                  ]}
                  onChange={setResidentId}
                />
                {!residentId && (
                  <label>
                    <span>Vastaanottajan nimi</span>
                    <input value={holderName} onChange={event => setHolderName(event.target.value)} maxLength={120} placeholder="Esim. Putki Oy, Matti Virtanen" />
                  </label>
                )}
                <label>
                  <span>Palautus viimeistään (valinnainen)</span>
                  <input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} />
                </label>
                <label>
                  <span>Lisätieto (valinnainen)</span>
                  <input value={loanNote} onChange={event => setLoanNote(event.target.value)} maxLength={300} placeholder="Esim. kylpyhuoneremontin ajaksi" />
                </label>
                <div className="draft-actions">
                  <button className="primary" disabled={saving || (!residentId && !holderName.trim())} onClick={() => handOver(open)}>
                    Luovuta avain
                  </button>
                </div>
              </div>
            )}

            <form className="ticket-form" onSubmit={handleSubmit}>
              {open && <h3>Avaimen tiedot</h3>}
              {!open && (
                <Dropdown
                  label="Taloyhtiö"
                  value={formCompany}
                  options={companies.map(company => ({ value: company.id, label: company.name }))}
                  onChange={value => { setFormCompany(value); setApartmentId(""); }}
                />
              )}

              <label>
                <span>Avaimen tunnus</span>
                <input value={code} onChange={event => setCode(event.target.value)} maxLength={60} placeholder="Esim. A12-1 tai Y-3" />
              </label>

              <Dropdown
                label="Tyyppi"
                value={type}
                options={(KEY_TYPES.includes(type) ? KEY_TYPES : [type, ...KEY_TYPES]).map(option => ({ value: option, label: option }))}
                onChange={setType}
              />

              <Dropdown
                label="Asunto"
                value={apartmentId}
                options={[
                  { value: "", label: "Ei asuntoa" },
                  ...apartments.map(apartment => ({ value: apartment.id, label: `${apartment.apartment_number} · ${apartment.address}` }))
                ]}
                onChange={setApartmentId}
              />

              <label>
                <span>Lisätieto</span>
                <input value={note} onChange={event => setNote(event.target.value)} maxLength={300} placeholder="Valinnainen, esim. sarjoitus tai säilytyspaikka" />
              </label>

              {open && (
                <label className="switch-row">
                  <span>
                    <strong>Avain on kadonnut</strong>
                    <small>Kadonnutta avainta ei voi luovuttaa.</small>
                  </span>
                  <input type="checkbox" role="switch" checked={lost} onChange={() => setLost(!lost)} />
                  <i aria-hidden="true" />
                </label>
              )}

              {error && <p className="send-error">{error}</p>}

              <div className="drawer-actions compact-actions">
                {open && isManager() && (
                  <button className="danger" type="button" onClick={() => handleDelete(open)} disabled={saving}>Poista</button>
                )}
                <button type="button" onClick={closeForm}>Peruuta</button>
                <button className="primary" type="submit" disabled={saving || !code.trim()}>
                  {saving ? "Tallennetaan…" : open ? "Tallenna muutokset" : "Lisää avain"}
                </button>
              </div>
            </form>

            {open && loans.length > 0 && (
              <>
                <h3>Luovutushistoria</h3>
                <ul className="move-people">
                  {loans.map(loan => (
                    <li key={loan.id}>
                      <strong>{loan.holder_name}</strong> · {formatDate(loan.handed_at)} – {loan.returned_at ? formatDate(loan.returned_at) : "ei palautettu"}
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
