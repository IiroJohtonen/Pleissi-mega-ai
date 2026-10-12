import { type FormEvent, useEffect, useState } from "react";
import { Dropdown, usePaged } from "../components/common";
import { formatDate } from "../format";
import { api, errorMessage, isManager } from "../session";
import type { Company } from "../types";

export type Announcement = {
  id: string;
  company_id: string;
  stairwell: string;
  title: string;
  body: string;
  emailed_count: number;
  created_by: string;
  created_at: string;
};

type AnnouncementAudience = {
  all: { residents: number; emails: number };
  stairwells: { stairwell: string; residents: number; emails: number }[];
};

// Tiedotteet: isännöitsijän viestit taloyhtiön tai yhden rapun asukkaille.
export function Announcements({ companies, defaultCompanyId }: { companies: Company[]; defaultCompanyId: string }) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState<Announcement | null>(null);
  const [creating, setCreating] = useState(false);
  const [formCompany, setFormCompany] = useState(defaultCompanyId);
  const [audience, setAudience] = useState<AnnouncementAudience | null>(null);
  const [stairwell, setStairwell] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";
  const targetLabel = (item: { stairwell: string }) => item.stairwell ? `Rappu ${item.stairwell}` : "Koko taloyhtiö";

  async function loadAnnouncements() {
    try {
      const lists = await Promise.all(companies.map(company =>
        api<Announcement[]>(`/companies/${encodeURIComponent(company.id)}/announcements`)));
      setAnnouncements(lists.flat().sort((a, b) => b.created_at.localeCompare(a.created_at)));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAnnouncements();
  }, [companies.length]);

  // Vastaanottajien määrä ja raput lomakkeen taloyhtiölle.
  useEffect(() => {
    if (!creating || !formCompany) return;
    setAudience(null);
    setStairwell("");
    api<AnnouncementAudience>(`/companies/${encodeURIComponent(formCompany)}/announcement-audience`)
      .then(setAudience)
      .catch(() => setAudience(null));
  }, [creating, formCompany]);

  const target = stairwell ? audience?.stairwells.find(item => item.stairwell === stairwell) : audience?.all;

  function openForm() {
    setFormCompany(defaultCompanyId || companies[0]?.id || "");
    setTitle("");
    setBody("");
    setSendEmail(true);
    setFormError("");
    setCreating(true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      const result = await api<{ emailed: number; emailFailed: boolean }>(
        `/companies/${encodeURIComponent(formCompany)}/announcements`,
        { method: "POST", body: JSON.stringify({ title: title.trim(), body: body.trim(), stairwell, sendEmail }) }
      );
      setCreating(false);
      setNotice(result.emailFailed
        ? `Tiedote julkaistiin portaalissa, mutta sähköpostin lähetys epäonnistui (${result.emailed} lähti).`
        : sendEmail
          ? `Tiedote julkaistu ja lähetetty ${result.emailed} sähköpostiosoitteeseen.`
          : "Tiedote julkaistu asukasportaalissa.");
      await loadAnnouncements();
    } catch (submitError) {
      setFormError(errorMessage(submitError, "Tiedotteen julkaisu epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(item: Announcement) {
    if (!window.confirm("Poistetaanko tiedote asukasportaalista? Lähetettyjä sähköposteja ei voi perua.")) return;
    try {
      await api(`/announcements/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      setOpen(null);
      await loadAnnouncements();
    } catch {
      setNotice("Tiedotteen poistaminen epäonnistui.");
    }
  }

  const paged = usePaged(announcements, "");

  return (
    <section className="content">
      <a className="back-link" href="#/companies">← Taloyhtiöt</a>

      <div className="residents-toolbar">
        <span>{announcements.length} tiedotetta</span>
        {isManager() && <button className="secondary" onClick={openForm}>Uusi tiedote</button>}
      </div>

      {notice && <p className="portal-sent">{notice}</p>}

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <p className="send-error">Tiedotteiden lataus epäonnistui.</p>
        : announcements.length === 0 ? <div className="empty">Ei tiedotteita.</div>
        : (
          <div className="table-card">
            <table className="data-table report-topics">
              <thead>
                <tr>
                  <th>Tiedote</th>
                  <th>Taloyhtiö</th>
                  <th>Kohde</th>
                  <th>Sähköposteja</th>
                  <th>Julkaisija</th>
                  <th>Julkaistu</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(item => (
                  <tr
                    key={item.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title="Avaa tiedote"
                    onClick={() => setOpen(item)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpen(item);
                      }
                    }}
                  >
                    <td>
                      <strong>{item.title}</strong>
                      <span>{item.body.length > 110 ? `${item.body.slice(0, 110)}…` : item.body}</span>
                    </td>
                    <td>{companyName(item.company_id)}</td>
                    <td>{targetLabel(item)}</td>
                    <td>{item.emailed_count || "–"}</td>
                    <td>{item.created_by}</td>
                    <td>{formatDate(item.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {paged.pager}

      {open && (
        <div className="overlay" onClick={() => setOpen(null)}>
          <aside className="drawer form-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={() => setOpen(null)}>×</button>
            <h2>{open.title}</h2>
            <p className="muted">
              {companyName(open.company_id)} · {targetLabel(open)} · {formatDate(open.created_at)} · {open.created_by}
              {open.emailed_count ? ` · lähetetty ${open.emailed_count} sähköpostiosoitteeseen` : " · vain asukasportaalissa"}
            </p>
            <p className="announcement-body">{open.body}</p>
            {isManager() && (
              <div className="draft-actions">
                <button className="danger" onClick={() => void handleDelete(open)}>Poista tiedote</button>
              </div>
            )}
          </aside>
        </div>
      )}

      {creating && (
        <div className="overlay" onClick={() => !saving && setCreating(false)}>
          <aside className="drawer form-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={() => setCreating(false)} disabled={saving}>×</button>
            <h2>Uusi tiedote</h2>
            <p className="muted">Tiedote näkyy asukkaille asukasportaalissa ja lähtee haluttaessa sähköpostilla.</p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              <Dropdown
                label="Taloyhtiö"
                value={formCompany}
                options={companies.map(company => ({ value: company.id, label: company.name }))}
                onChange={setFormCompany}
              />
              <Dropdown
                label="Kohde"
                value={stairwell}
                options={[
                  { value: "", label: "Koko taloyhtiö" },
                  ...(audience?.stairwells ?? []).map(item => ({ value: item.stairwell, label: `Rappu ${item.stairwell}` }))
                ]}
                onChange={setStairwell}
              />
              <label>
                <span>Otsikko</span>
                <input value={title} onChange={event => setTitle(event.target.value)} maxLength={150} placeholder="Esim. Vesikatko ti 20.10. klo 9–12" required />
              </label>
              <label>
                <span>Teksti</span>
                <textarea value={body} onChange={event => setBody(event.target.value)} rows={9} maxLength={8000} required />
              </label>
              <label className="switch-row">
                <span>
                  <strong>Lähetä myös sähköpostilla</strong>
                  <small>
                    {target
                      ? `${target.residents} asukasta, joista ${target.emails} sähköpostiosoitetta. Osoitteet ovat piilokopiona.`
                      : "Vastaanottajien määrää ei saatu ladattua."}
                  </small>
                </span>
                <input type="checkbox" role="switch" checked={sendEmail} onChange={() => setSendEmail(!sendEmail)} />
                <i aria-hidden="true" />
              </label>

              {formError && <p className="send-error">{formError}</p>}

              <div className="draft-actions">
                <button className="primary" type="submit" disabled={saving || title.trim().length < 3 || body.trim().length < 5}>
                  {saving ? "Julkaistaan…" : sendEmail ? "Julkaise ja lähetä" : "Julkaise"}
                </button>
                <button type="button" onClick={() => setCreating(false)} disabled={saving}>Peruuta</button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </section>
  );
}
