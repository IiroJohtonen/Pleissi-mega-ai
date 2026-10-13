import { useEffect, useState } from "react";
import { usePaged } from "../components/common";
import { formatDate, formatDay } from "../format";
import { api, errorMessage, isManager } from "../session";
import type { Company } from "../types";

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
  pending: "Odottaa käsittelyä",
  approved: "Hyväksytty",
  rejected: "Hylätty",
  completed: "Valmistunut"
};

export function renovationPeriod(notice: Pick<RenovationNotice, "start_date" | "end_date">) {
  return `${formatDay(notice.start_date)}–${formatDay(notice.end_date)}`;
}

// Toimiston näkymä: asukkaiden remontti-ilmoitukset, jotka isännöitsijä hyväksyy tai hylkää.
export function RenovationNotices({ companies }: { companies: Company[] }) {
  const [notices, setNotices] = useState<RenovationNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
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
      setError("Kirjoita hylkäämisen perustelu.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api(`/renovations/${encodeURIComponent(notice.id)}/${decision}`, { method: "POST", body: JSON.stringify({ note: note.trim() }) });
      setNote("");
      await loadNotices();
    } catch (decisionError) {
      setError(errorMessage(decisionError, "Remontti-ilmoituksen käsittely epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  const paged = usePaged(notices, "");
  const open = notices.find(notice => notice.id === openId) ?? null;
  const pendingCount = notices.filter(notice => notice.status === "pending").length;

  return (
    <section className="content">
      <a className="back-link" href="#/companies">← Taloyhtiöt</a>

      <div className="residents-toolbar">
        <span>{notices.length} remontti-ilmoitusta · {pendingCount} odottaa käsittelyä</span>
      </div>

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <p className="send-error">Remontti-ilmoitusten lataus epäonnistui.</p>
        : notices.length === 0 ? <div className="empty">Ei remontti-ilmoituksia. Asukas tekee ilmoituksen asukasportaalissa.</div>
        : (
          <div className="table-card">
            <table className="data-table report-topics">
              <thead>
                <tr>
                  <th>Ilmoittaja</th>
                  <th>Taloyhtiö</th>
                  <th>Asunto</th>
                  <th>Työ</th>
                  <th>Ajankohta</th>
                  <th>Tila</th>
                  <th>Ilmoitettu</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(notice => (
                  <tr
                    key={notice.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title="Avaa remontti-ilmoitus"
                    onClick={() => openNotice(notice.id)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openNotice(notice.id);
                      }
                    }}
                  >
                    <td><strong>{notice.resident_name || "Tuntematon asukas"}</strong></td>
                    <td>{companyName(notice.company_id)}</td>
                    <td>{notice.apartment_number || "–"}</td>
                    <td><span className="type">{notice.work_type}</span></td>
                    <td>{renovationPeriod(notice)}</td>
                    <td><span className={`work-order-status ${notice.status === "pending" ? "" : "done"}`}>{renovationStatusLabels[notice.status]}</span></td>
                    <td>{formatDate(notice.created_at)}</td>
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
            <h2>Remontti-ilmoitus</h2>
            <p className="muted">
              {open.resident_name || "Tuntematon asukas"} · {companyName(open.company_id)} · {open.apartment_number || "–"}
              {open.address ? `, ${open.address}` : ""} · ilmoitettu {formatDate(open.created_at)}
            </p>

            <dl className="ticket-facts">
              <div>
                <dt>Työ</dt>
                <dd>{open.work_type}</dd>
              </div>
              <div>
                <dt>Ajankohta</dt>
                <dd>{renovationPeriod(open)}</dd>
              </div>
              <div>
                <dt>Tila</dt>
                <dd>{renovationStatusLabels[open.status]}{open.decided_by ? ` · ${open.decided_by}` : ""}</dd>
              </div>
              <div>
                <dt>Urakoitsija</dt>
                <dd>{open.contractor || "–"}</dd>
              </div>
            </dl>

            <h3>Työn kuvaus</h3>
            <p className="announcement-body">{open.description}</p>

            {open.decision_note && (
              <>
                <h3>{open.status === "rejected" ? "Hylkäämisen perustelu" : "Hyväksynnän ehdot"}</h3>
                <p className="announcement-body">{open.decision_note}</p>
              </>
            )}

            {open.status !== "completed" && open.status !== "rejected" && !isManager() && (
              <p className="reply-hint">Remontti-ilmoituksen käsittelee isännöitsijä tai pääkäyttäjä.</p>
            )}
            {open.status === "pending" && isManager() && (
              <div className="ticket-form">
                <label>
                  <span>Ehdot tai perustelu</span>
                  <textarea
                    value={note}
                    onChange={event => setNote(event.target.value)}
                    rows={4}
                    maxLength={3000}
                    placeholder="Esim. valvoja tarkastaa vesieristyksen ennen laatoitusta. Hylkäys vaatii perustelun."
                  />
                </label>
                <p className="reply-hint">Asukas saa päätöksestä sähköpostin, jossa ehdot tai perustelu ovat mukana.</p>
                <div className="draft-actions">
                  <button className="primary" onClick={() => void decide(open, "approve")} disabled={saving}>
                    {saving ? "Käsitellään…" : "Hyväksy"}
                  </button>
                  <button onClick={() => void decide(open, "reject")} disabled={saving}>Hylkää</button>
                </div>
              </div>
            )}
            {open.status === "approved" && isManager() && (
              <div className="draft-actions">
                <button className="primary" onClick={() => void decide(open, "complete")} disabled={saving}>Merkitse valmistuneeksi</button>
              </div>
            )}
            {open.status === "completed" && open.completed_at && (
              <p className="portal-sent">Merkitty valmistuneeksi {formatDate(open.completed_at)}.</p>
            )}
            {error && <p className="send-error">{error}</p>}
          </aside>
        </div>
      )}
    </section>
  );
}
