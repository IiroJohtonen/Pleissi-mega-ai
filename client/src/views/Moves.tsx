import { useEffect, useState } from "react";
import { NoticeFilters, usePaged } from "../components/common";
import { ReporterCell, ReporterField } from "../components/Reporter";
import { formatDate, formatDateOnly, formatDay, noticeStatusClass } from "../format";
import { api, errorMessage, isManager } from "../session";
import type { Company } from "../types";
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
  apartment_number?: string | null;
  address?: string | null;
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
        : notices.length === 0 ? <div className="empty">{t("Ei muuttoilmoituksia. Asukas tekee ilmoituksen asukasportaalissa.")}</div>
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
                    onClick={() => { setOpenId(notice.id); setError(""); }}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenId(notice.id);
                        setError("");
                      }
                    }}
                  >
                    <td>
                      <ReporterCell name={notice.resident_name} email={notice.resident_email} />
                      <span>{moveSummary(notice)}</span>
                    </td>
                    {showCompany && <td>{companyName(notice.company_id)}</td>}
                    <td>{notice.apartment_number || "–"}</td>
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
            <button type="button" className="drawer-back" onClick={() => setOpenId(null)} disabled={saving}>{t("← Takaisin")}</button>
            <button className="close" onClick={() => setOpenId(null)} disabled={saving}>×</button>
            <h2>{t("Muuttoilmoitus")}</h2>
            <p className="muted">
              {companyName(open.company_id)}{" "}{t("· ilmoitettu")}{" "}{formatDate(open.created_at)}
            </p>
            <ReporterField
              companyId={open.company_id}
              reporter={{ id: open.resident_id, name: open.resident_name, email: open.resident_email, apartment_number: open.apartment_number, address: open.address }}
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

            {open.status === "pending" && !isManager() && (
              <p className="reply-hint">{t("Muuttoilmoituksen voi hyväksyä tai hylätä isännöitsijä tai pääkäyttäjä.")}</p>
            )}
            {open.status === "pending" && isManager() && (
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
            {error && <p className="send-error">{error}</p>}
          </aside>
        </div>
      )}
    </section>
  );
}
