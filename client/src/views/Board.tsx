import { type FormEvent, useEffect, useState } from "react";
import { LanguageToggle } from "../components/common";
import { formatDate, formatDay, formatTicketNumber, priorityLabel, statusLabel } from "../format";
import { locale, t } from "../i18n";
import { api, errorMessage, isManager, logout, MANAGEMENT_OFFICE } from "../session";
import { formatDuration } from "./Metrics";
import { renovationStatusLabels } from "./Renovations";

// ---------------------------------------------------------------------------------------------
// Taloyhtiön hallitus: isännöitsijä luo hallituksen jäsenille tunnukset taloyhtiön tiedoista, ja
// jäsen näkee kirjauduttuaan oman yhtiönsä tehtävien tilanteen, remontit ja tiedotteet.
// ---------------------------------------------------------------------------------------------

type BoardMember = { id: string; name: string; email: string; created_at: string; last_login_at: string | null };

// Hallituksen jäsenten tunnukset taloyhtiön tiedoissa.
export function BoardMembersCard({ companyId }: { companyId: string }) {
  const [members, setMembers] = useState<BoardMember[]>([]);
  const [editing, setEditing] = useState<BoardMember | "new" | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const canManage = isManager();

  const load = () => api<BoardMember[]>(`/companies/${encodeURIComponent(companyId)}/board-members`)
    .then(setMembers)
    .catch(() => setMembers([]));
  useEffect(() => { void load(); }, [companyId]);

  function edit(member: BoardMember | "new") {
    setEditing(member);
    setName(member === "new" ? "" : member.name);
    setEmail(member === "new" ? "" : member.email);
    setPassword("");
    setError("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body = JSON.stringify({ name: name.trim(), email: email.trim(), password });
      if (editing === "new") await api(`/companies/${encodeURIComponent(companyId)}/board-members`, { method: "POST", body });
      else if (editing) await api(`/board-members/${encodeURIComponent(editing.id)}`, { method: "PUT", body });
      setEditing(null);
      await load();
    } catch (saveError) {
      setError(errorMessage(saveError, t("Tunnuksen tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function remove(member: BoardMember) {
    if (!window.confirm(t("Poistetaanko käyttäjän {0} tunnus hallituksen näkymään?", member.name))) return;
    try {
      await api(`/board-members/${encodeURIComponent(member.id)}`, { method: "DELETE" });
      setEditing(null);
      await load();
    } catch (removeError) {
      setError(errorMessage(removeError, t("Tunnuksen poisto epäonnistui.")));
    }
  }

  if (!canManage) return null;

  return (
    <div className="settings-card board-members">
      <div className="suggest-header">
        <h2>{t("Hallituksen näkymä")}</h2>
        {!editing && <button type="button" className="secondary" onClick={() => edit("new")}>{t("Lisää hallituksen jäsen")}</button>}
      </div>
      <p className="muted">
        {t("Hallituksen jäsen kirjautuu Pleissiin omilla tunnuksillaan ja näkee taloyhtiön tehtävien tilanteen, remontti-ilmoitukset ja tiedotteet. Hän ei voi muuttaa mitään eikä näe asukkaiden nimiä tai viestejä.")}
      </p>

      {members.length === 0 && !editing && <p className="drawer-empty">{t("Hallituksen jäsenille ei ole vielä tunnuksia.")}</p>}
      {members.length > 0 && (
        <ul className="board-member-list">
          {members.map(member => (
            <li key={member.id}>
              <span>
                <strong>{member.name}</strong>
                <small>
                  {member.email} · {member.last_login_at ? t("kirjautunut viimeksi {0}", formatDate(member.last_login_at)) : t("ei vielä kirjautunut")}
                </small>
              </span>
              <button type="button" className="secondary" onClick={() => edit(member)}>{t("Muokkaa")}</button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <form className="ticket-form board-member-form" onSubmit={save}>
          <div className="form-columns">
            <label>
              <span>{t("Nimi")}</span>
              <input value={name} onChange={event => setName(event.target.value)} autoComplete="off" />
            </label>
            <label>
              <span>{t("Sähköposti")}</span>
              <input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="off" />
            </label>
            <label>
              <span>{editing === "new" ? t("Salasana") : t("Uusi salasana (tyhjä = ei muutosta)")}</span>
              <input type="text" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" minLength={editing === "new" ? 8 : undefined} />
            </label>
          </div>
          <p className="reply-hint">{t("Kerro salasana jäsenelle turvallisesti. Hän voi myöhemmin vaihtaa sen kirjautumissivun Unohtuiko salasana -toiminnolla.")}</p>
          {error && <p className="send-error">{error}</p>}
          <div className="draft-actions">
            <button className="primary" type="submit" disabled={saving || !name.trim() || !email.trim() || (editing === "new" && password.length < 8)}>
              {saving ? t("Tallennetaan…") : editing === "new" ? t("Luo tunnus") : t("Tallenna muutokset")}
            </button>
            <button type="button" onClick={() => setEditing(null)}>{t("Peruuta")}</button>
            {editing !== "new" && <button type="button" className="danger-link" onClick={() => void remove(editing)}>{t("Poista tunnus")}</button>}
          </div>
        </form>
      )}
      {error && !editing && <p className="send-error">{error}</p>}
    </div>
  );
}

type BoardOverview = {
  member: { name: string; email: string };
  company: {
    name: string; address: string; businessId: string; maintenanceName: string; maintenancePhone: string;
    maintenanceEmergencyPhone: string; managerName: string | null; managerEmail: string | null;
  };
  stats: { open: number; received30: number; closed30: number; overdue30: number; avgFirstResponseHours: number | null };
  tickets: {
    number: number | null; subject: string; type: string; status: string; priority: string;
    created_at: string; closed_at: string | null; due_date: string | null;
  }[];
  renovations: {
    id: string; work_type: string; description: string; start_date: string; end_date: string; status: string;
    created_at: string; completed_at: string | null; apartment_number: string | null;
  }[];
  announcements: { id: string; title: string; body: string; stairwell: string; created_at: string }[];
};

type BoardTab = "tickets" | "renovations" | "announcements";

// Hallituksen jäsenen näkymä: vain lukuoikeus oman taloyhtiön tietoihin.
export function BoardView({ name }: { name: string }) {
  const [overview, setOverview] = useState<BoardOverview | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<BoardTab>("tickets");
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    api<BoardOverview>("/board/overview")
      .then(setOverview)
      .catch(loadError => setError(errorMessage(loadError, t("Tietojen lataus epäonnistui. Päivitä sivu."))));
  }, []);

  const tickets = (overview?.tickets ?? []).filter(ticket => showClosed || ticket.status !== "closed");
  const today = new Date().toLocaleDateString("sv-SE");

  return (
    <div className="board-page">
      <header className="board-header">
        <img src="/pleissi-logo.svg" alt="Pleissi" className="board-logo" />
        <div>
          <strong>{overview?.company.name ?? t("Hallituksen näkymä")}</strong>
          <small>{t("Hallituksen näkymä")} · {MANAGEMENT_OFFICE.name}</small>
        </div>
        <div className="board-header-actions">
          <LanguageToggle />
          <span className="board-user">{name}</span>
          <button type="button" className="secondary" onClick={logout}>{t("Kirjaudu ulos")}</button>
        </div>
      </header>

      <main className="board-main">
        {error && <p className="send-error">{error}</p>}
        {!overview && !error && <div className="empty">{t("Ladataan…")}</div>}
        {overview && (
          <>
            <div className="queue-summary board-summary">
              <div>
                <span>{t("Kesken nyt")}</span>
                <strong>{overview.stats.open}</strong>
                <small>{t("avoimet tehtävät")}</small>
              </div>
              <div>
                <span>{t("Saapuneet")}</span>
                <strong>{overview.stats.received30}</strong>
                <small>{t("viimeiset 30 päivää")}</small>
              </div>
              <div>
                <span>{t("Ensimmäinen vastaus")}</span>
                <strong>{formatDuration(overview.stats.avgFirstResponseHours)}</strong>
                <small>{t("keskimäärin, 90 päivää")}</small>
              </div>
              <div className={overview.stats.overdue30 > 0 ? "summary-alert" : ""}>
                <span>{t("Myöhästyneet")}</span>
                <strong>{overview.stats.overdue30}</strong>
                <small>{t("viimeiset 30 päivää")}</small>
              </div>
            </div>

            <section className="report-card board-contact">
              <h2>{t("Yhteystiedot")}</h2>
              <dl>
                {overview.company.managerName && (
                  <div>
                    <dt>{t("Isännöitsijä")}</dt>
                    <dd>{overview.company.managerName}{overview.company.managerEmail && <> · <a href={`mailto:${overview.company.managerEmail}`}>{overview.company.managerEmail}</a></>}</dd>
                  </div>
                )}
                {overview.company.maintenanceName && (
                  <div>
                    <dt>{t("Huoltoyhtiö")}</dt>
                    <dd>{[overview.company.maintenanceName, overview.company.maintenancePhone].filter(Boolean).join(" · ")}</dd>
                  </div>
                )}
                {overview.company.maintenanceEmergencyPhone && (
                  <div>
                    <dt>{t("Päivystys")}</dt>
                    <dd>{overview.company.maintenanceEmergencyPhone}</dd>
                  </div>
                )}
              </dl>
            </section>

            <div className="billing-tabs board-tabs" role="tablist">
              {([
                ["tickets", t("Tehtävät")],
                ["renovations", t("Remontit")],
                ["announcements", t("Tiedotteet")]
              ] as const).map(([key, label]) => (
                <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
                  {label}
                </button>
              ))}
            </div>

            {tab === "tickets" && (
              <section className="report-card">
                <div className="suggest-header">
                  <h2>{t("Taloyhtiön tehtävät")}</h2>
                  <label className="board-toggle">
                    <input type="checkbox" checked={showClosed} onChange={event => setShowClosed(event.target.checked)} />
                    {t("Näytä myös suljetut (12 kk)")}
                  </label>
                </div>
                <p className="muted">{t("Asukkaiden henkilötiedot ja viestit eivät näy hallitukselle. Kysy lisätietoja isännöitsijältä.")}</p>
                {tickets.length === 0 ? <p className="drawer-empty">{t("Ei avoimia tehtäviä.")}</p> : (
                  <div className="table-card">
                    <table className="data-table board-tickets">
                      <thead>
                        <tr>
                          <th>{t("Nro")}</th>
                          <th>{t("Aihe")}</th>
                          <th>{t("Tyyppi")}</th>
                          <th>{t("Tila")}</th>
                          <th>{t("Saapui")}</th>
                          <th>{t("Määräaika")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tickets.map((ticket, index) => {
                          const late = ticket.due_date && ticket.status !== "closed" && ticket.due_date < today;
                          return (
                            <tr key={`${ticket.number}-${index}`}>
                              <td className="ticket-number">#{formatTicketNumber(ticket.number)}</td>
                              <td>
                                <strong>{ticket.subject}</strong>
                                {(ticket.priority === "emergency" || ticket.priority === "urgent") && (
                                  <span className={`priority ${ticket.priority}`}>{priorityLabel(ticket.priority)}</span>
                                )}
                              </td>
                              <td>{t(ticket.type)}</td>
                              <td><span className={`status-badge status-${ticket.status}`}>{statusLabel(ticket.status)}</span></td>
                              <td>{formatDay(ticket.created_at.slice(0, 10))}</td>
                              <td className={late ? "metric-alert" : ""}>
                                {ticket.status === "closed"
                                  ? t("Suljettu {0}", ticket.closed_at ? formatDay(ticket.closed_at.slice(0, 10)) : "")
                                  : ticket.due_date ? `${formatDay(ticket.due_date)}${late ? ` · ${t("myöhässä")}` : ""}` : "–"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {tab === "renovations" && (
              <section className="report-card">
                <h2>{t("Remontti-ilmoitukset")}</h2>
                {overview.renovations.length === 0 ? <p className="drawer-empty">{t("Ei remontti-ilmoituksia.")}</p> : (
                  <div className="board-cards">
                    {overview.renovations.map(renovation => (
                      <article key={renovation.id} className="board-card">
                        <div className="board-card-head">
                          <strong>{renovation.work_type ? t(renovation.work_type) : t("Remontti")}{renovation.apartment_number && ` · ${t("asunto {0}", renovation.apartment_number)}`}</strong>
                          <span className={`status-badge renovation-${renovation.status}`}>{renovationStatusLabels[renovation.status as keyof typeof renovationStatusLabels] ?? renovation.status}</span>
                        </div>
                        {(renovation.start_date || renovation.end_date) && (
                          <small>{renovation.start_date ? formatDay(renovation.start_date) : ""}–{renovation.end_date ? formatDay(renovation.end_date) : ""}</small>
                        )}
                        <p>{renovation.description}</p>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}

            {tab === "announcements" && (
              <section className="report-card">
                <h2>{t("Tiedotteet")}</h2>
                {overview.announcements.length === 0 ? <p className="drawer-empty">{t("Ei tiedotteita.")}</p> : (
                  <div className="board-cards">
                    {overview.announcements.map(item => (
                      <article key={item.id} className="board-card">
                        <div className="board-card-head">
                          <strong>{item.title}</strong>
                          <small>{new Date(item.created_at).toLocaleDateString(locale)}{item.stairwell && ` · ${t("porras {0}", item.stairwell)}`}</small>
                        </div>
                        <p>{item.body}</p>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
