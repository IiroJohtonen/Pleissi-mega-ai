import { type FormEvent, useEffect, useState } from "react";
import { Dropdown } from "../components/common";
import { type DetailField, DetailEditor, DetailFacts, detailValue, detailValues, sourceLabel } from "../components/FormDetails";
import { ReporterCell } from "../components/Reporter";
import { formatDateOnly, formatDay, noticeStatusClass } from "../format";
import { api, errorMessage } from "../session";
import type { Company } from "../types";
import type { Apartment } from "./Keys";
import { t } from "../i18n";

export type HeatingOrder = {
  id: string;
  company_id: string;
  apartment_id: string | null;
  resident_id: string | null;
  start_date: string | null;
  end_date: string | null;
  status: "pending" | "approved" | "rejected" | "ended";
  note: string;
  source: "office" | "portal" | "email";
  created_at: string;
  apartment_number?: string | null;
  resident_name?: string | null;
  resident_email?: string | null;
  // Verkkosivun lomakkeen kentät: kohde, paikka, tilaustyyppi ja tilaajan tiedot.
  details: DetailField[];
};

export const heatingStatusLabels: Record<HeatingOrder["status"], string> = {
  pending: t("Odottaa käsittelyä"), approved: t("Myönnetty"), rejected: t("Hylätty"), ended: t("Päättynyt")
};

type Draft = { apartmentId: string; startDate: string; endDate: string; status: HeatingOrder["status"]; note: string; details: Record<string, string> };

// Auton lämmityspaikan tilaukset Autopaikat-sivulla: verkkosivun lomakkeelta, asukasportaalista tai
// toimiston kirjaamina. Tilauksen kentät ovat samat kuin verkkosivun lomakkeella.
export function HeatingOrders({ companies, companyFilter }: { companies: Company[]; companyFilter: string }) {
  const [orders, setOrders] = useState<HeatingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  // Uusi tilaus: taloyhtiö, johon se kirjataan.
  const [newCompany, setNewCompany] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [apartments, setApartments] = useState<Apartment[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showClosed, setShowClosed] = useState(false);

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";
  const open = orders.find(order => order.id === openId) ?? null;
  const formCompany = newCompany ?? open?.company_id ?? "";
  // Kenttien otsikot uudelle tilaukselle saadaan mistä tahansa tilauksesta; ilman niitä käytetään oletuksia.
  const fieldTemplate = (orders[0]?.details ?? DEFAULT_FIELDS).map(field => ({ ...field, value: "" }));

  async function load() {
    try {
      const lists = await Promise.all(companies.map(company =>
        api<HeatingOrder[]>(`/companies/${encodeURIComponent(company.id)}/heating-orders`).catch(() => [] as HeatingOrder[])));
      setOrders(lists.flat().sort((a, b) =>
        Number(b.status === "pending") - Number(a.status === "pending") || b.created_at.localeCompare(a.created_at)));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [companies.length]);

  useEffect(() => {
    if (!draft || !formCompany) return;
    api<Apartment[]>(`/companies/${encodeURIComponent(formCompany)}/apartments`).then(setApartments).catch(() => setApartments([]));
  }, [Boolean(draft), formCompany]);

  function close() {
    setOpenId(null);
    setNewCompany(null);
    setDraft(null);
    setError("");
  }

  function edit(order: HeatingOrder) {
    setError("");
    setDraft({
      apartmentId: order.apartment_id ?? "", startDate: order.start_date ?? "", endDate: order.end_date ?? "",
      status: order.status, note: order.note, details: detailValues(order.details)
    });
  }

  function create() {
    close();
    setNewCompany(companyFilter !== "all" ? companyFilter : companies[0]?.id ?? "");
    setDraft({ apartmentId: "", startDate: "", endDate: "", status: "pending", note: "", details: {} });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError("");
    const body = JSON.stringify({
      apartmentId: draft.apartmentId || null, startDate: draft.startDate || null, endDate: draft.endDate || null,
      status: draft.status, note: draft.note.trim(), details: draft.details
    });
    try {
      if (open) await api(`/heating-orders/${encodeURIComponent(open.id)}`, { method: "PUT", body });
      else await api(`/companies/${encodeURIComponent(formCompany)}/heating-orders`, { method: "POST", body });
      if (open) setDraft(null);
      else close();
      await load();
    } catch (saveError) {
      setError(errorMessage(saveError, t("Tilauksen tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function remove(order: HeatingOrder) {
    if (!window.confirm(t("Poistetaanko lämmityspaikan tilaus?"))) return;
    setSaving(true);
    try {
      await api(`/heating-orders/${encodeURIComponent(order.id)}`, { method: "DELETE" });
      close();
      await load();
    } catch (deleteError) {
      setError(errorMessage(deleteError, t("Tilauksen poistaminen epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  const inCompany = orders.filter(order => companyFilter === "all" || order.company_id === companyFilter);
  const visible = inCompany.filter(order => showClosed || order.status === "pending" || order.status === "approved");
  const showCompany = companies.length > 1 && companyFilter === "all";
  const period = (order: HeatingOrder) =>
    [order.start_date ? formatDay(order.start_date) : "", order.end_date ? formatDay(order.end_date) : t("toistaiseksi")].filter(Boolean).join(" – ");

  return (
    <div className="heating-orders">
      <div className="residents-toolbar">
        <h2>{t("Auton lämmityspaikan tilaukset")}</h2>
        <div className="draft-actions">
          <label className="inline-check">
            <input type="checkbox" checked={showClosed} onChange={() => setShowClosed(!showClosed)} />
            {t("Näytä hylätyt ja päättyneet")}
          </label>
          <button className="secondary" onClick={create}>{t("Uusi tilaus")}</button>
        </div>
      </div>

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : visible.length === 0 ? (
          <div className="empty">{t("Ei lämmityspaikan tilauksia. Tilaus tulee isännöitsijäyrityksen verkkosivun lomakkeelta, asukasportaalista tai voit kirjata sen itse.")}</div>
        )
        : (
          <div className="table-card">
            <table className="data-table report-topics notice-table">
              <thead>
                <tr>
                  <th>{t("Tilaaja")}</th>
                  {showCompany && <th>{t("Taloyhtiö")}</th>}
                  <th>{t("Kohde")}</th>
                  <th>{t("Paikka")}</th>
                  <th>{t("Ajanjakso")}</th>
                  <th>{t("Tila")}</th>
                  <th>{t("Saapunut")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(order => (
                  <tr
                    key={order.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title={t("Avaa tilaus")}
                    onClick={() => { close(); setOpenId(order.id); }}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        close();
                        setOpenId(order.id);
                      }
                    }}
                  >
                    <td>
                      <ReporterCell
                        name={order.resident_name || detailValue(order.details, "name")}
                        email={order.resident_email || detailValue(order.details, "email")}
                        fallback={t("Ei tilaajaa")}
                      />
                      <span>{sourceLabel(order.source)}</span>
                    </td>
                    {showCompany && <td>{companyName(order.company_id)}</td>}
                    <td>
                      {[detailValue(order.details, "address"), order.apartment_number].filter(Boolean).join(", ") || "–"}
                      {!order.apartment_id && <span>{t("Asunto ei tiedossa")}</span>}
                    </td>
                    <td>
                      {detailValue(order.details, "spot") ? t(detailValue(order.details, "spot")) : "–"}
                      {detailValue(order.details, "orderType") && <span>{t(detailValue(order.details, "orderType"))}</span>}
                    </td>
                    <td>{period(order)}</td>
                    <td><span className={`work-order-status ${noticeStatusClass(order.status)}`}>{heatingStatusLabels[order.status]}</span></td>
                    <td>{formatDateOnly(order.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {(open || newCompany) && (
        <div className="overlay">
          <aside className="drawer form-drawer">
            <button type="button" className="drawer-back" onClick={close} disabled={saving}>{t("← Takaisin")}</button>
            <button className="close" onClick={close} disabled={saving}>×</button>
            <h2>{open ? t("Lämmityspaikan tilaus") : t("Uusi lämmityspaikan tilaus")}</h2>
            {open && (
              <>
                <p className="muted">{companyName(open.company_id)} · {formatDateOnly(open.created_at)} · {sourceLabel(open.source)}</p>
                <dl className="ticket-facts">
                  <div>
                    <dt>{t("Tila")}</dt>
                    <dd>{heatingStatusLabels[open.status]}</dd>
                  </div>
                  <div>
                    <dt>{t("Ajanjakso")}</dt>
                    <dd>{period(open) || "–"}</dd>
                  </div>
                  <div>
                    <dt>{t("Asunto")}</dt>
                    <dd>{open.apartment_number || "–"}</dd>
                  </div>
                  <div>
                    <dt>{t("Lisätieto")}</dt>
                    <dd>{open.note || "–"}</dd>
                  </div>
                </dl>
                {!draft && <DetailFacts title={t("Tilauslomakkeen tiedot")} fields={open.details} />}
              </>
            )}

            {draft ? (
              <form className="ticket-form record-edit" onSubmit={save}>
                {!open && (
                  <Dropdown
                    label={t("Taloyhtiö")}
                    value={formCompany}
                    options={companies.map(company => ({ value: company.id, label: company.name }))}
                    onChange={value => { setNewCompany(value); setDraft({ ...draft, apartmentId: "" }); }}
                  />
                )}
                <Dropdown
                  label={t("Tila")}
                  value={draft.status}
                  options={(Object.keys(heatingStatusLabels) as HeatingOrder["status"][]).map(value => ({ value, label: heatingStatusLabels[value] }))}
                  onChange={status => setDraft({ ...draft, status: status as HeatingOrder["status"] })}
                />
                <Dropdown
                  label={t("Asunto")}
                  value={draft.apartmentId}
                  options={[
                    { value: "", label: t("Ei valittu") },
                    ...apartments.map(apartment => ({ value: apartment.id, label: `${apartment.apartment_number} · ${apartment.address}` }))
                  ]}
                  onChange={apartmentId => setDraft({ ...draft, apartmentId })}
                />
                <div className="portal-form-row">
                  <label>
                    <span>{t("Tarve alkaen")}</span>
                    <input type="date" value={draft.startDate} onChange={event => setDraft({ ...draft, startDate: event.target.value })} />
                  </label>
                  <label>
                    <span>{t("Loppumispäivä (määräaikainen)")}</span>
                    <input type="date" value={draft.endDate} onChange={event => setDraft({ ...draft, endDate: event.target.value })} />
                  </label>
                </div>
                <label>
                  <span>{t("Lisätieto")}</span>
                  <input value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} maxLength={1000} placeholder={t("Esim. myönnetty paikka")} />
                </label>
                <DetailEditor
                  title={t("Tilauslomakkeen tiedot")}
                  fields={open?.details ?? fieldTemplate}
                  values={draft.details}
                  onChange={details => setDraft({ ...draft, details })}
                />
                {error && <p className="send-error">{error}</p>}
                <div className="drawer-actions compact-actions">
                  <button type="button" onClick={() => (open ? setDraft(null) : close())} disabled={saving}>{t("Peruuta")}</button>
                  <button className="primary" type="submit" disabled={saving}>{saving ? t("Tallennetaan…") : t("Tallenna")}</button>
                </div>
              </form>
            ) : open && (
              <>
                {error && <p className="send-error">{error}</p>}
                <div className="draft-actions">
                  <button className="secondary" onClick={() => edit(open)} disabled={saving}>{t("Muokkaa")}</button>
                  <button className="danger" onClick={() => void remove(open)} disabled={saving}>{t("Poista tilaus")}</button>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

// Verkkosivun lämmityspaikkalomakkeen kentät, kun yhtään tilausta ei vielä ole.
const DEFAULT_FIELDS: DetailField[] = [
  { key: "address", label: "Kohteen osoite", type: "text", options: [], value: "" },
  { key: "spot", label: "Tilaan", type: "select", options: ["Lämmitystolppapaikan", "Paikan katoksesta / tallista"], value: "" },
  { key: "orderType", label: "Tilaustyyppi", type: "select", options: ["Toistaiseksi voimassa oleva", "Määräaikainen"], value: "" },
  { key: "name", label: "Tilaajan nimi", type: "text", options: [], value: "" },
  { key: "phone", label: "Puhelinnumero", type: "tel", options: [], value: "" },
  { key: "email", label: "Sähköposti", type: "email", options: [], value: "" },
  { key: "ordererAddress", label: "Tilaajan osoite", type: "text", options: [], value: "" },
  { key: "city", label: "Kaupunki", type: "text", options: [], value: "" },
  { key: "postalCode", label: "Postinumero", type: "text", options: [], value: "" }
];
