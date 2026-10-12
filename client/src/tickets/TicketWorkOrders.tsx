import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { formatDate, formatDuration, formatTicketNumber } from "../format";
import { api, errorMessage } from "../session";
import type { TicketDetail, WorkOrder } from "../types";

// Tehtävän työtilaukset: tilaus huoltoyhtiölle ja sen kuittaus tehdyksi.
export function TicketWorkOrders({ detail, onChanged }: { detail: TicketDetail; onChanged: () => Promise<void> }) {
  const contractor = detail.contractor;
  const contractorEmail = contractor?.email?.trim() ?? "";
  const [ordering, setOrdering] = useState(false);
  const [description, setDescription] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [sendEmail, setSendEmail] = useState(Boolean(contractorEmail));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Viesti huoltoyhtiölle: avoinna olevan työtilauksen tunniste, teksti ja mukaan valitut liitteet.
  const [messageOrderId, setMessageOrderId] = useState<string | null>(null);
  const [messageBody, setMessageBody] = useState("");
  const [messageAttachmentIds, setMessageAttachmentIds] = useState<string[]>([]);
  const [messageSentTo, setMessageSentTo] = useState("");

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!messageOrderId) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<{ to: string }>(`/work-orders/${encodeURIComponent(messageOrderId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: messageBody.trim(), attachmentIds: messageAttachmentIds })
      });
      setMessageOrderId(null);
      setMessageBody("");
      setMessageAttachmentIds([]);
      setMessageSentTo(result.to);
      await onChanged();
    } catch (sendError) {
      setError(errorMessage(sendError, "Viestin lähetys huoltoyhtiölle epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  function openForm() {
    // Kuvaus pohjautuu tehtävän otsikkoon ja tiivistelmään; käsittelijä muokkaa sen tilaukseksi.
    setDescription([detail.ticket.subject, detail.ticket.summary].filter(Boolean).join("\n\n"));
    setAttachmentIds([]);
    setSendEmail(Boolean(contractorEmail));
    setError("");
    setOrdering(true);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/tickets/${encodeURIComponent(detail.ticket.id)}/work-orders`, {
        method: "POST",
        body: JSON.stringify({ description: description.trim(), attachmentIds: sendEmail ? attachmentIds : [], sendEmail })
      });
      setOrdering(false);
      await onChanged();
    } catch (submitError) {
      setError(errorMessage(submitError, "Työtilauksen tekeminen epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  async function markDone(order: WorkOrder) {
    setSaving(true);
    setError("");
    try {
      await api(`/work-orders/${encodeURIComponent(order.id)}/done`, { method: "POST" });
      await onChanged();
    } catch (doneError) {
      setError(errorMessage(doneError, "Kuittaus epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="drawer-section work-orders">
      <div className="suggest-header">
        <h3>Työtilaukset</h3>
        {!ordering && <button className="secondary" onClick={openForm}>Tilaa huolto</button>}
      </div>

      {detail.workOrders.length === 0 && !ordering && <p className="muted">Tehtävältä ei ole tehty työtilauksia.</p>}

      {detail.workOrders.map(order => (
        <div className={`work-order ${order.status}`} key={order.id}>
          <div className="work-order-top">
            <strong>{order.contractor_name}</strong>
            <span className={`work-order-status ${order.status}`}>{order.status === "done" ? "Tehty" : "Tilattu"}</span>
          </div>
          <p>{order.description}</p>
          <small>
            Tilattu {formatDate(order.ordered_at)} · {order.ordered_by}
            {order.email_sent ? ` · lähetetty: ${order.contractor_email}` : " · kirjattu ilman sähköpostia"}
          </small>
          {order.status === "done" && order.done_at ? (
            <small>
              Kuitattu tehdyksi {formatDate(order.done_at)} · {order.done_by} · kesto{" "}
              {formatDuration(Date.parse(order.done_at) - Date.parse(order.ordered_at))}
            </small>
          ) : (
            <div className="work-order-buttons">
              <button className="secondary" onClick={() => void markDone(order)} disabled={saving}>Kuittaa tehdyksi</button>
              <button
                className="secondary"
                disabled={saving || !(order.contractor_email || contractorEmail)}
                title={order.contractor_email || contractorEmail ? undefined : "Huoltoyhtiöllä ei ole sähköpostiosoitetta."}
                onClick={() => {
                  setMessageOrderId(messageOrderId === order.id ? null : order.id);
                  setMessageBody("");
                  setMessageAttachmentIds([]);
                  setMessageSentTo("");
                  setError("");
                }}
              >
                Lähetä viesti huoltoyhtiölle
              </button>
            </div>
          )}
          {messageOrderId === order.id && (
            <form className="ticket-form work-order-form" onSubmit={sendMessage}>
              <label>
                <span>Viesti · {order.contractor_email || contractorEmail}</span>
                <textarea value={messageBody} onChange={event => setMessageBody(event.target.value)} rows={4} maxLength={4000} required autoFocus />
              </label>
              {detail.attachments.length > 0 && (
                <fieldset className="work-order-files">
                  <legend>Mukaan lähetettävät liitteet</legend>
                  {detail.attachments.map(attachment => (
                    <label key={attachment.id}>
                      <input
                        type="checkbox"
                        checked={messageAttachmentIds.includes(attachment.id)}
                        onChange={() => setMessageAttachmentIds(current => current.includes(attachment.id)
                          ? current.filter(item => item !== attachment.id)
                          : [...current, attachment.id])}
                      />
                      {attachment.filename}
                    </label>
                  ))}
                </fieldset>
              )}
              <div className="draft-actions">
                <button className="primary" type="submit" disabled={saving || !messageBody.trim()}>
                  {saving ? "Lähetetään…" : "Lähetä"}
                </button>
                <button type="button" onClick={() => setMessageOrderId(null)} disabled={saving}>Peruuta</button>
              </div>
            </form>
          )}
        </div>
      ))}
      {messageSentTo && <p className="portal-sent">Viesti lähetetty: {messageSentTo}</p>}

      {ordering && (
        <form className="ticket-form work-order-form" onSubmit={handleSubmit}>
          <p className="reply-hint">
            Huoltoyhtiö: <strong>{contractor?.name || "ei nimeä"}</strong>
            {contractorEmail ? ` · ${contractorEmail}` : " · sähköpostia ei ole tallennettu taloyhtiön tietoihin"}
            {contractor?.phone ? ` · ${contractor.phone}` : ""}
          </p>
          <label>
            <span>Työn kuvaus</span>
            <textarea value={description} onChange={event => setDescription(event.target.value)} rows={6} maxLength={4000} required />
          </label>
          <label className="switch-row">
            <span>
              <strong>Lähetä sähköpostilla huoltoyhtiölle</strong>
              <small>
                {contractorEmail
                  ? "Viestiin lisätään taloyhtiö, osoite, asunto ja tehtävän numero."
                  : "Ei käytettävissä: lisää huoltoyhtiön sähköposti taloyhtiön tietoihin."}
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={sendEmail}
              disabled={!contractorEmail}
              onChange={() => setSendEmail(!sendEmail)}
            />
            <i aria-hidden="true" />
          </label>
          {sendEmail && detail.attachments.length > 0 && (
            <fieldset className="work-order-files">
              <legend>Mukaan lähetettävät liitteet</legend>
              {detail.attachments.map(attachment => (
                <label key={attachment.id}>
                  <input
                    type="checkbox"
                    checked={attachmentIds.includes(attachment.id)}
                    onChange={() => setAttachmentIds(current => current.includes(attachment.id)
                      ? current.filter(item => item !== attachment.id)
                      : [...current, attachment.id])}
                  />
                  {attachment.filename}
                </label>
              ))}
            </fieldset>
          )}
          <div className="draft-actions">
            <button className="primary" type="submit" disabled={saving || description.trim().length < 3}>
              {saving ? "Tilataan…" : sendEmail ? "Lähetä työtilaus" : "Kirjaa työtilaus"}
            </button>
            <button type="button" onClick={() => setOrdering(false)} disabled={saving}>Peruuta</button>
          </div>
        </form>
      )}
      {error && <p className="send-error">{error}</p>}
    </section>
  );
}

// Raportti: työtilaukset huoltoyhtiöittäin, läpimenoaika ja avoimet tilaukset.
export function WorkOrderReport({ companyId, tabs }: { companyId: string; tabs: ReactNode }) {
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    setFailed(false);
    api<WorkOrder[]>(`/companies/${encodeURIComponent(companyId)}/work-orders`)
      .then(setOrders)
      .catch(() => setFailed(true));
  }, [companyId]);

  const nowTime = Date.now();
  const contractors = [...new Set(orders.map(order => order.contractor_name))].sort((a, b) => a.localeCompare(b, "fi"));
  const rows = contractors.map(name => {
    const own = orders.filter(order => order.contractor_name === name);
    const done = own.filter(order => order.status === "done" && order.done_at);
    const open = own.filter(order => order.status !== "done");
    const average = done.length
      ? done.reduce((sum, order) => sum + (Date.parse(order.done_at!) - Date.parse(order.ordered_at)), 0) / done.length
      : null;
    const oldestOpen = open.length ? Math.min(...open.map(order => Date.parse(order.ordered_at))) : null;
    return { name, total: own.length, done: done.length, open: open.length, average, oldestOpen };
  });
  const openOrders = orders
    .filter(order => order.status !== "done")
    .sort((a, b) => Date.parse(a.ordered_at) - Date.parse(b.ordered_at));

  return (
    <div className="report-card">
      {tabs}
      <h2>Työtilaukset huoltoyhtiöittäin</h2>
      <p className="muted">Kaikki taloyhtiön työtilaukset. Läpimenoaika lasketaan tilauksesta tehdyksi kuittaukseen.</p>
      {failed ? <p className="send-error">Työtilausten lataus epäonnistui.</p>
        : orders.length === 0 ? <p className="muted">Taloyhtiölle ei ole tehty työtilauksia.</p>
        : (
          <>
            <div className="table-card">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Huoltoyhtiö</th>
                    <th>Tilauksia</th>
                    <th>Avoinna</th>
                    <th>Tehty</th>
                    <th>Läpimenoaika keskimäärin</th>
                    <th>Vanhin avoin</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.name}>
                      <td><strong>{row.name}</strong></td>
                      <td>{row.total}</td>
                      <td>{row.open}</td>
                      <td>{row.done}</td>
                      <td>{row.average === null ? "–" : formatDuration(row.average)}</td>
                      <td>{row.oldestOpen === null ? "–" : formatDuration(nowTime - row.oldestOpen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2 className="report-subhead">Avoimet työtilaukset</h2>
            {openOrders.length === 0 ? <p className="muted">Ei avoimia työtilauksia.</p> : (
              <div className="table-card">
                <table className="data-table report-topics">
                  <thead>
                    <tr>
                      <th>Tehtävä</th>
                      <th>Huoltoyhtiö</th>
                      <th>Tilattu</th>
                      <th>Odottanut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openOrders.map(order => (
                      <tr key={order.id}>
                        <td>
                          <a href={`#/tickets/${encodeURIComponent(order.ticket_id)}`}>
                            <strong>#{formatTicketNumber(order.ticket_number)} {order.ticket_subject}</strong>
                          </a>
                          <span>{order.description}</span>
                        </td>
                        <td>{order.contractor_name}</td>
                        <td>{formatDate(order.ordered_at)}</td>
                        <td>{formatDuration(nowTime - Date.parse(order.ordered_at))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
    </div>
  );
}
