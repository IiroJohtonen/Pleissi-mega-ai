import { type FormEvent, useEffect, useState } from "react";
import { Dropdown, NoticeFilters, usePaged } from "../components/common";
import { type DetailField, DetailEditor, DetailFacts, detailValue, detailValues, sourceLabel } from "../components/FormDetails";
import { ReporterCell, ReporterField } from "../components/Reporter";
import { formatDate, formatDateOnly, formatDay, noticeStatusClass } from "../format";
import { api, errorMessage, isManager } from "../session";
import type { Company } from "../types";
import type { Apartment } from "./Keys";
import { t } from "../i18n";

export type MoveNotice = {
  id: string;
  company_id: string;
  move_date: string;
  moves_out: number;
  // JSON-lista uusista asukkaista: [{ name, email }].
  new_residents: string;
  door_name: string;
  note: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  result?: string | null;
  resident_id?: string | null;
  resident_name?: string | null;
  resident_email?: string | null;
  apartment_id?: string | null;
  apartment_number?: string | null;
  address?: string | null;
  source?: "portal" | "email";
  // Verkkosivun muuttoilmoituksen kentät (muuttaja, osoitteet, mukana muuttavat, vesimaksu).
  details?: DetailField[];
};

type MoveDraft = {
  moveDate: string; movesOut: boolean; apartmentId: string; people: { name: string; email: string }[];
  doorName: string; note: string; details: Record<string, string>;
};

type MoveResult = { movedOut: number; parkingReleased: string[]; bookingsRemoved: number; added: string[]; skipped: string[] };

export const moveStatusLabels: Record<MoveNotice["status"], string> = { pending: t("Odottaa käsittelyä"), approved: t("Hyväksytty"), rejected: t("Hylätty") };

function newResidentsOf(notice: MoveNotice): { name: string; email: string }[] {
  try {
    return JSON.parse(notice.new_residents);
  } catch {
    return [];
  }
}

// Muuttoilmoituksen sisältö yhdellä rivillä.
export function moveSummary(notice: MoveNotice) {
  const incoming = newResidentsOf(notice).length;
  return [
    notice.moves_out ? t("Nykyiset asukkaat muuttavat pois") : "",
    incoming ? t("{0} uutta asukasta", incoming) : "",
    notice.door_name ? t("nimi oveen: {0}", notice.door_name) : ""
  ].filter(Boolean).join(" · ");
}

// Toimiston näkymä: asukkaiden muuttoilmoitukset, jotka hyväksytään tai hylätään.
export function MoveNotices({ companies, defaultCompanyId = "", onChanged }: { companies: Company[]; defaultCompanyId?: string; onChanged?: () => void }) {
  const [notices, setNotices] = useState<MoveNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [companyFilter, setCompanyFilter] = useState(companies.some(company => company.id === defaultCompanyId) ? defaultCompanyId : "all");
  // Oletuksena näytetään vain käsittelyä odottavat.
  const [statusFilter, setStatusFilter] = useState("pending");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<MoveDraft | null>(null);
  const [apartments, setApartments] = useState<Apartment[]>([]);

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";

  async function loadNotices() {
    try {
      const lists = await Promise.all(companies.map(company =>
        api<MoveNotice[]>(`/companies/${encodeURIComponent(company.id)}/moves`)));
      setNotices(lists.flat().sort((a, b) =>
        Number(b.status === "pending") - Number(a.status === "pending") || b.created_at.localeCompare(a.created_at)));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadNotices();
  }, [companies.length]);

  async function decide(notice: MoveNotice, decision: "approve" | "reject") {
    setSaving(true);
    setError("");
    try {
      await api(`/moves/${encodeURIComponent(notice.id)}/${decision}`, { method: "POST" });
      await loadNotices();
      onChanged?.();
    } catch (decisionError) {
      setError(errorMessage(decisionError, t("Muuttoilmoituksen käsittely epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  const editCompany = editing ? notices.find(notice => notice.id === openId)?.company_id ?? "" : "";
  useEffect(() => {
    if (!editCompany) return;
    api<Apartment[]>(`/companies/${encodeURIComponent(editCompany)}/apartments`).then(setApartments).catch(() => setApartments([]));
  }, [editCompany]);

  function startEdit(notice: MoveNotice) {
    setError("");
    setEditing({
      moveDate: notice.move_date, movesOut: Boolean(notice.moves_out), apartmentId: notice.apartment_id ?? "",
      people: newResidentsOf(notice), doorName: notice.door_name, note: notice.note, details: detailValues(notice.details)
    });
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    const notice = notices.find(item => item.id === openId);
    if (!notice || !editing) return;
    setSaving(true);
    setError("");
    try {
      await api(`/moves/${encodeURIComponent(notice.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          moveDate: editing.moveDate, movesOut: editing.movesOut, apartmentId: editing.apartmentId || null,
          newResidents: editing.people.filter(person => person.name.trim()).map(person => ({ name: person.name.trim(), email: person.email.trim() })),
          doorName: editing.doorName.trim(), note: editing.note.trim(), details: editing.details
        })
      });
      setEditing(null);
      await loadNotices();
    } catch (saveError) {
      setError(errorMessage(saveError, t("Muuttoilmoituksen tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  const inCompany = notices.filter(notice => companyFilter === "all" || notice.company_id === companyFilter);
  const visible = inCompany.filter(notice => statusFilter === "all" || notice.status === statusFilter);
  const paged = usePaged(visible, `${companyFilter}|${statusFilter}`);
  const showCompany = companies.length > 1;
  const open = notices.find(notice => notice.id === openId) ?? null;
  const pendingCount = inCompany.filter(notice => notice.status === "pending").length;
  let result: MoveResult | null;
  try {
    result = open?.result ? JSON.parse(open.result) : null;
  } catch {
    result = null;
  }

  return (
    <section className="content">
      <a className="back-link" href="#/companies">{t("← Taloyhtiöt")}</a>

      <NoticeFilters
        companies={companies}
        company={companyFilter}
        onCompany={setCompanyFilter}
        status={statusFilter}
        onStatus={setStatusFilter}
        statuses={(["pending", "approved", "rejected"] as const).map(value => ({ value, label: moveStatusLabels[value] }))}
      />

      <div className="residents-toolbar">
        <span>{inCompany.length}{" "}{t("muuttoilmoitusta ·")}{" "}{pendingCount}{" "}{t("odottaa käsittelyä")}</span>
      </div>

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <p className="send-error">{t("Muuttoilmoitusten lataus epäonnistui.")}</p>
        : notices.length === 0 ? <div className="empty">{t("Ei muuttoilmoituksia. Asukas tekee ilmoituksen asukasportaalissa tai isännöitsijäyrityksen verkkosivulla.")}</div>
        : visible.length === 0 ? (
          <div className="empty">
            {statusFilter === "pending" ? t("Ei käsittelyä odottavia muuttoilmoituksia.") : t("Ei suodattimia vastaavia muuttoilmoituksia.")}
          </div>
        )
        : (
          <div className="table-card">
            <table className="data-table report-topics notice-table">
              <thead>
                <tr>
                  <th>{t("Ilmoittaja")}</th>
                  {showCompany && <th>{t("Taloyhtiö")}</th>}
                  <th>{t("Asunto")}</th>
                  <th>{t("Muuttopäivä")}</th>
                  <th>{t("Tila")}</th>
                  <th>{t("Ilmoitettu")}</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(notice => (
                  <tr
                    key={notice.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title={t("Avaa muuttoilmoitus")}
                    onClick={() => { setOpenId(notice.id); setEditing(null); setError(""); }}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenId(notice.id);
                        setEditing(null);
                        setError("");
                      }
                    }}
                  >
                    <td>
                      <ReporterCell
                        name={notice.resident_name || detailValue(notice.details, "name")}
                        email={notice.resident_email || detailValue(notice.details, "email")}
                      />
                      <span>{[detailValue(notice.details, "kind"), moveSummary(notice), sourceLabel(notice.source)].filter(Boolean).join(" · ")}</span>
                    </td>
                    {showCompany && <td>{companyName(notice.company_id)}</td>}
                    <td>
                      {notice.apartment_number || "–"}
                      {!notice.apartment_id && <span className="late-note">{t("Valitse asunto")}</span>}
                    </td>
                    <td>{formatDay(notice.move_date)}</td>
                    <td><span className={`work-order-status ${noticeStatusClass(notice.status)}`}>{moveStatusLabels[notice.status]}</span></td>
                    <td>{formatDateOnly(notice.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {paged.pager}

      {open && (
        <div className="overlay">
          <aside className="drawer form-drawer">
            <button type="button" className="drawer-back" onClick={() => { setOpenId(null); setEditing(null); }} disabled={saving}>{t("← Takaisin")}</button>
            <button className="close" onClick={() => { setOpenId(null); setEditing(null); }} disabled={saving}>×</button>
            <h2>{detailValue(open.details, "kind") || t("Muuttoilmoitus")}</h2>
            <p className="muted">
              {companyName(open.company_id)}{" "}{t("· ilmoitettu")}{" "}{formatDate(open.created_at)}{" · "}{sourceLabel(open.source)}
            </p>
            <ReporterField
              companyId={open.company_id}
              reporter={{ id: open.resident_id, name: open.resident_name, email: open.resident_email, apartment_number: open.apartment_number, address: open.address }}
              fallbackName={detailValue(open.details, "name")}
              onChange={open.status === "pending" ? async residentId => {
                await api(`/moves/${encodeURIComponent(open.id)}/reporter`, { method: "PUT", body: JSON.stringify({ residentId }) });
                await loadNotices();
              } : undefined}
            />

            <dl className="ticket-facts">
              <div>
                <dt>{t("Muuttopäivä")}</dt>
                <dd>{formatDay(open.move_date)}</dd>
              </div>
              <div>
                <dt>{t("Tila")}</dt>
                <dd>{moveStatusLabels[open.status]}{open.decided_by ? ` · ${open.decided_by}` : ""}</dd>
              </div>
              <div>
                <dt>{t("Poismuutto")}</dt>
                <dd>{open.moves_out ? t("Asunnon nykyiset asukkaat muuttavat pois") : t("Ei")}</dd>
              </div>
              <div>
                <dt>{t("Nimi oveen")}</dt>
                <dd>{open.door_name || "–"}</dd>
              </div>
            </dl>

            <h3>{t("Uudet asukkaat")}</h3>
            {newResidentsOf(open).length === 0 ? <p className="muted">{t("Ei uusia asukkaita.")}</p> : (
              <ul className="move-people">
                {newResidentsOf(open).map((person, index) => (
                  <li key={index}><strong>{person.name}</strong>{person.email ? ` · ${person.email}` : ""}</li>
                ))}
              </ul>
            )}
            {open.note && (
              <>
                <h3>{t("Lisätiedot")}</h3>
                <p className="announcement-body">{open.note}</p>
              </>
            )}
            <DetailFacts title={t("Muuttoilmoituslomakkeen tiedot")} fields={open.details} />

            {editing ? (
              <form className="ticket-form record-edit" onSubmit={saveEdit}>
                <h3>{t("Muokkaa muuttoilmoitusta")}</h3>
                <Dropdown
                  label={t("Asunto")}
                  value={editing.apartmentId}
                  options={[
                    { value: "", label: t("Ei valittu") },
                    ...apartments.map(apartment => ({ value: apartment.id, label: `${apartment.apartment_number} · ${apartment.address}` }))
                  ]}
                  onChange={apartmentId => setEditing({ ...editing, apartmentId })}
                />
                <label>
                  <span>{t("Muuttopäivä")}</span>
                  <input type="date" value={editing.moveDate} onChange={event => setEditing({ ...editing, moveDate: event.target.value })} required />
                </label>
                <label className="switch-row">
                  <span><strong>{t("Asunnon nykyiset asukkaat muuttavat pois")}</strong></span>
                  <input type="checkbox" role="switch" checked={editing.movesOut} onChange={() => setEditing({ ...editing, movesOut: !editing.movesOut })} />
                  <i aria-hidden="true" />
                </label>
                <fieldset className="move-new-residents">
                  <legend>{t("Uudet asukkaat")}</legend>
                  {editing.people.map((person, index) => (
                    <div className="move-person" key={index}>
                      <input
                        value={person.name}
                        placeholder={t("Nimi")}
                        aria-label={t("Nimi")}
                        onChange={event => setEditing({ ...editing, people: editing.people.map((item, position) => position === index ? { ...item, name: event.target.value } : item) })}
                      />
                      <input
                        type="email"
                        value={person.email}
                        placeholder={t("Sähköposti (valinnainen)")}
                        aria-label={t("Sähköposti")}
                        onChange={event => setEditing({ ...editing, people: editing.people.map((item, position) => position === index ? { ...item, email: event.target.value } : item) })}
                      />
                      <button type="button" onClick={() => setEditing({ ...editing, people: editing.people.filter((_, position) => position !== index) })}>
                        {t("Poista")}
                      </button>
                    </div>
                  ))}
                  <button type="button" className="secondary" onClick={() => setEditing({ ...editing, people: [...editing.people, { name: "", email: "" }] })}>
                    {t("+ Lisää asukas")}
                  </button>
                </fieldset>
                <label>
                  <span>{t("Nimi oveen")}</span>
                  <input value={editing.doorName} onChange={event => setEditing({ ...editing, doorName: event.target.value })} maxLength={60} />
                </label>
                <label>
                  <span>{t("Lisätiedot")}</span>
                  <textarea value={editing.note} onChange={event => setEditing({ ...editing, note: event.target.value })} rows={3} maxLength={1000} />
                </label>
                <DetailEditor
                  title={t("Muuttoilmoituslomakkeen tiedot")}
                  fields={open.details ?? []}
                  values={editing.details}
                  onChange={details => setEditing({ ...editing, details })}
                />
                {error && <p className="send-error">{error}</p>}
                <div className="drawer-actions compact-actions">
                  <button type="button" onClick={() => setEditing(null)} disabled={saving}>{t("Peruuta")}</button>
                  <button className="primary" type="submit" disabled={saving}>{saving ? t("Tallennetaan…") : t("Tallenna")}</button>
                </div>
              </form>
            ) : (
              <div className="draft-actions">
                <button className="secondary" onClick={() => startEdit(open)} disabled={saving}>{t("Muokkaa")}</button>
              </div>
            )}

            {open.status === "pending" && !isManager() && (
              <p className="reply-hint">{t("Muuttoilmoituksen voi hyväksyä tai hylätä isännöitsijä tai pääkäyttäjä.")}</p>
            )}
            {open.status === "pending" && isManager() && !editing && (
              <>
                <p className="reply-hint">
                  {t("Hyväksyntä päivittää asukastietokannan: lähtijät poistuvat asukaslistalta muuttopäivänä, heidän autopaikkansa vapautuvat ja vuoronsa poistuvat muuttopäivästä alkaen, ja uudet asukkaat lisätään asuntoon.")}
                </p>
                <div className="draft-actions">
                  <button className="primary" onClick={() => void decide(open, "approve")} disabled={saving}>
                    {saving ? t("Käsitellään…") : t("Hyväksy")}
                  </button>
                  <button onClick={() => void decide(open, "reject")} disabled={saving}>{t("Hylkää")}</button>
                </div>
              </>
            )}
            {open.status === "approved" && result && (
              <p className="portal-sent">
                {t("Hyväksytty:")}{" "}{result.movedOut}{" "}{t("asukasta merkitty muuttaneeksi,")}{" "}{result.added.length}{" "}{t("lisätty")}
                {result.parkingReleased.length > 0 && t(", autopaikat vapautuvat: {0}", result.parkingReleased.join(", "))}
                {result.bookingsRemoved > 0 && t(", {0} vuoroa poistettu", result.bookingsRemoved)}.
                {result.skipped.length > 0 && t(" Lisäämättä jäi: {0}.", result.skipped.join(", "))}
              </p>
            )}
            {!editing && error && <p className="send-error">{error}</p>}
          </aside>
        </div>
      )}
    </section>
  );
}
