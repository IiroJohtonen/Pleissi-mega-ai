import { useEffect, useState } from "react";
import { usePaged } from "../components/common";
import { actionLabel, actorLabel, formatDate, formatTicketNumber } from "../format";
import { api } from "../session";

type AuditEntry = {
  id: string;
  // Tehtävän tiedot puuttuvat merkinnöiltä, jotka eivät liity tehtävään.
  ticket_id: string | null;
  actor: string;
  action: string;
  details: string;
  created_at: string;
  ticket_number?: number | null;
  ticket_subject: string | null;
  company_name: string | null;
  email_body?: string | null;
};

// Koko alustan loki: kaikkien tehtävien muutokset, päätökset ja lähetetyt sähköpostit uusimmasta alkaen.
export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<AuditEntry[]>("/audit")
      .then(setEntries)
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  const rows = entries.map(entry => {
    let details: { to?: string; subject?: string } = {};
    try {
      details = JSON.parse(entry.details || "{}");
    } catch {
      // Vanhassa merkinnässä ei ole JSON-tietoja.
    }
    const email = entry.action === "reply_sent"
      ? { to: details.to || "vastaanottaja ei tiedossa", subject: details.subject || "", body: entry.email_body || "" }
      : null;
    return { entry, email, label: email ? `Sähköposti lähetetty: ${email.to}` : actionLabel(entry.action) };
  });

  const searchText = search.trim().toLowerCase();
  const visible = searchText
    ? rows.filter(({ entry, label }) =>
        [label, actorLabel(entry.actor), entry.ticket_subject, entry.company_name, `#${formatTicketNumber(entry.ticket_number)}`]
          .some(value => (value ?? "").toLowerCase().includes(searchText)))
    : rows;
  const paged = usePaged(visible, searchText);

  return (
    <section className="content">
      <a className="back-link" href="#/settings">← Asetukset</a>
      <label className="log-search">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.200"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0" />
          <path d="M21 21l-4.300-4.300" />
        </svg>
        <input
          type="search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Hae lokista: tapahtuma, tekijä, tehtävä tai taloyhtiö"
          aria-label="Hae lokista"
        />
      </label>

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <div className="empty">Lokin lataus epäonnistui.</div>
        : visible.length === 0 ? <div className="empty">{entries.length === 0 ? "Ei tapahtumia." : "Ei hakua vastaavia tapahtumia."}</div>
        : (
          <div className="table-card">
            <table className="data-table log-table">
              <thead>
                <tr>
                  <th>Aika</th>
                  <th>Tapahtuma</th>
                  <th>Tekijä</th>
                  <th>Tehtävä</th>
                  <th>Taloyhtiö</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(({ entry, email, label }) => (
                  <tr key={entry.id}>
                    <td>{formatDate(entry.created_at)}</td>
                    <td>
                      <strong>{label}</strong>
                      {email && (
                        <details className="audit-email">
                          <summary>{email.subject || "Näytä viesti"}</summary>
                          <p>{email.body || "Viestin sisältöä ei ole tallennettu."}</p>
                        </details>
                      )}
                    </td>
                    <td>{actorLabel(entry.actor)}</td>
                    <td>
                      {/* Käyttäjän tai asukkaan poisto ja säilytysajan poistot eivät liity tehtävään. */}
                      {entry.ticket_id ? (
                        <a href={`#/tickets/${encodeURIComponent(entry.ticket_id)}`} title="Avaa tehtävä">
                          #{formatTicketNumber(entry.ticket_number)} {entry.ticket_subject}
                        </a>
                      ) : "–"}
                    </td>
                    <td>{entry.company_name ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {!loading && !loadError && paged.pager}
    </section>
  );
}
