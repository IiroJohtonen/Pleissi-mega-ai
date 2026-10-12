import { type FormEvent, useEffect, useRef, useState } from "react";
import { FactDropdown } from "../components/common";
import {
  actionLabel, actorLabel, channelLabel, fileToBase64, formatDate, formatFileSize, formatTicketNumber,
  MAX_REPLY_ATTACHMENT_BYTES, MAX_REPLY_ATTACHMENTS, priorityLabel, statusLabel, ticketPriorities, ticketTypeOptions
} from "../format";
import { actorName, api, type OfficeUser } from "../session";
import type { Company, Resident, TicketDetail } from "../types";
import { assignableUsers, canAssignTickets, isOverdue, splitQuotedReply } from "./ticket-utils";
import { AssignPicker, AttachmentsMenu } from "./TicketCard";
import { TicketWorkOrders } from "./TicketWorkOrders";

// Aikajanan viesti; väkäsestä viestin saa tiivistettyä yhdelle riville.
function TimelineMessage({
  message,
  replying = false,
  onReply
}: {
  message: TicketDetail["messages"][number];
  replying?: boolean;
  // Annetaan vain viesteille, joihin voi vastata sähköpostilla.
  onReply?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);
  const inbound = message.direction === "inbound";
  // Saapuneesta viestistä näytetään oletuksena vain uusi teksti, ei lainattua aiempaa viestiä.
  const { text, quoted } = inbound ? splitQuotedReply(message.body) : { text: message.body, quoted: "" };

  return (
    <div className={`message ${message.direction} ${collapsed ? "collapsed" : ""} ${replying ? "replying" : ""}`}>
      {onReply && (
        <button className="message-reply" onClick={onReply} title="Vastaa tähän viestiin samassa sähköpostiketjussa">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.200"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10a6 6 0 0 1 6 6v4" />
          </svg>
          Vastaa
        </button>
      )}
      <button
        className="message-head"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        title={collapsed ? "Näytä viesti" : "Tiivistä viesti"}
      >
        <span className="message-direction">{inbound ? "Saapunut" : "Lähetetty"}</span>
        <small>{channelLabel(message.channel)} · {actorLabel(message.sender)} · {formatDate(message.created_at)}</small>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.500"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <strong>{message.subject}</strong>
      <p>{text}</p>
      {quoted && (
        <>
          <button className="message-quoted-toggle" onClick={() => setShowQuoted(!showQuoted)} aria-expanded={showQuoted}>
            {showQuoted ? "Piilota lainattu viesti" : "Näytä lainattu viesti"}
          </button>
          {showQuoted && <p className="message-quoted">{quoted}</p>}
        </>
      )}
    </div>
  );
}

export function TicketDrawer({
  detail,
  onClose,
  onDecision,
  onDraftSaved,
  onChanged,
  company
}: {
  detail: TicketDetail;
  // Tehtävän taloyhtiö: määrää, kenelle tehtävän voi antaa ja kuka saa antaa.
  company?: Company;
  onClose: () => void;
  onDecision: (d: "ai" | "human" | "skip") => void;
  onDraftSaved: (draft: string) => void;
  onChanged: () => Promise<void>;
}) {
  const t = detail.ticket;
  const [draft, setDraft] = useState(t.draft || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState("");
  const [sendError, setSendError] = useState("");
  // Vastauksen mukana lähetettävät liitteet; tallentuvat lähetyksessä tehtävän liitteisiin.
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const replyFilesSize = replyFiles.reduce((total, file) => total + file.size, 0);
  const replyFilesTooLarge = replyFilesSize > MAX_REPLY_ATTACHMENT_BYTES;

  useEffect(() => {
    setReplyFiles([]);
  }, [t.id]);

  // Kuvaus on tehtävän alkuperäinen viesti; käsin luodulla tehtävällä sen tiivistelmä.
  const firstInbound = detail.messages.find(m => m.direction === "inbound");
  const description = (firstInbound ? splitQuotedReply(firstInbound.body).text.trim() : "")
    || t.summary
    || "Ei kuvausta.";
  const lastInbound = [...detail.messages].reverse().find(m => m.direction === "inbound");
  // Sama järjestys kuin palvelimella: ensin alkuperäinen lähettäjä, muuten linkitetyt asukkaat.
  // Aikajanalta valittu viesti, johon vastataan; ilman valintaa vastataan viimeisimpään saapuneeseen.
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const replyTarget = detail.messages.find(m => m.id === replyTargetId && m.direction === "inbound") ?? null;
  const draftEditor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setReplyTargetId(null);
  }, [t.id]);

  function startReply(message: TicketDetail["messages"][number]) {
    setReplyTargetId(message.id);
    draftEditor.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    draftEditor.current?.focus({ preventScroll: true });
  }

  const recipient = (replyTarget ?? lastInbound)?.sender.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    || detail.reporters.map(r => r.email?.trim()).filter(Boolean).join(", ");
  const canReply = t.status === "waiting_manager" || t.status === "waiting_third_party";

  useEffect(() => {
    setDraft(t.draft || "");
    setSaved(false);
  }, [t.id, t.draft]);

  // Viimeisin tässä istunnossa pyydetty AI-ehdotus; muuten näytetään tehtävälle tallennettu peruste ja lähde.
  const [suggestion, setSuggestion] = useState<{
    reason: string;
    source: { id: string; title: string } | null;
    usedAi: boolean;
  } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState("");

  useEffect(() => {
    setSuggestion(null);
    setSuggestError("");
  }, [t.id]);

  // AI-ehdotuksen voi pyytää tehtävälle vain kerran; aiempi pyyntö näkyy lokissa.
  const suggestionUsed = Boolean(suggestion) || detail.audit.some(a => a.action === "ai_suggested");
  const aiReason = suggestion ? suggestion.reason : t.ai_reason;
  // Dokumenttia ehdotetaan vasta, kun tehtävälle on pyydetty AI-ehdotus.
  const aiSource = suggestion
    ? suggestion.source
    : suggestionUsed && t.knowledge_source_id && t.knowledge_source_title
      ? { id: t.knowledge_source_id, title: t.knowledge_source_title }
      : null;

  async function requestSuggestion() {
    if (draft.trim() && draft !== (t.draft || "")
      && !window.confirm("Luonnoksessa on tallentamattomia muutoksia. Korvataanko se AI:n ehdotuksella?")) {
      return;
    }
    setSuggesting(true);
    setSuggestError("");
    try {
      const result = await api<{
        draft: string;
        reason: string;
        source: { id: string; title: string } | null;
        usedAi: boolean;
      }>(`/tickets/${t.id}/suggest`, { method: "POST" });
      setSuggestion(result);
      setDraft(result.draft);
      setSaved(false);
      setSentTo("");
      // Ehdotus tallennetaan heti luonnokseksi; jos tallennus epäonnistuu, teksti jää kenttään tallentamattomana.
      try {
        await api(`/tickets/${t.id}/draft`, {
          method: "POST",
          body: JSON.stringify({ draft: result.draft })
        });
        onDraftSaved(result.draft);
        setSaved(true);
      } catch {
        setSuggestError("AI-ehdotus on kentässä, mutta sen tallennus luonnokseksi epäonnistui. Paina Tallenna luonnos.");
      }
    } catch (error) {
      let message = "AI-ehdotuksen hakeminen epäonnistui. Yritä uudelleen.";
      try {
        message = JSON.parse((error as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setSuggestError(message);
    } finally {
      setSuggesting(false);
    }
  }

  const [note, setNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  useEffect(() => {
    setSentTo("");
    setSendError("");
    setNote("");
  }, [t.id]);

  // reply_sent ja message_created näkyvät aikajanalla jo itse viesteinä.
  const timeline = [
    ...detail.messages.map(m => ({ kind: "message" as const, id: m.id, created_at: m.created_at, message: m })),
    ...detail.notes.map(n => ({ kind: "note" as const, id: n.id, created_at: n.created_at, note: n })),
    ...detail.audit
      .filter(a => a.action !== "reply_sent" && a.action !== "message_created")
      .map(a => ({ kind: "event" as const, id: a.id, created_at: a.created_at, event: a }))
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const unlinkedSenders = detail.reporters.length === 0
    ? [...new Set(detail.messages.filter(m => m.direction === "inbound").map(m => m.sender))]
    : [];

  const [residents, setResidents] = useState<Resident[]>([]);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    api<Resident[]>(`/companies/${encodeURIComponent(t.company_id)}/residents`)
      .then(setResidents)
      .catch(() => setResidents([]));
  }, [t.id, t.company_id]);

  // Tehtävällä on yksi ilmoittaja. Valikossa on mukana myös nykyinen ilmoittaja, vaikka asukaslista ei olisi vielä latautunut.
  const reporter = detail.reporters[0];
  const reporterOptions = reporter && !residents.some(r => r.id === reporter.id)
    ? [reporter, ...residents]
    : residents;
  // Sähköposti haetaan asukastiedoista valitun ilmoittajan perusteella.
  const reporterEmail = reporter
    ? residents.find(r => r.id === reporter.id)?.email || reporter.email
    : "";

  // Ilmoittajan hakukenttä: null = ei muokata, jolloin kentässä näkyy nykyisen ilmoittajan nimi.
  const [reporterQuery, setReporterQuery] = useState<string | null>(null);
  const reporterInput = useRef<HTMLInputElement>(null);
  const reporterSearch = (reporterQuery ?? "").trim().toLowerCase();
  const reporterMatches = reporterOptions
    .filter(r => [r.name, r.apartment_number, r.email].some(value => value?.toLowerCase().includes(reporterSearch)))
    .slice(0, 8);

  function chooseReporter(residentId: string) {
    setReporterQuery(null);
    void setReporter(residentId);
  }

  // Vaihtaa tehtävän ilmoittajan: aiemmat linkitykset poistetaan ja valittu asukas linkitetään tilalle.
  async function setReporter(residentId: string) {
    setLinking(true);
    try {
      for (const current of detail.reporters) {
        if (current.id === residentId) continue;
        await api(`/tickets/${t.id}/reporters/${encodeURIComponent(current.id)}?actor=${encodeURIComponent(actorName())}`, {
          method: "DELETE"
        });
      }
      if (residentId && !detail.reporters.some(current => current.id === residentId)) {
        await api(`/tickets/${t.id}/reporters`, {
          method: "POST",
          body: JSON.stringify({ residentId, actor: actorName() })
        });
      }
      await onChanged();
    } finally {
      setLinking(false);
    }
  }

  const [updatingFields, setUpdatingFields] = useState(false);

  // Toimiston käyttäjät käsittelijän valintaa varten.
  const [officeUsers, setOfficeUsers] = useState<OfficeUser[]>([]);
  useEffect(() => {
    api<OfficeUser[]>("/users").then(setOfficeUsers).catch(() => setOfficeUsers([]));
  }, []);

  async function updateFields(fields: { type?: string; priority?: string; assigneeId?: string | null; dueDate?: string | null }) {
    setUpdatingFields(true);
    try {
      await api(`/tickets/${t.id}/fields`, {
        method: "PUT",
        body: JSON.stringify({ ...fields, actor: actorName() })
      });
      await onChanged();
    } finally {
      setUpdatingFields(false);
    }
  }

  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    setAddingNote(true);
    try {
      await api(`/tickets/${t.id}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: note, author: actorName() })
      });
      setNote("");
      await onChanged();
    } finally {
      setAddingNote(false);
    }
  }

  async function sendReply() {
    if (!draft.trim() || !recipient) return;
    setSending(true);
    setSendError("");
    setSentTo("");
    try {
      const result = await api<{ ok: boolean; to: string }>(`/tickets/${t.id}/reply`, {
        method: "POST",
        body: JSON.stringify({
          body: draft,
          actor: actorName(),
          messageId: replyTarget?.id,
          attachments: await Promise.all(replyFiles.map(async file => ({
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            data: await fileToBase64(file)
          })))
        })
      });
      setDraft("");
      setReplyFiles([]);
      setReplyTargetId(null);
      setSentTo(result.to);
      await onChanged();
    } catch (error) {
      let message = "Lähetys epäonnistui.";
      try {
        message = JSON.parse((error as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setSendError(message);
    } finally {
      setSending(false);
    }
  }

  async function saveDraft() {
    setSaving(true);
    try {
      await api(`/tickets/${t.id}/draft`, {
        method: "POST",
        body: JSON.stringify({ draft })
      });
      onDraftSaved(draft);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer drawer-split" onClick={e => e.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        <div className="drawer-main">
        {/* Yläpalkki pysyy näkyvissä, kun tehtävää vieritetään. */}
        <div className="drawer-topbar">
          <span className="drawer-topbar-number">#{formatTicketNumber(t.ticket_number)} · {statusLabel(t.status)}</span>
          <div className="drawer-topbar-tools">
          <AttachmentsMenu attachments={detail.attachments} ticketId={t.id} onChanged={onChanged} />
          {t.status === "closed" && (
            <div className="drawer-actions">
              <button
                disabled={updatingFields}
                onClick={async () => {
                  setUpdatingFields(true);
                  try {
                    await api(`/tickets/${t.id}/reopen`, { method: "POST" });
                    await onChanged();
                  } finally {
                    setUpdatingFields(false);
                  }
                }}
              >
                Avaa uudelleen
              </button>
            </div>
          )}
          {t.status !== "closed" && (
            <div className="drawer-actions">
              {canAssignTickets(company) && (
                <AssignPicker
                  users={assignableUsers(company, officeUsers)}
                  assigneeId={t.assignee_id ?? null}
                  onAssign={assigneeId => updateFields({ assigneeId })}
                />
              )}
              {t.status === "open" && (
                <button className="primary" onClick={() => onDecision("human")}>Osoita minulle</button>
              )}
              <button onClick={() => onDecision("skip")}>Sulje</button>
            </div>
          )}
          </div>
        </div>
        <h2>{t.subject}</h2>

        <dl className="ticket-facts">
          <div className="fact-number">
            <dt>Tehtävänumero</dt>
            <dd>#{formatTicketNumber(t.ticket_number)}</dd>
          </div>
          <div>
            <dt>Yhtiö</dt>
            <dd>{t.company_name || "-"}</dd>
          </div>
          <div>
            <dt>Osoite</dt>
            <dd>{[...new Set(detail.apartments.map(a => a.address).filter(Boolean))].join(", ") || "-"}</dd>
          </div>
          <div>
            <dt>Tyyppi</dt>
            <dd>
              <FactDropdown
                value={t.type}
                options={(ticketTypeOptions.includes(t.type) ? ticketTypeOptions : [t.type, ...ticketTypeOptions])
                  .map(type => ({ value: type, label: type }))}
                disabled={updatingFields}
                onChange={type => updateFields({ type })}
              />
            </dd>
          </div>
          <div>
            <dt>{detail.apartments.length > 1 ? "Asunnot" : "Asunto"}</dt>
            <dd>
              {detail.apartments.length > 0
                ? detail.apartments.map(a => a.apartment_number).join(", ")
                : "Yhteiset tilat"}
            </dd>
          </div>
          <div>
            <dt>Tila</dt>
            <dd>{statusLabel(t.status)}</dd>
          </div>
          <div>
            <dt>Käsittelijä</dt>
            <dd>
              <FactDropdown
                value={t.assignee_id ?? ""}
                options={[
                  { value: "", label: "Ei käsittelijää" },
                  ...officeUsers
                    .filter(user => assignableUsers(company, officeUsers).includes(user) || user.id === t.assignee_id)
                    .map(user => ({ value: user.id, label: user.name }))
                ]}
                disabled={updatingFields || !canAssignTickets(company)}
                onChange={assigneeId => updateFields({ assigneeId: assigneeId || null })}
              />
            </dd>
          </div>
          <div>
            <dt>Prioriteetti</dt>
            <dd>
              <FactDropdown
                value={t.priority}
                options={ticketPriorities.map(priority => ({
                  value: priority,
                  label: priorityLabel(priority),
                  pillClass: `priority ${priority}`
                }))}
                disabled={updatingFields}
                onChange={priority => updateFields({ priority })}
              />
            </dd>
          </div>
          <div>
            <dt>Määräaika</dt>
            <dd className="fact-due">
              <input
                type="date"
                value={t.due_date ?? ""}
                disabled={updatingFields || t.status === "closed"}
                aria-label="Määräaika"
                onChange={event => updateFields({ dueDate: event.target.value || null })}
              />
              {isOverdue(t) && <em className="new-reply overdue">Myöhässä</em>}
            </dd>
          </div>
          <div>
            <dt>Luotu</dt>
            <dd>{formatDate(t.created_at)}</dd>
          </div>
          <div>
            <dt>Ilmoittaja</dt>
            <dd className="fact-search">
              <input
                ref={reporterInput}
                value={reporterQuery ?? reporter?.name ?? ""}
                placeholder="Hae asukasta nimellä…"
                disabled={linking}
                onFocus={event => {
                  setReporterQuery("");
                  event.target.select();
                }}
                onChange={event => setReporterQuery(event.target.value)}
                onBlur={() => setReporterQuery(null)}
                onKeyDown={event => {
                  if (event.key === "Escape") event.currentTarget.blur();
                  if (event.key === "Enter" && reporterMatches.length > 0) {
                    event.preventDefault();
                    chooseReporter(reporterMatches[0].id);
                    event.currentTarget.blur();
                  }
                }}
              />
              <button
                type="button"
                className="fact-search-button"
                title="Hae asukasta"
                aria-label="Hae asukasta"
                disabled={linking}
                // Kenttä pysyy kohdistettuna, jotta painallus ei sulje juuri avattua hakua.
                onMouseDown={event => event.preventDefault()}
                onClick={() => reporterInput.current?.focus()}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0" />
                  <path d="M21 21l-4.300-4.300" />
                </svg>
              </button>
              {reporterQuery !== null && (
                <ul>
                  {reporterMatches.map(r => (
                    // mousedown ehtii ennen kentän blur-tapahtumaa, joka sulkee listan.
                    <li key={r.id} onMouseDown={() => chooseReporter(r.id)}>
                      <strong>{r.name}</strong>
                      <span>{[r.apartment_number, r.email].filter(Boolean).join(" · ")}</span>
                    </li>
                  ))}
                  {reporterMatches.length === 0 && <li className="empty-option">Ei hakua vastaavia asukkaita</li>}
                  {reporter && (
                    <li className="clear-option" onMouseDown={() => chooseReporter("")}>Poista ilmoittaja</li>
                  )}
                </ul>
              )}
            </dd>
          </div>
          <div>
            <dt>Muokattu</dt>
            <dd>{formatDate(t.updated_at || t.created_at)}</dd>
          </div>
          <div>
            <dt>Sähköposti</dt>
            <dd>
              {reporter
                ? reporterEmail || "-"
                : unlinkedSenders.length > 0 ? `${unlinkedSenders.join(", ")} (ei linkitetty asukkaaseen)` : "-"}
            </dd>
          </div>
        </dl>

        <div className="ticket-description">
          <h3>Kuvaus</h3>
          <p>{description}</p>
        </div>

        <section className="drawer-section">
          <div className="suggest-header">
            <h3>Vastaus asukkaalle</h3>
            <button
              className="ai-button"
              onClick={requestSuggestion}
              disabled={suggesting || suggestionUsed}
              title={suggestionUsed ? "AI-ehdotuksen voi pyytää tehtävälle vain kerran." : undefined}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2l1.900 5.600a4 4 0 0 0 2.500 2.500L22 12l-5.600 1.900a4 4 0 0 0-2.500 2.500L12 22l-1.900-5.600a4 4 0 0 0-2.500-2.500L2 12l5.600-1.900a4 4 0 0 0 2.500-2.500z" />
              </svg>
              {suggesting ? "AI kirjoittaa…" : suggestionUsed ? "AI-ehdotus pyydetty" : "Pyydä AI-ehdotus"}
            </button>
          </div>
          {suggestion?.usedAi && (
            <p className="ai-reason created">AI on luonut ehdotuksen tälle tehtävälle. Tarkista ja muokkaa tekstiä ennen lähettämistä.</p>
          )}
          {aiSource && <p className="ai-reason found">{aiReason}</p>}
          {aiSource ? (
            <p>
              <a
                className="source-pill source-link"
                href={`#/knowledge/${encodeURIComponent(aiSource.id)}`}
                target="_blank"
                rel="noreferrer"
                title="Avaa dokumentti uuteen välilehteen"
              >
                Ehdotettu dokumentti: {aiSource.title} ↗
              </a>
            </p>
          ) : null}
          {suggestion && !suggestion.usedAi && (
            <p className="reply-hint">
              AI ei ollut käytettävissä, joten ehdotus tehtiin avainsanahaulla dokumentaatiosta.
            </p>
          )}
          {suggestion && draft !== (t.draft || "") && (
            <p className="reply-hint">Ehdotusta ei ole vielä tallennettu. Muokkaa tekstiä ja tallenna luonnos.</p>
          )}
          {suggestError && <p className="send-error">{suggestError}</p>}
          {replyTarget && (
            <p className="reply-target">
              <span>
                Vastataan viestiin <strong>{replyTarget.subject}</strong> · {formatDate(replyTarget.created_at)}
              </span>
              <button onClick={() => setReplyTargetId(null)} title="Peru valinta" aria-label="Peru valinta">×</button>
            </p>
          )}
          <textarea
            ref={draftEditor}
            className="draft-editor"
            rows={10}
            placeholder="Kirjoita vastaus tai pyydä AI-ehdotus…"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
              setSentTo("");
            }}
          />
          {canReply && (
            <div className="reply-attachments">
              <label className="attach-button">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 11.500l-8.600 8.600a5.500 5.500 0 0 1-7.800-7.800l8.600-8.600a3.700 3.700 0 0 1 5.200 5.200l-8.500 8.500a1.800 1.800 0 0 1-2.600-2.600l7.800-7.800" />
                </svg>
                Liitä tiedosto
                <input
                  type="file"
                  multiple
                  // Sama tiedosto voidaan valita uudelleen poistamisen jälkeen.
                  onChange={event => {
                    const picked = [...(event.target.files ?? [])];
                    setReplyFiles(current => [...current, ...picked].slice(0, MAX_REPLY_ATTACHMENTS));
                    event.target.value = "";
                    setSendError("");
                  }}
                />
              </label>
              {replyFiles.map((file, index) => (
                <span className="reply-file" key={`${file.name}-${index}`}>
                  {file.name} <small>{formatFileSize(file.size)}</small>
                  <button
                    onClick={() => setReplyFiles(current => current.filter((_, position) => position !== index))}
                    title="Poista liite"
                    aria-label={`Poista liite ${file.name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              {replyFilesTooLarge && (
                <p className="send-error">Liitteiden yhteiskoko saa olla enintään 15 Mt (nyt {formatFileSize(replyFilesSize)}).</p>
              )}
            </div>
          )}
          <div className="draft-actions">
            {canReply && (
              <button className="primary" onClick={sendReply} disabled={sending || !draft.trim() || !recipient || replyFilesTooLarge}>
                {sending ? "Lähetetään…" : "Lähetä"}
              </button>
            )}
            <button className={canReply ? "" : "primary"} onClick={saveDraft} disabled={saving}>
              {saving ? "Tallennetaan…" : "Tallenna luonnos"}
            </button>
            {saved && <span className="saved-indicator">Tallennettu</span>}
            {sentTo && <span className="saved-indicator">Lähetetty: {sentTo}</span>}
          </div>
          {canReply && (
            <p className="reply-hint">
              {recipient
                ? `Vastaus lähetetään osoitteeseen ${recipient}`
                : "Tehtävällä ei ole sähköpostiosoitetta, johon vastauksen voisi lähettää."}
            </p>
          )}
          {sendError && <p className="send-error">{sendError}</p>}
        </section>

        <TicketWorkOrders detail={detail} onChanged={onChanged} />

        </div>

        <section className="drawer-timeline">
          <h3>Aikajana</h3>
          {timeline.map(item => item.kind === "message" ? (
            <TimelineMessage
              key={item.id}
              message={item.message}
              replying={replyTarget?.id === item.message.id}
              onReply={canReply && item.message.direction === "inbound" && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(item.message.sender)
                ? () => startReply(item.message)
                : undefined}
            />
          ) : item.kind === "note" ? (
            <div className="message note" key={item.id}>
              <small>Sisäinen muistiinpano · {actorLabel(item.note.author)} · {formatDate(item.created_at)}</small>
              <p>{item.note.body}</p>
            </div>
          ) : (
            <div className="timeline-event" key={item.id}>
              <span>{actionLabel(item.event.action)}</span>
              <small>{actorLabel(item.event.actor)} · {formatDate(item.created_at)}</small>
            </div>
          ))}
          {timeline.length === 0 && <p className="drawer-empty">Ei tapahtumia.</p>}
          <form className="note-form" onSubmit={addNote}>
            <textarea
              rows={2}
              value={note}
              onChange={event => setNote(event.target.value)}
              placeholder="Lisää sisäinen muistiinpano (ei lähde asukkaalle)…"
            />
            <button type="submit" disabled={addingNote || !note.trim()}>
              {addingNote ? "Lisätään…" : "Lisää muistiinpano"}
            </button>
          </form>
        </section>
      </aside>
    </div>
  );
}
