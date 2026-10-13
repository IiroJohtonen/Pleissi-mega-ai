import { type FormEvent, useEffect, useState } from "react";
import { DownloadLink } from "../components/common";
import { fileToBase64, formatDate, formatDay, formatFileSize, formatTicketNumber } from "../format";
import { api, errorMessage, logout, type ResidentAccount } from "../session";
import { splitQuotedReply } from "../tickets/ticket-utils";
import type { Announcement } from "./Announcements";
import { BookingCalendar } from "./Bookings";
import { formatReading, METER_TYPES, type MeterReading, meterLabel, meterUnit, parseReading } from "./Meters";
import { type MoveNotice, moveStatusLabels, moveSummary } from "./Moves";
import { PARKING_TYPES } from "./Parking";
import { RENOVATION_WORK_TYPES, type RenovationNotice, renovationPeriod, renovationStatusLabels } from "./Renovations";
import { type WaitlistEntry, waitlistLabel } from "./Waitlists";

// Asukasportaali: asukas näkee vain oman taloyhtiönsä sauna- ja pyykkitupavuorot.
export function ResidentPortal({ resident }: { resident: ResidentAccount }) {
  const [view, setView] = useState<"announcements" | "sauna" | "laundry" | "tickets" | "waitlist" | "moves" | "renovations" | "meters">("announcements");

  return (
    <div className="portal">
      <header className="portal-header">
        <img src="/kotilo-logo.svg" alt="Kotilo" />
        <nav>
          <button className={view === "announcements" ? "active" : ""} onClick={() => setView("announcements")}>Tiedotteet</button>
          <button className={view === "sauna" ? "active" : ""} onClick={() => setView("sauna")}>Saunavuorot</button>
          <button className={view === "laundry" ? "active" : ""} onClick={() => setView("laundry")}>Pyykkitupavuorot</button>
          <button className={view === "tickets" ? "active" : ""} onClick={() => setView("tickets")}>Tehtävät</button>
          <button className={view === "waitlist" ? "active" : ""} onClick={() => setView("waitlist")}>Jonot</button>
          <button className={view === "moves" ? "active" : ""} onClick={() => setView("moves")}>Muuttoilmoitus</button>
          <button className={view === "renovations" ? "active" : ""} onClick={() => setView("renovations")}>Remontti-ilmoitus</button>
          <button className={view === "meters" ? "active" : ""} onClick={() => setView("meters")}>Kulutuslukemat</button>
        </nav>
        <div className="portal-user">
          <strong>{resident.name}</strong>
          <span>{resident.companyName} · {resident.apartmentNumber}</span>
          <button
            onClick={logout}
          >
            Kirjaudu ulos
          </button>
        </div>
      </header>

      <main className="portal-main">
        <div>
          <h1>{view === "announcements" ? "Tiedotteet" : view === "sauna" ? "Saunavuorot" : view === "laundry" ? "Pyykkitupavuorot" : view === "waitlist" ? "Jonot" : view === "moves" ? "Muuttoilmoitus" : view === "renovations" ? "Remontti-ilmoitus" : view === "meters" ? "Kulutuslukemat" : "Tehtävät"}</h1>
          <p className="muted">{resident.companyName}</p>
        </div>
        {view === "announcements" ? <PortalAnnouncements />
          : view === "tickets" ? <PortalTickets resident={resident} />
          : view === "waitlist" ? <PortalWaitlist />
          : view === "moves" ? <PortalMoves resident={resident} />
          : view === "renovations" ? <PortalRenovations resident={resident} />
          : view === "meters" ? <PortalMeters resident={resident} />
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
// Asukkaan liitevalinta: kuvat ja PDF:t, enintään viisi.
function PortalFilePicker({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  return (
    <div className="reply-attachments">
      <label className="attach-button">
        Liitä kuva
        <input
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,image/heic,application/pdf"
          onChange={event => {
            const picked = [...(event.target.files ?? [])];
            event.target.value = "";
            onChange([...files, ...picked].slice(0, 5));
          }}
        />
      </label>
      {files.map((file, index) => (
        <span className="reply-file" key={`${file.name}-${index}`}>
          {file.name} <small>{formatFileSize(file.size)}</small>
          <button type="button" onClick={() => onChange(files.filter((_, position) => position !== index))} aria-label={`Poista liite ${file.name}`}>×</button>
        </span>
      ))}
    </div>
  );
}

async function portalAttachments(files: File[]) {
  return Promise.all(files.map(async file => ({ filename: file.name, mimeType: file.type, data: await fileToBase64(file) })));
}

type PortalThread = {
  ticket: PortalTicket;
  messages: { id: string; direction: string; body: string; created_at: string }[];
  attachments: { id: string; filename: string; size: number; created_at: string; direction: string }[];
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
      setError(errorMessage(sendError, "Viestin lähetys epäonnistui. Yritä uudelleen."));
    } finally {
      setSending(false);
    }
  }

  if (failed) return <p className="send-error">Tehtävän lataus epäonnistui.</p>;
  if (!thread) return <div className="empty">Ladataan…</div>;
  const closed = thread.ticket.status === "closed";

  return (
    <div className="portal-thread">
      <button className="back-link" onClick={onBack}>← Kaikki tehtävät</button>
      <div className="portal-thread-head">
        <h2>{thread.ticket.subject}</h2>
        <p className="muted">
          #{formatTicketNumber(thread.ticket.ticket_number)} · {thread.ticket.type} · {closed ? "Suljettu" : "Käsittelyssä"} · luotu {formatDate(thread.ticket.created_at)}
        </p>
      </div>

      <div className="portal-messages">
        {thread.messages.map(message => (
          <div key={message.id} className={`portal-message ${message.direction === "inbound" ? "mine" : "theirs"}`}>
            <small>{message.direction === "inbound" ? "Sinä" : "Isännöitsijä"} · {formatDate(message.created_at)}</small>
            <p>{message.direction === "inbound" ? splitQuotedReply(message.body).text : message.body}</p>
          </div>
        ))}
        {thread.messages.length === 0 && <p className="muted">Ei viestejä.</p>}
      </div>

      {thread.attachments.length > 0 && (
        <div className="portal-thread-files">
          <strong>Liitteet</strong>
          {thread.attachments.map(attachment => (
            <DownloadLink key={attachment.id} path={`/portal/attachments/${attachment.id}`} filename={attachment.filename}>
              {attachment.filename} <small>{attachment.direction === "portal" ? "sinulta" : "isännöitsijältä"} · {formatFileSize(attachment.size)}</small>
            </DownloadLink>
          ))}
        </div>
      )}

      <form className="ticket-form portal-ticket-form" onSubmit={send}>
        <label>
          <span>{closed ? "Uusi viesti (avaa tehtävän uudelleen)" : "Uusi viesti isännöitsijälle"}</span>
          <textarea value={body} onChange={event => setBody(event.target.value)} rows={4} maxLength={5000} required />
        </label>
        <PortalFilePicker files={files} onChange={setFiles} />
        {error && <p className="send-error">{error}</p>}
        <div className="portal-ticket-actions">
          <button type="submit" className="portal-new" disabled={sending || !body.trim()}>{sending ? "Lähetetään…" : "Lähetä viesti"}</button>
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
      setFormError("Kirjoita otsikko ja kuvaus.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const created = await api<{ attachmentError?: string | null }>("/portal/tickets", {
        method: "POST",
        body: JSON.stringify({ subject: subject.trim(), description: description.trim(), type, attachments: await portalAttachments(files) })
      });
      if (created.attachmentError) setFormError(`Tehtävä lähetettiin, mutta liitteitä ei tallennettu: ${created.attachmentError}`);
      setFiles([]);
      setSubject("");
      setDescription("");
      setType(PORTAL_TICKET_TYPES[0]);
      setCreating(false);
      setSent(true);
      await loadTickets();
    } catch {
      setFormError("Tehtävän lähetys epäonnistui. Yritä uudelleen.");
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
          Vikailmoitukset, kysymykset ja pyynnöt isännöitsijälle. Kiireellisessä hätätilanteessa soita huoltoyhtiön päivystykseen.
        </p>
        {!creating && (
          <button className="portal-new" onClick={() => { setCreating(true); setSent(false); }}>Luo tehtävä</button>
        )}
      </div>

      {sent && !creating && <p className="portal-sent">Tehtävä on lähetetty isännöitsijälle.</p>}
      {formError && !creating && <p className="send-error">{formError}</p>}

      {creating && (
        <form className="ticket-form portal-ticket-form" onSubmit={handleSubmit}>
          <dl className="ticket-facts">
            <div>
              <dt>Ilmoittaja</dt>
              <dd>{resident.name}</dd>
            </div>
            <div>
              <dt>Asunto</dt>
              <dd>{resident.apartmentNumber || "–"}</dd>
            </div>
          </dl>

          <label>
            <span>Tyyppi</span>
            <select value={type} onChange={event => setType(event.target.value)}>
              {PORTAL_TICKET_TYPES.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>

          <label>
            <span>Otsikko</span>
            <input
              value={subject}
              onChange={event => setSubject(event.target.value)}
              maxLength={150}
              placeholder="Esim. Keittiön hana vuotaa"
              required
              autoFocus
            />
          </label>

          <label>
            <span>Kuvaus</span>
            <textarea
              value={description}
              onChange={event => setDescription(event.target.value)}
              maxLength={5000}
              rows={6}
              placeholder="Kerro, mitä on tapahtunut ja missä."
              required
            />
          </label>

          <PortalFilePicker files={files} onChange={setFiles} />

          {formError && <p className="send-error">{formError}</p>}

          <div className="portal-ticket-actions">
            <button type="button" className="secondary" onClick={() => setCreating(false)} disabled={saving}>Peruuta</button>
            <button type="submit" className="portal-new" disabled={saving}>{saving ? "Lähetetään…" : "Lähetä tehtävä"}</button>
          </div>
        </form>
      )}

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <p className="send-error">Tehtävien lataus epäonnistui.</p>
        : tickets.length === 0 ? <div className="empty">Et ole vielä luonut tehtäviä.</div>
        : (
          <div className="table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Numero</th>
                  <th>Otsikko</th>
                  <th>Tyyppi</th>
                  <th>Tila</th>
                  <th>Luotu</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map(ticket => (
                  <tr
                    key={ticket.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title="Avaa viestiketju"
                    onClick={() => setOpenId(ticket.id)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenId(ticket.id);
                      }
                    }}
                  >
                    <td>#{formatTicketNumber(ticket.ticket_number)}</td>
                    <td><strong>{ticket.subject}</strong></td>
                    <td>{ticket.type}</td>
                    <td>{ticket.status === "closed" ? "Suljettu" : "Käsittelyssä"}</td>
                    <td>{formatDate(ticket.created_at)}</td>
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

  if (loading) return <div className="empty">Ladataan…</div>;
  if (failed) return <p className="send-error">Tiedotteiden lataus epäonnistui.</p>;
  if (items.length === 0) return <div className="empty">Ei tiedotteita.</div>;
  return (
    <div className="portal-announcements">
      {items.map(item => (
        <article key={item.id}>
          <small>{formatDate(item.created_at)}{item.stairwell ? ` · Rappu ${item.stairwell}` : ""}</small>
          <h2>{item.title}</h2>
          <p>{item.body}</p>
        </article>
      ))}
    </div>
  );
}

// Asukkaan jonot: ilmoittautuminen autopaikka- ja saunavuorojonoon sekä oma sija.
function PortalWaitlist() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [parkingType, setParkingType] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({ parking: "", sauna: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function loadEntries() {
    try {
      setEntries(await api<WaitlistEntry[]>("/portal/waitlist"));
    } catch {
      setError("Jonotietojen lataus epäonnistui.");
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
      setError(errorMessage(joinError, "Jonoon ilmoittautuminen epäonnistui."));
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
      setError("Jonosta poistuminen epäonnistui.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty">Ladataan…</div>;

  const queues: { resource: "parking" | "sauna"; title: string; hint: string }[] = [
    { resource: "parking", title: "Autopaikkajono", hint: "Vapautuva autopaikka tarjotaan jonossa ensimmäisenä olevalle." },
    { resource: "sauna", title: "Saunavuorojono", hint: "Vapautuva vakiovuoro tarjotaan jonossa ensimmäisenä olevalle." }
  ];

  return (
    <div className="portal-queues">
      {queues.map(queue => {
        const entry = entries.find(item => item.resource === queue.resource);
        return (
          <article key={queue.resource}>
            <h2>{queue.title}</h2>
            <p className="muted">{queue.hint}</p>
            {entry ? (
              <>
                <p className="portal-queue-position">
                  Olet jonossa sijalla <strong>{entry.position}</strong>
                  {entry.status === "offered" && " · isännöitsijä on tarjonnut sinulle paikkaa"}
                </p>
                <p className="muted">
                  {waitlistLabel(entry)} · ilmoittauduttu {formatDate(entry.created_at)}{entry.note ? ` · ${entry.note}` : ""}
                </p>
                <button className="secondary" onClick={() => void leave(entry)} disabled={saving}>Poistu jonosta</button>
              </>
            ) : (
              <div className="ticket-form">
                {queue.resource === "parking" && (
                  <label>
                    <span>Toivottu paikkatyyppi</span>
                    <select value={parkingType} onChange={event => setParkingType(event.target.value)}>
                      <option value="">Mikä tahansa</option>
                      {PARKING_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                    </select>
                  </label>
                )}
                <label>
                  <span>Toive (valinnainen)</span>
                  <input
                    value={notes[queue.resource]}
                    onChange={event => setNotes(current => ({ ...current, [queue.resource]: event.target.value }))}
                    maxLength={300}
                    placeholder={queue.resource === "parking" ? "Esim. sähköauton latausmahdollisuus" : "Esim. perjantai-ilta"}
                  />
                </label>
                <div className="portal-ticket-actions">
                  <button className="portal-new" onClick={() => void join(queue.resource)} disabled={saving}>Ilmoittaudu jonoon</button>
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
      setError("Muuttoilmoitusten lataus epäonnistui.");
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
      setError("Ilmoita poismuutto, uudet asukkaat tai oveen tuleva nimi.");
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
      setError(errorMessage(submitError, "Muuttoilmoituksen lähetys epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty">Ladataan…</div>;

  return (
    <>
      {sent && <p className="portal-sent">Muuttoilmoitus on lähetetty isännöitsijälle.</p>}

      {pending ? (
        <p className="muted">Sinulla on käsittelyä odottava muuttoilmoitus. Uuden voi tehdä, kun se on käsitelty.</p>
      ) : (
        <form className="ticket-form portal-ticket-form" onSubmit={handleSubmit}>
          <dl className="ticket-facts">
            <div>
              <dt>Ilmoittaja</dt>
              <dd>{resident.name}</dd>
            </div>
            <div>
              <dt>Asunto</dt>
              <dd>{resident.apartmentNumber || "–"}</dd>
            </div>
          </dl>

          <label>
            <span>Muuttopäivä</span>
            <input type="date" value={moveDate} onChange={event => setMoveDate(event.target.value)} required />
          </label>

          <label className="switch-row">
            <span>
              <strong>Asunnon nykyiset asukkaat muuttavat pois</strong>
              <small>Autopaikka ja varatut vuorot päättyvät muuttopäivänä.</small>
            </span>
            <input type="checkbox" role="switch" checked={movesOut} onChange={() => setMovesOut(!movesOut)} />
            <i aria-hidden="true" />
          </label>

          <fieldset className="move-new-residents">
            <legend>Asuntoon muuttavat uudet asukkaat</legend>
            {people.map((person, index) => (
              <div className="move-person" key={index}>
                <input
                  value={person.name}
                  onChange={event => setPeople(current => current.map((item, position) => position === index ? { ...item, name: event.target.value } : item))}
                  placeholder="Nimi"
                  maxLength={100}
                  aria-label={`Uuden asukkaan ${index + 1} nimi`}
                />
                <input
                  type="email"
                  value={person.email}
                  onChange={event => setPeople(current => current.map((item, position) => position === index ? { ...item, email: event.target.value } : item))}
                  placeholder="Sähköposti (valinnainen)"
                  aria-label={`Uuden asukkaan ${index + 1} sähköposti`}
                />
                <button type="button" onClick={() => setPeople(current => current.filter((_, position) => position !== index))} aria-label="Poista asukas">×</button>
              </div>
            ))}
            {people.length < 8 && (
              <button type="button" className="secondary" onClick={() => setPeople(current => [...current, { name: "", email: "" }])}>
                Lisää asukas
              </button>
            )}
          </fieldset>

          <label>
            <span>Nimi oveen (valinnainen)</span>
            <input value={doorName} onChange={event => setDoorName(event.target.value)} maxLength={60} placeholder="Esim. Virtanen" />
          </label>

          <label>
            <span>Lisätiedot (valinnainen)</span>
            <textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={1000} />
          </label>

          {error && <p className="send-error">{error}</p>}

          <div className="portal-ticket-actions">
            <button type="submit" className="portal-new" disabled={saving || !moveDate}>{saving ? "Lähetetään…" : "Lähetä muuttoilmoitus"}</button>
          </div>
        </form>
      )}

      {notices.length > 0 && (
        <div className="table-card">
          <table className="data-table report-topics">
            <thead>
              <tr>
                <th>Muuttopäivä</th>
                <th>Sisältö</th>
                <th>Tila</th>
                <th>Ilmoitettu</th>
              </tr>
            </thead>
            <tbody>
              {notices.map(notice => (
                <tr key={notice.id}>
                  <td><strong>{formatDay(notice.move_date)}</strong></td>
                  <td>{moveSummary(notice) || "–"}</td>
                  <td>{moveStatusLabels[notice.status]}</td>
                  <td>{formatDate(notice.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// Asukkaan remontti-ilmoitus: työn tyyppi, kuvaus, ajankohta ja urakoitsija. Isännöitsijä hyväksyy
// ilmoituksen ennen työn aloittamista ja voi asettaa sille ehtoja.
function PortalRenovations({ resident }: { resident: ResidentAccount }) {
  const [notices, setNotices] = useState<RenovationNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [workType, setWorkType] = useState(RENOVATION_WORK_TYPES[0]);
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [contractor, setContractor] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function loadNotices() {
    try {
      setNotices(await api<RenovationNotice[]>("/portal/renovations"));
    } catch {
      setError("Remontti-ilmoitusten lataus epäonnistui.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadNotices();
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (description.trim().length < 10) {
      setError("Kuvaa työ vähintään parilla lauseella.");
      return;
    }
    if (endDate < startDate) {
      setError("Päättymispäivä ei voi olla ennen alkamispäivää.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api("/portal/renovations", {
        method: "POST",
        body: JSON.stringify({ workType, description: description.trim(), startDate, endDate, contractor: contractor.trim() })
      });
      setWorkType(RENOVATION_WORK_TYPES[0]);
      setDescription("");
      setStartDate("");
      setEndDate("");
      setContractor("");
      setCreating(false);
      setSent(true);
      await loadNotices();
    } catch (submitError) {
      setError(errorMessage(submitError, "Remontti-ilmoituksen lähetys epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty">Ladataan…</div>;

  return (
    <>
      <div className="portal-tickets-head">
        <p className="muted">
          Ilmoita remontista ennen työn aloittamista. Työn saa aloittaa vasta, kun isännöitsijä on hyväksynyt ilmoituksen.
        </p>
        {!creating && (
          <button className="portal-new" onClick={() => { setCreating(true); setSent(false); setError(""); }}>Tee remontti-ilmoitus</button>
        )}
      </div>

      {sent && !creating && <p className="portal-sent">Remontti-ilmoitus on lähetetty isännöitsijälle.</p>}
      {error && !creating && <p className="send-error">{error}</p>}

      {creating && (
        <form className="ticket-form portal-ticket-form" onSubmit={handleSubmit}>
          <dl className="ticket-facts">
            <div>
              <dt>Ilmoittaja</dt>
              <dd>{resident.name}</dd>
            </div>
            <div>
              <dt>Asunto</dt>
              <dd>{resident.apartmentNumber || "–"}</dd>
            </div>
          </dl>

          <label>
            <span>Työn tyyppi</span>
            <select value={workType} onChange={event => setWorkType(event.target.value)}>
              {RENOVATION_WORK_TYPES.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>

          <label>
            <span>Työn kuvaus</span>
            <textarea
              value={description}
              onChange={event => setDescription(event.target.value)}
              maxLength={5000}
              rows={6}
              placeholder="Kerro, mitä tehdään ja mihin rakenteisiin tai putkiin työ vaikuttaa."
              required
            />
          </label>

          <label>
            <span>Työ alkaa</span>
            <input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} required />
          </label>

          <label>
            <span>Työ päättyy</span>
            <input type="date" value={endDate} min={startDate} onChange={event => setEndDate(event.target.value)} required />
          </label>

          <label>
            <span>Urakoitsija ja yhteystiedot (valinnainen)</span>
            <input value={contractor} onChange={event => setContractor(event.target.value)} maxLength={300} placeholder="Esim. Remontti Oy, 040 123 4567" />
          </label>

          {error && <p className="send-error">{error}</p>}

          <div className="portal-ticket-actions">
            <button type="button" className="secondary" onClick={() => setCreating(false)} disabled={saving}>Peruuta</button>
            <button type="submit" className="portal-new" disabled={saving || !startDate || !endDate}>{saving ? "Lähetetään…" : "Lähetä remontti-ilmoitus"}</button>
          </div>
        </form>
      )}

      {notices.length === 0 ? <div className="empty">Et ole vielä tehnyt remontti-ilmoituksia.</div> : (
        <div className="table-card">
          <table className="data-table report-topics">
            <thead>
              <tr>
                <th>Työ</th>
                <th>Ajankohta</th>
                <th>Tila</th>
                <th>Ilmoitettu</th>
              </tr>
            </thead>
            <tbody>
              {notices.map(notice => (
                <tr key={notice.id}>
                  <td>
                    <strong>{notice.work_type}</strong>
                    <span>{notice.description}</span>
                  </td>
                  <td>{renovationPeriod(notice)}</td>
                  <td>
                    <strong>{renovationStatusLabels[notice.status]}</strong>
                    {notice.decision_note && <span>{notice.decision_note}</span>}
                  </td>
                  <td>{formatDate(notice.created_at)}</td>
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
      setError("Lukemien lataus epäonnistui.");
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
      setError("Anna lukema numerona, esim. 123,45.");
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
      setError(errorMessage(submitError, "Lukeman lähetys epäonnistui."));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty">Ladataan…</div>;

  return (
    <>
      <form className="ticket-form portal-ticket-form" onSubmit={handleSubmit}>
        <dl className="ticket-facts">
          <div>
            <dt>Ilmoittaja</dt>
            <dd>{resident.name}</dd>
          </div>
          <div>
            <dt>Asunto</dt>
            <dd>{resident.apartmentNumber || "–"}</dd>
          </div>
        </dl>

        <label>
          <span>Mittari</span>
          <select value={meterType} onChange={event => setMeterType(event.target.value)}>
            {METER_TYPES.map(option => <option key={option} value={option}>{meterLabel(option)}</option>)}
          </select>
        </label>

        <label>
          <span>Mittarin lukema tänään ({meterUnit(meterType)})</span>
          <input value={valueText} onChange={event => setValueText(event.target.value)} inputMode="decimal" placeholder="Esim. 123,45" required />
        </label>

        {sent && <p className="portal-sent">Lukema on tallennettu.</p>}
        {error && <p className="send-error">{error}</p>}

        <div className="portal-ticket-actions">
          <button type="submit" className="portal-new" disabled={saving || !valueText.trim()}>{saving ? "Lähetetään…" : "Lähetä lukema"}</button>
        </div>
      </form>

      {readings.length > 0 && (
        <div className="table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Lukupäivä</th>
                <th>Mittari</th>
                <th>Lukema</th>
              </tr>
            </thead>
            <tbody>
              {readings.map(reading => (
                <tr key={reading.id}>
                  <td><strong>{formatDay(reading.reading_date)}</strong></td>
                  <td>{meterLabel(reading.meter_type)}</td>
                  <td>{formatReading(reading.value, reading.meter_type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
