import { useEffect, useState } from "react";
import { usePaged } from "../components/common";
import { formatDate, formatDay } from "../format";
import { api, errorMessage, isManager } from "../session";
import type { Company } from "../types";

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
  resident_name?: string | null;
  apartment_number?: string | null;
  address?: string | null;
};

type MoveResult = { movedOut: number; parkingReleased: string[]; bookingsRemoved: number; added: string[]; skipped: string[] };

export const moveStatusLabels: Record<MoveNotice["status"], string> = { pending: "Odottaa käsittelyä", approved: "Hyväksytty", rejected: "Hylätty" };

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
    notice.moves_out ? "Nykyiset asukkaat muuttavat pois" : "",
    incoming ? `${incoming} uutta asukasta` : "",
    notice.door_name ? `nimi oveen: ${notice.door_name}` : ""
  ].filter(Boolean).join(" · ");
}

// Toimiston näkymä: asukkaiden muuttoilmoitukset, jotka hyväksytään tai hylätään.
export function MoveNotices({ companies }: { companies: Company[] }) {
  const [notices, setNotices] = useState<MoveNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
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
    } catch (decisionError) {
      setError(errorMessage(decisionError, "Muuttoilmoituksen käsittely epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  const paged = usePaged(notices, "");
  const open = notices.find(notice => notice.id === openId) ?? null;
  const pendingCount = notices.filter(notice => notice.status === "pending").length;
  let result: MoveResult | null;
  try {
    result = open?.result ? JSON.parse(open.result) : null;
  } catch {
    result = null;
  }

  return (
    <section className="content">
      <a className="back-link" href="#/companies">← Taloyhtiöt</a>

      <div className="residents-toolbar">
        <span>{notices.length} muuttoilmoitusta · {pendingCount} odottaa käsittelyä</span>
      </div>

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <p className="send-error">Muuttoilmoitusten lataus epäonnistui.</p>
        : notices.length === 0 ? <div className="empty">Ei muuttoilmoituksia. Asukas tekee ilmoituksen asukasportaalissa.</div>
        : (
          <div className="table-card">
            <table className="data-table report-topics">
              <thead>
                <tr>
                  <th>Ilmoittaja</th>
                  <th>Taloyhtiö</th>
                  <th>Asunto</th>
                  <th>Muuttopäivä</th>
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
                    title="Avaa muuttoilmoitus"
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
                      <strong>{notice.resident_name || "Tuntematon asukas"}</strong>
                      <span>{moveSummary(notice)}</span>
                    </td>
                    <td>{companyName(notice.company_id)}</td>
                    <td>{notice.apartment_number || "–"}</td>
                    <td>{formatDay(notice.move_date)}</td>
                    <td><span className={`work-order-status ${notice.status === "pending" ? "" : "done"}`}>{moveStatusLabels[notice.status]}</span></td>
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
            <h2>Muuttoilmoitus</h2>
            <p className="muted">
              {open.resident_name || "Tuntematon asukas"} · {companyName(open.company_id)} · {open.apartment_number || "–"}
              {open.address ? `, ${open.address}` : ""} · ilmoitettu {formatDate(open.created_at)}
            </p>

            <dl className="ticket-facts">
              <div>
                <dt>Muuttopäivä</dt>
                <dd>{formatDay(open.move_date)}</dd>
              </div>
              <div>
                <dt>Tila</dt>
                <dd>{moveStatusLabels[open.status]}{open.decided_by ? ` · ${open.decided_by}` : ""}</dd>
              </div>
              <div>
                <dt>Poismuutto</dt>
                <dd>{open.moves_out ? "Asunnon nykyiset asukkaat muuttavat pois" : "Ei"}</dd>
              </div>
              <div>
                <dt>Nimi oveen</dt>
                <dd>{open.door_name || "–"}</dd>
              </div>
            </dl>

            <h3>Uudet asukkaat</h3>
            {newResidentsOf(open).length === 0 ? <p className="muted">Ei uusia asukkaita.</p> : (
              <ul className="move-people">
                {newResidentsOf(open).map((person, index) => (
                  <li key={index}><strong>{person.name}</strong>{person.email ? ` · ${person.email}` : ""}</li>
                ))}
              </ul>
            )}
            {open.note && (
              <>
                <h3>Lisätiedot</h3>
                <p className="announcement-body">{open.note}</p>
              </>
            )}

            {open.status === "pending" && !isManager() && (
              <p className="reply-hint">Muuttoilmoituksen voi hyväksyä tai hylätä isännöitsijä tai pääkäyttäjä.</p>
            )}
            {open.status === "pending" && isManager() && (
              <>
                <p className="reply-hint">
                  Hyväksyntä päivittää asukastietokannan: lähtijät poistuvat asukaslistalta muuttopäivänä, heidän
                  autopaikkansa vapautuvat ja vuoronsa poistuvat muuttopäivästä alkaen, ja uudet asukkaat lisätään asuntoon.
                </p>
                <div className="draft-actions">
                  <button className="primary" onClick={() => void decide(open, "approve")} disabled={saving}>
                    {saving ? "Käsitellään…" : "Hyväksy"}
                  </button>
                  <button onClick={() => void decide(open, "reject")} disabled={saving}>Hylkää</button>
                </div>
              </>
            )}
            {open.status === "approved" && result && (
              <p className="portal-sent">
                Hyväksytty: {result.movedOut} asukasta merkitty muuttaneeksi, {result.added.length} lisätty
                {result.parkingReleased.length > 0 && `, autopaikat vapautuvat: ${result.parkingReleased.join(", ")}`}
                {result.bookingsRemoved > 0 && `, ${result.bookingsRemoved} vuoroa poistettu`}.
                {result.skipped.length > 0 && ` Lisäämättä jäi: ${result.skipped.join(", ")}.`}
              </p>
            )}
            {error && <p className="send-error">{error}</p>}
          </aside>
        </div>
      )}
    </section>
  );
}
