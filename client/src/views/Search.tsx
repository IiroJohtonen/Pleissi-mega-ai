import { Fragment, useEffect, useState } from "react";
import { formatDate, formatTicketNumber, priorityLabel, statusLabel } from "../format";
import { api, errorMessage } from "../session";
import { t } from "../i18n";

type SearchTicket = {
  id: string; ticket_number: number | null; subject: string; status: string; priority: string; created_at: string;
  company_id: string; company_name: string; resident_name: string | null; apartment_number: string | null; snippet: string;
};
type SearchKnowledge = { id: string; title: string; audience: string; company_id: string; company_name: string; snippet: string };
type SearchResident = {
  id: string; name: string; email: string | null; apartment_number: string; address: string; company_id: string; company_name: string;
};
type SearchAnnouncement = { id: string; title: string; created_at: string; company_id: string; company_name: string; snippet: string };

export type SearchResponse = {
  query: string;
  tickets: SearchTicket[]; ticketCount: number;
  knowledge: SearchKnowledge[]; knowledgeCount: number;
  residents: SearchResident[]; residentCount: number;
  announcements: SearchAnnouncement[]; announcementCount: number;
};

// Tehtävänumerohaku (#123): palauttaa numeron tai null.
export function ticketNumberQuery(query: string): number | null {
  const match = query.trim().match(/^#\s*(\d+)$/);
  return match ? Number(match[1]) : null;
}

// Korostaa hakusanat otteessa.
function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.toLocaleLowerCase("fi").replace(/^#/, "").split(/\s+/).filter(Boolean);
  if (terms.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return <>{text.split(pattern).map((part, index) => index % 2 === 1 ? <mark key={index}>{part}</mark> : <Fragment key={index}>{part}</Fragment>)}</>;
}

// Hakutulokset otsikoittain: tehtävät, dokumentaatio, asukkaat ja tiedotteet.
export function SearchResults({
  query,
  onOpenTicket,
  onOpenKnowledge,
  onOpenResidents,
  onOpenAnnouncements
}: {
  query: string;
  onOpenTicket: (ticketId: string) => void;
  onOpenKnowledge: (companyId: string, entryId: string) => void;
  onOpenResidents: (companyId: string) => void;
  onOpenAnnouncements: (companyId: string) => void;
}) {
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!query.trim()) return;
    let current = true;
    setResult(null);
    setError("");
    api<SearchResponse>(`/search?q=${encodeURIComponent(query)}`)
      .then(found => current && setResult(found))
      .catch(searchError => current && setError(errorMessage(searchError, t("Haku epäonnistui. Yritä uudelleen."))));
    return () => { current = false; };
  }, [query]);

  if (!query.trim()) return <div className="empty">{t("Kirjoita hakusana sivupalkin hakukenttään.")}</div>;
  if (error) return <p className="send-error">{error}</p>;
  if (!result) return <div className="empty">{t("Haetaan…")}</div>;

  const total = result.ticketCount + result.knowledgeCount + result.residentCount + result.announcementCount;
  const more = (shown: number, count: number) => count > shown
    ? <p className="search-more">{t("Näytetään {0}/{1}. Tarkenna hakua nähdäksesi loput.", String(shown), String(count))}</p>
    : null;

  return (
    <div className="search-results">
      <p className="search-summary">
        {total === 0 ? t("Haulla ”{0}” ei löytynyt mitään.", query) : t("Haulla ”{0}” löytyi {1} osumaa.", query, String(total))}
      </p>

      {result.ticketCount > 0 && (
        <section className="search-section">
          <h2>{t("Tehtävät")} <b>{result.ticketCount}</b></h2>
          {result.tickets.map(ticket => (
            <button key={ticket.id} type="button" className="search-hit" onClick={() => onOpenTicket(ticket.id)}>
              <span className="search-hit-head">
                <span className="ticket-number">#{formatTicketNumber(ticket.ticket_number)}</span>
                <strong><Highlight text={ticket.subject} query={query} /></strong>
                <span className={`priority ${ticket.priority}`}>{priorityLabel(ticket.priority)}</span>
                <span className={`status-badge status-${ticket.status}`}>{statusLabel(ticket.status)}</span>
              </span>
              <span className="search-hit-meta">
                {[ticket.company_name, ticket.apartment_number, ticket.resident_name, formatDate(ticket.created_at)].filter(Boolean).join(" · ")}
              </span>
              <span className="search-hit-snippet"><Highlight text={ticket.snippet} query={query} /></span>
            </button>
          ))}
          {more(result.tickets.length, result.ticketCount)}
        </section>
      )}

      {result.knowledgeCount > 0 && (
        <section className="search-section">
          <h2>{t("Dokumentaatio")} <b>{result.knowledgeCount}</b></h2>
          {result.knowledge.map(item => (
            <button key={item.id} type="button" className="search-hit" onClick={() => onOpenKnowledge(item.company_id, item.id)}>
              <span className="search-hit-head">
                <strong><Highlight text={item.title} query={query} /></strong>
                <span className="type">{item.audience === "internal" ? t("Sisäinen dokumentaatio") : t("AI dokumentaatio")}</span>
              </span>
              <span className="search-hit-meta">{item.company_name}</span>
              <span className="search-hit-snippet"><Highlight text={item.snippet} query={query} /></span>
            </button>
          ))}
          {more(result.knowledge.length, result.knowledgeCount)}
        </section>
      )}

      {result.residentCount > 0 && (
        <section className="search-section">
          <h2>{t("Asukkaat")} <b>{result.residentCount}</b></h2>
          {result.residents.map(resident => (
            <button key={resident.id} type="button" className="search-hit" onClick={() => onOpenResidents(resident.company_id)}>
              <span className="search-hit-head">
                <strong><Highlight text={resident.name} query={query} /></strong>
              </span>
              <span className="search-hit-meta">
                <Highlight text={[resident.company_name, `${resident.address} ${resident.apartment_number}`, resident.email].filter(Boolean).join(" · ")} query={query} />
              </span>
            </button>
          ))}
          {more(result.residents.length, result.residentCount)}
        </section>
      )}

      {result.announcementCount > 0 && (
        <section className="search-section">
          <h2>{t("Tiedotteet")} <b>{result.announcementCount}</b></h2>
          {result.announcements.map(item => (
            <button key={item.id} type="button" className="search-hit" onClick={() => onOpenAnnouncements(item.company_id)}>
              <span className="search-hit-head">
                <strong><Highlight text={item.title} query={query} /></strong>
              </span>
              <span className="search-hit-meta">{item.company_name} · {formatDate(item.created_at)}</span>
              <span className="search-hit-snippet"><Highlight text={item.snippet} query={query} /></span>
            </button>
          ))}
          {more(result.announcements.length, result.announcementCount)}
        </section>
      )}
    </div>
  );
}
