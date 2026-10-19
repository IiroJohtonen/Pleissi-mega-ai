import { type FormEvent, useEffect, useState } from "react";
import { usePaged } from "../components/common";
import { formatDateOnly } from "../format";
import { api, errorMessage, isAdmin, isManager } from "../session";
import type { Company, Resident } from "../types";
import { t } from "../i18n";
import { ApartmentPicker, type ApartmentRow, RoleTags } from "./Apartments";

type OpenTicket = { id: string; ticket_number: number | null; subject: string; type: string; status: string; created_at: string };

const ERASURE_OTHER = "Muu peruste";
// Säilytyksen perusteet: asia on kesken, tai tietoja tarvitaan oikeusvaateeseen (GDPR 17 art. 3 kohta).
const ERASURE_REASONS = [
  "Kesken oleva vahinko- tai korjausasia",
  "Mahdollinen korvaus- tai vakuutusasia",
  ERASURE_OTHER
];

export function Residents({
  companyId,
  companies,
  onCompanyChange,
  onChanged,
  openResidentId,
  onResidentClosed,
  onOpenResident,
  formCompanies = companies
}: {
  // Annettuna asukkaan avaaminen vaihtaa osoitetta, ja asukas näytetään omana sivunaan.
  onOpenResident?: (residentId: string) => void;
  // Taloyhtiöt, joihin uuden asukkaan voi lisätä; taloyhtiö kysytään aina lisättäessä.
  formCompanies?: Company[];
  // Avattava asukas (osoite #/residents/<id>), esim. ilmoittajakentän painikkeesta.
  openResidentId?: string | null;
  onResidentClosed?: () => void;
  companyId: string;
  companies: Company[];
  // Annettuna näkymä on koko asukastietokanta: kaikkien taloyhtiöiden asukkaat ja suodattimet.
  // Ilman tätä näytetään vain yhden, lukitun taloyhtiön asukkaat.
  onCompanyChange?: (companyId: string) => void;
  onChanged: () => Promise<void>;
}) {
  const allCompanies = Boolean(onCompanyChange);
  const companyName = companies.find(company => company.id === companyId)?.name ?? t("Taloyhtiö");
  const [residents, setResidents] = useState<Resident[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Kaikkien yhtiöiden näkymässä oletuksena yläpalkissa valittu taloyhtiö.
  const [companyFilter, setCompanyFilter] = useState(allCompanies && companies.some(company => company.id === companyId) ? companyId : "all");
  const [emailFilter, setEmailFilter] = useState("all");
  const [search, setSearch] = useState("");
  // Uuden asukkaan taloyhtiö; oletuksena näkymän taloyhtiö.
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
  const [staircase, setStaircase] = useState("");
  // Valittu asunto; "new" = uusi asunto kirjoitetaan numerona ja osoitteena.
  const [apartmentId, setApartmentId] = useState("");
  const [apartmentOptions, setApartmentOptions] = useState<ApartmentRow[]>([]);
  // Henkilön roolit asunnossa: osakas, asukas tai molemmat.
  const [roles, setRoles] = useState<string[]>(["asukas"]);
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
    setStaircase(resident?.staircase ?? "");
    setApartmentId(resident?.apartment_id ?? "");
    setRoles(resident ? (resident.roles ?? "asukas").split(",").filter(Boolean) : ["asukas"]);
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

  // Osoitteessa annettu asukas avataan, kun lista on ladattu. Toisen taloyhtiön asukkaalle vaihdetaan suodatin.
  const [openedFromRoute, setOpenedFromRoute] = useState("");
  useEffect(() => {
    if (!openResidentId || openResidentId === openedFromRoute || loading) return;
    const resident = residents.find(candidate => candidate.id === openResidentId);
    if (!resident) return;
    setOpenedFromRoute(openResidentId);
    if (allCompanies && resident.company_id && companyFilter !== "all" && resident.company_id !== companyFilter) {
      setCompanyFilter(resident.company_id);
    }
    openForm(resident);
  }, [openResidentId, residents, loading]);

  // Osoitteesta poistunut asukas (esim. selaimen takaisin-painike) sulkee asukkaan sivun.
  useEffect(() => {
    if (onOpenResident && !openResidentId && editing) {
      setAdding(false);
      setEditing(null);
      setOpenedFromRoute("");
    }
  }, [openResidentId]);

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
    { key: "name", label: t("Nimi") },
    { key: "email", label: t("Sähköposti") },
    ...(allCompanies ? [{ key: "company" as const, label: t("Taloyhtiö") }] : []),
    { key: "address", label: t("Osoite") },
    { key: "apartment", label: t("Asunto") }
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
          label: t("Taloyhtiö"),
          value: companies.find(company => company.id === companyFilter)?.name ?? "",
          clear: () => setCompanyFilter("all")
        }]
      : []),
    ...(emailFilter !== "all"
      ? [{
          key: "email",
          label: t("Sähköposti"),
          value: emailFilter === "with" ? t("On sähköposti") : t("Ei sähköpostia"),
          clear: () => setEmailFilter("all")
        }]
      : []),
    ...(searchText ? [{ key: "search", label: t("Haku"), value: search.trim(), clear: () => setSearch("") }] : [])
  ];

  // Lomakkeen taloyhtiön asunnot asuntovalintaan.
  const formCompany = editing ? (editing.company_id ?? companyId) : formCompanyId;
  useEffect(() => {
    if (!adding) return;
    api<ApartmentRow[]>(`/companies/${encodeURIComponent(formCompany)}/apartments`).then(setApartmentOptions).catch(() => setApartmentOptions([]));
  }, [adding, formCompany]);

  function closeForm() {
    if (openedFromRoute && editing?.id === openedFromRoute) onResidentClosed?.();
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
        : `/companies/${encodeURIComponent(formCompanyId)}/residents`, {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({
          name, email, roles, password: residentPassword || undefined,
          ...(apartmentId && apartmentId !== "new" ? { apartmentId } : { address, apartmentNumber, staircase })
        })
      });
      setName("");
      setEmail("");
      setAddress("");
      setApartmentNumber("");
      setAdding(false);
      // Asukkaan sivulta palataan tallennuksen jälkeen listaan.
      if (onOpenResident && editing) onResidentClosed?.();
      await loadResidents();
      await onChanged();
    } catch (error) {
      let message = editing ? t("Asukkaan tietojen tallennus epäonnistui.") : t("Asukkaan lisääminen epäonnistui.");
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
      setFormError(errorMessage(error, t("Tietojen vienti epäonnistui.")));
    }
  }

  // Poistopyyntö: ensin haetaan asukkaan avoimet tehtävät. Kesken olevan asian (esim. vesivahingon)
  // tehtävät voi säilyttää perusteineen; ne anonymisoidaan, kun tehtävä suljetaan.
  const [erasure, setErasure] = useState<{ openTickets: OpenTicket[]; keep: Set<string>; reason: string; other: string } | null>(null);
  useEffect(() => setErasure(null), [editing?.id]);

  async function startErasure(resident: Resident) {
    setFormError("");
    try {
      const preview = await api<{ openTickets: OpenTicket[] }>(`/residents/${encodeURIComponent(resident.id)}/erasure-preview`);
      if (preview.openTickets.length === 0) {
        await eraseResident(resident, [], "");
        return;
      }
      setErasure({ openTickets: preview.openTickets, keep: new Set(), reason: ERASURE_REASONS[0], other: "" });
    } catch (error) {
      setFormError(errorMessage(error, t("Asukkaan tehtävien haku epäonnistui.")));
    }
  }

  // Poistaa asukkaan henkilötiedot pysyvästi; tehtävät jäävät historiaan ilman nimeä ja viestejä.
  async function eraseResident(resident: Resident, keepTicketIds: string[], keepReason: string) {
    if (!window.confirm(
      t("Poistetaanko asukkaan {0} henkilötiedot pysyvästi?\n\n", resident.name)
      + t("Nimi, sähköposti, kirjautumistunnus, viestit, liitteet, tulevat vuorot, jonotukset ja muuttoilmoitukset poistetaan. ")
      + (keepTicketIds.length
        ? t("Säilytettävät tehtävät ({0}) anonymisoidaan, kun ne suljetaan. ", String(keepTicketIds.length))
        : "")
      + t("Tehtävät jäävät historiaan ilman nimeä. Poistoa ei voi perua.")
    )) return;
    setSubmitting(true);
    setFormError("");
    try {
      await api(`/residents/${encodeURIComponent(resident.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ keepTicketIds, keepReason })
      });
      setErasure(null);
      setAdding(false);
      if (onOpenResident) onResidentClosed?.();
      await loadResidents();
      await onChanged();
    } catch (error) {
      setFormError(errorMessage(error, t("Asukkaan tietojen poisto epäonnistui.")));
    } finally {
      setSubmitting(false);
    }
  }

  // Avattu asukas on oma sivunsa (#/residents/<asukas>), kun näkymä on osoitteen ohjaama; uusi asukas
  // lisätään sivulta avautuvalla lomakkeella.
  const asPage = Boolean(onOpenResident && editing);
  const Frame = asPage ? "section" : "div";
  const residentForm = adding ? (
        <Frame className={asPage ? "record-page" : "overlay"}>
          <aside className="drawer form-drawer resident-drawer">
            <button type="button" className="drawer-back" onClick={closeForm}>{t("← Takaisin")}</button>
            <button className="close" onClick={closeForm}>×</button>
            <h2>{editing ? editing.name : t("Lisää asukas")}</h2>
            <p className="muted">
              {editing
                ? t("Asukkaan tiedot · {0}", editing.company_name ?? companyName)
                : t("Valitse taloyhtiö, johon asukas lisätään.")}
            </p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              {!editing && (
                <label>
                  <span>{t("Taloyhtiö")}</span>
                  <select value={formCompanyId} onChange={event => setFormCompanyId(event.target.value)}>
                    {formCompanies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
                  </select>
                </label>
              )}

              <label>
                <span>{t("Nimi")}</span>
                <input value={name} onChange={event => setName(event.target.value)} placeholder={t("Esim. Matti Meikäläinen")} />
              </label>

              <label>
                <span>{t("Sähköposti")}</span>
                <input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder={t("Valinnainen")} />
              </label>

              <fieldset className="role-choices">
                <legend>{t("Rooli")}</legend>
                {[["osakas", t("Osakas")], ["asukas", t("Asukas")]].map(([role, label]) => (
                  <label key={role} className={`role-choice role-${role}`}>
                    <input
                      type="checkbox"
                      checked={roles.includes(role)}
                      onChange={event => setRoles(current => event.target.checked ? [...current, role] : current.filter(item => item !== role))}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>

              <div className="resident-apartment">
                <span>{t("Asunto")}</span>
                {apartmentId === "new" ? (
                  <>
                    <label>
                      <span>{t("Osoite")}</span>
                      <input value={address} onChange={event => setAddress(event.target.value)} placeholder={t("Esim. Koivikkotie 10")} />
                    </label>
                    <div className="form-columns">
                      <label>
                        <span>{t("Asunnon numero")}</span>
                        <input value={apartmentNumber} onChange={event => setApartmentNumber(event.target.value)} placeholder={t("Esim. A 12")} />
                      </label>
                      <label>
                        <span>{t("Rappu")}</span>
                        <input value={staircase} onChange={event => setStaircase(event.target.value)} placeholder={t("Esim. A")} maxLength={20} />
                      </label>
                    </div>
                    <button type="button" className="back-link" onClick={() => setApartmentId(editing?.apartment_id ?? "")}>
                      {t("← Valitse olemassa oleva asunto")}
                    </button>
                  </>
                ) : (
                  <>
                    <ApartmentPicker apartments={apartmentOptions} value={apartmentId} onChange={setApartmentId} />
                    <button type="button" className="back-link" onClick={() => {
                      setApartmentId("new");
                      setAddress("");
                      setApartmentNumber("");
                      setStaircase("");
                    }}>
                      {t("+ Uusi asunto")}
                    </button>
                  </>
                )}
              </div>

              {/* Asukkaan autopaikat: paikat, joiden haltija asukas on tänään (Autopaikat-sivulta). */}
              {editing && (
                <div className="resident-parking">
                  <span>{t("Autopaikat")}</span>
                  {(editing.parking ?? []).length > 0 ? (
                    <ul>
                      {(editing.parking ?? []).map(space => (
                        <li key={space.id}><strong>{space.label}</strong> · {t(space.type)}</li>
                      ))}
                    </ul>
                  ) : <p className="muted">{t("Ei autopaikkaa.")}</p>}
                </div>
              )}

              {isAdmin() && (
                <label>
                  <span>{editing?.has_password ? t("Uusi salasana") : t("Salasana")}</span>
                  <input
                    type="password"
                    value={residentPassword}
                    onChange={event => setResidentPassword(event.target.value)}
                    placeholder={editing?.has_password ? t("Jätä tyhjäksi, jos salasanaa ei vaihdeta") : t("Valinnainen, vähintään 8 merkkiä")}
                    autoComplete="new-password"
                  />
                </label>
              )}
              <p className="reply-hint">
                {editing?.has_password
                  ? t("Asukkaalla on salasana, ja hän voi kirjautua sähköpostillaan asukasportaaliin.")
                  : t("Salasanan asettamisen jälkeen asukas voi kirjautua sähköpostillaan ja nähdä omat yhteydenottonsa ja vuoronsa.")}
                {!isAdmin() && t(" Salasanan voi asettaa tai vaihtaa vain pääkäyttäjä.")}
              </p>

              {formError && <p className="send-error">{formError}</p>}

              <div className="drawer-actions compact-actions">
                <button type="button" onClick={closeForm}>{t("Peruuta")}</button>
                <button
                  className="primary"
                  type="submit"
                  disabled={submitting || !name.trim()
                    || (apartmentId === "new" ? !address.trim() || !apartmentNumber.trim() : !apartmentId)}
                >
                  {editing
                    ? submitting ? t("Tallennetaan…") : t("Tallenna muutokset")
                    : submitting ? t("Lisätään…") : t("Lisää asukas")}
                </button>
              </div>

              {editing && isManager() && (
                <div className="privacy-actions">
                  <h3>{t("Tietosuoja")}</h3>
                  <p className="reply-hint">
                    {t("Vie asukkaasta tallennetut tiedot tiedostona tai poista henkilötiedot pysyvästi asukkaan pyynnöstä.")}
                  </p>
                  <div className="drawer-actions compact-actions">
                    <button type="button" disabled={submitting} onClick={() => exportResident(editing)}>{t("Vie tiedot")}</button>
                    <button type="button" className="danger" disabled={submitting || Boolean(erasure)} onClick={() => void startErasure(editing)}>
                      {t("Poista henkilötiedot")}
                    </button>
                  </div>
                  {erasure && (
                    <div className="erasure-panel">
                      <h4>{t("Asukkaalla on avoimia tehtäviä")}</h4>
                      <p className="reply-hint">
                        {t("Jos asia on kesken ja tietoja tarvitaan sen hoitamiseen (esim. vesivahinko tai korvausasia), tehtävän voi säilyttää. Säilytetty tehtävä anonymisoidaan automaattisesti, kun se suljetaan. Muut tiedot poistetaan heti.")}
                      </p>
                      {erasure.openTickets.map(ticket => (
                        <label key={ticket.id} className="erasure-ticket">
                          <input
                            type="checkbox"
                            checked={erasure.keep.has(ticket.id)}
                            onChange={event => {
                              const keep = new Set(erasure.keep);
                              if (event.target.checked) keep.add(ticket.id); else keep.delete(ticket.id);
                              setErasure({ ...erasure, keep });
                            }}
                          />
                          <span>
                            {ticket.ticket_number ? `#${ticket.ticket_number} ` : ""}{ticket.subject}
                            <small>{" · "}{t(ticket.type)}{" · "}{formatDateOnly(ticket.created_at)}</small>
                          </span>
                        </label>
                      ))}
                      {erasure.keep.size > 0 && (
                        <label>
                          <span>{t("Säilytyksen peruste")}</span>
                          <select value={erasure.reason} onChange={event => setErasure({ ...erasure, reason: event.target.value })}>
                            {ERASURE_REASONS.map(reason => <option key={reason} value={reason}>{t(reason)}</option>)}
                          </select>
                        </label>
                      )}
                      {erasure.keep.size > 0 && erasure.reason === ERASURE_OTHER && (
                        <label>
                          <span>{t("Kirjoita peruste")}</span>
                          <input value={erasure.other} onChange={event => setErasure({ ...erasure, other: event.target.value })} />
                        </label>
                      )}
                      <div className="drawer-actions compact-actions">
                        <button
                          type="button"
                          className="danger"
                          disabled={submitting || (erasure.keep.size > 0 && erasure.reason === ERASURE_OTHER && !erasure.other.trim())}
                          onClick={() => void eraseResident(
                            editing,
                            [...erasure.keep],
                            erasure.keep.size ? (erasure.reason === ERASURE_OTHER ? erasure.other.trim() : erasure.reason) : ""
                          )}
                        >
                          {t("Poista henkilötiedot pysyvästi")}
                        </button>
                        <button type="button" className="secondary" onClick={() => setErasure(null)}>{t("Peru")}</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </form>
          </aside>
        </Frame>
  ) : null;

  if (asPage && adding) return <section className="content">{residentForm}</section>;

  return (
    <section className="content">
      {allCompanies && <a className="back-link" href="#/companies">{t("← Taloyhtiöt")}</a>}

      {allCompanies && filtersOpen && (
        <div className="ticket-filters">
          <label>
            <span>{t("Taloyhtiö")}</span>
            <select value={companyFilter} onChange={event => setCompanyFilter(event.target.value)}>
              <option value="all">{t("Kaikki")}</option>
              {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>
          <label>
            <span>{t("Sähköposti")}</span>
            <select value={emailFilter} onChange={event => setEmailFilter(event.target.value)}>
              <option value="all">{t("Kaikki")}</option>
              <option value="with">{t("On sähköposti")}</option>
              <option value="without">{t("Ei sähköpostia")}</option>
            </select>
          </label>
          <label>
            <span>{t("Haku")}</span>
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder={t("Nimi, sähköposti, osoite tai asunto")}
            />
          </label>
          {residentFilters.length > 0 && (
            <button className="clear-filters" onClick={() => {
              setCompanyFilter("all");
              setEmailFilter("all");
              setSearch("");
            }}>{t("Tyhjennä suodattimet")}</button>
          )}
        </div>
      )}

      <div className="residents-toolbar">
        <div className="filter-chips">
          {allCompanies && (
            <button
              className={`filter-toggle ${filtersOpen || residentFilters.length > 0 ? "active" : ""}`}
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
              {residentFilters.length > 0 && <i />}
            </button>
          )}
          <span>
            {allCompanies
              ? t("Kaikki taloyhtiöt · {0}", visibleResidents.length === residents.length
                ? `${residents.length} asukasta`
                : `${visibleResidents.length} / ${residents.length} asukasta`)
              : t("{0} · {1} asukasta", companyName, residents.length)}
          </span>
          {residentFilters.map(filter => (
            <span className="filter-chip" key={filter.key}>
              <small>{filter.label}</small>
              {filter.value}
              <button onClick={filter.clear} title={t("Poista suodatin")} aria-label={t("Poista suodatin {0}", filter.label)}>×</button>
            </span>
          ))}
        </div>
        <div className="toolbar-actions">
          <button className="secondary" onClick={() => setImporting(true)}>{t("Tuo asukkaita")}</button>
          <button className="secondary" onClick={() => openForm(null)}>{t("Lisää asukas")}</button>
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
                title={t("Järjestä sarakkeen {0} mukaan", column.label)}
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

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <div className="empty">{t("Asukkaiden lataus epäonnistui. Tarkista, että palvelin on käynnistetty uudelleen.")}</div>
        : visibleResidents.length === 0
          ? <div className="empty">{residents.length === 0 ? t("Ei asukkaita.") : t("Ei suodattimia vastaavia asukkaita.")}</div>
        : pagedResidents.items.map(resident => (
          <article
            className={`resident-row clickable ${allCompanies ? "with-company" : ""}`}
            key={resident.id}
            title={t("Avaa asukkaan tiedot")}
            role="button"
            tabIndex={0}
            onClick={() => (onOpenResident ? onOpenResident(resident.id) : openForm(resident))}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (onOpenResident) onOpenResident(resident.id); else openForm(resident);
              }
            }}
          >
            <strong>{resident.name}<RoleTags roles={resident.roles} /></strong>
            <span>{resident.email || t("Ei sähköpostia")}</span>
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

      {residentForm}
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

// Lukee CSV- tai Excel-tiedoston taulukoksi (otsikkorivi + rivit). Excelistä luetaan ensimmäinen
// välilehti; virhe heitetään, jos tiedosto ei ole .xlsx-muodossa.
export async function readTableFile(file: File, format: "csv" | "excel"): Promise<string[][]> {
  if (format === "excel") {
    // Excel-lukija ladataan vasta tarvittaessa.
    const { readSheet } = await import("read-excel-file/browser");
    return (await readSheet(file))
      .map(cells => cells.map(cell => cell == null ? "" : String(cell)))
      .filter(cells => cells.some(cell => cell.trim()));
  }
  const buffer = await file.arrayBuffer();
  let text = new TextDecoder("utf-8").decode(buffer);
  // Excelin tallentama CSV on usein Windows-merkistössä, jolloin ääkköset eivät aukea UTF-8:na.
  if (text.includes("\uFFFD")) text = new TextDecoder("windows-1252").decode(buffer);
  return parseCsv(text);
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
    try {
      table = await readTableFile(file, format);
    } catch {
      setError(t("Excel-tiedoston lukeminen epäonnistui. Tiedoston pitää olla .xlsx-muodossa."));
      return;
    }

    const parsed = tableToResidents(table);
    if (parsed.missing.length > 0) {
      setError(t("Tiedostosta puuttuu sarake: {0}. Tarkista otsikkorivi.", parsed.missing.join(", ")));
    } else if (parsed.rows.length === 0) {
      setError(t("Tiedostossa ei ole otsikkorivin lisäksi yhtään riviä."));
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
      setError(errorMessage(importError, t("Asukkaiden tuonti epäonnistui.")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay">
      <aside className="drawer form-drawer resident-drawer">
        <button type="button" className="drawer-back" onClick={onClose}>{t("← Takaisin")}</button>
        <button className="close" onClick={onClose}>×</button>
        <h2>{t("Tuo asukkaita")}</h2>
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
              {option === "csv" ? t("CSV") : t("Excel")}
            </button>
          ))}
        </div>
        <p className="muted">
          {t("Ensimmäisen rivin pitää olla otsikkorivi, jossa on sarakkeet")}{" "}<strong>{t("nimi")}</strong>, <strong>{t("osoite")}</strong>{" "}{t("ja")}{" "}
          <strong>{t("asunto")}</strong>{t(". Sarake")}{" "}<strong>{t("sähköposti")}</strong>{" "}{t("on valinnainen.")}{" "}
          {format === "csv"
            ? t("Erottimena käy puolipiste tai pilkku.")
            : t("Tiedoston pitää olla .xlsx-muodossa, ja asukkaat luetaan ensimmäiseltä välilehdeltä.")}
        </p>
        {format === "csv" ? (
          <pre className="csv-example">{t("nimi;sähköposti;osoite;asunto")}{"\n"}{t("Matti Meikäläinen;matti@example.com;Koivikkotie 10;A 12")}</pre>
        ) : (
          <div className="table-card import-example">
            <table className="data-table">
              <thead>
                <tr><th>{t("nimi")}</th><th>{t("sähköposti")}</th><th>{t("osoite")}</th><th>{t("asunto")}</th></tr>
              </thead>
              <tbody>
                <tr><td>{t("Matti Meikäläinen")}</td><td>{t("matti@example.com")}</td><td>{t("Koivikkotie 10")}</td><td>{t("A 12")}</td></tr>
              </tbody>
            </table>
          </div>
        )}

        <div className="ticket-form">
          {!lockedCompanyId && (
            <label>
              <span>{t("Taloyhtiö, johon asukkaat tuodaan")}</span>
              <select value={targetCompany} onChange={event => setTargetCompany(event.target.value)}>
                {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            </label>
          )}

          <label>
            <span>{format === "csv" ? t("CSV-tiedosto") : t("Excel-tiedosto (.xlsx)")}</span>
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
              <p className="reply-hint">{fileName}: {rows.length}{" "}{t("riviä. Esikatselu ensimmäisistä riveistä:")}</p>
              <div className="table-card">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("Nimi")}</th>
                      <th>{t("Sähköposti")}</th>
                      <th>{t("Osoite")}</th>
                      <th>{t("Asunto")}</th>
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
              {t("Lisätty")}{" "}{result.added}{" "}{t("asukasta")}{result.skipped.length > 0 ? t(", ohitettu {0} riviä.", result.skipped.length) : "."}
            </div>
          )}
          {result && result.skipped.length > 0 && (
            <ul className="import-skipped">
              {result.skipped.map(skip => (
                <li key={skip.line}>
                  <strong>{t("Rivi")}{" "}{skip.line}{skip.name ? ` (${skip.name})` : ""}:</strong> {skip.reason}
                </li>
              ))}
            </ul>
          )}

          {error && <p className="send-error">{error}</p>}

          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>{result ? t("Sulje") : t("Peruuta")}</button>
            {!result && (
              <button className="primary" type="button" onClick={handleImport} disabled={submitting || rows.length === 0}>
                {submitting ? t("Tuodaan…") : rows.length > 0 ? t("Tuo {0} asukasta", rows.length) : t("Tuo asukkaat")}
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
