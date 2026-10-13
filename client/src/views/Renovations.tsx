import { useEffect, useState } from "react";
import { NoticeFilters, usePaged } from "../components/common";
import { formatDate, formatDateOnly, formatDay, noticeStatusClass } from "../format";
import { api, errorMessage, isManager } from "../session";
import type { Company } from "../types";
import { t } from "../i18n";

export type RenovationNotice = {
  id: string;
  company_id: string;
  work_type: string;
  description: string;
  start_date: string;
  end_date: string;
  contractor: string;
  status: "pending" | "approved" | "rejected" | "completed";
  // Hyväksynnän ehdot tai hylkäämisen perustelu.
  decision_note: string;
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  completed_at?: string | null;
  resident_name?: string | null;
  resident_email?: string | null;
  apartment_number?: string | null;
  address?: string | null;
};

export const RENOVATION_WORK_TYPES = ["Märkätila", "Keittiö", "Vesi- ja viemärityöt", "Sähkötyöt", "Lattiat ja pinnat", "Rakenteet", "Muu"];

export const renovationStatusLabels: Record<RenovationNotice["status"], string> = {
  pending: t("Odottaa käsittelyä"),
  approved: t("Hyväksytty"),
  rejected: t("Hylätty"),
  completed: t("Valmistunut")
};

export function renovationPeriod(notice: Pick<RenovationNotice, "start_date" | "end_date">) {
  return `${formatDay(notice.start_date)}–${formatDay(notice.end_date)}`;
}

// Hyväksytty remontti, jonka päättymispäivä on mennyt mutta jota ei ole merkitty valmistuneeksi.
export function isUnconfirmed(notice: Pick<RenovationNotice, "status" | "end_date">) {
  return notice.status === "approved" && notice.end_date < new Date().toLocaleDateString("sv-SE");
}

// Toimiston näkymä: asukkaiden remontti-ilmoitukset, jotka isännöitsijä hyväksyy tai hylkää.
export function RenovationNotices({ companies, onChanged }: { companies: Company[]; onChanged?: () => void }) {
  const [notices, setNotices] = useState<RenovationNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [companyFilter, setCompanyFilter] = useState("all");
  // Oletuksena näytetään vain käsittelyä odottavat.
  const [statusFilter, setStatusFilter] = useState("pending");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";

  async function loadNotices() {
    try {
      const lists = await Promise.all(companies.map(company =>
        api<RenovationNotice[]>(`/companies/${encodeURIComponent(company.id)}/renovations`)));
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

  function openNotice(id: string) {
    setOpenId(id);
    setNote("");
    setError("");
  }

  async function decide(notice: RenovationNotice, decision: "approve" | "reject" | "complete") {
    if (decision === "reject" && !note.trim()) {
      setError(t("Kirjoita hylkäämisen perustelu."));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api(`/renovations/${encodeURIComponent(notice.id)}/${decision}`, { method: "POST", body: JSON.stringify({ note: note.trim() }) });
      setNote("");
      await loadNotices();
      onChanged?.();
    } catch (decisionError) {
      setError(errorMessage(decisionError, t("Remontti-ilmoituksen käsittely epäonnistui.")));
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

  return (
    <section className="content">
      <a className="back-link" href="#/companies">{t("← Taloyhtiöt")}</a>

      <NoticeFilters
        companies={companies}
        company={companyFilter}
        onCompany={setCompanyFilter}
        status={statusFilter}
        onStatus={setStatusFilter}
        statuses={(["pending", "approved", "rejected", "completed"] as const).map(value => ({ value, label: renovationStatusLabels[value] }))}
      />

      <div className="residents-toolbar">
        <span>{inCompany.length}{" "}{t("remontti-ilmoitusta ·")}{" "}{pendingCount}{" "}{t("odottaa käsittelyä")}</span>
      </div>

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <p className="send-error">{t("Remontti-ilmoitusten lataus epäonnistui.")}</p>
        : notices.length === 0 ? <div className="empty">{t("Ei remontti-ilmoituksia. Asukas tekee ilmoituksen asukasportaalissa.")}</div>
        : visible.length === 0 ? (
          <div className="empty">
            {statusFilter === "pending" ? t("Ei käsittelyä odottavia remontti-ilmoituksia.") : t("Ei suodattimia vastaavia remontti-ilmoituksia.")}
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
                  <th>{t("Työ")}</th>
                  <th>{t("Ajankohta")}</th>
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
                    title={t("Avaa remontti-ilmoitus")}
                    onClick={() => openNotice(notice.id)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openNotice(notice.id);
                      }
                    }}
                  >
                    <td>
                      <strong>{notice.resident_name || t("Tuntematon asukas")}</strong>
                      <span>{notice.description.length > 110 ? `${notice.description.slice(0, 110)}…` : notice.description}</span>
                    </td>
                    {showCompany && <td>{companyName(notice.company_id)}</td>}
                    <td>{notice.apartment_number || "–"}</td>
                    <td><span className="type">{t(notice.work_type)}</span></td>
                    <td>
                      {renovationPeriod(notice)}
                      {isUnconfirmed(notice) && <span className="late-note">{t("Päättynyt, valmistumista ei ole kuitattu")}</span>}
                    </td>
                    <td><span className={`work-order-status ${noticeStatusClass(notice.status)}`}>{renovationStatusLabels[notice.status]}</span></td>
                    <td>{formatDateOnly(notice.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {paged.pager}

      {open && (
        <div className="overlay" onClick={() => !saving && setOpenId(null)}>
          <aside className="drawer form-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={() => setOpenId(null)} disabled={saving}>×</button>
            <h2>{t("Remontti-ilmoitus")}</h2>
            <p className="muted">
              {open.resident_name || t("Tuntematon asukas")} · {companyName(open.company_id)} · {open.apartment_number || "–"}
              {open.address ? `, ${open.address}` : ""}{" "}{t("· ilmoitettu")}{" "}{formatDate(open.created_at)}
            </p>

            <dl className="ticket-facts">
              <div>
                <dt>{t("Työ")}</dt>
                <dd>{t(open.work_type)}</dd>
              </div>
              <div>
                <dt>{t("Ajankohta")}</dt>
                <dd>{renovationPeriod(open)}</dd>
              </div>
              <div>
                <dt>{t("Tila")}</dt>
                <dd>{renovationStatusLabels[open.status]}{open.decided_by ? ` · ${open.decided_by}` : ""}</dd>
              </div>
              <div>
                <dt>{t("Urakoitsija")}</dt>
                <dd>{open.contractor || "–"}</dd>
              </div>
            </dl>

            <h3>{t("Työn kuvaus")}</h3>
            <p className="announcement-body">{open.description}</p>

            {open.decision_note && (
              <>
                <h3>{open.status === "rejected" ? t("Hylkäämisen perustelu") : t("Hyväksynnän ehdot")}</h3>
                <p className="announcement-body">{open.decision_note}</p>
              </>
            )}

            {open.status !== "completed" && open.status !== "rejected" && !isManager() && (
              <p className="reply-hint">{t("Remontti-ilmoituksen käsittelee isännöitsijä tai pääkäyttäjä.")}</p>
            )}
            {open.status === "pending" && isManager() && (
              <div className="ticket-form">
                <label>
                  <span>{t("Ehdot tai perustelu")}</span>
                  <textarea
                    value={note}
                    onChange={event => setNote(event.target.value)}
                    rows={4}
                    maxLength={3000}
                    placeholder={t("Esim. valvoja tarkastaa vesieristyksen ennen laatoitusta. Hylkäys vaatii perustelun.")}
                  />
                </label>
                <p className="reply-hint">{t("Asukas saa päätöksestä sähköpostin, jossa ehdot tai perustelu ovat mukana.")}</p>
                <div className="draft-actions">
                  <button className="primary" onClick={() => void decide(open, "approve")} disabled={saving}>
                    {saving ? t("Käsitellään…") : t("Hyväksy")}
                  </button>
                  <button onClick={() => void decide(open, "reject")} disabled={saving}>{t("Hylkää")}</button>
                </div>
              </div>
            )}
            {open.status === "approved" && isManager() && (
              <div className="draft-actions">
                <button className="primary" onClick={() => void decide(open, "complete")} disabled={saving}>{t("Merkitse valmistuneeksi")}</button>
              </div>
            )}
            {open.status === "completed" && open.completed_at && (
              <p className="portal-sent">{t("Merkitty valmistuneeksi")}{" "}{formatDate(open.completed_at)}.</p>
            )}
            {error && <p className="send-error">{error}</p>}
          </aside>
        </div>
      )}
    </section>
  );
}
