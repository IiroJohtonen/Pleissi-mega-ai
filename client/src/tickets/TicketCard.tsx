import { useState } from "react";
import { DownloadLink, TabIcon } from "../components/common";
import {
  fileToBase64, formatDate, formatDay, formatFileSize, formatTicketNumber, MAX_REPLY_ATTACHMENT_BYTES,
  MAX_REPLY_ATTACHMENTS, priorityLabel, statusLabel
} from "../format";
import { api, errorMessage, type OfficeUser, session } from "../session";
import type { Ticket, TicketDetail } from "../types";
import { isManagerRole, isOverdue, type TicketReminder } from "./ticket-utils";
import { t } from "../i18n";

// "Anna toiselle" -nappi: avaa listan toimiston isännöitsijöistä ja vaihtaa tehtävän käsittelijän.
export function AssignPicker({
  users,
  assigneeId,
  onAssign
}: {
  users: OfficeUser[];
  assigneeId: string | null;
  onAssign: (assigneeId: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const managers = users.filter(isManagerRole);

  async function choose(userId: string) {
    setOpen(false);
    if (userId === assigneeId) return;
    setSaving(true);
    try {
      await onAssign(userId);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`assign-picker ${open ? "open" : ""}`}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button type="button" aria-haspopup="listbox" aria-expanded={open} disabled={saving} onClick={() => setOpen(!open)}>
        {saving ? t("Siirretään…") : t("Anna toiselle")}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="assign-menu" role="listbox" aria-label={t("Valitse isännöitsijä")}>
          <small>{t("Valitse isännöitsijä")}</small>
          {managers.length === 0 && <p>{t("Ei isännöitsijöitä.")}</p>}
          {managers.map(user => (
            <button
              type="button"
              key={user.id}
              role="option"
              aria-selected={user.id === assigneeId}
              className={user.id === assigneeId ? "current" : ""}
              onClick={() => void choose(user.id)}
            >
              <span className="user-avatar">{user.name.split(" ").map(part => part[0]).join("").slice(0, 2)}</span>
              <span className="assign-name">
                <strong>{user.name}{session?.user.id === user.id ? t(" (sinä)") : ""}</strong>
                <em>{user.id === assigneeId ? t("Nykyinen käsittelijä") : t(user.role)}</em>
              </span>
              {user.id === assigneeId && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12l5 5 9-10" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Tehtävän liitteet yläpalkin pudotusvalikossa; liite latautuu klikkaamalla.
export function AttachmentsMenu({
  attachments,
  ticketId,
  onChanged
}: {
  attachments: TicketDetail["attachments"];
  ticketId: string;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  // Liittää valitut tiedostot suoraan tehtävälle; mitään ei lähetetä.
  async function upload(files: File[]) {
    if (files.length === 0) return;
    if (files.reduce((total, file) => total + file.size, 0) > MAX_REPLY_ATTACHMENT_BYTES) {
      setError(t("Liitteiden yhteiskoko saa olla enintään 15 Mt."));
      return;
    }
    setUploading(true);
    setError("");
    try {
      await api(`/tickets/${encodeURIComponent(ticketId)}/attachments`, {
        method: "POST",
        body: JSON.stringify({
          attachments: await Promise.all(files.slice(0, MAX_REPLY_ATTACHMENTS).map(async file => ({
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            data: await fileToBase64(file)
          })))
        })
      });
      await onChanged();
    } catch (uploadError) {
      setError(errorMessage(uploadError, t("Liitteen lisääminen epäonnistui.")));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div
      className={`assign-picker attachments-menu ${open ? "open" : ""}`}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button type="button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg className="clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 11.500l-8.600 8.600a5.500 5.500 0 0 1-7.800-7.800l8.600-8.600a3.700 3.700 0 0 1 5.200 5.200l-8.500 8.500a1.800 1.800 0 0 1-2.600-2.600l7.800-7.800" />
        </svg>
        {t("Liitteet")}
        <b>{attachments.length}</b>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="assign-menu">
          <small>{t("Tehtävän liitteet")}</small>
          {attachments.length === 0 && <p>{t("Ei liitteitä.")}</p>}
          {attachments.map(attachment => (
            <DownloadLink
              key={attachment.id}
              path={`/attachments/${attachment.id}`}
              filename={attachment.filename}
              title={t("Lataa {0}", attachment.filename)}
            >
              <strong>{attachment.filename}</strong>
              <em>
                {attachment.direction === "outbound" ? t("Lähetetty") : attachment.direction === "internal" ? t("Lisätty") : attachment.direction === "portal" ? t("Asukkaalta") : t("Saapunut")} · {formatFileSize(attachment.size)} · {formatDate(attachment.created_at)}
              </em>
            </DownloadLink>
          ))}
          <label className="attachments-add">
            {uploading ? t("Lisätään…") : t("+ Lisää liite")}
            <input
              type="file"
              multiple
              disabled={uploading}
              onChange={event => {
                const picked = [...(event.target.files ?? [])];
                event.target.value = "";
                void upload(picked);
              }}
            />
          </label>
          {error && <p className="send-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function TicketCard({
  ticket,
  reminders = [],
  compact = false,
  companyName,
  users,
  canAssign,
  allUsers,
  onAssign,
  onOpen,
  onDecision
}: {
  ticket: Ticket;
  // Muistutusten syyt (määräaika lähestyy, asukas odottanut vastausta); myöhästyminen näkyy omana merkkinään.
  reminders?: TicketReminder[];
  compact?: boolean;
  companyName?: string;
  // Käyttäjät, joille tehtävän voi antaa, ja saako kirjautunut käyttäjä antaa sen eteenpäin.
  users: OfficeUser[];
  canAssign: boolean;
  allUsers: OfficeUser[];
  onAssign: (assigneeId: string) => Promise<void>;
  onOpen: () => void;
  onDecision: (d: "ai" | "human" | "skip") => void;
}) {
  const hasDraft = Boolean((ticket.draft || "").trim());
  const assignee = allUsers.find(user => user.id === ticket.assignee_id);

  if (compact) {
    return (
      <article
        className={`ticket-row priority-${ticket.priority}`}
        onClick={onOpen}
        onKeyDown={event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <span className="ticket-number">#{formatTicketNumber(ticket.ticket_number)}</span>
        <div className="ticket-row-main">
          <strong>
            {ticket.subject}
            {ticket.has_new_reply ? <em className="new-reply">{t("Uusi viesti")}</em> : null}
            {ticket.ai_action === "filtered" && ticket.status === "closed"
              ? <em className="new-reply filtered" title={ticket.ai_reason}>{t("AI suodatti")}</em>
              : null}
            {isOverdue(ticket) ? <em className="new-reply overdue" title={t("Määräaika oli {0}", formatDay(ticket.due_date))}>{t("Myöhässä")}</em> : null}
          </strong>
          {reminders.length > 0 && (
            <span className="ticket-row-reminders">
              {reminders.map(reminder => <em key={reminder.kind} className={`reminder-chip reminder-${reminder.kind}`}>{reminder.text}</em>)}
            </span>
          )}
          {/* Kapealla näytöllä käsittelijä näkyy otsikon alla, koska sarake ei mahdu. */}
          <span className="ticket-row-assignee-line">{assignee ? t("Käsittelijä: {0}", assignee.name) : t("Ei käsittelijää")}</span>
        </div>
        <span className={`priority ${ticket.priority}`}>{priorityLabel(ticket.priority)}</span>
        <span className="type">{t(ticket.type)}</span>
        <span className="ticket-row-contact">{ticket.resident_name || ticket.apartment_number || t("Ei yhteyshenkilöä")}</span>
        <span className={`ticket-row-assignee ${assignee ? "" : "none"}`}>{assignee ? assignee.name : t("Ei käsittelijää")}</span>
        <span className="status-badge">{statusLabel(ticket.status)}</span>
        <time className="date">{formatDate(ticket.created_at)}</time>
        <time className="date">{formatDate(ticket.updated_at || ticket.created_at)}</time>
      </article>
    );
  }

  return (
    <article className={`ticket-card priority-${ticket.priority} ${ticket.status === "waiting_manager" ? "managed" : ""} ${ticket.priority === "emergency" ? "emergency" : ""}`} onClick={onOpen}>
      <div className="ticket-top">
        <span className="ticket-company" title={t("Taloyhtiö")}>
          <TabIcon tab="companies" />
          {companyName ?? t("Tuntematon yhtiö")}
        </span>
        <span className="ticket-number">#{formatTicketNumber(ticket.ticket_number)}</span>
        <span className={`priority ${ticket.priority}`}>{priorityLabel(ticket.priority)}</span>
        <span className="type">{t(ticket.type)}</span>
        <span className="status-badge">{statusLabel(ticket.status)}</span>
        <span className="date">{formatDate(ticket.updated_at || ticket.created_at)}</span>
      </div>

      <div className="ticket-main">
        <div>
          <h2>{ticket.subject}</h2>
          <div className="meta">
            <span>{ticket.apartment_number || t("Asuntoa ei tunnistettu")}</span>
            <span>{ticket.resident_name || t("Asukasta ei tunnistettu")}</span>
            <span className="assignee-pill">{assignee ? t("Käsittelijä: {0}", assignee.name) : t("Ei käsittelijää")}</span>
            {hasDraft && <span className="draft-pill">{t("Luonnos tallennettu")}</span>}
            {ticket.has_new_reply ? <span className="new-reply">{t("Uusi viesti")}</span> : null}
            {reminders.map(reminder => <span key={reminder.kind} className={`reminder-chip reminder-${reminder.kind}`}>{reminder.text}</span>)}
            {ticket.due_date && !reminders.some(reminder => reminder.kind === "due") && (
              <span className={isOverdue(ticket) ? "new-reply overdue" : "assignee-pill"}>
                {isOverdue(ticket) ? t("Myöhässä") : t("Määräaika")} {formatDay(ticket.due_date)}
              </span>
            )}
          </div>
        </div>

        <div className="recommendation">
          <small>{ticket.ai_suggested ? t("KOTILON EHDOTUS") : t("LUONNOS")}</small>
          {/* Peruste näytetään vain, kun AI-ehdotus on pyydetty ja sille löytyi lähde dokumentaatiosta. */}
          {ticket.ai_suggested && ticket.knowledge_source_title ? <strong>{ticket.ai_reason}</strong> : null}
          <p>{ticket.draft || t("Ei tallennettua luonnosta.")}</p>
          {ticket.ai_suggested && ticket.knowledge_source_title ? (
            <span className="source-pill">{t("Lähde:")}{" "}{ticket.knowledge_source_title}</span>
          ) : null}
        </div>
      </div>

      {ticket.status === "open" && (
        <div className="actions" onClick={e => e.stopPropagation()}>
          {canAssign && <AssignPicker users={users} assigneeId={ticket.assignee_id ?? null} onAssign={onAssign} />}
          <button className="primary" onClick={() => onDecision("human")}>{t("Osoita minulle")}</button>
          <button onClick={() => onDecision("skip")}>{t("Sulje")}</button>
        </div>
      )}
    </article>
  );
}
