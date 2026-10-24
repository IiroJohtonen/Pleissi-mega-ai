import { type FormEvent, useEffect, useRef, useState } from "react";
import { DownloadLink, Dropdown, FactDropdown } from "../components/common";
import { placeLabel, topicLabel, topicOptions } from "../topics";
import { IncidentDrawer } from "../views/Incidents";
import {
  actionLabel, actorLabel, channelLabel, fileToBase64, formatDate, formatDateOnly, formatFileSize, formatTicketNumber,
  MAX_REPLY_ATTACHMENT_BYTES, MAX_REPLY_ATTACHMENTS, manualTicketStatuses, priorityLabel, statusLabel, ticketPriorities, ticketTypeOptions
} from "../format";
import { actorName, api, errorMessage, fetchObjectUrl, isAdmin, isManager, MANAGEMENT_OFFICE, type OfficeUser, session } from "../session";
import type { Company, ReplyAccount, Resident, TicketDetail } from "../types";
import { assignableUsers, canAssignTickets, isOverdue, splitQuotedReply } from "./ticket-utils";
import { AssignPicker, AttachmentsMenu } from "./TicketCard";
import { AiSuggestModal, CreateResidentModal } from "./TicketModals";
import { TicketWorkOrders } from "./TicketWorkOrders";
import { UnidentifiedCompanyPanel } from "./TicketCompany";
import { RenovationPanel } from "../views/Renovations";
import { Toast } from "../components/Toast";
import { t } from "../i18n";
import { OpenResidentButton } from "../components/Reporter";

type Attachment = TicketDetail["attachments"][number];

const PREVIEW_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

function isPreviewImage(attachment: Attachment) {
  return PREVIEW_IMAGE_TYPES.includes(attachment.mime_type.toLowerCase());
}

// Kuvan pikkukuva aikajanalla. Kuva haetaan kirjautumistunnisteen kanssa, joten se ladataan
// selaimen muistiin eikä suoraan osoitteesta.
function AttachmentThumbnail({ attachment, onOpen }: { attachment: Attachment; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl = "";
    let cancelled = false;
    fetchObjectUrl(`/attachments/${encodeURIComponent(attachment.id)}?inline=1`)
      .then(result => {
        objectUrl = result;
        if (cancelled) URL.revokeObjectURL(result);
        else setUrl(result);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id]);

  if (failed) return <AttachmentFile attachment={attachment} />;
  return (
    <button
      className="message-thumbnail"
      onClick={() => url && onOpen(url)}
      title={t("Näytä kuva {0}", attachment.filename)}
      aria-label={t("Näytä kuva {0}", attachment.filename)}
    >
      {url ? <img src={url} alt={attachment.filename} /> : <span className="message-thumbnail-loading" aria-hidden="true" />}
    </button>
  );
}

function AttachmentFile({ attachment }: { attachment: Attachment }) {
  return (
    <DownloadLink className="message-file" path={`/attachments/${attachment.id}`} filename={attachment.filename} title={t("Lataa liite")}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
      <span>{attachment.filename}</span>
      <small>{formatFileSize(attachment.size)}</small>
    </DownloadLink>
  );
}

// Viestin liitteet aikajanalla: kuvat pikkukuvina, muut tiedostot nimellä. Kuvan saa avattua isompana.
function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const [preview, setPreview] = useState<{ url: string; attachment: Attachment } | null>(null);

  useEffect(() => {
    if (!preview) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setPreview(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [preview]);

  if (attachments.length === 0) return null;
  const images = attachments.filter(isPreviewImage);
  const files = attachments.filter(attachment => !isPreviewImage(attachment));
  return (
    <div className="message-attachments">
      {images.length > 0 && (
        <div className="message-thumbnails">
          {images.map(attachment => (
            <AttachmentThumbnail key={attachment.id} attachment={attachment} onOpen={url => setPreview({ url, attachment })} />
          ))}
        </div>
      )}
      {files.map(attachment => <AttachmentFile key={attachment.id} attachment={attachment} />)}
      {preview && (
        <div className="image-preview" role="dialog" aria-modal="true" aria-label={preview.attachment.filename} onClick={() => setPreview(null)}>
          <figure onClick={event => event.stopPropagation()}>
            <img src={preview.url} alt={preview.attachment.filename} />
            <figcaption>
              <span>{preview.attachment.filename}</span>
              <DownloadLink path={`/attachments/${preview.attachment.id}`} filename={preview.attachment.filename}>{t("Lataa")}</DownloadLink>
              <button onClick={() => setPreview(null)}>{t("Sulje")}</button>
            </figcaption>
          </figure>
        </div>
      )}
    </div>
  );
}

// Aikajanan viesti; väkäsestä viestin saa tiivistettyä yhdelle riville.
function TimelineMessage({
  message,
  attachments = [],
  replying = false,
  onReply
}: {
  message: TicketDetail["messages"][number];
  attachments?: Attachment[];
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
      <MessageAttachments attachments={attachments} />
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
  company,
  companies = []
}: {
  detail: TicketDetail;
  // Tehtävän taloyhtiö: määrää, kenelle tehtävän voi antaa ja kuka saa antaa.
  company?: Company;
  // Taloyhtiöt, joihin tehtävän voi siirtää.
  companies?: Company[];
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
  // Vastaukseen valitut tehtävän omat liitteet ja taloyhtiön dokumentaation tiedostot (tunnisteet).
  const [replyTicketFiles, setReplyTicketFiles] = useState<string[]>([]);
  const [replyDocs, setReplyDocs] = useState<string[]>([]);
  // Taloyhtiön dokumentit, joissa on tiedosto; henkilökunnan sisäisiä dokumentteja ei lähetetä asukkaalle.
  const [companyDocs, setCompanyDocs] = useState<{ id: string; title: string; file_name: string }[]>([]);
  const replyFilesSize = replyFiles.reduce((total, file) => total + file.size, 0)
    + detail.attachments.filter(attachment => replyTicketFiles.includes(attachment.id)).reduce((total, attachment) => total + attachment.size, 0);
  const replyFilesTooLarge = replyFilesSize > MAX_REPLY_ATTACHMENT_BYTES;
  const replyFileCount = replyFiles.length + replyTicketFiles.length + replyDocs.length;

  useEffect(() => {
    setReplyFiles([]);
    setReplyTicketFiles([]);
    setReplyDocs([]);
  }, [ticket.id]);

  useEffect(() => {
    // Tunnistamattoman tehtävän taloyhtiö ei ole vielä varma, joten dokumentteja ei tarjota.
    if (!ticket.company_id || ticket.company_pending) {
      setCompanyDocs([]);
      return;
    }
    api<{ id: string; title: string; kind: string; file_name: string | null; audience?: string }[]>(`/companies/${encodeURIComponent(ticket.company_id)}/knowledge`)
      .then(rows => setCompanyDocs(rows
        .filter(row => row.kind === "document" && row.file_name && row.audience !== "internal")
        .map(row => ({ id: row.id, title: row.title, file_name: row.file_name ?? "" }))))
      .catch(() => setCompanyDocs([]));
  }, [ticket.company_id, ticket.company_pending]);

  // Kuvaus on tehtävän alkuperäinen viesti; käsin luodulla tehtävällä sen tiivistelmä.
  const firstInbound = detail.messages.find(m => m.direction === "inbound");
  const description = (firstInbound ? splitQuotedReply(firstInbound.body).text.trim() : "")
    || ticket.summary
    || t("Ei kuvausta.");
  const lastInbound = [...detail.messages].reverse().find(m => m.direction === "inbound");
  // Sama järjestys kuin palvelimella: ensin alkuperäinen lähettäjä, muuten linkitetyt asukkaat.
  // Aikajanalta valittu viesti, johon vastataan; ilman valintaa vastataan viimeisimpään saapuneeseen.
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  // Valittu lähettäjätili; oletuksena tili, johon tehtävän viesti saapui.
  const [fromChoice, setFromChoice] = useState("");
  // Kopion saajat ja allekirjoituksen lisääminen vastaukseen.
  const [cc, setCc] = useState("");
  const [useSignature, setUseSignature] = useState(true);
  const fromAccountId = detail.replyAccounts.some(account => account.id === fromChoice)
    ? fromChoice
    : detail.replyAccounts[0]?.id ?? "";
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
  // Vastata voi kaikkiin keskeneräisiin tehtäviin; suljettu tehtävä avataan ensin uudelleen.
  const canReply = ticket.status !== "closed";

  useEffect(() => {
    setDraft(ticket.draft || "");
    setSaved(false);
  }, [ticket.id, ticket.draft]);

  // Viimeisin tässä istunnossa pyydetty AI-ehdotus; muuten näytetään tehtävälle tallennettu peruste ja lähde.
  const [suggestion, setSuggestion] = useState<{
    reason: string;
    source: { id: string; title: string; chunkId?: string | null; page?: number | string | null } | null;
    usedAi: boolean;
  } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState("");

  useEffect(() => {
    setSuggestion(null);
    setSuggestError("");
  }, [ticket.id]);

  // AI-ehdotuksen voi pyytää uudelleen; aiempi pyyntö näkyy lokissa. Kun asukkaalle on jo vastattu,
  // uusi ehdotus on jatkovastaus, jossa AI ottaa huomioon koko sähköpostiketjun.
  const suggestedBefore = Boolean(suggestion) || detail.audit.some(a => a.action === "ai_suggested");
  // Dokumenttia ehdotetaan vasta, kun tehtävälle on pyydetty AI-ehdotus.
  const aiSource = suggestion
    ? suggestion.source
    : suggestedBefore && ticket.knowledge_source_id && ticket.knowledge_source_title
      ? { id: ticket.knowledge_source_id, title: ticket.knowledge_source_title, chunkId: ticket.knowledge_source_chunk_id, page: ticket.knowledge_source_page }
      : null;

  const [suggestionToast, setSuggestionToast] = useState<{ title: string; message: string } | null>(null);
  useEffect(() => setSuggestionToast(null), [ticket.id]);

  // AI-ehdotus pyydetään ikkunasta, johon voi kirjoittaa lisätietoa tehtävästä.
  const [aiPromptOpen, setAiPromptOpen] = useState(false);

  function openSuggestionPrompt() {
    if (draft.trim() && draft !== (ticket.draft || "")
      && !window.confirm(t("Luonnoksessa on tallentamattomia muutoksia. Korvataanko se AI:n ehdotuksella?"))) {
      return;
    }
    // Lisätietoikkunan voi ottaa toimiston AI-asetuksista pois, jolloin ehdotus pyydetään suoraan.
    if (MANAGEMENT_OFFICE.aiPrompt) setAiPromptOpen(true);
    else void requestSuggestion("");
  }

  // AI-agentti käsittelee tehtävän vasta, kun käsittelijä painaa painiketta. Agentti voi vastata asukkaalle ja
  // varata vuoron; muut asiat se jättää käsittelijälle perustelun kanssa.
  const [agentRunning, setAgentRunning] = useState(false);
  async function runAgent() {
    if (!window.confirm(t("AI-agentti lukee tehtävän. Sauna-, pyykkitupa- ja autopaikka-asioissa se vastaa asukkaalle itse ja voi varata vuoron. Muut asiat se jättää sinulle. Jatketaanko?"))) return;
    setAgentRunning(true);
    setSuggestError("");
    try {
      const result = await api<{ outcome: "replied" | "handed_over"; reason: string; resolved: boolean; booked: boolean }>(
        `/tickets/${ticket.id}/agent`, { method: "POST" }
      );
      setSuggestionToast(result.outcome === "handed_over"
        ? { title: t("AI-agentti jätti tehtävän sinulle."), message: result.reason }
        : {
          title: result.resolved ? t("AI-agentti hoiti tehtävän ja sulki sen.") : t("AI-agentti vastasi asukkaalle ja odottaa hänen vastaustaan."),
          message: result.booked ? t("Agentti varasi vuoron asukkaalle. Vastaus ja varaus näkyvät tehtävän aikajanalla.")
            : result.resolved ? t("Vastaus näkyy tehtävän aikajanalla.")
            : t("Tehtävä näkyy AI tehtävissä. Kun asukas vastaa, agentti jatkaa itse.")
        });
      await onChanged();
    } catch (error) {
      setSuggestError(errorMessage(error, t("AI-agentin käsittely epäonnistui. Yritä uudelleen.")));
    } finally {
      setAgentRunning(false);
    }
  }

  const [sensitiveSaving, setSensitiveSaving] = useState(false);
  async function toggleSensitive() {
    const next = !ticket.sensitive;
    if (!next && !window.confirm(t("Poistetaanko arkaluonteisuusmerkintä? Tehtävän tekstit voidaan sen jälkeen lähettää AI:lle, ja tehtävän näkevät kaikki taloyhtiön käsittelijät."))) return;
    if (next && !window.confirm(t("Merkitäänkö tehtävä arkaluonteiseksi? Sitä ei lähetetä AI:lle, ja sen näkevät vain käsittelijä, taloyhtiön vastuuisännöitsijä ja pääkäyttäjät."))) return;
    setSensitiveSaving(true);
    try {
      await api(`/tickets/${ticket.id}/sensitive`, { method: "PUT", body: JSON.stringify({ sensitive: next }) });
      await onChanged();
    } catch (error) {
      setSuggestError(errorMessage(error, t("Merkinnän tallennus epäonnistui.")));
    } finally {
      setSensitiveSaving(false);
    }
  }

  async function requestSuggestion(context: string) {
    setAiPromptOpen(false);
    setSuggesting(true);
    setSuggestError("");
    try {
      const result = await api<{
        draft: string;
        reason: string;
        source: { id: string; title: string; chunkId?: string | null; page?: number | string | null } | null;
        usedAi: boolean;
        sensitive?: boolean;
        followUp?: boolean;
      }>(`/tickets/${ticket.id}/suggest`, { method: "POST", body: JSON.stringify(context ? { context } : {}) });
      setSuggestion(result);
      setSuggestionToast({
        title: result.usedAi && result.followUp
          ? t("AI on luonut uuden ehdotuksen. Se ottaa huomioon tehtävän sähköpostit ja asukkaalle jo lähetetyt vastaukset. Tarkista ja muokkaa tekstiä ennen lähettämistä.")
          : result.usedAi
          ? t("AI on luonut ehdotuksen tälle tehtävälle. Tarkista ja muokkaa tekstiä ennen lähettämistä.")
          : result.sensitive
          ? t("Tehtävä on arkaluonteinen, joten sitä ei lähetetty AI:lle. Ehdotus tehtiin avainsanahaulla dokumentaatiosta.")
          : t("AI ei ollut käytettävissä, joten ehdotus tehtiin avainsanahaulla dokumentaatiosta."),
        message: result.reason
      });
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
      // Lisätieto tallentui aikajanalle sisäiseksi muistiinpanoksi.
      if (context) await onChanged();
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

  // reply_sent ja message_created näkyvät aikajanalla jo itse viesteinä. AI:lle lähetetty tieto näkyy vain Lokissa.
  const timeline = [
    ...detail.messages.map(m => ({ kind: "message" as const, id: m.id, created_at: m.created_at, message: m })),
    ...detail.notes.map(n => ({ kind: "note" as const, id: n.id, created_at: n.created_at, note: n })),
    ...detail.audit
      .filter(a => a.action !== "reply_sent" && a.action !== "message_created" && a.action !== "ai_request")
      .map(a => ({ kind: "event" as const, id: a.id, created_at: a.created_at, event: a }))
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const unlinkedSenders = detail.reporters.length === 0
    ? [...new Set(detail.messages.filter(m => m.direction === "inbound").map(m => m.sender))]
    : [];

  const [residents, setResidents] = useState<Resident[]>([]);
  const [linking, setLinking] = useState(false);

  // Mahdollinen yhteinen vika, johon tehtävä on liitetty.
  const [incident, setIncident] = useState<{ id: string; topic: string; stairwell: string; status: string; reporters: number } | null>(null);
  const [incidentOpen, setIncidentOpen] = useState(false);
  useEffect(() => {
    setIncidentOpen(false);
    api<typeof incident>(`/tickets/${encodeURIComponent(ticket.id)}/incident`)
      .then(found => setIncident(found && (found.status === "open" || found.status === "ordered") ? found : null))
      .catch(() => setIncident(null));
  }, [ticket.id, ticket.updated_at]);

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
  type FieldEdits = {
    type?: string; topic?: string; priority?: string; assigneeId?: string | null; dueDate?: string | null; reporterId?: string; status?: string; companyId?: string;
  };
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
    topic: ticket.topic ?? "other",
    priority: ticket.priority,
    assigneeId: ticket.assignee_id ?? null,
    dueDate: ticket.due_date ?? null,
    reporterId: reporter?.id ?? "",
    status: ticket.status,
    // Tunnistamattoman tehtävän yhtiö on tyhjä, kunnes se valitaan.
    companyId: ticket.company_pending ? "" : ticket.company_id
  };
  // Näytettävät arvot: tallennettu arvo, ellei kenttää ole muutettu.
  const shown = { ...savedFields, ...edits };
  const dirty = Object.keys(edits).length > 0;
  const shownReporter = reporterOptions.find(r => r.id === shown.reporterId);
  // Asunto ja osoite seuraavat valittua ilmoittajaa heti, jo ennen tallennusta.
  const reporterEdited = edits.reporterId !== undefined;
  const pendingResident = reporterEdited ? residents.find(r => r.id === edits.reporterId) : undefined;
  const shownApartments: { apartment_number: string; address: string }[] = !reporterEdited ? detail.apartments
    : pendingResident ? [{ apartment_number: pendingResident.apartment_number, address: pendingResident.address }]
    : [];

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

  // Lähettäjä, josta tehdään uusi asukas; null = kortti kiinni.
  const [newResidentFrom, setNewResidentFrom] = useState<{ name: string; email: string } | null>(null);
  // Linkittämättömät lähettäjät nimeksi ja osoitteeksi. Jos osoitteella on jo asukas, hänet voi linkittää suoraan.
  const senderContacts = unlinkedSenders.map(sender => {
    const email = sender.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
    const name = sender.replace(/<[^>]*>/, "").replace(/["']/g, "").trim();
    return {
      sender,
      email,
      name: name && name !== email ? name : "",
      existing: email ? residents.find(resident => resident.email?.toLowerCase() === email.toLowerCase()) : undefined
    };
  });

  async function createResidentFromSender(residentId: string, companyId: string) {
    // Asukas lisättiin toiseen taloyhtiöön: tehtävä siirretään sinne ennen kuin asukas liitetään ilmoittajaksi.
    if (ticket.company_pending || companyId !== ticket.company_id) {
      await api(`/tickets/${ticket.id}/company`, { method: "PUT", body: JSON.stringify({ companyId }) });
    }
    await setReporter(residentId);
    setNewResidentFrom(null);
    api<Resident[]>(`/companies/${encodeURIComponent(companyId)}/residents`).then(setResidents).catch(() => undefined);
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
      const { reporterId, companyId, ...fields } = edits;
      // Taloyhtiön vaihto siirtää tehtävän: se menee uuden yhtiön vastuuisännöitsijälle (tai valitulle
      // käsittelijälle) ja saa yhtiön tehtävänumeron.
      if (companyId) {
        const target = companies.find(item => item.id === companyId);
        if (!window.confirm(t("Siirretäänkö tehtävä taloyhtiöön {0}? Se saa uuden tehtävänumeron.", target?.name ?? ""))) return;
        await api(`/tickets/${ticket.id}/company`, {
          method: "PUT",
          body: JSON.stringify(fields.assigneeId !== undefined ? { companyId, assigneeId: fields.assigneeId } : { companyId })
        });
        delete fields.assigneeId;
      }
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

  const myId = session?.user.id ?? "";
  const canMoveCompany = Boolean(ticket.company_pending) || ticket.assignee_id === myId || isAdmin()
    || Boolean(company?.manager_id && company.manager_id === myId);

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
          fromAccountId: fromAccountId || undefined,
          cc: cc.trim() || undefined,
          signature: useSignature,
          attachments: await Promise.all(replyFiles.map(async file => ({
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            data: await fileToBase64(file)
          }))),
          ticketAttachmentIds: replyTicketFiles,
          knowledgeIds: replyDocs
        })
      });
      setDraft("");
      setReplyFiles([]);
      setReplyTicketFiles([]);
      setReplyDocs([]);
      setReplyTargetId(null);
      setCc("");
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
              {/* Toiselle osoitetun tehtävän voi ottaa itselleen; tila säilyy. Käsittelijätön uusi tai avoin
                  tehtävä otetaan käsittelyyn kuten ennenkin. */}
              {myId && ticket.assignee_id && ticket.assignee_id !== myId ? (
                <button className="primary" onClick={() => void updateFields({ assigneeId: myId })} disabled={updatingFields}>
                  {t("Osoita minulle")}
                </button>
              ) : !ticket.assignee_id && (ticket.status === "open" || ticket.status === "active") ? (
                <button className="primary" onClick={() => onDecision("human")}>{t("Osoita minulle")}</button>
              ) : null}
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
        {ticket.company_pending ? (
          <UnidentifiedCompanyPanel ticket={ticket} companies={companies} users={officeUsers} onChanged={onChanged} />
        ) : null}
        {incident && (
          <p className="incident-notice">
            <span>
              {t("Kuuluu mahdolliseen yhteiseen vikaan: {0}, {1} ({2} asuntoa).", topicLabel(incident.topic), placeLabel(incident.stairwell), incident.reporters)}
            </span>
            <button type="button" onClick={() => setIncidentOpen(true)}>{t("Avaa yhteinen vika")}</button>
          </p>
        )}
        {incidentOpen && incident && (
          <IncidentDrawer incidentId={incident.id} onClose={() => setIncidentOpen(false)} onChanged={onChanged} onOpenTicket={() => setIncidentOpen(false)} />
        )}
        <h2>{ticket.subject}</h2>

        <dl className="ticket-facts">
          <div className="fact-number">
            <dt>{t("Tehtävänumero")}</dt>
            <dd>#{formatTicketNumber(ticket.ticket_number)}</dd>
          </div>
          <div className={edits.companyId !== undefined ? "changed" : ""}>
            <dt>{t("Yhtiö")}</dt>
            <dd>
              {/* Taloyhtiön vaihto siirtää tehtävän, kun muutokset tallennetaan. Siirron voi tehdä käsittelijä,
                  vastuuisännöitsijä tai pääkäyttäjä; tunnistamattoman tehtävän yhtiön valitsee jonon käsittelijä. */}
              <FactDropdown
                value={shown.companyId}
                options={[
                  ...(ticket.company_pending ? [{ value: "", label: t("Taloyhtiö tunnistamatta") }] : []),
                  ...companies.map(item => ({ value: item.id, label: item.name }))
                ]}
                disabled={updatingFields || !canMoveCompany}
                onChange={companyId => edit("companyId", companyId)}
              />
            </dd>
          </div>
          <div className={reporterEdited ? "changed" : ""}>
            <dt>{t("Osoite")}</dt>
            <dd>{[...new Set(shownApartments.map(a => a.address).filter(Boolean))].join(", ") || "-"}</dd>
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
          <div className={reporterEdited ? "changed" : ""}>
            <dt>{shownApartments.length > 1 ? t("Asunnot") : t("Asunto")}</dt>
            <dd>
              {shownApartments.length > 0
                ? shownApartments.map(a => a.apartment_number).join(", ")
                : t("Yhteiset tilat")}
            </dd>
          </div>
          <div className={edits.status !== undefined ? "changed" : ""}>
            <dt>{t("Tila")}</dt>
            <dd>
              <FactDropdown
                value={shown.status}
                options={(manualTicketStatuses.includes(ticket.status) ? manualTicketStatuses : [ticket.status, ...manualTicketStatuses])
                  .map(status => ({ value: status, label: statusLabel(status), pillClass: `status-pill status-${status}` }))}
                disabled={updatingFields}
                onChange={status => edit("status", status)}
              />
            </dd>
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
            {/* Myöhässä-merkintä on kentän alla, jotta se ei ahda kenttää. */}
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
            <dt className="fact-label-action">
              {t("Ilmoittaja")}
              {shownReporter && !reporterEdited && <OpenResidentButton residentId={shownReporter.id} name={shownReporter.name} className="fact-open-resident" />}
            </dt>
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
          <div className={reporterEdited ? "changed" : ""}>
            <dt>{t("Sähköposti")}</dt>
            <dd>
              {shownReporter
                ? reporterEmail || "-"
                : senderContacts.length > 0 ? (
                  <span className="sender-contacts">
                    {senderContacts.map(contact => (
                      <span className="sender-contact" key={contact.sender}>
                        <span>{contact.email || contact.sender}</span>
                        {contact.existing ? (
                          <button
                            type="button"
                            className="sender-action"
                            disabled={linking}
                            onClick={() => void setReporter(contact.existing!.id)}
                            title={t("Liitä asukas {0} tämän tehtävän ilmoittajaksi", contact.existing.name)}
                          >
                            {t("Linkitä: {0}", contact.existing.name)}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="sender-action"
                            disabled={linking}
                            onClick={() => setNewResidentFrom({ name: contact.name, email: contact.email })}
                            title={t("Lähettäjää ei löydy asukkaista. Lisää hänet asukkaaksi.")}
                          >
                            {t("Tee käyttäjä")}
                          </button>
                        )}
                      </span>
                    ))}
                    <small>{t("Ei linkitetty asukkaaseen")}</small>
                  </span>
                ) : "-"}
            </dd>
          </div>
          <div className={edits.topic !== undefined ? "changed" : ""}>
            <dt>{t("Aihe")}</dt>
            <dd>
              <FactDropdown
                value={shown.topic}
                options={topicOptions}
                disabled={updatingFields}
                onChange={topic => edit("topic", topic)}
              />
            </dd>
          </div>
        </dl>

        {aiPromptOpen && <AiSuggestModal onClose={() => setAiPromptOpen(false)} onSubmit={context => void requestSuggestion(context)} />}

        {newResidentFrom && (
          <CreateResidentModal
            companyId={ticket.company_pending ? "" : ticket.company_id}
            companies={companies}
            initialName={newResidentFrom.name}
            initialEmail={newResidentFrom.email}
            onClose={() => setNewResidentFrom(null)}
            onCreated={createResidentFromSender}
          />
        )}

        {detail.erasurePending && (
          <p className="erasure-note">
            {t("Asukas on pyytänyt tietojensa poistoa ({0}). Tehtävä säilytetään perusteella \"{1}\" ja anonymisoidaan, kun se suljetaan.",
              formatDateOnly(detail.erasurePending.created_at), t(detail.erasurePending.reason))}
          </p>
        )}

        {detail.renovation ? (
          <RenovationPanel notice={detail.renovation} onChanged={onChanged} />
        ) : detail.form ? (
          <section className="ticket-form-card" aria-label={t(detail.form.title)}>
            <h3>{t(detail.form.title)} <small>{detail.form.source === "email" ? t("verkkosivun lomake sähköpostista") : t("asukasportaalin lomake")}</small></h3>
            <dl>
              {detail.form.fields.map(field => (
                <div key={field.label} className={field.label === "Huomio" ? "warning" : ""}>
                  <dt>{t(field.label)}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : (
          <div className="ticket-description">
            <h3>{t("Kuvaus")}</h3>
            <p>{description}</p>
          </div>
        )}

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
            <div className="suggest-actions">
            {MANAGEMENT_OFFICE.aiAgent && (
              <button
                className="ai-button"
                onClick={() => void runAgent()}
                disabled={agentRunning || suggesting || Boolean(ticket.sensitive)}
                title={ticket.sensitive ? t("Arkaluonteista tehtävää ei lähetetä AI:lle.") : t("AI-agentti hoitaa sauna-, pyykkitupa- ja autopaikka-asiat ja vastaa asukkaalle")}
              >
                {agentRunning ? t("AI-agentti käsittelee…") : t("Anna AI-agentin hoitaa")}
              </button>
            )}
            <button
              className="ai-button"
              onClick={openSuggestionPrompt}
              disabled={suggesting || agentRunning}
            >
              {suggesting ? t("AI kirjoittaa…")
                : ticket.sensitive ? (suggestedBefore ? t("Pyydä uusi ehdotus dokumentaatiosta") : t("Pyydä ehdotus dokumentaatiosta"))
                : suggestedBefore ? t("Pyydä uusi AI-ehdotus") : t("Pyydä AI-ehdotus")}
            </button>
            </div>
          </div>
          {/* Arkaluonteinen tehtävä (esim. terveystietoja) ei mene AI:lle; merkinnän voi asettaa ja poistaa. */}
          <p className={ticket.sensitive ? "sensitive-note active" : "sensitive-note"}>
            {ticket.sensitive ? (
              <span>{t("Arkaluonteinen tehtävä: sitä ei lähetetä AI:lle, ja sen näkevät vain käsittelijä, taloyhtiön vastuuisännöitsijä ja pääkäyttäjät. Avaukset kirjataan lokiin.")}</span>
            ) : null}
            <button type="button" className="back-link" disabled={sensitiveSaving} onClick={() => void toggleSensitive()}>
              {ticket.sensitive ? t("Poista arkaluonteisuusmerkintä") : t("Merkitse arkaluonteiseksi")}
            </button>
          </p>
          {/* Ehdotuksen valmistuminen ja sen peruste näytetään hetken ilmoituksena näytön yläreunassa. */}
          {suggestionToast && (
            <Toast
              title={suggestionToast.title}
              message={suggestionToast.message}
              onClose={() => setSuggestionToast(null)}
            />
          )}
          {aiSource ? (
            <p>
              <a
                className="source-pill source-link"
                href={`#/knowledge/${encodeURIComponent(aiSource.chunkId ? `${aiSource.id}:${aiSource.chunkId}` : aiSource.id)}`}
                target="_blank"
                rel="noreferrer"
                title={t("Avaa lähde uuteen välilehteen")}
              >
                📄 {aiSource.title}{aiSource.page ? `, ${t("s. {0}", String(aiSource.page))}` : ""} ↗
              </a>
            </p>
          ) : null}
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
          {canReply && (
            // Lähettäjä ja kopio yhtenä kompaktina otsakkeena tekstikentän yläpuolella, kuten sähköpostiohjelmassa.
            <div className="reply-header">
              {detail.replyAccounts.length > 0 && (
                <label className="reply-from">
                  <span>{t("Lähettäjä")}</span>
                  <select value={fromAccountId} onChange={event => setFromChoice(event.target.value)}>
                    {detail.replyAccounts.map(account => (
                      <option key={account.id} value={account.id}>
                        {replyAccountLabel(account)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="reply-cc">
                <label>
                  <span>{t("Kopio (Cc)")}</span>
                  <input
                    type="text"
                    value={cc}
                    onChange={event => setCc(event.target.value)}
                    placeholder={t("esim. hallitus@yhtio.fi, useampi pilkulla eroteltuna")}
                  />
                </label>
                {detail.contractor?.email && !cc.toLowerCase().includes(detail.contractor.email.toLowerCase()) && (
                  <button
                    type="button"
                    className="reply-cc-add"
                    onClick={() => setCc(current => [current.trim(), detail.contractor!.email].filter(Boolean).join(", "))}
                    title={detail.contractor.email}
                  >
                    {t("+ Huoltoyhtiö")}
                  </button>
                )}
              </div>
            </div>
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
            <div className="reply-signature">
              <label className="reply-signature-toggle">
                <input type="checkbox" checked={useSignature} onChange={event => setUseSignature(event.target.checked)} />
                {t("Lisää allekirjoitus")}
              </label>
              {useSignature && (detail.signature
                ? <pre>{detail.signature}</pre>
                : <p className="reply-hint">{t("Sinulla ei ole allekirjoitusta.")}{" "}<a href="#/settings">{t("Lisää se omista asetuksistasi.")}</a></p>)}
            </div>
          )}
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
                    setReplyFiles(current => [...current, ...picked].slice(0, Math.max(MAX_REPLY_ATTACHMENTS - replyTicketFiles.length - replyDocs.length, current.length)));
                    event.target.value = "";
                    setSendError("");
                  }}
                />
              </label>
              {/* Tehtävällä jo olevat liitteet ja taloyhtiön dokumentit valitaan listasta. */}
              {detail.attachments.some(attachment => !replyTicketFiles.includes(attachment.id)) && (
                <Dropdown
                  className="attach-dropdown"
                  value=""
                  placeholder={t("Tehtävän liitteet")}
                  ariaLabel={t("Liitä tehtävän liite")}
                  disabled={replyFileCount >= MAX_REPLY_ATTACHMENTS}
                  options={detail.attachments
                    .filter(attachment => !replyTicketFiles.includes(attachment.id))
                    .map(attachment => ({ value: attachment.id, label: `${attachment.filename} (${formatFileSize(attachment.size)})` }))}
                  onChange={value => { setReplyTicketFiles(current => [...current, value]); setSendError(""); }}
                />
              )}
              {companyDocs.some(doc => !replyDocs.includes(doc.id)) && (
                <Dropdown
                  className="attach-dropdown"
                  value=""
                  placeholder={t("Dokumentaatiosta")}
                  ariaLabel={t("Liitä dokumentti dokumentaatiosta")}
                  disabled={replyFileCount >= MAX_REPLY_ATTACHMENTS}
                  options={companyDocs
                    .filter(doc => !replyDocs.includes(doc.id))
                    .map(doc => ({ value: doc.id, label: `${doc.title} (${doc.file_name})` }))}
                  onChange={value => { setReplyDocs(current => [...current, value]); setSendError(""); }}
                />
              )}
              {detail.attachments.filter(attachment => replyTicketFiles.includes(attachment.id)).map(attachment => (
                <span className="reply-file" key={attachment.id}>
                  {attachment.filename} <small>{formatFileSize(attachment.size)}</small>
                  <button
                    onClick={() => setReplyTicketFiles(current => current.filter(item => item !== attachment.id))}
                    title={t("Poista liite")}
                    aria-label={t("Poista liite {0}", attachment.filename)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {companyDocs.filter(doc => replyDocs.includes(doc.id)).map(doc => (
                <span className="reply-file" key={doc.id}>
                  {doc.file_name} <small>{t("Dokumentaatio")}</small>
                  <button
                    onClick={() => setReplyDocs(current => current.filter(item => item !== doc.id))}
                    title={t("Poista liite")}
                    aria-label={t("Poista liite {0}", doc.file_name)}
                  >
                    ×
                  </button>
                </span>
              ))}
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
              attachments={detail.attachments.filter(attachment => attachment.message_id === item.message.id)}
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
              {eventNote(item.event.details) && <span className="event-note">{eventNote(item.event.details)}</span>}
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
        <div className="overlay skip-overlay">
          <aside className="drawer skip-drawer" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
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

// Lokimerkinnän vapaa teksti, esim. remontin valvontakäynnin havainnot.
function eventNote(details: string) {
  try {
    const parsed = JSON.parse(details) as { note?: unknown; from?: unknown; to?: unknown; number?: unknown };
    if (typeof parsed?.note === "string") return parsed.note;
    // Taloyhtiön valinta tai siirto: mistä mihin ja uusi tehtävänumero.
    if (typeof parsed?.to === "string" && typeof parsed.number === "number") {
      const target = t("{0}, uusi numero #{1}", parsed.to, formatTicketNumber(parsed.number));
      return typeof parsed.from === "string" ? `${parsed.from} → ${target}` : target;
    }
    return "";
  } catch {
    return "";
  }
}

// Lähettäjävalikon teksti: osoite ja tilin laji; saapumislaatikko merkitään.
function replyAccountLabel(account: ReplyAccount): string {
  const kind = account.kind === "own" ? t("oma postilaatikko")
    : account.kind === "office" ? t("isännöintitoimisto")
    : t("taloyhtiö");
  const name = account.email || t("Toimiston tili");
  return account.arrived ? t("{0} ({1}, viesti saapui tänne)", name, kind) : `${name} (${kind})`;
}
