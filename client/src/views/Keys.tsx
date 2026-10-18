import { type FormEvent, useEffect, useState } from "react";
import { DownloadLink, Dropdown, usePaged } from "../components/common";
import { ReporterField } from "../components/Reporter";
import { formatDate, formatDay } from "../format";
import { api, errorMessage, isManager } from "../session";
import type { Company, Resident } from "../types";
import { t } from "../i18n";
import { readTableFile } from "./Residents";

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
  holder_resident_id?: string | null;
  holder_email?: string | null;
  holder_apartment?: string | null;
  holder_address?: string | null;
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
  const [companyFilter, setCompanyFilter] = useState(companies.some(company => company.id === defaultCompanyId) ? defaultCompanyId : "all");
  const [stateFilter, setStateFilter] = useState("all");
  // keys = avainlista, apartments = avaimet asunnoittain.
  const [view, setView] = useState<"keys" | "apartments">("keys");
  const [allApartments, setAllApartments] = useState<(Apartment & { company_id: string })[]>([]);
  const [importing, setImporting] = useState(false);
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

  // Taloyhtiö-sarake vain, kun näkymässä on useita yhtiöitä.

  const multiCompany = companies.length > 1;

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

  // Asunnoittaisessa näkymässä näytetään myös asunnot, joilla ei ole avaimia.
  useEffect(() => {
    if (view !== "apartments") return;
    void Promise.all(companies.map(company =>
      api<Apartment[]>(`/companies/${encodeURIComponent(company.id)}/apartments`)
        .then(list => list.map(apartment => ({ ...apartment, company_id: company.id })))
        .catch(() => [])))
      .then(lists => setAllApartments(lists.flat()));
  }, [view, companies.length]);

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
  // Asunnon avainten määrä lasketaan avainriveistä, jotta luku ei voi mennä ristiin numeroiden kanssa.
  const apartmentRows = allApartments
    .filter(apartment => companyFilter === "all" || apartment.company_id === companyFilter)
    .map(apartment => ({ apartment, keys: visible.filter(key => key.apartment_id === apartment.id) }))
    .sort((a, b) => companyName(a.apartment.company_id).localeCompare(companyName(b.apartment.company_id), "fi")
      || a.apartment.apartment_number.localeCompare(b.apartment.apartment_number, "fi", { numeric: true }));
  const pagedApartments = usePaged(apartmentRows, `apartments|${companyFilter}|${stateFilter}`);
  // Vienti ja tuonti koskevat yhtä taloyhtiötä.
  const fileCompany = companyFilter !== "all" ? companyFilter : companies.length === 1 ? companies[0].id : "";
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

      <div className="card-tabs">
        <button className={view === "keys" ? "active" : ""} onClick={() => setView("keys")}>{t("Avaimet")}</button>
        <button className={view === "apartments" ? "active" : ""} onClick={() => setView("apartments")}>{t("Asunnoittain")}</button>
      </div>

      <div className="residents-toolbar">
        <span>{visible.length}{" "}{t("avainta ·")}{" "}{outCount}{" "}{t("luovutettu")}{lateCount > 0 ? t(" · {0} myöhässä", lateCount) : ""}</span>
        <div className="toolbar-actions">
          {fileCompany ? (
            <DownloadLink className="button-link secondary" path={`/companies/${encodeURIComponent(fileCompany)}/keys/export`} filename={t("avaimet.csv")}>
              {t("Vie tiedostoksi")}
            </DownloadLink>
          ) : (
            <button className="secondary" disabled title={t("Valitse ensin taloyhtiö.")}>{t("Vie tiedostoksi")}</button>
          )}
          <button className="secondary" onClick={() => setImporting(true)} disabled={!fileCompany} title={fileCompany ? undefined : t("Valitse ensin taloyhtiö.")}>
            {t("Tuo tiedostosta")}
          </button>
          <button className="secondary" onClick={() => openForm(null)}>{t("Lisää avain")}</button>
        </div>
      </div>

      {view === "apartments" && !loading && !loadError && (
        apartmentRows.length === 0 ? <div className="empty">{t("Ei asuntoja.")}</div> : (
          <div className="table-card">
            <table className="data-table report-topics">
              <thead>
                <tr>
                  <th>{t("Asunto")}</th>
                  {multiCompany && <th>{t("Taloyhtiö")}</th>}
                  <th>{t("Avaimia")}</th>
                  <th>{t("Avainnumerot")}</th>
                </tr>
              </thead>
              <tbody>
                {pagedApartments.items.map(({ apartment, keys: apartmentKeys }) => (
                  <tr key={apartment.id}>
                    <td><strong>{apartment.apartment_number}</strong>{apartment.address && <span>{apartment.address}</span>}</td>
                    {multiCompany && <td>{companyName(apartment.company_id)}</td>}
                    <td>{apartmentKeys.length}</td>
                    <td>
                      {apartmentKeys.length === 0 ? "–" : (
                        <span className="key-codes">
                          {apartmentKeys.map(key => (
                            <button key={key.id} type="button" className="key-code" title={keyState(key)} onClick={() => openForm(key)}>
                              {key.code}{key.status === "lost" ? ` (${t("kadonnut")})` : key.holder_name ? ` (${t("lainassa")})` : ""}
                            </button>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {view === "apartments" && !loading && !loadError && pagedApartments.pager}

      {view === "apartments" ? null
        : loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <div className="empty">{t("Avainten lataus epäonnistui.")}</div>
        : visible.length === 0 ? <div className="empty">{keys.length === 0 ? t("Ei avaimia. Lisää taloyhtiön avaimet rekisteriin.") : t("Ei suodattimia vastaavia avaimia.")}</div>
        : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("Tunnus")}</th>
                  <th>{t("Tyyppi")}</th>
                  {multiCompany && <th>{t("Taloyhtiö")}</th>}
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
                    {multiCompany && <td>{companyName(key.company_id)}</td>}
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
      {view === "keys" && !loading && !loadError && paged.pager}
      {view === "apartments" && (loading || loadError) && (
        <div className="empty">{loading ? t("Ladataan…") : t("Avainten lataus epäonnistui.")}</div>
      )}

      {importing && fileCompany && (
        <KeyImport
          companyId={fileCompany}
          companyName={companyName(fileCompany)}
          onClose={() => setImporting(false)}
          onImported={async () => {
            await loadKeys();
            onChanged?.();
          }}
        />
      )}

      {formOpen && (
        <div className="overlay">
          <aside className="drawer form-drawer resident-drawer">
            <button type="button" className="drawer-back" onClick={closeForm} disabled={saving}>{t("← Takaisin")}</button>
            <button className="close" onClick={closeForm} disabled={saving}>×</button>
            <h2>{open ? t("Avain {0}", open.code) : t("Lisää avain")}</h2>
            <p className="muted">{open ? `${companyName(open.company_id)} · ${keyState(open)}` : t("Valitse taloyhtiö ja anna avaimen tiedot.")}</p>

            {open && open.loan_id && (
              <div className="ticket-form">
                <ReporterField
                  label={t("Haltija")}
                  companyId={open.company_id}
                  reporter={{
                    id: open.holder_resident_id, name: open.holder_resident_id ? open.holder_name : null, email: open.holder_email,
                    apartment_number: open.holder_apartment, address: open.holder_address
                  }}
                  fallbackName={open.holder_name}
                />
                <dl className="ticket-facts">
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

type KeyImportRow = { line: number; apartment: string; code: string; type: string; note: string; state: string };
type KeyImportPlan = {
  created: { line: number; code: string; type: string; apartment: string }[];
  existing: { line: number; code: string; apartment: string }[];
  invalid: { line: number; code: string; apartment: string; reason: string }[];
  added: number;
};

// Sarakeotsikot, joista tuontitiedoston sarakkeet tunnistetaan (pienaakkosin, ilman välejä).
const KEY_COLUMNS: Record<Exclude<keyof KeyImportRow, "line">, string[]> = {
  apartment: ["asunto", "huoneisto", "apartment"],
  code: ["avainnumero", "avain", "numero", "tunnus", "code", "key"],
  type: ["tyyppi", "type"],
  note: ["huomio", "lisätieto", "note"],
  state: ["tila", "state", "status"]
};

// Muuntaa taulukon tuotaviksi avaimiksi. Avainnumero on pakollinen sarake, muut ovat valinnaisia.
export function tableToKeys(table: string[][]): { rows: KeyImportRow[]; missing: string[] } {
  if (table.length === 0) return { rows: [], missing: [] };
  const header = table[0].map(cell => cell.trim().toLowerCase().replace(/\s+/g, ""));
  const index = (key: keyof typeof KEY_COLUMNS) => header.findIndex(cell => KEY_COLUMNS[key].includes(cell));
  const columns = { apartment: index("apartment"), code: index("code"), type: index("type"), note: index("note"), state: index("state") };
  if (columns.code < 0) return { rows: [], missing: ["avainnumero"] };
  const cell = (cells: string[], column: number) => (column >= 0 ? cells[column] ?? "" : "").trim();
  return {
    missing: [],
    rows: table.slice(1).map((cells, rowIndex) => ({
      // Rivinumero sellaisena kuin se näkyy taulukkolaskennassa (otsikko on rivi 1).
      line: rowIndex + 2,
      apartment: cell(cells, columns.apartment),
      code: cell(cells, columns.code),
      type: cell(cells, columns.type),
      note: cell(cells, columns.note),
      state: cell(cells, columns.state)
    }))
  };
}

// Avainten tuonti CSV- tai Excel-tiedostosta. Palvelin näyttää ensin esikatselun: uudet avaimet,
// jo rekisterissä olevat (ohitetaan) ja virheelliset rivit syineen. Tallennus tapahtuu vasta erikseen.
function KeyImport({ companyId, companyName, onClose, onImported }: {
  companyId: string;
  companyName: string;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [format, setFormat] = useState<"csv" | "excel">("csv");
  const [rows, setRows] = useState<KeyImportRow[]>([]);
  const [plan, setPlan] = useState<KeyImportPlan | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send(importRows: KeyImportRow[], commit: boolean) {
    return api<KeyImportPlan>(`/companies/${encodeURIComponent(companyId)}/keys/import`, {
      method: "POST", body: JSON.stringify({ rows: importRows, commit })
    });
  }

  async function readFile(file: File | undefined) {
    setRows([]);
    setPlan(null);
    setDone(null);
    setError("");
    if (!file) return;
    let table: string[][];
    try {
      table = await readTableFile(file, format);
    } catch {
      setError(t("Excel-tiedoston lukeminen epäonnistui. Tiedoston pitää olla .xlsx-muodossa."));
      return;
    }
    const parsed = tableToKeys(table);
    if (parsed.missing.length > 0) {
      setError(t("Tiedostosta puuttuu sarake: {0}. Tarkista otsikkorivi.", parsed.missing.join(", ")));
      return;
    }
    if (parsed.rows.length === 0) {
      setError(t("Tiedostossa ei ole otsikkorivin lisäksi yhtään riviä."));
      return;
    }
    setBusy(true);
    try {
      setRows(parsed.rows);
      setPlan(await send(parsed.rows, false));
    } catch (previewError) {
      setError(errorMessage(previewError, t("Tiedoston tarkistus epäonnistui.")));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const saved = await send(rows, true);
      setDone(saved.added);
      setPlan(saved);
      await onImported();
    } catch (saveError) {
      setError(errorMessage(saveError, t("Avainten tuonti epäonnistui.")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay">
      <aside className="drawer form-drawer resident-drawer">
        <button type="button" className="drawer-back" onClick={onClose}>{t("← Takaisin")}</button>
        <button className="close" onClick={onClose}>×</button>
        <h2>{t("Tuo avaimia")}</h2>
        <p className="muted">{t("Taloyhtiö:")}{" "}{companyName}</p>
        <div className="card-tabs import-format">
          {(["csv", "excel"] as const).map(option => (
            <button key={option} className={format === option ? "active" : ""} onClick={() => { setFormat(option); setRows([]); setPlan(null); setDone(null); setError(""); }}>
              {option === "csv" ? t("CSV") : t("Excel")}
            </button>
          ))}
        </div>
        <p className="muted">
          {t("Ensimmäisen rivin pitää olla otsikkorivi. Sarake avainnumero on pakollinen, ja sarakkeet asunto, tyyppi, huomio ja tila ovat valinnaisia. Asunto tunnistetaan taloyhtiön asunnoista, esim. A 12. Avainrekisterin vienti tuottaa saman muodon.")}
        </p>
        <pre className="csv-example">{t("asunto;avainnumero;tyyppi;huomio;tila")}{"\n"}{t("A 12;A12-1;Asunto;;käytössä")}</pre>

        <div className="ticket-form">
          <label>
            <span>{format === "csv" ? t("CSV-tiedosto") : t("Excel-tiedosto (.xlsx)")}</span>
            <input
              key={format}
              type="file"
              accept={format === "csv" ? ".csv,text/csv" : ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
              onChange={event => void readFile(event.target.files?.[0])}
            />
          </label>

          {busy && !plan && <p className="reply-hint">{t("Tarkistetaan tiedostoa…")}</p>}

          {plan && (
            <>
              <div className={`ai-reason ${plan.invalid.length === 0 ? "created" : "found"}`}>
                {done === null
                  ? t("Uusia avaimia {0}, jo rekisterissä {1} (ohitetaan), virheellisiä rivejä {2}.", plan.created.length, plan.existing.length, plan.invalid.length)
                  : t("Lisätty {0} avainta. Jo rekisterissä olleet {1} riviä ohitettiin.", done, plan.existing.length)}
              </div>
              {done === null && plan.created.length > 0 && (
                <div className="table-card">
                  <table className="data-table">
                    <thead>
                      <tr><th>{t("Rivi")}</th><th>{t("Asunto")}</th><th>{t("Avainnumero")}</th><th>{t("Tyyppi")}</th></tr>
                    </thead>
                    <tbody>
                      {plan.created.slice(0, 10).map(row => (
                        <tr key={row.line}><td>{row.line}</td><td>{row.apartment || "–"}</td><td>{row.code}</td><td>{t(row.type)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  {plan.created.length > 10 && <p className="reply-hint">{t("…ja {0} muuta.", plan.created.length - 10)}</p>}
                </div>
              )}
              {plan.existing.length > 0 && (
                <details>
                  <summary>{t("Jo rekisterissä ({0})", plan.existing.length)}</summary>
                  <ul className="import-skipped">
                    {plan.existing.map(row => <li key={row.line}><strong>{t("Rivi")}{" "}{row.line}:</strong> {row.code}</li>)}
                  </ul>
                </details>
              )}
              {plan.invalid.length > 0 && (
                <ul className="import-skipped">
                  {plan.invalid.map(row => (
                    <li key={row.line}><strong>{t("Rivi")}{" "}{row.line}{row.code ? ` (${row.code})` : ""}:</strong> {row.reason}</li>
                  ))}
                </ul>
              )}
            </>
          )}

          {error && <p className="send-error">{error}</p>}

          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>{done !== null ? t("Sulje") : t("Peruuta")}</button>
            {done === null && (
              <button className="primary" type="button" onClick={() => void save()} disabled={busy || !plan || plan.created.length === 0}>
                {busy && plan ? t("Tuodaan…") : t("Tuo {0} avainta", plan?.created.length ?? 0)}
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
