import { type FormEvent, useEffect, useState } from "react";
import { DownloadLink, LanguageToggle } from "../components/common";
import { fileToBase64, formatDate, formatDay, formatFileSize, formatTicketNumber } from "../format";
import { api, errorMessage, fetchObjectUrl, logout, type ResidentAccount } from "../session";
import { splitQuotedReply } from "../tickets/ticket-utils";
import type { Announcement } from "./Announcements";
import { BookingCalendar, type QueueEntry, SlotQueueList } from "./Bookings";
import { formatReading, METER_TYPES, type MeterReading, meterLabel, meterUnit, parseReading } from "./Meters";
import { type MoveNotice, moveStatusLabels, moveSummary } from "./Moves";
import { PARKING_TYPES } from "./Parking";
import { PortalForm, type PortalFormKey, PortalHeating } from "./PortalForms";
import { type RenovationNotice, RenovationFields, renovationFieldsError, renovationPayload, renovationPeriod, renovationStatusLabels, renovationValues } from "./Renovations";
import { type WaitlistEntry, waitlistLabel } from "./Waitlists";
import { t } from "../i18n";

type PortalView = "announcements" | "sauna" | "laundry" | "tickets" | "waitlist" | "moves" | "renovations" | "meters" | "heating" | PortalFormKey;

const PORTAL_FORMS: PortalFormKey[] = ["service", "disturbance", "termination", "application"];
const isPortalForm = (view: PortalView): view is PortalFormKey => (PORTAL_FORMS as PortalView[]).includes(view);

const portalViews: { view: PortalView; label: string }[] = [
  { view: "announcements", label: t("Tiedotteet") },
  { view: "sauna", label: t("Saunavuorot") },
  { view: "laundry", label: t("Pyykkitupavuorot") },
  { view: "tickets", label: t("Tehtävät") },
  { view: "waitlist", label: t("Jonot") },
  { view: "service", label: t("Huoltotyötilaus") },
  { view: "disturbance", label: t("Häiriöilmoitus") },
  { view: "meters", label: t("Mittarilukemat") },
  { view: "moves", label: t("Muuttoilmoitus") },
  { view: "renovations", label: t("Remontti-ilmoitus") },
  { view: "heating", label: t("Auton lämmityspaikka") },
  { view: "termination", label: t("Irtisanomisilmoitus") },
  { view: "application", label: t("Yleinen asuntohakemus") }
];

// Työpöydän sivupalkin ryhmät: tiedotteet, vuorovaraukset ja asiointi isännöitsijän kanssa.
const portalNavGroups: { label: string; views: PortalView[] }[] = [
  { label: "", views: ["announcements"] },
  { label: t("Varaukset"), views: ["sauna", "laundry"] },
  { label: t("Asiointi"), views: ["tickets", "waitlist"] },
  { label: t("Lomakkeet"), views: ["service", "disturbance", "meters", "moves", "renovations", "heating", "termination", "application"] }
];

const portalIcons: Record<PortalView, string> = {
  announcements: "M4 5h16v11H8l-4 4zM8 9h8M8 12h5",
  sauna: "M7 21c0-3 2-4 2-7M12 21c0-3 2-4 2-7M17 21c0-3 2-4 2-7M5 3c0 2 2 2 2 4M10 3c0 2 2 2 2 4M15 3c0 2 2 2 2 4",
  laundry: "M5 3h14v18H5zM5 7h14M12 10a4 4 0 1 0 0 8a4 4 0 1 0 0-8M8 5h1",
  tickets: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  waitlist: "M8 7a3 3 0 1 0 0-.01M3 20c0-3 2-5 5-5s5 2 5 5M16 8h5M16 12h5M16 16h3",
  moves: "M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-.01M17 19a2 2 0 1 0 0-.01",
  renovations: "M14 4l6 6-9 9H5v-6zM12 6l6 6",
  meters: "M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z",
  service: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z",
  disturbance: "M11 5L6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12",
  heating: "M5 17h14v-4l-2-5H7l-2 5zM7 17v2M17 17v2M8 13h.01M16 13h.01M12 3v3",
  termination: "M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h4",
  application: "M3 11l9-7 9 7v9H3zM10 20v-5h4v5"
};

// Puhelimen alapalkin näkymät lyhyine nimineen; muut ovat Lisää-valikossa.
const portalTabs: { view: PortalView; label: string; icon: string }[] = [
  { view: "announcements", label: t("Tiedotteet"), icon: portalIcons.announcements },
  { view: "sauna", label: t("Sauna"), icon: portalIcons.sauna },
  { view: "laundry", label: t("Pyykkitupa"), icon: portalIcons.laundry },
  { view: "tickets", label: t("Tehtävät"), icon: portalIcons.tickets }
];

function PortalIcon({ path }: { path: string }) {
  return (
    <svg className="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

// Asukasportaali: asukas näkee vain oman taloyhtiönsä sauna- ja pyykkitupavuorot.
// Tietokoneella näkymät ovat sivupalkissa kuten henkilökunnan puolella. Puhelimella ne vaihdetaan
// alapalkista, ja harvemmin käytetyt ovat Lisää-valikossa.
export function ResidentPortal({ resident }: { resident: ResidentAccount }) {
  const [view, setView] = useState<PortalView>("announcements");
  const [menuOpen, setMenuOpen] = useState(false);
  const title = portalViews.find(item => item.view === view)?.label ?? "";
  const moreActive = !portalTabs.some(tab => tab.view === view);

  function open(next: PortalView) {
    setView(next);
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="portal">
      <header className="portal-header">
        <img src="/pleissi-logo.svg" alt="Pleissi" />
        <span className="portal-header-home">{resident.companyName} · {resident.apartmentNumber}</span>
      </header>

      <aside className="sidebar portal-sidebar">
        <div className="brand">
          <img src="/pleissi-logo.svg" alt="Pleissi" />
        </div>
        <nav aria-label={t("Asukasportaalin valikko")}>
          {portalNavGroups.map(group => (
            <div key={group.label || "main"} className="portal-nav-group">
              {group.label && <span className="portal-nav-label">{group.label}</span>}
              {group.views.map(item => (
                <button
                  key={item}
                  className={view === item ? "active" : ""}
                  onClick={() => open(item)}
                  aria-current={view === item ? "page" : undefined}
                >
                  <PortalIcon path={portalIcons[item]} />
                  {portalViews.find(entry => entry.view === item)?.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="company">
            <small>{resident.companyName} · {resident.apartmentNumber}</small>
            <strong>{resident.name}</strong>
            <div className="portal-footer-links">
              <LanguageToggle className="secondary portal-footer-button" />
              <button className="secondary portal-footer-button" onClick={logout}>{t("Kirjaudu ulos")}</button>
            </div>
          </div>
        </div>
      </aside>

      <main className="portal-main">
        <div className="portal-title">
          <p className="eyebrow">{resident.companyName} · {resident.apartmentNumber}</p>
          <h1>{title}</h1>
        </div>
        {view === "announcements" ? <PortalAnnouncements />
          : view === "tickets" ? <PortalTickets resident={resident} />
          : view === "waitlist" ? <PortalWaitlist />
          : view === "moves" ? <PortalMoves resident={resident} />
          : view === "renovations" ? <PortalRenovations resident={resident} />
          : view === "meters" ? <PortalMeters resident={resident} />
          : view === "heating" ? <PortalHeating resident={resident} />
          : isPortalForm(view) ? <PortalForm key={view} form={view} resident={resident} onOpenTickets={() => open("tickets")} />
          : (
          <BookingCalendar
            key={view}
            portalResident={resident}
            resource={view}
            companyId={resident.companyId}
            companies={[]}
            onCompanyChange={() => undefined}
          />
        )}
      </main>

      <nav className="portal-tabbar" aria-label={t("Asukasportaalin valikko")}>
        {portalTabs.map(tab => (
          <button
            key={tab.view}
            className={view === tab.view && !menuOpen ? "active" : ""}
            onClick={() => open(tab.view)}
            aria-current={view === tab.view ? "page" : undefined}
          >
            <PortalIcon path={tab.icon} />
            <span>{tab.label}</span>
          </button>
        ))}
        <button className={moreActive || menuOpen ? "active" : ""} onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen}>
          <PortalIcon path="M4 6h16M4 12h16M4 18h16" />
          <span>{t("Lisää")}</span>
        </button>
      </nav>

      {menuOpen && (
        <div className="portal-sheet-backdrop" onClick={() => setMenuOpen(false)}>
          <div className="portal-sheet" role="dialog" aria-label={t("Lisää")} onClick={event => event.stopPropagation()}>
            <div className="portal-sheet-user">
              <strong>{resident.name}</strong>
              <span>{resident.companyName} · {resident.apartmentNumber}</span>
            </div>
            {portalViews.filter(item => !portalTabs.some(tab => tab.view === item.view)).map(item => (
              <button key={item.view} className={view === item.view ? "active" : ""} onClick={() => open(item.view)}>
                {item.label}
                <span aria-hidden="true">›</span>
              </button>
            ))}
            <div className="portal-sheet-actions">
              <LanguageToggle className="secondary" />
              <button className="secondary" onClick={logout}>{t("Kirjaudu ulos")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type PortalTicket = {
  id: string;
  ticket_number?: number;
  subject: string;
  type: string;
  status: string;
  created_at: string;
  updated_at?: string;
};

const PORTAL_TICKET_TYPES = ["Vikailmoitus", "Kysymys", "Ilmoitus", "Pyyntö", "Muu"];

// Asukkaan tehtävät: uuden tehtävän luonti isännöitsijälle ja lista omista tehtävistä tiloineen.
// Asukkaan liitevalinta: kuvat ja PDF:t, enintään viisi. Puhelimella "Ota kuva" avaa kameran.
// Isot kuvat pienennetään ennen lähetystä, jotta puhelimen kuvat mahtuvat 10 Mt:n rajaan.
const PORTAL_MAX_FILES = 5;
const PORTAL_MAX_BYTES = 10 * 1024 * 1024;
const RESIZE_OVER_BYTES = 1.5 * 1024 * 1024;
const RESIZE_MAX_SIDE = 2000;

export async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp|heic)$/.test(file.type) || file.size <= RESIZE_OVER_BYTES || typeof createImageBitmap !== "function") {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, RESIZE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    // Selain ei osaa lukea kuvaa (esim. HEIC): lähetetään alkuperäinen.
    return file;
  }
}

function FilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file.type.startsWith("image/") || file.type === "image/heic") return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return (
    <span className="portal-file">
      {url ? <img src={url} alt="" /> : <span className="portal-file-icon" aria-hidden="true">{file.type === "application/pdf" ? "PDF" : "IMG"}</span>}
      <span className="portal-file-name">{file.name}<small>{formatFileSize(file.size)}</small></span>
      <button type="button" onClick={onRemove} aria-label={t("Poista liite {0}", file.name)}>×</button>
    </span>
  );
}

export function PortalFilePicker({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const [busy, setBusy] = useState(false);
  const total = files.reduce((sum, file) => sum + file.size, 0);

  async function add(picked: File[]) {
    setBusy(true);
    try {
      const prepared = await Promise.all(picked.map(shrinkImage));
      onChange([...files, ...prepared].slice(0, PORTAL_MAX_FILES));
    } finally {
      setBusy(false);
    }
  }

  const input = (capture: boolean) => (
    <input
      type="file"
      multiple={!capture}
      accept={capture ? "image/*" : "image/png,image/jpeg,image/gif,image/webp,image/heic,application/pdf"}
      {...(capture ? { capture: "environment" } : {})}
      disabled={busy || files.length >= PORTAL_MAX_FILES}
      onChange={event => {
        const picked = [...(event.target.files ?? [])];
        event.target.value = "";
        void add(picked);
      }}
    />
  );

  return (
    <div className="portal-files">
      <div className="portal-file-buttons">
        <label className="attach-button portal-camera">
          {t("Ota kuva")}
          {input(true)}
        </label>
        <label className="attach-button">
          {t("Liitä kuva tai PDF")}
          {input(false)}
        </label>
        <small>{busy ? t("Valmistellaan kuvaa…") : t("Enintään {0} liitettä, yhteensä 10 Mt.", PORTAL_MAX_FILES)}</small>
      </div>
      {files.length > 0 && (
        <div className="portal-file-list">
          {files.map((file, index) => (
            <FilePreview key={`${file.name}-${index}`} file={file} onRemove={() => onChange(files.filter((_, position) => position !== index))} />
          ))}
        </div>
      )}
      {total > PORTAL_MAX_BYTES && <p className="send-error">{t("Liitteiden yhteiskoko on liian suuri. Poista jokin liite.")}</p>}
    </div>
  );
}

// Portaalin liitteen pikkukuva: kuva haetaan kirjautumisotsakkeella, ja klikkaus lataa tiedoston.
function PortalAttachmentThumb({ attachment }: { attachment: PortalThread["attachments"][number] }) {
  const [url, setUrl] = useState("");
  const isImage = /^image\/(png|jpeg|gif|webp)$/.test(attachment.mime_type ?? "");
  useEffect(() => {
    if (!isImage) return;
    let objectUrl = "";
    let current = true;
    fetchObjectUrl(`/portal/attachments/${encodeURIComponent(attachment.id)}`)
      .then(found => {
        objectUrl = found;
        if (current) setUrl(found);
        else URL.revokeObjectURL(found);
      })
      .catch(() => undefined);
    return () => {
      current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, isImage]);
  if (!url) return null;
  return (
    <a className="portal-thumb" href={url} target="_blank" rel="noreferrer" title={attachment.filename}>
      <img src={url} alt={attachment.filename} />
    </a>
  );
}

export async function portalAttachments(files: File[]) {
  return Promise.all(files.map(async file => ({ filename: file.name, mimeType: file.type, data: await fileToBase64(file) })));
}

type PortalThread = {
  ticket: PortalTicket;
  messages: { id: string; direction: string; body: string; created_at: string }[];
  attachments: { id: string; filename: string; size: number; created_at: string; direction: string; mime_type?: string }[];
};

// Asukkaan näkymä yhteen tehtävään: viestiketju isännöitsijän kanssa, liitteet ja uusi viesti.
function PortalTicketThread({ ticketId, onBack }: { ticketId: string; onBack: () => void }) {
  const [thread, setThread] = useState<PortalThread | null>(null);
  const [failed, setFailed] = useState(false);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function loadThread() {
    try {
      setThread(await api<PortalThread>(`/portal/tickets/${encodeURIComponent(ticketId)}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    void loadThread();
  }, [ticketId]);

  async function send(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError("");
    try {
      await api(`/portal/tickets/${encodeURIComponent(ticketId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: body.trim(), attachments: await portalAttachments(files) })
      });
      setBody("");
      setFiles([]);
      await loadThread();
    } catch (sendError) {
      setError(errorMessage(sendError, t("Viestin lähetys epäonnistui. Yritä uudelleen.")));
    } finally {
      setSending(false);
    }
  }

  if (failed) return <p className="send-error">{t("Tehtävän lataus epäonnistui.")}</p>;
  if (!thread) return <div className="empty">{t("Ladataan…")}</div>;
  const closed = thread.ticket.status === "closed";

  return (
    <div className="portal-thread">
      <button className="back-link" onClick={onBack}>{t("← Kaikki tehtävät")}</button>
      <div className="portal-thread-head">
        <h2>{thread.ticket.subject}</h2>
        <p className="muted">
          #{formatTicketNumber(thread.ticket.ticket_number)} · {t(thread.ticket.type)} · {closed ? t("Suljettu") : t("Käsittelyssä")}{" "}{t("· luotu")}{" "}{formatDate(thread.ticket.created_at)}
        </p>
      </div>

      <div className="portal-messages">
        {thread.messages.map(message => (
          <div key={message.id} className={`portal-message ${message.direction === "inbound" ? "mine" : "theirs"}`}>
            <small>{message.direction === "inbound" ? t("Sinä") : t("Isännöitsijä")} · {formatDate(message.created_at)}</small>
            <p>{message.direction === "inbound" ? splitQuotedReply(message.body).text : message.body}</p>
          </div>
        ))}
        {thread.messages.length === 0 && <p className="muted">{t("Ei viestejä.")}</p>}
      </div>

      {thread.attachments.length > 0 && (
        <div className="portal-thread-files">
          <strong>{t("Liitteet")}</strong>
          <div className="portal-thumbs">
            {thread.attachments.map(attachment => <PortalAttachmentThumb key={attachment.id} attachment={attachment} />)}
          </div>
          {thread.attachments.map(attachment => (
            <DownloadLink key={attachment.id} path={`/portal/attachments/${attachment.id}`} filename={attachment.filename}>
              {attachment.filename} <small>{attachment.direction === "portal" ? t("sinulta") : t("isännöitsijältä")} · {formatFileSize(attachment.size)}</small>
            </DownloadLink>
          ))}
        </div>
      )}

      <form className="ticket-form portal-ticket-form" onSubmit={send}>
        <label>
          <span>{closed ? t("Uusi viesti (avaa tehtävän uudelleen)") : t("Uusi viesti isännöitsijälle")}</span>
          <textarea value={body} onChange={event => setBody(event.target.value)} rows={4} maxLength={5000} required />
        </label>
        <PortalFilePicker files={files} onChange={setFiles} />
        {error && <p className="send-error">{error}</p>}
        <div className="portal-ticket-actions">
          <button type="submit" className="portal-new" disabled={sending || !body.trim()}>{sending ? t("Lähetetään…") : t("Lähetä viesti")}</button>
        </div>
      </form>
    </div>
  );
}

function PortalTickets({ resident }: { resident: ResidentAccount }) {
  const [tickets, setTickets] = useState<PortalTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState(PORTAL_TICKET_TYPES[0]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [sent, setSent] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  // Avattu tehtävä näyttää viestiketjun listan tilalla.
  const [openId, setOpenId] = useState<string | null>(null);

  async function loadTickets() {
    try {
      setTickets(await api<PortalTicket[]>("/portal/tickets"));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTickets();
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (subject.trim().length < 3 || description.trim().length < 5) {
      setFormError(t("Kirjoita otsikko ja kuvaus."));
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const created = await api<{ attachmentError?: string | null }>("/portal/tickets", {
        method: "POST",
        body: JSON.stringify({ subject: subject.trim(), description: description.trim(), type, attachments: await portalAttachments(files) })
      });
      if (created.attachmentError) setFormError(t("Tehtävä lähetettiin, mutta liitteitä ei tallennettu: {0}", created.attachmentError));
      setFiles([]);
      setSubject("");
      setDescription("");
      setType(PORTAL_TICKET_TYPES[0]);
      setCreating(false);
      setSent(true);
      await loadTickets();
    } catch {
      setFormError(t("Tehtävän lähetys epäonnistui. Yritä uudelleen."));
    } finally {
      setSaving(false);
    }
  }

  if (openId) {
    return <PortalTicketThread ticketId={openId} onBack={() => { setOpenId(null); void loadTickets(); }} />;
  }

  return (
    <>
      <div className="portal-tickets-head">
        <p className="muted">
          {t("Vikailmoitukset, kysymykset ja pyynnöt isännöitsijälle. Kiireellisessä hätätilanteessa soita huoltoyhtiön päivystykseen.")}
        </p>
        {!creating && (
          <button className="portal-new" onClick={() => { setCreating(true); setSent(false); }}>{t("Luo tehtävä")}</button>
        )}
      </div>

      {sent && !creating && <p className="portal-sent">{t("Tehtävä on lähetetty isännöitsijälle.")}</p>}
      {formError && !creating && <p className="send-error">{formError}</p>}

      {creating && (
        <form className="ticket-form portal-ticket-form" onSubmit={handleSubmit}>
          <dl className="ticket-facts">
            <div>
              <dt>{t("Ilmoittaja")}</dt>
              <dd>{resident.name}</dd>
            </div>
            <div>
              <dt>{t("Asunto")}</dt>
              <dd>{resident.apartmentNumber || "–"}</dd>
            </div>
          </dl>

          <label>
            <span>{t("Tyyppi")}</span>
            <select value={type} onChange={event => setType(event.target.value)}>
              {PORTAL_TICKET_TYPES.map(option => <option key={option} value={option}>{t(option)}</option>)}
            </select>
          </label>

          <label>
            <span>{t("Otsikko")}</span>
            <input
              value={subject}
              onChange={event => setSubject(event.target.value)}
              maxLength={150}
              placeholder={t("Esim. Keittiön hana vuotaa")}
              required
              autoFocus
            />
          </label>

          <label>
            <span>{t("Kuvaus")}</span>
            <textarea
              value={description}
              onChange={event => setDescription(event.target.value)}
              maxLength={5000}
              rows={6}
              placeholder={t("Kerro, mitä on tapahtunut ja missä.")}
              required
            />
          </label>

          <PortalFilePicker files={files} onChange={setFiles} />

          {formError && <p className="send-error">{formError}</p>}

          <div className="portal-ticket-actions">
            <button type="button" className="secondary" onClick={() => setCreating(false)} disabled={saving}>{t("Peruuta")}</button>
            <button type="submit" className="portal-new" disabled={saving}>{saving ? t("Lähetetään…") : t("Lähetä tehtävä")}</button>
          </div>
        </form>
      )}

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <p className="send-error">{t("Tehtävien lataus epäonnistui.")}</p>
        : tickets.length === 0 ? <div className="empty">{t("Et ole vielä luonut tehtäviä.")}</div>
        : (
          <div className="table-card portal-cards">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("Numero")}</th>
                  <th>{t("Otsikko")}</th>
                  <th>{t("Tyyppi")}</th>
                  <th>{t("Tila")}</th>
                  <th>{t("Luotu")}</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map(ticket => (
                  <tr
                    key={ticket.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title={t("Avaa viestiketju")}
                    onClick={() => setOpenId(ticket.id)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenId(ticket.id);
                      }
                    }}
                  >
                    <td data-label={t("Numero")}>#{formatTicketNumber(ticket.ticket_number)}</td>
                    <td data-label={t("Otsikko")}><strong>{ticket.subject}</strong></td>
                    <td data-label={t("Tyyppi")}>{t(ticket.type)}</td>
                    <td data-label={t("Tila")}>{ticket.status === "closed" ? t("Suljettu") : ticket.status === "answered" ? t("Vastattu") : t("Käsittelyssä")}</td>
                    <td data-label={t("Luotu")}>{formatDate(ticket.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </>
  );
}

// Asukkaan näkymä taloyhtiön tiedotteisiin.
function PortalAnnouncements() {
  const [items, setItems] = useState<Pick<Announcement, "id" | "title" | "body" | "stairwell" | "created_at">[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<typeof items>("/portal/announcements")
      .then(setItems)
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="empty">{t("Ladataan…")}</div>;
  if (failed) return <p className="send-error">{t("Tiedotteiden lataus epäonnistui.")}</p>;
  if (items.length === 0) return <div className="empty">{t("Ei tiedotteita.")}</div>;
  return (
    <div className="portal-announcements">
      {items.map(item => (
        <article key={item.id}>
          <small>{formatDate(item.created_at)}{item.stairwell ? t(" · Rappu {0}", item.stairwell) : ""}</small>
          <h2>{item.title}</h2>
          <p>{item.body}</p>
        </article>
      ))}
    </div>
  );
}

// Asukkaan jonot: ilmoittautuminen autopaikka- ja saunavuorojonoon sekä oma sija.
// Asukkaan jonot: sauna- ja pyykkitupavuorojen jonopaikat (liittyminen kalenterista) sekä
// autopaikka- ja saunavuorojonot, joihin ilmoittaudutaan tältä sivulta.
function PortalWaitlist() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [slotEntries, setSlotEntries] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [parkingType, setParkingType] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({ parking: "", sauna: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function loadEntries() {
    try {
      const [waitlist, slots] = await Promise.all([
        api<WaitlistEntry[]>("/portal/waitlist"),
        api<QueueEntry[]>("/portal/booking-queue")
      ]);
      setEntries(waitlist);
      setSlotEntries(slots);
    } catch {
      setError(t("Jonotietojen lataus epäonnistui."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadEntries();
  }, []);

  async function join(resource: "parking" | "sauna") {
    setSaving(true);
    setError("");
    try {
      await api("/portal/waitlist", {
        method: "POST",
        body: JSON.stringify({ resource, parkingType: resource === "parking" ? parkingType : "", note: notes[resource].trim() })
      });
      setNotes(current => ({ ...current, [resource]: "" }));
      await loadEntries();
    } catch (joinError) {
      setError(errorMessage(joinError, t("Jonoon ilmoittautuminen epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function leaveSlot(entryId: string) {
    setSaving(true);
    setError("");
    try {
      await api(`/portal/booking-queue/${encodeURIComponent(entryId)}`, { method: "DELETE" });
      await loadEntries();
    } catch {
      setError(t("Jonosta poistuminen epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  async function leave(entry: WaitlistEntry) {
    setSaving(true);
    setError("");
    try {
      await api(`/portal/waitlist/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      await loadEntries();
    } catch {
      setError(t("Jonosta poistuminen epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty">{t("Ladataan…")}</div>;

  const slotQueue = (
    slotEntries.length > 0 ? (
      <SlotQueueList entries={slotEntries} showResource disabled={saving} onLeave={entryId => void leaveSlot(entryId)} />
    ) : (
      <article>
        <h2>{t("Omat jonopaikat")}</h2>
        <p className="muted">{t("Et ole minkään sauna- tai pyykkitupavuoron jonossa. Jonoon liitytään kalenterista varatun vuoron päältä.")}</p>
      </article>
    )
  );

  const queues: { resource: "parking" | "sauna"; title: string; hint: string }[] = [
    { resource: "parking", title: t("Autopaikkajono"), hint: t("Vapautuva autopaikka tarjotaan jonossa ensimmäisenä olevalle.") },
    { resource: "sauna", title: t("Saunan vakiovuorojono"), hint: t("Vapautuva vakiovuoro tarjotaan jonossa ensimmäisenä olevalle.") }
  ];

  return (
    <div className="portal-queues">
      {slotQueue}
      {queues.map(queue => {
        const entry = entries.find(item => item.resource === queue.resource);
        return (
          <article key={queue.resource}>
            <h2>{queue.title}</h2>
            <p className="muted">{queue.hint}</p>
            {entry ? (
              <>
                <p className="portal-queue-position">
                  {t("Olet jonossa sijalla")}{" "}<strong>{entry.position}</strong>
                  {entry.status === "offered" && t(" · isännöitsijä on tarjonnut sinulle paikkaa")}
                </p>
                <p className="muted">
                  {waitlistLabel(entry)}{" "}{t("· ilmoittauduttu")}{" "}{formatDate(entry.created_at)}{entry.note ? ` · ${entry.note}` : ""}
                </p>
                <button className="secondary" onClick={() => void leave(entry)} disabled={saving}>{t("Poistu jonosta")}</button>
              </>
            ) : (
              <div className="ticket-form">
                {queue.resource === "parking" && (
                  <label>
                    <span>{t("Toivottu paikkatyyppi")}</span>
                    <select value={parkingType} onChange={event => setParkingType(event.target.value)}>
                      <option value="">{t("Mikä tahansa")}</option>
                      {PARKING_TYPES.map(type => <option key={type} value={type}>{t(type)}</option>)}
                    </select>
                  </label>
                )}
                <label>
                  <span>{t("Toive (valinnainen)")}</span>
                  <input
                    value={notes[queue.resource]}
                    onChange={event => setNotes(current => ({ ...current, [queue.resource]: event.target.value }))}
                    maxLength={300}
                    placeholder={queue.resource === "parking" ? t("Esim. sähköauton latausmahdollisuus") : t("Esim. perjantai-ilta")}
                  />
                </label>
                <div className="portal-ticket-actions">
                  <button className="portal-new" onClick={() => void join(queue.resource)} disabled={saving}>{t("Ilmoittaudu jonoon")}</button>
                </div>
              </div>
            )}
          </article>
        );
      })}
      {error && <p className="send-error">{error}</p>}
    </div>
  );
}

// Asukkaan muuttoilmoitus: muuttopäivä, poismuutto, uudet asukkaat ja oveen tuleva nimi.
function PortalMoves({ resident }: { resident: ResidentAccount }) {
  const [notices, setNotices] = useState<MoveNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [moveDate, setMoveDate] = useState("");
  const [movesOut, setMovesOut] = useState(false);
  const [people, setPeople] = useState<{ name: string; email: string }[]>([]);
  const [doorName, setDoorName] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function loadNotices() {
    try {
      setNotices(await api<MoveNotice[]>("/portal/moves"));
    } catch {
      setError(t("Muuttoilmoitusten lataus epäonnistui."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadNotices();
  }, []);

  const pending = notices.some(notice => notice.status === "pending");
  const filledPeople = people.filter(person => person.name.trim());

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!movesOut && filledPeople.length === 0 && !doorName.trim()) {
      setError(t("Ilmoita poismuutto, uudet asukkaat tai oveen tuleva nimi."));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api("/portal/moves", {
        method: "POST",
        body: JSON.stringify({
          moveDate,
          movesOut,
          newResidents: filledPeople.map(person => ({ name: person.name.trim(), email: person.email.trim() })),
          doorName: doorName.trim(),
          note: note.trim()
        })
      });
      setMoveDate("");
      setMovesOut(false);
      setPeople([]);
      setDoorName("");
      setNote("");
      setSent(true);
      await loadNotices();
    } catch (submitError) {
      setError(errorMessage(submitError, t("Muuttoilmoituksen lähetys epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty">{t("Ladataan…")}</div>;

  return (
    <>
      {sent && <p className="portal-sent">{t("Muuttoilmoitus on lähetetty isännöitsijälle.")}</p>}

      {pending ? (
        <p className="muted">{t("Sinulla on käsittelyä odottava muuttoilmoitus. Uuden voi tehdä, kun se on käsitelty.")}</p>
      ) : (
        <form className="ticket-form portal-ticket-form" onSubmit={handleSubmit}>
          <dl className="ticket-facts">
            <div>
              <dt>{t("Ilmoittaja")}</dt>
              <dd>{resident.name}</dd>
            </div>
            <div>
              <dt>{t("Asunto")}</dt>
              <dd>{resident.apartmentNumber || "–"}</dd>
            </div>
          </dl>

          <label>
            <span>{t("Muuttopäivä")}</span>
            <input type="date" value={moveDate} onChange={event => setMoveDate(event.target.value)} required />
          </label>

          <label className="switch-row">
            <span>
              <strong>{t("Asunnon nykyiset asukkaat muuttavat pois")}</strong>
              <small>{t("Autopaikka ja varatut vuorot päättyvät muuttopäivänä.")}</small>
            </span>
            <input type="checkbox" role="switch" checked={movesOut} onChange={() => setMovesOut(!movesOut)} />
            <i aria-hidden="true" />
          </label>

          <fieldset className="move-new-residents">
            <legend>{t("Asuntoon muuttavat uudet asukkaat")}</legend>
            {people.map((person, index) => (
              <div className="move-person" key={index}>
                <input
                  value={person.name}
                  onChange={event => setPeople(current => current.map((item, position) => position === index ? { ...item, name: event.target.value } : item))}
                  placeholder={t("Nimi")}
                  maxLength={100}
                  aria-label={t("Uuden asukkaan {0} nimi", index + 1)}
                />
                <input
                  type="email"
                  value={person.email}
                  onChange={event => setPeople(current => current.map((item, position) => position === index ? { ...item, email: event.target.value } : item))}
                  placeholder={t("Sähköposti (valinnainen)")}
                  aria-label={t("Uuden asukkaan {0} sähköposti", index + 1)}
                />
                <button type="button" onClick={() => setPeople(current => current.filter((_, position) => position !== index))} aria-label={t("Poista asukas")}>×</button>
              </div>
            ))}
            {people.length < 8 && (
              <button type="button" className="secondary" onClick={() => setPeople(current => [...current, { name: "", email: "" }])}>
                {t("Lisää asukas")}
              </button>
            )}
          </fieldset>

          <label>
            <span>{t("Nimi oveen (valinnainen)")}</span>
            <input value={doorName} onChange={event => setDoorName(event.target.value)} maxLength={60} placeholder={t("Esim. Virtanen")} />
          </label>

          <label>
            <span>{t("Lisätiedot (valinnainen)")}</span>
            <textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={1000} />
          </label>

          {error && <p className="send-error">{error}</p>}

          <div className="portal-ticket-actions">
            <button type="submit" className="portal-new" disabled={saving || !moveDate}>{saving ? t("Lähetetään…") : t("Lähetä muuttoilmoitus")}</button>
          </div>
        </form>
      )}

      {notices.length > 0 && (
        <div className="table-card portal-cards">
          <table className="data-table report-topics">
            <thead>
              <tr>
                <th>{t("Muuttopäivä")}</th>
                <th>{t("Sisältö")}</th>
                <th>{t("Tila")}</th>
                <th>{t("Ilmoitettu")}</th>
              </tr>
            </thead>
            <tbody>
              {notices.map(notice => (
                <tr key={notice.id}>
                  <td data-label={t("Muuttopäivä")}><strong>{formatDay(notice.move_date)}</strong></td>
                  <td data-label={t("Sisältö")}>{moveSummary(notice) || "–"}</td>
                  <td data-label={t("Tila")}>{moveStatusLabels[notice.status]}</td>
                  <td data-label={t("Ilmoitettu")}>{formatDate(notice.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// Asukkaan remontti-ilmoitus (muutostyöilmoitus). Kaikki kentät ovat valinnaisia; liitteiksi käyvät
// suunnitelmat, piirustukset, urakoitsijan todistukset ja valokuvat. Isännöitsijä hyväksyy ilmoituksen
// ennen työn aloittamista ja voi asettaa sille ehtoja.
function PortalRenovations({ resident }: { resident: ResidentAccount }) {
  const [notices, setNotices] = useState<RenovationNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [values, setValues] = useState(() => renovationValues());
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function loadNotices() {
    try {
      setNotices(await api<RenovationNotice[]>("/portal/renovations"));
    } catch {
      setError(t("Remontti-ilmoitusten lataus epäonnistui."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadNotices();
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const invalid = renovationFieldsError(values);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const created = await api<{ attachmentError?: string | null }>("/portal/renovations", {
        method: "POST",
        body: JSON.stringify({ ...renovationPayload(values), attachments: await portalAttachments(files) })
      });
      setValues(renovationValues());
      setFiles([]);
      setCreating(false);
      setSent(true);
      if (created.attachmentError) setError(t("Ilmoitus lähetettiin, mutta liitteitä ei tallennettu: {0}", created.attachmentError));
      await loadNotices();
    } catch (submitError) {
      setError(errorMessage(submitError, t("Remontti-ilmoituksen lähetys epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty">{t("Ladataan…")}</div>;

  return (
    <>
      <div className="portal-tickets-head">
        <p className="muted">
          {t("Ilmoita remontista ennen työn aloittamista. Työn saa aloittaa vasta, kun isännöitsijä on hyväksynyt ilmoituksen.")}
        </p>
        {!creating && (
          <button className="portal-new" onClick={() => { setCreating(true); setSent(false); setError(""); }}>{t("Tee remontti-ilmoitus")}</button>
        )}
      </div>

      {sent && !creating && <p className="portal-sent">{t("Remontti-ilmoitus on lähetetty isännöitsijälle.")}</p>}
      {error && !creating && <p className="send-error">{error}</p>}

      {creating && (
        <form className="ticket-form portal-ticket-form" onSubmit={handleSubmit}>
          <dl className="ticket-facts">
            <div>
              <dt>{t("Ilmoittaja")}</dt>
              <dd>{resident.name}</dd>
            </div>
            <div>
              <dt>{t("Asunto")}</dt>
              <dd>{resident.apartmentNumber || "–"}</dd>
            </div>
          </dl>

          <RenovationFields values={values} onChange={setValues} />

          <p className="muted">{t("Liitä halutessasi suunnitelmat, piirustukset, urakoitsijan todistukset tai valokuvat.")}</p>
          <PortalFilePicker files={files} onChange={setFiles} />

          {error && <p className="send-error">{error}</p>}

          <div className="portal-ticket-actions">
            <button type="button" className="secondary" onClick={() => setCreating(false)} disabled={saving}>{t("Peruuta")}</button>
            <button type="submit" className="portal-new" disabled={saving || files.reduce((sum, file) => sum + file.size, 0) > PORTAL_MAX_BYTES}>{saving ? t("Lähetetään…") : t("Lähetä remontti-ilmoitus")}</button>
          </div>
        </form>
      )}

      {notices.length === 0 ? <div className="empty">{t("Et ole vielä tehnyt remontti-ilmoituksia.")}</div> : (
        <div className="table-card portal-cards">
          <table className="data-table report-topics">
            <thead>
              <tr>
                <th>{t("Työ")}</th>
                <th>{t("Ajankohta")}</th>
                <th>{t("Tila")}</th>
                <th>{t("Ilmoitettu")}</th>
              </tr>
            </thead>
            <tbody>
              {notices.map(notice => (
                <tr key={notice.id}>
                  <td data-label={t("Työ")}>
                    <strong>{notice.work_type ? t(notice.work_type) : t("Remontti")}</strong>
                    {notice.description && <span>{notice.description}</span>}
                  </td>
                  <td data-label={t("Ajankohta")}>{renovationPeriod(notice) || "–"}</td>
                  <td data-label={t("Tila")}>
                    <strong>{renovationStatusLabels[notice.status] ?? notice.status}</strong>
                    {notice.decision_note && <span>{notice.decision_note}</span>}
                  </td>
                  <td data-label={t("Ilmoitettu")}>{formatDate(notice.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// Asukkaan kulutuslukemat: uuden lukeman ilmoitus ja aiemmin ilmoitetut lukemat.
function PortalMeters({ resident }: { resident: ResidentAccount }) {
  const [readings, setReadings] = useState<MeterReading[]>([]);
  const [loading, setLoading] = useState(true);
  const [meterType, setMeterType] = useState<string>(METER_TYPES[0]);
  const [valueText, setValueText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function loadReadings() {
    try {
      setReadings(await api<MeterReading[]>("/portal/meter-readings"));
    } catch {
      setError(t("Lukemien lataus epäonnistui."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadReadings();
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const value = parseReading(valueText);
    if (value === null) {
      setError(t("Anna lukema numerona, esim. 123,45."));
      return;
    }
    setSaving(true);
    setError("");
    setSent(false);
    try {
      await api("/portal/meter-readings", { method: "POST", body: JSON.stringify({ meterType, value }) });
      setValueText("");
      setSent(true);
      await loadReadings();
    } catch (submitError) {
      setError(errorMessage(submitError, t("Lukeman lähetys epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty">{t("Ladataan…")}</div>;

  return (
    <>
      <form className="ticket-form portal-ticket-form" onSubmit={handleSubmit}>
        <dl className="ticket-facts">
          <div>
            <dt>{t("Ilmoittaja")}</dt>
            <dd>{resident.name}</dd>
          </div>
          <div>
            <dt>{t("Asunto")}</dt>
            <dd>{resident.apartmentNumber || "–"}</dd>
          </div>
        </dl>

        <label>
          <span>{t("Mittari")}</span>
          <select value={meterType} onChange={event => setMeterType(event.target.value)}>
            {METER_TYPES.map(option => <option key={option} value={option}>{meterLabel(option)}</option>)}
          </select>
        </label>

        <label>
          <span>{t("Mittarin lukema tänään (")}{meterUnit(meterType)})</span>
          <input value={valueText} onChange={event => setValueText(event.target.value)} inputMode="decimal" placeholder={t("Esim. 123,45")} required />
        </label>

        {sent && <p className="portal-sent">{t("Lukema on tallennettu.")}</p>}
        {error && <p className="send-error">{error}</p>}

        <div className="portal-ticket-actions">
          <button type="submit" className="portal-new" disabled={saving || !valueText.trim()}>{saving ? t("Lähetetään…") : t("Lähetä lukema")}</button>
        </div>
      </form>

      {readings.length > 0 && (
        <div className="table-card portal-cards">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("Lukupäivä")}</th>
                <th>{t("Mittari")}</th>
                <th>{t("Lukema")}</th>
              </tr>
            </thead>
            <tbody>
              {readings.map(reading => (
                <tr key={reading.id}>
                  <td data-label={t("Lukupäivä")}><strong>{formatDay(reading.reading_date)}</strong></td>
                  <td data-label={t("Mittari")}>{meterLabel(reading.meter_type)}</td>
                  <td data-label={t("Lukema")}>{formatReading(reading.value, reading.meter_type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
