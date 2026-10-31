import { Fragment, useEffect, useState } from "react";
import { usePaged } from "../components/common";
import { formatDate, formatTicketNumber } from "../format";
import { t } from "../i18n";
import { api, errorMessage } from "../session";

type MessageStatus = "pending" | "sent" | "failed" | "superseded";

type IntegrationMessage = {
  event_id: string;
  event_type: string;
  task_id: string;
  sequence: number;
  status: MessageStatus;
  attempts: number;
  next_attempt_at: string;
  last_status_code: number | null;
  last_error: string | null;
  superseded_by: string | null;
  created_at: string;
  sent_at: string | null;
  ticket_number: number | null;
  ticket_subject: string | null;
  company_name: string | null;
};

type MessageList = { adapter: string | null; pull?: boolean; limit: number; counts: Record<MessageStatus, number>; messages: IntegrationMessage[] };

const STATUSES: MessageStatus[] = ["pending", "sent", "failed", "superseded"];

const statusLabels: Record<MessageStatus, string> = {
  pending: t("Odottaa"),
  sent: t("Lähetetty"),
  failed: t("Epäonnistui"),
  superseded: t("Korvattu uudemmalla")
};

const eventLabels: Record<string, string> = {
  "task.created": t("Tehtävä luotu"),
  "task.updated": t("Tehtävä päivitetty"),
  "task.comment.added": t("Kommentti lisätty")
};

// Sanoma tiedostona sellaisenaan (sama JSON kuin ERP:hen lähtevä).
function download(envelope: unknown, eventId: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${eventId}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

// Avatun sanoman tiedot ja sisältö. Sisältö haetaan vasta avattaessa, ja avaus kirjautuu lokiin.
function MessageDetails({ message }: { message: IntegrationMessage }) {
  const [envelope, setEnvelope] = useState<unknown>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ envelope: unknown }>(`/integration/messages/${encodeURIComponent(message.event_id)}`)
      .then(result => setEnvelope(result.envelope))
      .catch(fetchError => setError(errorMessage(fetchError, t("Sanoman haku epäonnistui."))));
  }, [message.event_id]);

  return (
    <div className="integration-details">
      <dl>
        <dt>{t("Sanoman tunniste")}</dt><dd><code>{message.event_id}</code></dd>
        <dt>{t("Järjestysnumero")}</dt><dd>{message.sequence}</dd>
        <dt>{t("Kirjattu")}</dt><dd>{formatDate(message.created_at)}</dd>
        {message.sent_at && <><dt>{t("Lähetetty")}</dt><dd>{formatDate(message.sent_at)}</dd></>}
        {message.status === "pending" && message.attempts > 0 && (
          <><dt>{t("Seuraava yritys")}</dt><dd>{formatDate(message.next_attempt_at)}</dd></>
        )}
        {message.last_error && <><dt>{t("Virhe")}</dt><dd>{message.last_error}</dd></>}
        {message.superseded_by && <><dt>{t("Korvaava sanoma")}</dt><dd><code>{message.superseded_by}</code></dd></>}
      </dl>
      {error ? <p className="form-error">{error}</p>
        : envelope === null ? <p className="muted">{t("Ladataan…")}</p>
        : (
          <>
            <pre className="integration-json">{JSON.stringify(envelope, null, 2)}</pre>
            <button type="button" className="secondary" onClick={() => download(envelope, message.event_id)}>
              {t("Lataa sanoma")}
            </button>
          </>
        )}
    </div>
  );
}

// Integraatioloki: ERP:hen lähteneet ja lähtevät sanomat uusimmasta alkaen. Vain pääkäyttäjälle.
export function IntegrationLog() {
  const [data, setData] = useState<MessageList | null>(null);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState<MessageStatus | "">("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setLoadError("");
    api<MessageList>(`/integration/messages${status ? `?status=${status}` : ""}`)
      .then(setData)
      .catch(error => setLoadError(errorMessage(error, t("Integraatiolokin lataus epäonnistui."))));
  }, [status]);

  const paged = usePaged(data?.messages ?? [], status);
  const total = data ? STATUSES.reduce((sum, key) => sum + data.counts[key], 0) : 0;

  return (
    <section className="content">
      <a className="back-link" href="#/settings">{t("← Asetukset")}</a>
      <p className="muted">
        {data && (data.adapter
          ? t("Toiminnanohjausjärjestelmään (ERP) lähtevät tehtävät ja kommentit. Käytössä: {0}.", data.adapter === "mock" ? t("simuloitu ERP") : data.adapter)
          : data.pull
            ? t("ERP hakee tehtävät ja kommentit jonosta. Lähetetty tarkoittaa, että ERP on hakenut sanoman.")
            : t("ERP-integraatio ei ole käytössä, joten uusia sanomia ei kirjata."))}
        {" "}{t("Sanoman avaus kirjataan toimintalokiin.")}
      </p>

      <fieldset className="chip-select">
        <legend>{t("Tila")}</legend>
        <div>
          <button type="button" className={status === "" ? "active" : ""} onClick={() => setStatus("")}>
            {t("Kaikki")} ({total})
          </button>
          {STATUSES.map(key => (
            <button type="button" key={key} className={status === key ? "active" : ""} onClick={() => setStatus(key)}>
              {statusLabels[key]} ({data?.counts[key] ?? 0})
            </button>
          ))}
        </div>
      </fieldset>

      {loadError ? <div className="empty">{loadError}</div>
        : !data ? <div className="empty">{t("Ladataan…")}</div>
        : data.messages.length === 0 ? <div className="empty">{t("Ei sanomia.")}</div>
        : (
          <div className="table-card">
            <table className="data-table log-table integration-table">
              <thead>
                <tr>
                  <th>{t("Aika")}</th>
                  <th>{t("Sanoma")}</th>
                  <th>{t("Tila")}</th>
                  <th>{t("ERP:n vastaus")}</th>
                  <th>{t("Tehtävä")}</th>
                  <th>{t("Taloyhtiö")}</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(message => {
                  const open = openId === message.event_id;
                  return (
                    <Fragment key={message.event_id}>
                      <tr className={open ? "open" : ""}>
                        <td>{formatDate(message.created_at)}</td>
                        <td>
                          <button
                            type="button"
                            className="link-button"
                            aria-expanded={open}
                            onClick={() => setOpenId(open ? null : message.event_id)}
                          >
                            {eventLabels[message.event_type] ?? message.event_type}
                          </button>
                        </td>
                        <td><span className={`status-badge integration-status-${message.status}`}>{statusLabels[message.status]}</span></td>
                        <td>
                          {message.last_status_code ?? (message.last_error ? t("ei yhteyttä") : "–")}
                          {message.attempts > 0 && <small className="muted"> · {t("{0} yritystä", message.attempts)}</small>}
                        </td>
                        <td>
                          {message.ticket_number !== null ? (
                            <a href={`#/tickets/${encodeURIComponent(message.task_id)}`} title={t("Avaa tehtävä")}>
                              #{formatTicketNumber(message.ticket_number)} {message.ticket_subject}
                            </a>
                          ) : "–"}
                        </td>
                        <td>{message.company_name ?? "–"}</td>
                      </tr>
                      {open && (
                        <tr className="integration-details-row">
                          <td colSpan={6}><MessageDetails message={message} /></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      {data && data.messages.length >= data.limit && (
        <p className="muted">{t("Näytetään {0} uusinta sanomaa.", data.limit)}</p>
      )}
      {data && paged.pager}
    </section>
  );
}
