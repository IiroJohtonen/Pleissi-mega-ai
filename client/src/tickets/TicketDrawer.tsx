import { type FormEvent, useEffect, useRef, useState } from "react";
import { FactDropdown } from "../components/common";
import {
  actionLabel, actorLabel, channelLabel, fileToBase64, formatDate, formatFileSize, formatTicketNumber,
  MAX_REPLY_ATTACHMENT_BYTES, MAX_REPLY_ATTACHMENTS, priorityLabel, statusLabel, ticketPriorities, ticketTypeOptions
} from "../format";
import { actorName, api, errorMessage, isManager, type OfficeUser } from "../session";
import type { Company, Resident, TicketDetail } from "../types";
import { assignableUsers, canAssignTickets, isOverdue, splitQuotedReply } from "./ticket-utils";
import { AssignPicker, AttachmentsMenu } from "./TicketCard";
import { TicketWorkOrders } from "./TicketWorkOrders";
import { t } from "../i18n";

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
        <button className="message-reply" onClick={onReply} title={t("Vastaa tähän viestiin samassa sähköpostiketjussa")}>
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
          {t("Vastaa")}
        </button>
      )}
      <button
        className="message-head"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        title={collapsed ? t("Näytä viesti") : t("Tiivistä viesti")}
      >
        <span className="message-direction">{inbound ? t("Saapunut") : t("Lähetetty")}</span>
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
            {showQuoted ? t("Piilota lainattu viesti") : t("Näytä lainattu viesti")}
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
  onDeleted,
  onDirtyChange,
  backLabel,
  company
}: {
  detail: TicketDetail;
  // Tehtävän taloyhtiö: määrää, kenelle tehtävän voi antaa ja kuka saa antaa.
  company?: Company;
  onClose: () => void;
  onDecision: (d: "ai" | "human" | "skip") => void;
  onDraftSaved: (draft: string) => void;
  onChanged: () => Promise<void>;
  // Tehtävä on poistettu: näkymä suljetaan ja listat ladataan uudelleen.
  onDeleted: () => Promise<void>;
  // Kertoo, onko tiedoissa tallentamattomia muutoksia, jotta navigointi voi varmistaa poistumisen.
  onDirtyChange: (dirty: boolean) => void;
  // Takaisin-linkin teksti: näkymä, josta tehtävä avattiin.
  backLabel: string;
}) {
  const ticket = detail.ticket;
  const [draft, setDraft] = useState(ticket.draft || "");
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
  }, [ticket.id]);

  // Kuvaus on tehtävän alkuperäinen viesti; käsin luodulla tehtävällä sen tiivistelmä.
  const firstInbound = detail.messages.find(m => m.direction === "inbound");
  const description = (firstInbound ? splitQuotedReply(firstInbound.body).text.trim() : "")
    || ticket.summary
    || t("Ei kuvausta.");
  const lastInbound = [...detail.messages].reverse().find(m => m.direction === "inbound");
  // Sama järjestys kuin palvelimella: ensin alkuperäinen lähettäjä, muuten linkitetyt asukkaat.
  // Aikajanalta valittu viesti, johon vastataan; ilman valintaa vastataan viimeisimpään saapuneeseen.
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const replyTarget = detail.messages.find(m => m.id === replyTargetId && m.direction === "inbound") ?? null;
  const draftEditor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setReplyTargetId(null);
  }, [ticket.id]);

  function startReply(message: TicketDetail["messages"][number]) {
    setReplyTargetId(message.id);
    draftEditor.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    draftEditor.current?.focus({ preventScroll: true });
  }

  const recipient = (replyTarget ?? lastInbound)?.sender.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    || detail.reporters.map(r => r.email?.trim()).filter(Boolean).join(", ");
  const canReply = ticket.status === "waiting_manager" || ticket.status === "waiting_third_party";

  useEffect(() => {
    setDraft(ticket.draft || "");
    setSaved(false);
  }, [ticket.id, ticket.draft]);

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
  }, [ticket.id]);

  // AI-ehdotuksen voi pyytää tehtävälle vain kerran; aiempi pyyntö näkyy lokissa.
  const suggestionUsed = Boolean(suggestion) || detail.audit.some(a => a.action === "ai_suggested");
  const aiReason = suggestion ? suggestion.reason : ticket.ai_reason;
  // Dokumenttia ehdotetaan vasta, kun tehtävälle on pyydetty AI-ehdotus.
  const aiSource = suggestion
    ? suggestion.source
    : suggestionUsed && ticket.knowledge_source_id && ticket.knowledge_source_title
      ? { id: ticket.knowledge_source_id, title: ticket.knowledge_source_title }
      : null;

  async function requestSuggestion() {
    if (draft.trim() && draft !== (ticket.draft || "")
      && !window.confirm(t("Luonnoksessa on tallentamattomia muutoksia. Korvataanko se AI:n ehdotuksella?"))) {
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
      }>(`/tickets/${ticket.id}/suggest`, { method: "POST" });
      setSuggestion(result);
      setDraft(result.draft);
      setSaved(false);
      setSentTo("");
      // Ehdotus tallennetaan heti luonnokseksi; jos tallennus epäonnistuu, teksti jää kenttään tallentamattomana.
      try {
        await api(`/tickets/${ticket.id}/draft`, {
          method: "POST",
          body: JSON.stringify({ draft: result.draft })
        });
        onDraftSaved(result.draft);
        setSaved(true);
      } catch {
        setSuggestError(t("AI-ehdotus on kentässä, mutta sen tallennus luonnokseksi epäonnistui. Paina Tallenna luonnos."));
      }
    } catch (error) {
      let message = t("AI-ehdotuksen hakeminen epäonnistui. Yritä uudelleen.");
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
  // Näkyvä välilehti: vastaus asukkaalle tai työtilaukset.
  const [section, setSection] = useState<"reply" | "orders">("reply");

  useEffect(() => {
    setSection("reply");
  }, [ticket.id]);

  useEffect(() => {
    setSentTo("");
    setSendError("");
    setNote("");
  }, [ticket.id]);

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
    api<Resident[]>(`/companies/${encodeURIComponent(ticket.company_id)}/residents`)
      .then(setResidents)
      .catch(() => setResidents([]));
  }, [ticket.id, ticket.company_id]);

  // Tehtävällä on yksi ilmoittaja. Valikossa on mukana myös nykyinen ilmoittaja, vaikka asukaslista ei olisi vielä latautunut.
  const reporter = detail.reporters[0];
  const reporterOptions = reporter && !residents.some(r => r.id === reporter.id)
    ? [reporter, ...residents]
    : residents;
  // Tietokenttien muutokset kerätään tähän ja tallennetaan vasta Tallenna-painikkeesta. Tehtävän
  // taustapäivitys ei koske niihin, joten keskeneräinen muokkaus säilyy.
  type FieldEdits = { type?: string; priority?: string; assigneeId?: string | null; dueDate?: string | null; reporterId?: string };
  const [edits, setEdits] = useState<FieldEdits>({});
  const [saveError, setSaveError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    setEdits({});
    setSaveError("");
    setConfirmDelete(false);
    setDeleteError("");
  }, [ticket.id]);

  const savedFields = {
    type: ticket.type,
    priority: ticket.priority,
    assigneeId: ticket.assignee_id ?? null,
    dueDate: ticket.due_date ?? null,
    reporterId: reporter?.id ?? ""
  };
  // Näytettävät arvot: tallennettu arvo, ellei kenttää ole muutettu.
  const shown = { ...savedFields, ...edits };
  const dirty = Object.keys(edits).length > 0;
  const shownReporter = reporterOptions.find(r => r.id === shown.reporterId);

  // Kirjaa kentän muutoksen; alkuperäiseen arvoon palaaminen poistaa sen muutoksista.
  function edit<K extends keyof FieldEdits>(key: K, value: (typeof savedFields)[K]) {
    setSaveError("");
    setEdits(previous => {
      const next = { ...previous };
      if (value === savedFields[key]) delete next[key];
      else (next as Record<string, unknown>)[key] = value;
      return next;
    });
  }

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty]);

  // Sulkeminen varmistetaan, jos muutoksia on tallentamatta.
  function requestClose() {
    if (dirty && !window.confirm(t("Tallentamattomat muutokset menetetään. Suljetaanko tehtävä?"))) return;
    onClose();
  }

  // Ilmoittajan hakukenttä: null = ei muokata, jolloin kentässä näkyy nykyisen ilmoittajan nimi.
  const [reporterQuery, setReporterQuery] = useState<string | null>(null);
  const reporterInput = useRef<HTMLInputElement>(null);
  const reporterSearch = (reporterQuery ?? "").trim().toLowerCase();
  const reporterMatches = reporterOptions
    .filter(r => [r.name, r.apartment_number, r.email].some(value => value?.toLowerCase().includes(reporterSearch)))
    .slice(0, 8);

  function chooseReporter(residentId: string) {
    setReporterQuery(null);
    edit("reporterId", residentId);
  }

  // Vaihtaa tehtävän ilmoittajan: aiemmat linkitykset poistetaan ja valittu asukas linkitetään tilalle.
  async function setReporter(residentId: string) {
    setLinking(true);
    try {
      for (const current of detail.reporters) {
        if (current.id === residentId) continue;
        await api(`/tickets/${ticket.id}/reporters/${encodeURIComponent(current.id)}?actor=${encodeURIComponent(actorName())}`, {
          method: "DELETE"
        });
      }
      if (residentId && !detail.reporters.some(current => current.id === residentId)) {
        await api(`/tickets/${ticket.id}/reporters`, {
          method: "POST",
          body: JSON.stringify({ residentId, actor: actorName() })
        });
      }
      await onChanged();
    } finally {
      setLinking(false);
    }
  }

  // Sähköposti haetaan asukastiedoista valitun ilmoittajan perusteella.
  const reporterEmail = shownReporter
    ? residents.find(r => r.id === shownReporter.id)?.email || shownReporter.email
    : "";

  const [updatingFields, setUpdatingFields] = useState(false);

  // Tallentaa kerätyt muutokset: ensin tietokentät, sitten ilmoittaja.
  async function saveEdits() {
    setUpdatingFields(true);
    setSaveError("");
    try {
      const { reporterId, ...fields } = edits;
      if (Object.keys(fields).length > 0) {
        await api(`/tickets/${ticket.id}/fields`, {
          method: "PUT",
          body: JSON.stringify({ ...fields, actor: actorName() })
        });
      }
      if (reporterId !== undefined) await setReporter(reporterId);
      else await onChanged();
      setEdits({});
    } catch (error) {
      setSaveError(errorMessage(error, t("Tallennus epäonnistui.")));
    } finally {
      setUpdatingFields(false);
    }
  }

  async function deleteTicket() {
    setDeleting(true);
    setDeleteError("");
    try {
      await api(`/tickets/${ticket.id}`, { method: "DELETE" });
      await onDeleted();
    } catch (error) {
      setDeleteError(errorMessage(error, t("Tehtävän poistaminen epäonnistui.")));
      setDeleting(false);
    }
  }

  // Toimiston käyttäjät käsittelijän valintaa varten.
  const [officeUsers, setOfficeUsers] = useState<OfficeUser[]>([]);
  useEffect(() => {
    api<OfficeUser[]>("/users").then(setOfficeUsers).catch(() => setOfficeUsers([]));
  }, []);

  async function updateFields(fields: { type?: string; priority?: string; assigneeId?: string | null; dueDate?: string | null }) {
    setUpdatingFields(true);
    try {
      await api(`/tickets/${ticket.id}/fields`, {
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
      await api(`/tickets/${ticket.id}/notes`, {
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
      const result = await api<{ ok: boolean; to: string }>(`/tickets/${ticket.id}/reply`, {
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
      let message = t("Lähetys epäonnistui.");
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
      await api(`/tickets/${ticket.id}/draft`, {
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
    <section className="ticket-page">
      <button className="back-link" onClick={requestClose}>{backLabel}</button>
      <div className="drawer drawer-split">
        <div className="drawer-main">
        {/* Yläpalkki pysyy näkyvissä, kun tehtävää vieritetään. */}
        <div className="drawer-topbar">
          <span className="drawer-topbar-number">
            #{formatTicketNumber(ticket.ticket_number)} · {statusLabel(ticket.status)}
            {dirty && <em className="unsaved-mark">{t("Tallentamattomia muutoksia")}</em>}
          </span>
          <div className="drawer-topbar-tools">
          <AttachmentsMenu attachments={detail.attachments} ticketId={ticket.id} onChanged={onChanged} />
          {ticket.status === "closed" && (
            <div className="drawer-actions">
              <button
                disabled={updatingFields}
                onClick={async () => {
                  setUpdatingFields(true);
                  try {
                    await api(`/tickets/${ticket.id}/reopen`, { method: "POST" });
                    await onChanged();
                  } finally {
                    setUpdatingFields(false);
                  }
                }}
              >
                {t("Avaa uudelleen")}
              </button>
            </div>
          )}
          {ticket.status !== "closed" && (
            <div className="drawer-actions">
              {canAssignTickets(company) && (
                <AssignPicker
                  users={assignableUsers(company, officeUsers)}
                  assigneeId={ticket.assignee_id ?? null}
                  onAssign={assigneeId => updateFields({ assigneeId })}
                />
              )}
              {ticket.status === "open" && (
                <button className="primary" onClick={() => onDecision("human")}>{t("Osoita minulle")}</button>
              )}
              <button onClick={() => onDecision("skip")}>{t("Sulje")}</button>
            </div>
          )}
          <div className="drawer-actions">
            {isManager() && (
              <button className="danger" onClick={() => { setDeleteError(""); setConfirmDelete(true); }} disabled={updatingFields}>
                {t("Poista")}
              </button>
            )}
            <button className={dirty ? "primary" : ""} onClick={() => void saveEdits()} disabled={!dirty || updatingFields}>
              {updatingFields && dirty ? t("Tallennetaan…") : t("Tallenna")}
            </button>
          </div>
          </div>
        </div>
        {saveError && <p className="send-error">{saveError}</p>}
        {ticket.ai_action === "filtered" && ticket.status === "closed" && (
          <p className="filtered-notice">
            <strong>{t("AI suodatti tämän viestin pois päätösjonosta.")}</strong>{" "}
            {ticket.ai_reason}{" "}
            {t("Jos viesti kuuluu toimistolle, avaa tehtävä uudelleen.")}
          </p>
        )}
        <h2>{ticket.subject}</h2>

        <dl className="ticket-facts">
          <div className="fact-number">
            <dt>{t("Tehtävänumero")}</dt>
            <dd>#{formatTicketNumber(ticket.ticket_number)}</dd>
          </div>
          <div>
            <dt>{t("Yhtiö")}</dt>
            <dd>{ticket.company_name || "-"}</dd>
          </div>
          <div>
            <dt>{t("Osoite")}</dt>
            <dd>{[...new Set(detail.apartments.map(a => a.address).filter(Boolean))].join(", ") || "-"}</dd>
          </div>
          <div className={edits.type !== undefined ? "changed" : ""}>
            <dt>{t("Tyyppi")}</dt>
            <dd>
              <FactDropdown
                value={shown.type}
                options={(ticketTypeOptions.includes(ticket.type) ? ticketTypeOptions : [ticket.type, ...ticketTypeOptions])
                  .map(type => ({ value: type, label: t(type) }))}
                disabled={updatingFields}
                onChange={type => edit("type", type)}
              />
            </dd>
          </div>
          <div>
            <dt>{detail.apartments.length > 1 ? t("Asunnot") : t("Asunto")}</dt>
            <dd>
              {detail.apartments.length > 0
                ? detail.apartments.map(a => a.apartment_number).join(", ")
                : t("Yhteiset tilat")}
            </dd>
          </div>
          <div>
            <dt>{t("Tila")}</dt>
            <dd>{statusLabel(ticket.status)}</dd>
          </div>
          <div className={edits.assigneeId !== undefined ? "changed" : ""}>
            <dt>{t("Käsittelijä")}</dt>
            <dd>
              <FactDropdown
                value={shown.assigneeId ?? ""}
                options={[
                  { value: "", label: t("Ei käsittelijää") },
                  ...officeUsers
                    .filter(user => assignableUsers(company, officeUsers).includes(user) || user.id === ticket.assignee_id)
                    .map(user => ({ value: user.id, label: user.name }))
                ]}
                disabled={updatingFields || !canAssignTickets(company)}
                onChange={assigneeId => edit("assigneeId", assigneeId || null)}
              />
            </dd>
          </div>
          <div className={edits.priority !== undefined ? "changed" : ""}>
            <dt>{t("Prioriteetti")}</dt>
            <dd>
              <FactDropdown
                value={shown.priority}
                options={ticketPriorities.map(priority => ({
                  value: priority,
                  label: priorityLabel(priority),
                  pillClass: `priority ${priority}`
                }))}
                disabled={updatingFields}
                onChange={priority => edit("priority", priority)}
              />
            </dd>
          </div>
          <div className={edits.dueDate !== undefined ? "changed" : ""}>
            <dt>{t("Määräaika")}</dt>
            <dd className="fact-due">
              <input
                type="date"
                value={shown.dueDate ?? ""}
                disabled={updatingFields || ticket.status === "closed"}
                aria-label={t("Määräaika")}
                onChange={event => edit("dueDate", event.target.value || null)}
              />
              {isOverdue(ticket) && <em className="new-reply overdue">{t("Myöhässä")}</em>}
            </dd>
          </div>
          <div>
            <dt>{t("Luotu")}</dt>
            <dd>{formatDate(ticket.created_at)}</dd>
          </div>
          <div className={edits.reporterId !== undefined ? "changed" : ""}>
            <dt>{t("Ilmoittaja")}</dt>
            <dd className="fact-search">
              <input
                ref={reporterInput}
                value={reporterQuery ?? shownReporter?.name ?? ""}
                placeholder={t("Hae asukasta nimellä…")}
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
                title={t("Hae asukasta")}
                aria-label={t("Hae asukasta")}
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
                  {reporterMatches.length === 0 && <li className="empty-option">{t("Ei hakua vastaavia asukkaita")}</li>}
                  {shownReporter && (
                    <li className="clear-option" onMouseDown={() => chooseReporter("")}>{t("Poista ilmoittaja")}</li>
                  )}
                </ul>
              )}
            </dd>
          </div>
          <div>
            <dt>{t("Muokattu")}</dt>
            <dd>{formatDate(ticket.updated_at || ticket.created_at)}</dd>
          </div>
          <div>
            <dt>{t("Sähköposti")}</dt>
            <dd>
              {shownReporter
                ? reporterEmail || "-"
                : unlinkedSenders.length > 0 ? t("{0} (ei linkitetty asukkaaseen)", unlinkedSenders.join(", ")) : "-"}
            </dd>
          </div>
        </dl>

        <div className="ticket-description">
          <h3>{t("Kuvaus")}</h3>
          <p>{description}</p>
        </div>

        {/* Vastaus ja työtilaukset ovat välilehtinä. Piilotettu välilehti pysyy sivulla, jotta keskeneräinen
            vastaus tai työtilaus ei katoa välilehteä vaihdettaessa. */}
        <div className="ticket-sections">
        <div className="billing-tabs ticket-section-tabs" role="tablist">
          <button role="tab" aria-selected={section === "reply"} className={section === "reply" ? "active" : ""} onClick={() => setSection("reply")}>
            {t("Vastaus asukkaalle")}
          </button>
          <button role="tab" aria-selected={section === "orders"} className={section === "orders" ? "active" : ""} onClick={() => setSection("orders")}>
            {t("Työtilaukset")}
            <b>{detail.workOrders.length}</b>
          </button>
        </div>

        <div role="tabpanel" hidden={section !== "reply"}>
        <section className="drawer-section">
          <div className="suggest-header">
            <h3>{t("Vastaus asukkaalle")}</h3>
            <button
              className="ai-button"
              onClick={requestSuggestion}
              disabled={suggesting || suggestionUsed}
              title={suggestionUsed ? t("AI-ehdotuksen voi pyytää tehtävälle vain kerran.") : undefined}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2l1.900 5.600a4 4 0 0 0 2.500 2.500L22 12l-5.600 1.900a4 4 0 0 0-2.500 2.500L12 22l-1.900-5.600a4 4 0 0 0-2.500-2.500L2 12l5.600-1.900a4 4 0 0 0 2.500-2.500z" />
              </svg>
              {suggesting ? t("AI kirjoittaa…") : suggestionUsed ? t("AI-ehdotus pyydetty") : t("Pyydä AI-ehdotus")}
            </button>
          </div>
          {suggestion?.usedAi && (
            <p className="ai-reason created">{t("AI on luonut ehdotuksen tälle tehtävälle. Tarkista ja muokkaa tekstiä ennen lähettämistä.")}</p>
          )}
          {aiSource && <p className="ai-reason found">{aiReason}</p>}
          {aiSource ? (
            <p>
              <a
                className="source-pill source-link"
                href={`#/knowledge/${encodeURIComponent(aiSource.id)}`}
                target="_blank"
                rel="noreferrer"
                title={t("Avaa dokumentti uuteen välilehteen")}
              >
                {t("Ehdotettu dokumentti:")}{" "}{aiSource.title} ↗
              </a>
            </p>
          ) : null}
          {suggestion && !suggestion.usedAi && (
            <p className="reply-hint">
              {t("AI ei ollut käytettävissä, joten ehdotus tehtiin avainsanahaulla dokumentaatiosta.")}
            </p>
          )}
          {suggestion && draft !== (ticket.draft || "") && (
            <p className="reply-hint">{t("Ehdotusta ei ole vielä tallennettu. Muokkaa tekstiä ja tallenna luonnos.")}</p>
          )}
          {suggestError && <p className="send-error">{suggestError}</p>}
          {replyTarget && (
            <p className="reply-target">
              <span>
                {t("Vastataan viestiin")}{" "}<strong>{replyTarget.subject}</strong> · {formatDate(replyTarget.created_at)}
              </span>
              <button onClick={() => setReplyTargetId(null)} title={t("Peru valinta")} aria-label={t("Peru valinta")}>×</button>
            </p>
          )}
          <textarea
            ref={draftEditor}
            className="draft-editor"
            rows={10}
            placeholder={t("Kirjoita vastaus tai pyydä AI-ehdotus…")}
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
                {t("Liitä tiedosto")}
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
                    title={t("Poista liite")}
                    aria-label={t("Poista liite {0}", file.name)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {replyFilesTooLarge && (
                <p className="send-error">{t("Liitteiden yhteiskoko saa olla enintään 15 Mt (nyt")}{" "}{formatFileSize(replyFilesSize)}).</p>
              )}
            </div>
          )}
          <div className="draft-actions">
            {canReply && (
              <button className="primary" onClick={sendReply} disabled={sending || !draft.trim() || !recipient || replyFilesTooLarge}>
                {sending ? t("Lähetetään…") : t("Lähetä")}
              </button>
            )}
            <button className={canReply ? "" : "primary"} onClick={saveDraft} disabled={saving}>
              {saving ? t("Tallennetaan…") : t("Tallenna luonnos")}
            </button>
            {saved && <span className="saved-indicator">{t("Tallennettu")}</span>}
            {sentTo && <span className="saved-indicator">{t("Lähetetty:")}{" "}{sentTo}</span>}
          </div>
          {canReply && (
            <p className="reply-hint">
              {recipient
                ? t("Vastaus lähetetään osoitteeseen {0}", recipient)
                : t("Tehtävällä ei ole sähköpostiosoitetta, johon vastauksen voisi lähettää.")}
            </p>
          )}
          {sendError && <p className="send-error">{sendError}</p>}
        </section>
        </div>

        <div role="tabpanel" hidden={section !== "orders"}>
          <TicketWorkOrders detail={detail} onChanged={onChanged} />
        </div>
        </div>

        </div>

        <section className="drawer-timeline">
          <h3>{t("Aikajana")}</h3>
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
              <small>{t("Sisäinen muistiinpano ·")}{" "}{actorLabel(item.note.author)} · {formatDate(item.created_at)}</small>
              <p>{item.note.body}</p>
            </div>
          ) : (
            <div className="timeline-event" key={item.id}>
              <span>{actionLabel(item.event.action)}</span>
              <small>{actorLabel(item.event.actor)} · {formatDate(item.created_at)}</small>
            </div>
          ))}
          {timeline.length === 0 && <p className="drawer-empty">{t("Ei tapahtumia.")}</p>}
          <form className="note-form" onSubmit={addNote}>
            <textarea
              rows={2}
              value={note}
              onChange={event => setNote(event.target.value)}
              placeholder={t("Lisää sisäinen muistiinpano (ei lähde asukkaalle)…")}
            />
            <button type="submit" disabled={addingNote || !note.trim()}>
              {addingNote ? t("Lisätään…") : t("Lisää muistiinpano")}
            </button>
          </form>
        </section>
      </div>

      {confirmDelete && (
        <div className="overlay skip-overlay" onClick={() => { if (!deleting) setConfirmDelete(false); }}>
          <aside className="drawer skip-drawer" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" onClick={event => event.stopPropagation()}>
            <h2 id="delete-title">{t("Poistetaanko tehtävä #{0}?", formatTicketNumber(ticket.ticket_number))}</h2>
            <p className="delete-warning">
              {t("Tehtävä poistetaan pysyvästi viesteineen, liitteineen, muistiinpanoineen ja työtilauksineen. Poistoa ei voi perua.")}
            </p>
            <p className="muted">{t("Jos asia on vain hoidettu, sulje tehtävä poistamisen sijaan, niin se jää historiaan.")}</p>
            {deleteError && <p className="send-error">{deleteError}</p>}
            <div className="drawer-actions compact-actions">
              <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleting}>{t("Peruuta")}</button>
              <button type="button" className="danger-fill" onClick={() => void deleteTicket()} disabled={deleting}>
                {deleting ? t("Poistetaan…") : t("Poista tehtävä")}
              </button>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
