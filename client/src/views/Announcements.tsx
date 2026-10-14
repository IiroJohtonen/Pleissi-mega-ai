import { type FormEvent, useEffect, useState } from "react";
import { Dropdown, NoticeFilters, usePaged } from "../components/common";
import { formatDate, formatDateOnly } from "../format";
import { api, errorMessage, isManager } from "../session";
import type { Company } from "../types";
import { t } from "../i18n";

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
  const [companyFilter, setCompanyFilter] = useState("all");
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
  const targetLabel = (item: { stairwell: string }) => item.stairwell ? t("Rappu {0}", item.stairwell) : t("Koko taloyhtiö");

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
        ? t("Tiedote julkaistiin portaalissa, mutta sähköpostin lähetys epäonnistui ({0} lähti).", result.emailed)
        : sendEmail
          ? t("Tiedote julkaistu ja lähetetty {0} sähköpostiosoitteeseen.", result.emailed)
          : t("Tiedote julkaistu asukasportaalissa."));
      await loadAnnouncements();
    } catch (submitError) {
      setFormError(errorMessage(submitError, t("Tiedotteen julkaisu epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(item: Announcement) {
    if (!window.confirm(t("Poistetaanko tiedote asukasportaalista? Lähetettyjä sähköposteja ei voi perua."))) return;
    try {
      await api(`/announcements/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      setOpen(null);
      await loadAnnouncements();
    } catch {
      setNotice(t("Tiedotteen poistaminen epäonnistui."));
    }
  }

  const visible = announcements.filter(item => companyFilter === "all" || item.company_id === companyFilter);
  const showCompany = companies.length > 1;
  const paged = usePaged(visible, companyFilter);

  return (
    <section className="content">
      <a className="back-link" href="#/companies">{t("← Taloyhtiöt")}</a>

      <NoticeFilters companies={companies} company={companyFilter} onCompany={setCompanyFilter} />

      <div className="residents-toolbar">
        <span>{visible.length}{" "}{t("tiedotetta")}</span>
        {isManager() && <button className="secondary" onClick={openForm}>{t("Uusi tiedote")}</button>}
      </div>

      {notice && <p className="portal-sent">{notice}</p>}

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <p className="send-error">{t("Tiedotteiden lataus epäonnistui.")}</p>
        : visible.length === 0 ? <div className="empty">{t("Ei tiedotteita.")}</div>
        : (
          <div className="table-card">
            <table className="data-table report-topics notice-table">
              <thead>
                <tr>
                  <th>{t("Tiedote")}</th>
                  {showCompany && <th>{t("Taloyhtiö")}</th>}
                  <th>{t("Kohde")}</th>
                  <th>{t("Lähetys")}</th>
                  <th>{t("Julkaisija")}</th>
                  <th>{t("Julkaistu")}</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(item => (
                  <tr
                    key={item.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title={t("Avaa tiedote")}
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
                    {showCompany && <td>{companyName(item.company_id)}</td>}
                    <td>{targetLabel(item)}</td>
                    <td>{item.emailed_count ? t("Portaali ja {0} sähköpostia", item.emailed_count) : t("Vain portaali")}</td>
                    <td>{item.created_by}</td>
                    <td>{formatDateOnly(item.created_at)}</td>
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
            <button type="button" className="drawer-back" onClick={() => setOpen(null)}>{t("← Takaisin")}</button>
            <button className="close" onClick={() => setOpen(null)}>×</button>
            <h2>{open.title}</h2>
            <p className="muted">
              {companyName(open.company_id)} · {targetLabel(open)} · {formatDate(open.created_at)} · {open.created_by}
              {open.emailed_count ? t(" · lähetetty {0} sähköpostiosoitteeseen", open.emailed_count) : t(" · vain asukasportaalissa")}
            </p>
            <p className="announcement-body">{open.body}</p>
            {isManager() && (
              <div className="draft-actions">
                <button className="danger" onClick={() => void handleDelete(open)}>{t("Poista tiedote")}</button>
              </div>
            )}
          </aside>
        </div>
      )}

      {creating && (
        <div className="overlay">
          <aside className="drawer form-drawer">
            <button type="button" className="drawer-back" onClick={() => setCreating(false)} disabled={saving}>{t("← Takaisin")}</button>
            <button className="close" onClick={() => setCreating(false)} disabled={saving}>×</button>
            <h2>{t("Uusi tiedote")}</h2>
            <p className="muted">{t("Tiedote näkyy asukkaille asukasportaalissa ja lähtee haluttaessa sähköpostilla.")}</p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              <Dropdown
                label={t("Taloyhtiö")}
                value={formCompany}
                options={companies.map(company => ({ value: company.id, label: company.name }))}
                onChange={setFormCompany}
              />
              <Dropdown
                label={t("Kohde")}
                value={stairwell}
                options={[
                  { value: "", label: t("Koko taloyhtiö") },
                  ...(audience?.stairwells ?? []).map(item => ({ value: item.stairwell, label: t("Rappu {0}", item.stairwell) }))
                ]}
                onChange={setStairwell}
              />
              <label>
                <span>{t("Otsikko")}</span>
                <input value={title} onChange={event => setTitle(event.target.value)} maxLength={150} placeholder={t("Esim. Vesikatko ti 20.10. klo 9–12")} required />
              </label>
              <label>
                <span>{t("Teksti")}</span>
                <textarea value={body} onChange={event => setBody(event.target.value)} rows={9} maxLength={8000} required />
              </label>
              <label className="switch-row">
                <span>
                  <strong>{t("Lähetä myös sähköpostilla")}</strong>
                  <small>
                    {target
                      ? t("{0} asukasta, joista {1} sähköpostiosoitetta. Osoitteet ovat piilokopiona.", target.residents, target.emails)
                      : t("Vastaanottajien määrää ei saatu ladattua.")}
                  </small>
                </span>
                <input type="checkbox" role="switch" checked={sendEmail} onChange={() => setSendEmail(!sendEmail)} />
                <i aria-hidden="true" />
              </label>

              {formError && <p className="send-error">{formError}</p>}

              <div className="draft-actions">
                <button className="primary" type="submit" disabled={saving || title.trim().length < 3 || body.trim().length < 5}>
                  {saving ? t("Julkaistaan…") : sendEmail ? t("Julkaise ja lähetä") : t("Julkaise")}
                </button>
                <button type="button" onClick={() => setCreating(false)} disabled={saving}>{t("Peruuta")}</button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </section>
  );
}
