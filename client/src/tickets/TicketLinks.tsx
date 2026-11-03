import { useEffect, useState } from "react";
import { formatDateOnly, formatTicketNumber } from "../format";
import { t } from "../i18n";
import { api, errorMessage } from "../session";
import type { Ticket } from "../types";

type Candidate = { id: string; ticketNumber: number | null; subject: string; createdAt: string };

// Yhdistämisehdotus: saman asukkaan avoin samanaiheinen tehtävä 14 päivän sisällä. Yhdistäminen vaatii aina
// käsittelijän klikkauksen.
export function MergeSuggestion({ ticket, onMerged }: { ticket: Ticket; onMerged: (ticketId: string) => void }) {
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setCandidate(null);
    setError("");
    if (ticket.merged_into || ticket.status === "closed") return;
    let cancelled = false;
    api<{ candidate: Candidate | null }>(`/tickets/${encodeURIComponent(ticket.id)}/merge-suggestion`)
      .then(result => { if (!cancelled) setCandidate(result?.candidate ?? null); })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ticket.id, ticket.topic, ticket.status, ticket.merged_into]);

  if (ticket.merged_into) {
    return (
      <p className="incident-notice">
        <span>{t("Tämä tehtävä on yhdistetty toiseen tehtävään; viestit ovat siellä.")}</span>
        <button type="button" onClick={() => onMerged(ticket.merged_into!)}>{t("Avaa tehtävä")}</button>
      </p>
    );
  }
  if (!candidate) return null;
  return (
    <div className="incident-notice merge-suggestion">
      <span>
        {t("Sama asukas on ilmoittanut samasta asiasta {0}: #{1} {2}. Liitetäänkö tämä siihen?", formatDateOnly(candidate.createdAt),
          formatTicketNumber(candidate.ticketNumber), candidate.subject)}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await api(`/tickets/${encodeURIComponent(ticket.id)}/merge`, { method: "POST", body: JSON.stringify({ intoTicketId: candidate.id }) });
            onMerged(candidate.id);
          } catch (caught) {
            setError(errorMessage(caught, t("Yhdistäminen epäonnistui.")));
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("Liitä edelliseen")}
      </button>
      <button type="button" className="quiet-button" onClick={() => setCandidate(null)}>{t("Ei")}</button>
      {error && <p className="send-error">{error}</p>}
    </div>
  );
}

type Apartment = { id: string; apartment_number: string; address?: string };

// Häiriö- ja turvallisuusilmoituksen kohdeasunto: AI ehdottaa viestistä, käsittelijä vahvistaa. Vain henkilökunnalle.
export function TargetApartmentField({ ticket, onChanged }: { ticket: Ticket; onChanged: () => void | Promise<unknown> }) {
  const [apartments, setApartments] = useState<Apartment[]>([]);
  const [value, setValue] = useState(ticket.target_apartment_id ?? "");
  const [error, setError] = useState("");
  const relevant = ticket.topic === "noise" || ticket.topic === "safety";
  useEffect(() => {
    setValue(ticket.target_apartment_id ?? "");
    if (!relevant) return;
    api<Apartment[]>(`/companies/${encodeURIComponent(ticket.company_id)}/apartments`)
      .then(found => setApartments(Array.isArray(found) ? found : []))
      .catch(() => setApartments([]));
  }, [ticket.id, ticket.company_id, ticket.target_apartment_id, relevant]);
  if (!relevant) return null;

  async function confirm(apartmentId: string) {
    setError("");
    try {
      await api(`/tickets/${encodeURIComponent(ticket.id)}/target-apartment`, { method: "PUT", body: JSON.stringify({ apartmentId: apartmentId || null }) });
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught, t("Tallennus epäonnistui.")));
    }
  }

  return (
    <div className="target-apartment">
      <label>
        <span>{t("Kohdeasunto")}</span>
        <select value={value} onChange={event => setValue(event.target.value)}>
          <option value="">{t("Ei tiedossa")}</option>
          {apartments.map(apartment => <option key={apartment.id} value={apartment.id}>{apartment.apartment_number}</option>)}
        </select>
      </label>
      {!ticket.target_apartment_confirmed && ticket.target_apartment_text && (
        <small className="muted">{t("AI:n ehdotus viestistä: {0}", ticket.target_apartment_text)}</small>
      )}
      <button type="button" className="secondary" onClick={() => void confirm(value)}>
        {ticket.target_apartment_confirmed && value === (ticket.target_apartment_id ?? "") ? t("Vahvistettu") : t("Vahvista")}
      </button>
      {error && <p className="send-error">{error}</p>}
    </div>
  );
}
