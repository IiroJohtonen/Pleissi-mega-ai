import { useEffect, useState } from "react";
import { formatDate, formatTicketNumber, statusLabel } from "../format";
import { t } from "../i18n";
import { api, errorMessage } from "../session";
import { placeLabel, topicLabel } from "../topics";

export type IncidentInterpretation = {
  summary: string; likelyCause: string; actions: string[]; workOrder: string;
  announcementTitle: string; announcementBody: string; reply: string;
};

export type Incident = {
  id: string; companyId: string; companyName: string; topic: string; stairwell: string;
  status: "open" | "ordered" | "resolved" | "dismissed";
  firstReportAt: string; lastReportAt: string; createdAt: string; summary: string;
  ai: IncidentInterpretation | null; aiAt: string | null; autoReply: boolean; replyMessage: string;
  announcedAt: string | null; orderedAt: string | null; handledBy: string | null; handledAt: string | null; resolution?: string | null;
  drafts: { workOrder: string; announcementTitle: string; announcementBody: string; reply: string };
  reporters: number;
  tickets: { id: string; ticketNumber: number | null; subject: string; status: string; createdAt: string;
    apartmentNumber: string | null; stairwell: string; residentName: string | null }[];
};

const incidentStatusLabels: Record<Incident["status"], string> = {
  open: t("Uusi"),
  ordered: t("Työtilaus tehty"),
  resolved: t("Korjattu"),
  dismissed: t("Ei yhteinen vika")
};

const active = (incident: Incident) => incident.status === "open" || incident.status === "ordered";

// Päätösjonon yläosan lista: mahdolliset yhteiset viat, joihin isännöitsijän kannattaa tarttua ennen
// yksittäisiä ilmoituksia. Lista ei näy, kun avoimia poikkeamia ei ole.
export function IncidentList({ refreshKey, onOpenTicket }: { refreshKey: number; onOpenTicket: (ticketId: string) => void }) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const load = () => api<Incident[]>("/incidents").then(setIncidents).catch(() => setIncidents([]));
  useEffect(() => {
    void load();
  }, [refreshKey]);

  if (!incidents.length && !openId) return null;
  return (
    <>
      {incidents.length > 0 && (
        <section className="incident-list" aria-labelledby="incident-list-title">
          <h2 id="incident-list-title" className="queue-subheading">
            {t("Mahdolliset yhteiset viat")}
            <b>{incidents.length}</b>
          </h2>
          <ul>
            {incidents.map(incident => (
              <li key={incident.id}>
                <button type="button" className="incident-row" onClick={() => setOpenId(incident.id)}>
                  <span className="incident-row-title">
                    <strong>{topicLabel(incident.topic)}, {placeLabel(incident.stairwell)}</strong>
                    <span>{incident.companyName}</span>
                  </span>
                  <span className="incident-row-meta">
                    <span>{t("{0} asuntoa", incident.reporters)}</span>
                    <span>{t("viimeisin {0}", formatDate(incident.lastReportAt))}</span>
                    <span className={`incident-status incident-${incident.status}`}>{incidentStatusLabels[incident.status]}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {openId && (
        <IncidentDrawer
          incidentId={openId}
          onClose={() => setOpenId(null)}
          onChanged={load}
          onOpenTicket={ticketId => {
            setOpenId(null);
            onOpenTicket(ticketId);
          }}
        />
      )}
    </>
  );
}

// Yhteisen vian tiedot ja toimenpiteet: kaikki liitetyt ilmoitukset hoidetaan kerralla.
export function IncidentDrawer({
  incidentId, onClose, onChanged, onOpenTicket
}: {
  incidentId: string;
  onClose: () => void;
  onChanged?: () => void | Promise<unknown>;
  onOpenTicket?: (ticketId: string) => void;
}) {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [workOrder, setWorkOrder] = useState("");
  const [announcementTitle, setAnnouncementTitle] = useState("");
  const [announcementBody, setAnnouncementBody] = useState("");
  const [announcementEmail, setAnnouncementEmail] = useState(false);
  const [reply, setReply] = useState("");
  const [autoReply, setAutoReply] = useState(false);
  const [resolution, setResolution] = useState(t("Vika on korjattu. Kiitos ilmoituksestasi."));
  const [cause, setCause] = useState("");

  // Luonnokset: AI-tulkinnan teksti, jos se on pyydetty, muuten valmis pohja.
  function fill(next: Incident) {
    setIncident(next);
    setWorkOrder(next.ai?.workOrder || next.drafts.workOrder);
    setAnnouncementTitle(next.ai?.announcementTitle || next.drafts.announcementTitle);
    setAnnouncementBody(next.ai?.announcementBody || next.drafts.announcementBody);
    setReply(next.replyMessage || next.ai?.reply || next.drafts.reply);
    setAutoReply(next.autoReply);
  }

  useEffect(() => {
    api<Incident>(`/incidents/${encodeURIComponent(incidentId)}`)
      .then(fill)
      .catch(caught => setError(errorMessage(caught, t("Yhteisen vian lataus epäonnistui."))));
  }, [incidentId]);

  async function run(action: string, work: () => Promise<Incident | void>, done?: string) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const next = await work();
      if (next) fill(next);
      if (done) setNotice(done);
      await onChanged?.();
    } catch (caught) {
      setError(errorMessage(caught, t("Toiminto epäonnistui. Yritä uudelleen.")));
    } finally {
      setBusy("");
    }
  }

  const post = <T,>(path: string, body: unknown = {}, method = "POST") =>
    api<T>(path, { method, body: JSON.stringify(body) });

  if (!incident) {
    return (
      <div className="overlay">
        <aside className="drawer incident-drawer" role="dialog" aria-modal="true" aria-label={t("Mahdollinen yhteinen vika")}>
          <button className="close" onClick={onClose}>×</button>
          <p className={error ? "send-error" : "muted"}>{error || t("Ladataan…")}</p>
        </aside>
      </div>
    );
  }

  const path = `/incidents/${encodeURIComponent(incident.id)}`;
  const firstOpen = incident.tickets.find(ticket => ticket.status !== "closed") ?? incident.tickets[0];
  const isActive = active(incident);

  return (
    <div className="overlay">
      <aside className="drawer incident-drawer" role="dialog" aria-modal="true" aria-labelledby="incident-title">
        <button className="close" onClick={onClose} disabled={Boolean(busy)}>×</button>
        <h2 id="incident-title">{t("Mahdollinen yhteinen vika: {0}", topicLabel(incident.topic))}</h2>
        <p className="incident-subtitle">
          {incident.companyName}, {placeLabel(incident.stairwell)}
          <span className={`incident-status incident-${incident.status}`}>{incidentStatusLabels[incident.status]}</span>
        </p>

        <section className="incident-section">
          <h3>{t("Tilanne")}</h3>
          <p>{incident.summary}</p>
        </section>

        <section className="incident-section">
          <h3>{t("AI-tulkinta")}</h3>
          {incident.ai ? (
            <div className="incident-ai">
              <p>{incident.ai.summary}</p>
              <p><strong>{t("Todennäköinen syy")}</strong> {incident.ai.likelyCause}</p>
              {incident.ai.actions.length > 0 && (
                <ol>{incident.ai.actions.map(action => <li key={action}>{action}</li>)}</ol>
              )}
              <p className="reply-hint">{t("AI:n arvio {0}. Tarkista ennen kuin toimit sen perusteella.", formatDate(incident.aiAt ?? undefined))}</p>
            </div>
          ) : (
            <p className="muted">{t("AI voi arvioida ilmoitusten, työtilausten, tiedotteiden ja taloyhtiön dokumentaation perusteella, mistä vika todennäköisesti johtuu, ja kirjoittaa luonnokset alla oleviin kenttiin.")}</p>
          )}
          {isActive && (
            <div className="draft-actions">
              <button type="button" disabled={Boolean(busy)} onClick={() => void run("ai", () => post<Incident>(`${path}/interpret`))}>
                {busy === "ai" ? t("AI tulkitsee…") : incident.ai ? t("Päivitä AI-tulkinta") : t("Pyydä AI-tulkinta")}
              </button>
            </div>
          )}
        </section>

        <section className="incident-section">
          <h3>{t("Ilmoitukset ({0})", incident.tickets.length)}</h3>
          <ul className="incident-tickets">
            {incident.tickets.map(ticket => (
              <li key={ticket.id}>
                <button type="button" className="link-button" onClick={() => onOpenTicket?.(ticket.id)} disabled={!onOpenTicket}>
                  #{formatTicketNumber(ticket.ticketNumber)} {ticket.subject}
                </button>
                <span>{[ticket.apartmentNumber, ticket.residentName].filter(Boolean).join(", ") || t("Asunto tuntematon")}</span>
                <span>{formatDate(ticket.createdAt)}</span>
                <span>{statusLabel(ticket.status)}</span>
                {isActive && (
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={Boolean(busy)}
                    title={t("Ilmoitus ei kuulu tähän vikaan. Se jää omaksi tehtäväkseen.")}
                    onClick={() => void run(`unlink-${ticket.id}`, () => post<Incident>(`${path}/tickets/${encodeURIComponent(ticket.id)}`, {}, "DELETE"))}
                  >
                    {t("Irrota")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {isActive ? (
          <>
            <section className="incident-section ticket-form">
              <h3>{t("Työtilaus huoltoyhtiölle")}</h3>
              {incident.orderedAt && <p className="reply-hint">{t("Työtilaus tehty {0}. Sen voi tehdä tarvittaessa uudelleen.", formatDate(incident.orderedAt))}</p>}
              <label>
                <span>{t("Kuvaus")}</span>
                <textarea value={workOrder} onChange={event => setWorkOrder(event.target.value)} rows={4} maxLength={4000} />
              </label>
              <p className="reply-hint">{t("Tilaus lähtee taloyhtiön huoltoyhtiölle ja kirjataan tehtävälle #{0}.", formatTicketNumber(firstOpen?.ticketNumber))}</p>
              <div className="draft-actions">
                <button
                  className="primary"
                  type="button"
                  disabled={Boolean(busy) || workOrder.trim().length < 3 || !firstOpen}
                  onClick={() => void run("order", async () => {
                    await post(`/tickets/${encodeURIComponent(firstOpen!.id)}/work-orders`, { description: workOrder.trim(), sendEmail: true });
                    return post<Incident>(`${path}/ordered`);
                  }, t("Työtilaus lähetetty huoltoyhtiölle."))}
                >
                  {busy === "order" ? t("Lähetetään…") : t("Lähetä työtilaus")}
                </button>
              </div>
            </section>

            <section className="incident-section ticket-form">
              <h3>{t("Tiedote asukkaille")}</h3>
              {incident.announcedAt && <p className="reply-hint">{t("Tiedote julkaistu {0}.", formatDate(incident.announcedAt))}</p>}
              <label>
                <span>{t("Otsikko")}</span>
                <input value={announcementTitle} onChange={event => setAnnouncementTitle(event.target.value)} maxLength={150} />
              </label>
              <label>
                <span>{t("Teksti")}</span>
                <textarea value={announcementBody} onChange={event => setAnnouncementBody(event.target.value)} rows={5} maxLength={8000} />
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={announcementEmail} onChange={event => setAnnouncementEmail(event.target.checked)} />
                <span>{t("Lähetä myös sähköpostilla")}</span>
              </label>
              <p className="reply-hint">
                {incident.stairwell
                  ? t("Tiedote näkyy {0}-portaan asukkaille asukasportaalissa.", incident.stairwell)
                  : t("Tiedote näkyy kaikille taloyhtiön asukkaille asukasportaalissa.")}
              </p>
              <div className="draft-actions">
                <button
                  type="button"
                  disabled={Boolean(busy) || announcementTitle.trim().length < 3 || announcementBody.trim().length < 5}
                  onClick={() => void run("announce", async () => {
                    await post(`/companies/${encodeURIComponent(incident.companyId)}/announcements`, {
                      title: announcementTitle.trim(), body: announcementBody.trim(), stairwell: incident.stairwell, sendEmail: announcementEmail
                    });
                    return post<Incident>(`${path}/announced`);
                  }, t("Tiedote julkaistu."))}
                >
                  {busy === "announce" ? t("Julkaistaan…") : t("Julkaise tiedote")}
                </button>
              </div>
            </section>

            <section className="incident-section ticket-form">
              <h3>{t("Vastaus ilmoittajille")}</h3>
              <label>
                <span>{t("Viesti")}</span>
                <textarea value={reply} onChange={event => setReply(event.target.value)} rows={4} maxLength={4000} />
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={autoReply} onChange={event => setAutoReply(event.target.checked)} />
                <span>{t("Vastaa tällä viestillä automaattisesti uusiin samanaiheisiin ilmoituksiin")}</span>
              </label>
              <p className="reply-hint">{t("Vastaus lähtee ilmoittajille, joille ei ole vielä vastattu. Ilmoitukset jäävät odottamaan vian korjausta. AI-agentti käyttää samaa viestiä.")}</p>
              <div className="draft-actions">
                <button
                  type="button"
                  disabled={Boolean(busy) || reply.trim().length < 10}
                  onClick={() => void run("reply", async () => {
                    const result = await post<{ incident: Incident; replied: number; failed: string[] }>(`${path}/reply`, { message: reply.trim(), autoReply, replyNow: true }, "PUT");
                    setNotice([t("Vastattu {0} ilmoittajalle.", result.replied), ...result.failed].join(" "));
                    return result.incident;
                  })}
                >
                  {busy === "reply" ? t("Lähetetään…") : t("Vastaa ilmoittajille")}
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  disabled={Boolean(busy) || reply.trim().length < 10}
                  onClick={() => void run("save-reply", async () => (await post<{ incident: Incident }>(`${path}/reply`, { message: reply.trim(), autoReply }, "PUT")).incident, t("Tallennettu."))}
                >
                  {t("Tallenna vastaamatta")}
                </button>
              </div>
            </section>

            <section className="incident-section ticket-form">
              <h3>{t("Vika korjattu")}</h3>
              <label>
                <span>{t("Mikä ratkaisi vian?")}</span>
                <input
                  value={cause}
                  onChange={event => setCause(event.target.value)}
                  maxLength={500}
                  placeholder={t("Esim. lämmönjakokeskuksen pumppu vaihdettu.")}
                />
              </label>
              <p className="reply-hint">{t("Ratkaisu kirjataan kaikille ilmoituksille ja taloyhtiön vikahistoriaan. Asukkaat eivät näe sitä.")}</p>
              <label>
                <span>{t("Viesti ilmoittajille (valinnainen)")}</span>
                <textarea value={resolution} onChange={event => setResolution(event.target.value)} rows={3} maxLength={4000} />
              </label>
              <p className="reply-hint">{t("Kaikki avoimet ilmoitukset suljetaan, ja viesti lähetetään jokaiselle ilmoittajalle.")}</p>
              <div className="draft-actions">
                <button
                  className="primary"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (!window.confirm(t("Suljetaanko kaikki tämän vian {0} ilmoitusta?", incident.tickets.filter(ticket => ticket.status !== "closed").length))) return;
                    void run("resolve", async () => {
                      const result = await post<{ incident: Incident; closed: number; failed: string[] }>(`${path}/resolve`, { message: resolution.trim(), resolution: cause.trim() });
                      setNotice([t("Suljettu {0} ilmoitusta.", result.closed), ...result.failed].join(" "));
                      return result.incident;
                    });
                  }}
                >
                  {busy === "resolve" ? t("Suljetaan…") : t("Merkitse korjatuksi ja sulje ilmoitukset")}
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  disabled={Boolean(busy)}
                  title={t("Ilmoitukset jäävät omiksi tehtävikseen.")}
                  onClick={() => void run("dismiss", () => post<Incident>(`${path}/dismiss`), t("Merkitty: ei yhteinen vika."))}
                >
                  {t("Ei yhteinen vika")}
                </button>
              </div>
            </section>
          </>
        ) : (
          <p className="muted">
            {`${incidentStatusLabels[incident.status]}: ${incident.handledBy ?? "-"}, ${formatDate(incident.handledAt ?? undefined)}.`}
            {incident.resolution && <><br />{t("Ratkaisu: {0}", incident.resolution)}</>}
          </p>
        )}

        {notice && <p className="saved-indicator" role="status">{notice}</p>}
        {error && <p className="send-error" role="alert">{error}</p>}
      </aside>
    </div>
  );
}
