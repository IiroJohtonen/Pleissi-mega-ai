import { useEffect, useState } from "react";
import { formatDateOnly, formatTicketNumber, statusLabel } from "../format";
import { t } from "../i18n";
import { api, errorMessage } from "../session";
import { placeLabel, topicLabel } from "../topics";
import type { Ticket } from "../types";

type HistoryItem = {
  id: string; ticketNumber: number | null; subject: string; topic: string | null; status: string; createdAt: string;
  closedAt: string | null; resolution: string | null; apartmentNumber: string | null; stairwell: string;
};
type History = {
  stairwell: string; apartmentNumber: string | null; apartment: HistoryItem[]; stair: HistoryItem[];
  incidents: { id: string; topic: string; stairwell: string; status: string; firstReportAt: string; handledAt: string | null;
    resolution: string | null; reports: number }[];
};

// Mikä ratkaisi asian: käsittelijän lyhyt kuvaus. Kerryttää taloyhtiön vikahistoriaa ja muistia.
export function TicketResolution({ ticket, onSaved }: { ticket: Ticket; onSaved: () => void | Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(ticket.resolution ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setText(ticket.resolution ?? "");
    setEditing(false);
    setError("");
  }, [ticket.id, ticket.resolution]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      await api(`/tickets/${encodeURIComponent(ticket.id)}/resolution`, { method: "PUT", body: JSON.stringify({ resolution: text.trim() }) });
      setEditing(false);
      await onSaved();
    } catch (caught) {
      setError(errorMessage(caught, t("Tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  // Avoimella tehtävällä kenttä näkyy vain, jos ratkaisu on jo kirjattu tai sitä halutaan kirjata.
  if (!editing && !ticket.resolution && ticket.status !== "closed") return null;
  return (
    <section className="ticket-resolution">
      <h3>{t("Mikä ratkaisi asian")}</h3>
      {editing ? (
        <>
          <input
            value={text}
            onChange={event => setText(event.target.value)}
            maxLength={500}
            autoFocus
            aria-label={t("Mikä ratkaisi asian")}
            placeholder={t("Esim. huoltoyhtiö ilmasi patterit, termostaatti oli kiinni.")}
          />
          <div className="draft-actions">
            <button className="primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? t("Tallennetaan…") : t("Tallenna")}</button>
            <button type="button" disabled={saving} onClick={() => { setEditing(false); setText(ticket.resolution ?? ""); }}>{t("Peruuta")}</button>
          </div>
        </>
      ) : (
        <p>
          {ticket.resolution || <span className="muted">{t("Ei kirjattu. Kirjaa lyhyesti, mikä ratkaisi asian: se auttaa seuraavissa samanlaisissa tehtävissä.")}</span>}
          <button type="button" className="quiet-button" onClick={() => setEditing(true)}>{ticket.resolution ? t("Muokkaa") : t("Kirjaa ratkaisu")}</button>
        </p>
      )}
      {error && <p className="send-error">{error}</p>}
    </section>
  );
}

// Aiemmat viat samassa asunnossa ja saman portaan samanaiheiset tehtävät ratkaisuineen.
export function TicketHistory({ ticket, onOpenTicket }: { ticket: Ticket; onOpenTicket: (ticketId: string) => void }) {
  const [history, setHistory] = useState<History | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<History>(`/tickets/${encodeURIComponent(ticket.id)}/history`)
      .then(result => { if (!cancelled) setHistory(result && Array.isArray(result.apartment) ? result : null); })
      .catch(() => { if (!cancelled) setHistory(null); });
    return () => {
      cancelled = true;
    };
  }, [ticket.id, ticket.topic, ticket.apartment_number]);

  if (!history || (!history.apartment.length && !history.stair.length && !history.incidents.length)) return null;
  const row = (item: HistoryItem) => (
    <li key={item.id}>
      <button type="button" className="link-button" onClick={() => onOpenTicket(item.id)}>
        #{formatTicketNumber(item.ticketNumber)} {item.subject}
      </button>
      <span>{[item.apartmentNumber, formatDateOnly(item.createdAt), statusLabel(item.status)].filter(Boolean).join(", ")}</span>
      {item.resolution && <p className="history-resolution">{t("Ratkaisu: {0}", item.resolution)}</p>}
    </li>
  );
  return (
    <section className="ticket-history" aria-labelledby={`history-${ticket.id}`}>
      <h3 id={`history-${ticket.id}`}>{t("Aiemmin")}</h3>
      {history.incidents.length > 0 && (
        <>
          <h4>{t("Yhteiset viat: {0}", topicLabel(history.incidents[0].topic))}</h4>
          <ul>
            {history.incidents.map(item => (
              <li key={item.id}>
                <span className="history-title">{placeLabel(item.stairwell)}, {formatDateOnly(item.firstReportAt)}, {t("{0} asuntoa", item.reports)}</span>
                {item.resolution && <p className="history-resolution">{t("Ratkaisu: {0}", item.resolution)}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
      {history.apartment.length > 0 && (
        <>
          <h4>{t("Asunnossa {0} (2 vuotta)", history.apartmentNumber ?? "")}</h4>
          <ul>{history.apartment.map(row)}</ul>
        </>
      )}
      {history.stair.length > 0 && (
        <>
          <h4>{t("{0}: {1} (vuosi)", placeLabel(history.stairwell), topicLabel(ticket.topic))}</h4>
          <ul>{history.stair.map(row)}</ul>
        </>
      )}
    </section>
  );
}
