import { type FormEvent, useEffect, useState } from "react";
import { usePaged } from "../components/common";
import { api, errorMessage, isAdmin, isManager } from "../session";
import type { Company, Resident } from "../types";

export function Residents({
  companyId,
  companies,
  onCompanyChange,
  onChanged
}: {
  companyId: string;
  companies: Company[];
  // Annettuna näkymä on koko asukastietokanta: kaikkien taloyhtiöiden asukkaat ja suodattimet.
  // Ilman tätä näytetään vain yhden, lukitun taloyhtiön asukkaat.
  onCompanyChange?: (companyId: string) => void;
  onChanged: () => Promise<void>;
}) {
  const allCompanies = Boolean(onCompanyChange);
  const companyName = companies.find(company => company.id === companyId)?.name ?? "Taloyhtiö";
  const [residents, setResidents] = useState<Resident[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [companyFilter, setCompanyFilter] = useState("all");
  const [emailFilter, setEmailFilter] = useState("all");
  const [search, setSearch] = useState("");
  // Uuden asukkaan taloyhtiö, kun näkymässä on kaikki yhtiöt.
  const [formCompanyId, setFormCompanyId] = useState(companyId);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [adding, setAdding] = useState(false);
  // Muokattava asukas; null = lomakkeella lisätään uutta asukasta.
  const [editing, setEditing] = useState<Resident | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [apartmentNumber, setApartmentNumber] = useState("");
  const [residentPassword, setResidentPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  function openForm(resident: Resident | null) {
    setResidentPassword("");
    setEditing(resident);
    setName(resident?.name ?? "");
    setEmail(resident?.email ?? "");
    setAddress(resident?.address ?? "");
    setApartmentNumber(resident?.apartment_number ?? "");
    setFormError("");
    setFormCompanyId(companyFilter !== "all" ? companyFilter : companyId);
    setAdding(true);
  }

  async function loadResidents() {
    try {
      if (allCompanies) {
        const lists = await Promise.all(companies.map(async company =>
          (await api<Resident[]>(`/companies/${encodeURIComponent(company.id)}/residents`))
            .map(resident => ({ ...resident, company_id: company.id, company_name: company.name }))
        ));
        setResidents(lists.flat().sort((a, b) => a.name.localeCompare(b.name, "fi")));
      } else {
        setResidents(await api<Resident[]>(`/companies/${encodeURIComponent(companyId)}/residents`));
      }
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void loadResidents();
  }, [companyId, allCompanies, companies.length]);

  const searchText = search.trim().toLowerCase();
  const visibleResidents = allCompanies
    ? residents.filter(resident =>
        (companyFilter === "all" || resident.company_id === companyFilter)
        && (emailFilter === "all" || (emailFilter === "with") === Boolean(resident.email))
        && (!searchText || [resident.name, resident.email, resident.address, resident.apartment_number]
          .some(value => value?.toLowerCase().includes(searchText))))
    : residents;
  // Sarakeotsikot; taloyhtiösarake on mukana vain koko asukastietokannassa.
  const residentColumns: { key: ResidentSortKey; label: string }[] = [
    { key: "name", label: "Nimi" },
    { key: "email", label: "Sähköposti" },
    ...(allCompanies ? [{ key: "company" as const, label: "Taloyhtiö" }] : []),
    { key: "address", label: "Osoite" },
    { key: "apartment", label: "Asunto" }
  ];
  const [residentSort, setResidentSort] = useState<{ key: ResidentSortKey; descending: boolean } | null>(null);
  const residentSortValue = (resident: Resident, key: ResidentSortKey) => ({
    name: resident.name,
    email: resident.email ?? "",
    company: resident.company_name ?? "",
    address: resident.address,
    apartment: resident.apartment_number
  })[key];
  const sortedResidents = residentSort
    ? [...visibleResidents].sort((a, b) =>
        residentSortValue(a, residentSort.key).localeCompare(residentSortValue(b, residentSort.key), "fi", { numeric: true })
        * (residentSort.descending ? -1 : 1))
    : visibleResidents;
  const pagedResidents = usePaged(sortedResidents, [
    companyId, companyFilter, emailFilter, searchText, residentSort?.key, residentSort?.descending
  ].join("|"));

  const residentFilters: { key: string; label: string; value: string; clear: () => void }[] = [
    ...(companyFilter !== "all"
      ? [{
          key: "company",
          label: "Taloyhtiö",
          value: companies.find(company => company.id === companyFilter)?.name ?? "",
          clear: () => setCompanyFilter("all")
        }]
      : []),
    ...(emailFilter !== "all"
      ? [{
          key: "email",
          label: "Sähköposti",
          value: emailFilter === "with" ? "On sähköposti" : "Ei sähköpostia",
          clear: () => setEmailFilter("all")
        }]
      : []),
    ...(searchText ? [{ key: "search", label: "Haku", value: search.trim(), clear: () => setSearch("") }] : [])
  ];

  function closeForm() {
    setAdding(false);
    setFormError("");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError("");
    try {
      await api(editing
        ? `/residents/${encodeURIComponent(editing.id)}`
        : `/companies/${encodeURIComponent(allCompanies ? formCompanyId : companyId)}/residents`, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({ name, email, address, apartmentNumber, password: residentPassword || undefined })
      });
      setName("");
      setEmail("");
      setAddress("");
      setApartmentNumber("");
      setAdding(false);
      await loadResidents();
      await onChanged();
    } catch (error) {
      let message = editing ? "Asukkaan tietojen tallennus epäonnistui." : "Asukkaan lisääminen epäonnistui.";
      try {
        message = JSON.parse((error as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  // Lataa asukkaasta tallennetut tiedot tiedostona (tietosuoja-asetuksen mukainen tietopyyntö).
  async function exportResident(resident: Resident) {
    setFormError("");
    try {
      const data = await api<unknown>(`/residents/${encodeURIComponent(resident.id)}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `asukkaan-tiedot-${resident.name.toLowerCase().replace(/[^a-z0-9åäö]+/g, "-")}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setFormError(errorMessage(error, "Tietojen vienti epäonnistui."));
    }
  }

  // Poistaa asukkaan henkilötiedot pysyvästi; tehtävät jäävät historiaan ilman nimeä ja viestejä.
  async function eraseResident(resident: Resident) {
    if (!window.confirm(
      `Poistetaanko asukkaan ${resident.name} henkilötiedot pysyvästi?\n\n`
      + "Nimi, sähköposti, kirjautumistunnus, viestit, liitteet, tulevat vuorot, jonotukset ja muuttoilmoitukset poistetaan. "
      + "Tehtävät jäävät historiaan ilman nimeä. Poistoa ei voi perua."
    )) return;
    setSubmitting(true);
    setFormError("");
    try {
      await api(`/residents/${encodeURIComponent(resident.id)}`, { method: "DELETE" });
      setAdding(false);
      await loadResidents();
      await onChanged();
    } catch (error) {
      setFormError(errorMessage(error, "Asukkaan tietojen poisto epäonnistui."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="content">
      {allCompanies && <a className="back-link" href="#/companies">← Taloyhtiöt</a>}

      {allCompanies && filtersOpen && (
        <div className="ticket-filters">
          <label>
            <span>Taloyhtiö</span>
            <select value={companyFilter} onChange={event => setCompanyFilter(event.target.value)}>
              <option value="all">Kaikki</option>
              {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>
          <label>
            <span>Sähköposti</span>
            <select value={emailFilter} onChange={event => setEmailFilter(event.target.value)}>
              <option value="all">Kaikki</option>
              <option value="with">On sähköposti</option>
              <option value="without">Ei sähköpostia</option>
            </select>
          </label>
          <label>
            <span>Haku</span>
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Nimi, sähköposti, osoite tai asunto"
            />
          </label>
          {residentFilters.length > 0 && (
            <button className="clear-filters" onClick={() => {
              setCompanyFilter("all");
              setEmailFilter("all");
              setSearch("");
            }}>Tyhjennä suodattimet</button>
          )}
        </div>
      )}

      <div className="residents-toolbar">
        <div className="filter-chips">
          {allCompanies && (
            <button
              className={`filter-toggle ${filtersOpen || residentFilters.length > 0 ? "active" : ""}`}
              onClick={() => setFiltersOpen(!filtersOpen)}
              title={filtersOpen ? "Piilota suodattimet" : "Näytä suodattimet"}
              aria-label={filtersOpen ? "Piilota suodattimet" : "Näytä suodattimet"}
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
              {residentFilters.length > 0 && <i />}
            </button>
          )}
          <span>
            {allCompanies
              ? `Kaikki taloyhtiöt · ${visibleResidents.length === residents.length
                ? `${residents.length} asukasta`
                : `${visibleResidents.length} / ${residents.length} asukasta`}`
              : `${companyName} · ${residents.length} asukasta`}
          </span>
          {residentFilters.map(filter => (
            <span className="filter-chip" key={filter.key}>
              <small>{filter.label}</small>
              {filter.value}
              <button onClick={filter.clear} title="Poista suodatin" aria-label={`Poista suodatin ${filter.label}`}>×</button>
            </span>
          ))}
        </div>
        <div className="toolbar-actions">
          <button className="secondary" onClick={() => setImporting(true)}>Tuo asukkaita</button>
          <button className="secondary" onClick={() => openForm(null)}>Lisää asukas</button>
        </div>
      </div>

      {!loading && !loadError && residents.length > 0 && (
        <div className={`ticket-row-header resident-row-header ${allCompanies ? "with-company" : ""}`}>
          {residentColumns.map(column => {
            const active = residentSort?.key === column.key;
            return (
              <button
                key={column.key}
                className={active ? "active" : ""}
                onClick={() => setResidentSort(current => current?.key === column.key
                  ? { key: column.key, descending: !current.descending }
                  : { key: column.key, descending: false })}
                title={`Järjestä sarakkeen ${column.label} mukaan`}
                aria-sort={active ? (residentSort.descending ? "descending" : "ascending") : undefined}
              >
                {column.label}
                <svg
                  className={active && !residentSort.descending ? "up" : ""}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.500"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            );
          })}
        </div>
      )}

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <div className="empty">Asukkaiden lataus epäonnistui. Tarkista, että palvelin on käynnistetty uudelleen.</div>
        : visibleResidents.length === 0
          ? <div className="empty">{residents.length === 0 ? "Ei asukkaita." : "Ei suodattimia vastaavia asukkaita."}</div>
        : pagedResidents.items.map(resident => (
          <article
            className={`resident-row clickable ${allCompanies ? "with-company" : ""}`}
            key={resident.id}
            title="Avaa asukkaan tiedot"
            role="button"
            tabIndex={0}
            onClick={() => openForm(resident)}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openForm(resident);
              }
            }}
          >
            <strong>{resident.name}</strong>
            <span>{resident.email || "Ei sähköpostia"}</span>
            {allCompanies && <span>{resident.company_name}</span>}
            <span>{resident.address}</span>
            <span className="type">{resident.apartment_number}</span>
          </article>
        ))}
      {!loading && !loadError && pagedResidents.pager}

      {importing && (
        <ResidentImport
          companies={companies}
          // Yhden yhtiön näkymässä yhtiö on lukittu; koko tietokannassa se valitaan lomakkeella.
          lockedCompanyId={allCompanies ? null : companyId}
          defaultCompanyId={companyFilter !== "all" ? companyFilter : companyId}
          onClose={() => setImporting(false)}
          onImported={async () => {
            await loadResidents();
            await onChanged();
          }}
        />
      )}

      {adding && (
        <div className="overlay" onClick={closeForm}>
          <aside className="drawer form-drawer resident-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={closeForm}>×</button>
            <h2>{editing ? editing.name : "Lisää asukas"}</h2>
            <p className="muted">
              {editing
                ? `Asukkaan tiedot · ${editing.company_name ?? companyName}`
                : allCompanies ? "Valitse taloyhtiö, johon asukas lisätään." : `Asukas lisätään taloyhtiöön ${companyName}.`}
            </p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              {allCompanies && !editing && (
                <label>
                  <span>Taloyhtiö</span>
                  <select value={formCompanyId} onChange={event => setFormCompanyId(event.target.value)}>
                    {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
                  </select>
                </label>
              )}

              <label>
                <span>Nimi</span>
                <input value={name} onChange={event => setName(event.target.value)} placeholder="Esim. Matti Meikäläinen" />
              </label>

              <label>
                <span>Sähköposti</span>
                <input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="Valinnainen" />
              </label>

              <label>
                <span>Osoite</span>
                <input value={address} onChange={event => setAddress(event.target.value)} placeholder="Esim. Koivikkotie 10" />
              </label>

              <label>
                <span>Asunto</span>
                <input value={apartmentNumber} onChange={event => setApartmentNumber(event.target.value)} placeholder="Esim. A 12" />
              </label>

              {isAdmin() && (
                <label>
                  <span>{editing?.has_password ? "Uusi salasana" : "Salasana"}</span>
                  <input
                    type="password"
                    value={residentPassword}
                    onChange={event => setResidentPassword(event.target.value)}
                    placeholder={editing?.has_password ? "Jätä tyhjäksi, jos salasanaa ei vaihdeta" : "Valinnainen, vähintään 8 merkkiä"}
                    autoComplete="new-password"
                  />
                </label>
              )}
              <p className="reply-hint">
                {editing?.has_password
                  ? "Asukkaalla on salasana, ja hän voi kirjautua sähköpostillaan asukasportaaliin."
                  : "Salasanan asettamisen jälkeen asukas voi kirjautua sähköpostillaan ja nähdä omat yhteydenottonsa ja vuoronsa."}
                {!isAdmin() && " Salasanan voi asettaa tai vaihtaa vain pääkäyttäjä."}
              </p>

              {formError && <p className="send-error">{formError}</p>}

              <div className="drawer-actions compact-actions">
                <button type="button" onClick={closeForm}>Peruuta</button>
                <button
                  className="primary"
                  type="submit"
                  disabled={submitting || !name.trim() || !address.trim() || !apartmentNumber.trim()}
                >
                  {editing
                    ? submitting ? "Tallennetaan…" : "Tallenna muutokset"
                    : submitting ? "Lisätään…" : "Lisää asukas"}
                </button>
              </div>

              {editing && isManager() && (
                <div className="privacy-actions">
                  <h3>Tietosuoja</h3>
                  <p className="reply-hint">
                    Vie asukkaasta tallennetut tiedot tiedostona tai poista henkilötiedot pysyvästi asukkaan pyynnöstä.
                  </p>
                  <div className="drawer-actions compact-actions">
                    <button type="button" disabled={submitting} onClick={() => exportResident(editing)}>Vie tiedot</button>
                    <button type="button" className="danger" disabled={submitting} onClick={() => eraseResident(editing)}>
                      Poista henkilötiedot
                    </button>
                  </div>
                </div>
              )}
            </form>
          </aside>
        </div>
      )}
    </section>
  );
}

type ResidentSortKey = "name" | "email" | "company" | "address" | "apartment";

type ImportRow = { line: number; name: string; email: string; address: string; apartmentNumber: string };

// Sarakeotsikot, joista CSV:n sarakkeet tunnistetaan (pienaakkosin, ilman välejä).
const CSV_COLUMNS: Record<keyof Omit<ImportRow, "line">, string[]> = {
  name: ["nimi", "name", "asukas"],
  email: ["sähköposti", "sahkoposti", "email", "e-mail", "sposti"],
  address: ["osoite", "address", "katuosoite"],
  apartmentNumber: ["asunto", "huoneisto", "asuntonumero", "apartment"]
};

// Jäsentää CSV-tekstin riveiksi. Erotin (; , tai sarkain) päätellään otsikkoriviltä, ja
// lainausmerkeissä oleva kenttä saa sisältää erottimen ja rivinvaihdon.
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [";", ",", "\t"].reduce((best, candidate) =>
    firstLine.split(candidate).length > firstLine.split(best).length ? candidate : best, ";");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (quoted) {
      if (char === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(cells => cells.some(cell => cell.trim()));
}

// Muuntaa taulukon (otsikkorivi + rivit) tuotaviksi asukkaiksi; sama CSV:lle ja Excelille.
export function tableToResidents(table: string[][]): { rows: ImportRow[]; missing: string[] } {
  if (table.length === 0) return { rows: [], missing: [] };

  const header = table[0].map(cell => cell.trim().toLowerCase().replace(/\s+/g, ""));
  const index = (key: keyof typeof CSV_COLUMNS) => header.findIndex(cell => CSV_COLUMNS[key].includes(cell));
  const columns = { name: index("name"), email: index("email"), address: index("address"), apartmentNumber: index("apartmentNumber") };

  const missing = [
    columns.name < 0 ? "nimi" : "",
    columns.address < 0 ? "osoite" : "",
    columns.apartmentNumber < 0 ? "asunto" : ""
  ].filter(Boolean);
  if (missing.length > 0) return { rows: [], missing };

  return {
    missing: [],
    rows: table.slice(1).map((cells, rowIndex) => ({
      // Rivinumero sellaisena kuin se näkyy taulukkolaskennassa (otsikko on rivi 1).
      line: rowIndex + 2,
      name: (cells[columns.name] ?? "").trim(),
      email: columns.email >= 0 ? (cells[columns.email] ?? "").trim() : "",
      address: (cells[columns.address] ?? "").trim(),
      apartmentNumber: (cells[columns.apartmentNumber] ?? "").trim()
    }))
  };
}

function ResidentImport({
  companies,
  lockedCompanyId,
  defaultCompanyId,
  onClose,
  onImported
}: {
  companies: Company[];
  lockedCompanyId: string | null;
  defaultCompanyId: string;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [targetCompany, setTargetCompany] = useState(lockedCompanyId ?? defaultCompanyId);
  const [format, setFormat] = useState<"csv" | "excel">("csv");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ added: number; skipped: { line: number; name: string; reason: string }[] } | null>(null);

  async function readFile(file: File | undefined) {
    setRows([]);
    setResult(null);
    setError("");
    setFileName(file?.name ?? "");
    if (!file) return;

    let table: string[][];
    if (format === "excel") {
      try {
        // Excel-lukija ladataan vasta tarvittaessa. Luetaan työkirjan ensimmäinen välilehti.
        const { readSheet } = await import("read-excel-file/browser");
        table = (await readSheet(file))
          .map(cells => cells.map(cell => cell == null ? "" : String(cell)))
          .filter(cells => cells.some(cell => cell.trim()));
      } catch {
        setError("Excel-tiedoston lukeminen epäonnistui. Tiedoston pitää olla .xlsx-muodossa.");
        return;
      }
    } else {
      const buffer = await file.arrayBuffer();
      let text = new TextDecoder("utf-8").decode(buffer);
      // Excelin tallentama CSV on usein Windows-merkistössä, jolloin ääkköset eivät aukea UTF-8:na.
      if (text.includes("\uFFFD")) text = new TextDecoder("windows-1252").decode(buffer);
      table = parseCsv(text);
    }

    const parsed = tableToResidents(table);
    if (parsed.missing.length > 0) {
      setError(`Tiedostosta puuttuu sarake: ${parsed.missing.join(", ")}. Tarkista otsikkorivi.`);
    } else if (parsed.rows.length === 0) {
      setError("Tiedostossa ei ole otsikkorivin lisäksi yhtään riviä.");
    } else {
      setRows(parsed.rows);
    }
  }

  async function handleImport() {
    setSubmitting(true);
    setError("");
    try {
      const imported = await api<NonNullable<typeof result>>(
        `/companies/${encodeURIComponent(targetCompany)}/residents/import`,
        { method: "POST", body: JSON.stringify({ rows }) }
      );
      setResult(imported);
      setRows([]);
      if (imported.added > 0) await onImported();
    } catch (importError) {
      setError(errorMessage(importError, "Asukkaiden tuonti epäonnistui."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer form-drawer resident-drawer" onClick={event => event.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        <h2>Tuo asukkaita</h2>
        <div className="card-tabs import-format">
          {(["csv", "excel"] as const).map(option => (
            <button
              key={option}
              className={format === option ? "active" : ""}
              onClick={() => {
                setFormat(option);
                setRows([]);
                setResult(null);
                setError("");
                setFileName("");
              }}
            >
              {option === "csv" ? "CSV" : "Excel"}
            </button>
          ))}
        </div>
        <p className="muted">
          Ensimmäisen rivin pitää olla otsikkorivi, jossa on sarakkeet <strong>nimi</strong>, <strong>osoite</strong> ja{" "}
          <strong>asunto</strong>. Sarake <strong>sähköposti</strong> on valinnainen.{" "}
          {format === "csv"
            ? "Erottimena käy puolipiste tai pilkku."
            : "Tiedoston pitää olla .xlsx-muodossa, ja asukkaat luetaan ensimmäiseltä välilehdeltä."}
        </p>
        {format === "csv" ? (
          <pre className="csv-example">nimi;sähköposti;osoite;asunto{"\n"}Matti Meikäläinen;matti@example.com;Koivikkotie 10;A 12</pre>
        ) : (
          <div className="table-card import-example">
            <table className="data-table">
              <thead>
                <tr><th>nimi</th><th>sähköposti</th><th>osoite</th><th>asunto</th></tr>
              </thead>
              <tbody>
                <tr><td>Matti Meikäläinen</td><td>matti@example.com</td><td>Koivikkotie 10</td><td>A 12</td></tr>
              </tbody>
            </table>
          </div>
        )}

        <div className="ticket-form">
          {!lockedCompanyId && (
            <label>
              <span>Taloyhtiö, johon asukkaat tuodaan</span>
              <select value={targetCompany} onChange={event => setTargetCompany(event.target.value)}>
                {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            </label>
          )}

          <label>
            <span>{format === "csv" ? "CSV-tiedosto" : "Excel-tiedosto (.xlsx)"}</span>
            <input
              // Muodon vaihto tyhjentää valitun tiedoston.
              key={format}
              type="file"
              accept={format === "csv"
                ? ".csv,text/csv"
                : ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
              onChange={event => void readFile(event.target.files?.[0])}
            />
          </label>

          {rows.length > 0 && (
            <>
              <p className="reply-hint">{fileName}: {rows.length} riviä. Esikatselu ensimmäisistä riveistä:</p>
              <div className="table-card">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Nimi</th>
                      <th>Sähköposti</th>
                      <th>Osoite</th>
                      <th>Asunto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map(row => (
                      <tr key={row.line}>
                        <td>{row.name || "–"}</td>
                        <td>{row.email || "–"}</td>
                        <td>{row.address || "–"}</td>
                        <td>{row.apartmentNumber || "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {result && (
            <div className={`ai-reason ${result.skipped.length === 0 ? "created" : "found"}`}>
              Lisätty {result.added} asukasta{result.skipped.length > 0 ? `, ohitettu ${result.skipped.length} riviä.` : "."}
            </div>
          )}
          {result && result.skipped.length > 0 && (
            <ul className="import-skipped">
              {result.skipped.map(skip => (
                <li key={skip.line}>
                  <strong>Rivi {skip.line}{skip.name ? ` (${skip.name})` : ""}:</strong> {skip.reason}
                </li>
              ))}
            </ul>
          )}

          {error && <p className="send-error">{error}</p>}

          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>{result ? "Sulje" : "Peruuta"}</button>
            {!result && (
              <button className="primary" type="button" onClick={handleImport} disabled={submitting || rows.length === 0}>
                {submitting ? "Tuodaan…" : rows.length > 0 ? `Tuo ${rows.length} asukasta` : "Tuo asukkaat"}
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
