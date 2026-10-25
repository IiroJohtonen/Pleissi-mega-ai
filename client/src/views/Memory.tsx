import { useEffect, useState } from "react";
import { Dropdown } from "../components/common";
import { formatDate, formatDateOnly, formatTicketNumber } from "../format";
import { t } from "../i18n";
import { api, errorMessage } from "../session";
import { placeLabel, topicLabel, topicOptions } from "../topics";
import type { Company } from "../types";
import { navigate } from "../routing";

type MemoryNote = {
  id: string; companyId: string; topic: string | null; stairwell: string; text: string;
  sources: { id: string; ticketNumber: number | null; subject: string }[];
  status: "proposed" | "approved" | "rejected"; validUntil: string | null; origin: "ai" | "manual";
  createdAt: string; decidedBy: string | null; decidedAt: string | null; updatedAt: string;
};
type MemoryList = { notes: MemoryNote[]; scannedAt: string | null; newCases: number };
type NoteFields = { text: string; topic: string | null; stairwell: string; validUntil: string | null };

const ANY_TOPIC = "";
const fieldTopicOptions = [{ value: ANY_TOPIC, label: t("Kaikki aiheet") }, ...topicOptions.filter(option => option.value !== "booking" && option.value !== "other")];

// Tiedon kentät: teksti, aihe, porras ja voimassaolo. Käytetään ehdotuksen muokkaukseen ja uuden lisäämiseen.
function NoteEditor({ initial, busy, submitLabel, onSubmit, onCancel, extra }: {
  initial: NoteFields; busy: boolean; submitLabel: string;
  onSubmit: (fields: NoteFields) => void; onCancel?: () => void; extra?: React.ReactNode;
}) {
  const [fields, setFields] = useState<NoteFields>(initial);
  const valid = fields.text.trim().length >= 5 && /^[A-Za-zÅÄÖåäö]{0,3}$/.test(fields.stairwell.trim());
  return (
    <div className="memory-editor ticket-form">
      <label>
        <span>{t("Tieto")}</span>
        <textarea value={fields.text} onChange={event => setFields({ ...fields, text: event.target.value })} rows={2} maxLength={500} />
      </label>
      <div className="memory-editor-row">
        <Dropdown
          label={t("Aihe")}
          value={fields.topic ?? ANY_TOPIC}
          options={fieldTopicOptions}
          onChange={value => setFields({ ...fields, topic: value || null })}
        />
        <label>
          <span>{t("Porras")}</span>
          <input
            value={fields.stairwell}
            onChange={event => setFields({ ...fields, stairwell: event.target.value.toUpperCase() })}
            maxLength={3}
            placeholder={t("koko taloyhtiö")}
          />
        </label>
        <label>
          <span>{t("Voimassa asti")}</span>
          <input type="date" value={fields.validUntil ?? ""} onChange={event => setFields({ ...fields, validUntil: event.target.value || null })} />
        </label>
      </div>
      <div className="draft-actions">
        <button className="primary" type="button" disabled={busy || !valid} onClick={() => onSubmit({ ...fields, text: fields.text.trim(), stairwell: fields.stairwell.trim() })}>
          {submitLabel}
        </button>
        {extra}
        {onCancel && <button type="button" disabled={busy} onClick={onCancel}>{t("Peruuta")}</button>}
      </div>
    </div>
  );
}

// Taloyhtiön muisti: AI ehdottaa ratkaistuista tehtävistä pysyviä tietoja, isännöitsijä hyväksyy ne.
// Vain hyväksytyt tiedot annetaan AI:lle vastausehdotuksissa, agentissa ja yhteisen vian tulkinnassa.
export function CompanyMemory({ companies, companyId }: { companies: Company[]; companyId: string }) {
  const [company, setCompany] = useState(companyId && companyId !== "all" ? companyId : companies[0]?.id ?? "");
  const [list, setList] = useState<MemoryList | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!company && companies[0]) setCompany(companies[0].id);
  }, [companies, company]);

  const load = () => company
    ? api<MemoryList>(`/companies/${encodeURIComponent(company)}/memory`).then(setList).catch(caught => setError(errorMessage(caught, t("Muistin lataus epäonnistui."))))
    : Promise.resolve();
  useEffect(() => {
    setList(null);
    setEditing(null);
    setAdding(false);
    setNotice("");
    void load();
  }, [company]);

  async function run(action: string, work: () => Promise<unknown>, done?: string) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      await work();
      if (done) setNotice(done);
      setEditing(null);
      await load();
    } catch (caught) {
      setError(errorMessage(caught, t("Toiminto epäonnistui. Yritä uudelleen.")));
    } finally {
      setBusy("");
    }
  }

  const save = (note: MemoryNote, fields: NoteFields, status: "approved" | "rejected") =>
    api(`/memory/${encodeURIComponent(note.id)}`, { method: "PUT", body: JSON.stringify({ ...fields, status }) });

  const proposed = list?.notes.filter(note => note.status === "proposed") ?? [];
  const approved = list?.notes.filter(note => note.status === "approved") ?? [];
  const rejected = list?.notes.filter(note => note.status === "rejected") ?? [];

  const meta = (note: MemoryNote) => (
    <p className="memory-meta">
      <span>{note.topic ? topicLabel(note.topic) : t("Kaikki aiheet")}, {placeLabel(note.stairwell)}</span>
      {note.validUntil && <span>{t("voimassa {0} asti", formatDateOnly(note.validUntil))}</span>}
      <span>{note.origin === "ai" ? t("AI:n ehdotus {0}", formatDate(note.createdAt)) : t("Lisätty käsin {0}", formatDate(note.createdAt))}</span>
      {note.decidedBy && note.status !== "proposed" && <span>{t("{0} hyväksyi", note.decidedBy)}</span>}
      {note.sources.map(source => (
        <button key={source.id} type="button" className="link-button" onClick={() => navigate("tickets", source.id)}>
          #{formatTicketNumber(source.ticketNumber)} {source.subject}
        </button>
      ))}
    </p>
  );
  const fieldsOf = (note: MemoryNote): NoteFields => ({ text: note.text, topic: note.topic, stairwell: note.stairwell, validUntil: note.validUntil });

  return (
    <div className="metrics company-memory">
      <div className="ticket-filters metrics-filters no-print">
        <Dropdown label={t("Taloyhtiö")} value={company} options={companies.map(item => ({ value: item.id, label: item.name }))} onChange={setCompany} />
      </div>

      <div className="report-card">
        <h2>{t("Taloyhtiön muisti")}</h2>
        <p className="muted">
          {t("AI käy läpi ratkaistut tehtävät ja yhteiset viat ja ehdottaa niistä pysyviä tietoja rakennuksesta, esimerkiksi toistuvan vian syyn tai tehdyn korjauksen. Vain hyväksymäsi tiedot annetaan AI:lle vastausehdotuksissa, AI-agentille ja yhteisen vian tulkintaan. Asukkaista ei tallenneta mitään.")}
        </p>
        {list && (
          <div className="draft-actions">
            <button
              className="primary"
              type="button"
              disabled={Boolean(busy) || list.newCases === 0}
              onClick={() => void run("propose", async () => {
                const result = await api<{ proposed: number; cases: number }>(`/companies/${encodeURIComponent(company)}/memory/propose`, { method: "POST" });
                setNotice(result.proposed ? t("AI ehdotti {0} uutta tietoa {1} ratkaisun perusteella.", result.proposed, result.cases) : t("AI ei löytänyt uutta muistettavaa."));
              })}
            >
              {busy === "propose" ? t("AI käy ratkaisuja läpi…") : t("Hae ehdotukset")}
            </button>
            <span className="reply-hint">
              {list.newCases
                ? t("{0} uutta ratkaisua edellisen haun jälkeen.", list.newCases)
                : t("Ei uusia ratkaisuja edellisen haun jälkeen. Kirjaa tehtäviä suljettaessa, mikä ratkaisi asian.")}
            </span>
          </div>
        )}
        {notice && <p className="saved-indicator" role="status">{notice}</p>}
        {error && <p className="send-error" role="alert">{error}</p>}
      </div>

      {!list && !error && <div className="empty">{t("Ladataan…")}</div>}

      {proposed.length > 0 && (
        <div className="report-card">
          <h2>{t("Hyväksyttävänä ({0})", proposed.length)}</h2>
          <ul className="memory-list">
            {proposed.map(note => (
              <li key={note.id}>
                <NoteEditor
                  initial={fieldsOf(note)}
                  busy={Boolean(busy)}
                  submitLabel={t("Hyväksy")}
                  onSubmit={fields => void run(`approve-${note.id}`, () => save(note, fields, "approved"), t("Tieto hyväksytty."))}
                  extra={(
                    <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => void run(`reject-${note.id}`, () => save(note, fieldsOf(note), "rejected"))}>
                      {t("Hylkää")}
                    </button>
                  )}
                />
                {meta(note)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {list && (
        <div className="report-card">
          <div className="memory-heading">
            <h2>{t("Käytössä ({0})", approved.length)}</h2>
            {!adding && <button type="button" onClick={() => setAdding(true)}>{t("Lisää tieto")}</button>}
          </div>
          {adding && (
            <NoteEditor
              initial={{ text: "", topic: null, stairwell: "", validUntil: null }}
              busy={Boolean(busy)}
              submitLabel={t("Lisää")}
              onSubmit={fields => void run("add", async () => {
                await api(`/companies/${encodeURIComponent(company)}/memory`, { method: "POST", body: JSON.stringify(fields) });
                setAdding(false);
              }, t("Tieto lisätty."))}
              onCancel={() => setAdding(false)}
            />
          )}
          {approved.length === 0 && !adding && <p className="muted">{t("Ei vielä hyväksyttyjä tietoja.")}</p>}
          <ul className="memory-list">
            {approved.map(note => (
              <li key={note.id}>
                {editing === note.id ? (
                  <NoteEditor
                    initial={fieldsOf(note)}
                    busy={Boolean(busy)}
                    submitLabel={t("Tallenna")}
                    onSubmit={fields => void run(`edit-${note.id}`, () => save(note, fields, "approved"), t("Tallennettu."))}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <div className="memory-text">
                    <p>{note.text}</p>
                    <div className="memory-actions">
                      <button type="button" className="quiet-button" disabled={Boolean(busy)} onClick={() => setEditing(note.id)}>{t("Muokkaa")}</button>
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          if (!window.confirm(t("Poistetaanko tieto muistista?"))) return;
                          void run(`delete-${note.id}`, () => api(`/memory/${encodeURIComponent(note.id)}`, { method: "DELETE" }));
                        }}
                      >
                        {t("Poista")}
                      </button>
                    </div>
                  </div>
                )}
                {meta(note)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rejected.length > 0 && (
        <div className="report-card">
          <h2>{t("Hylätyt (30 päivää)")}</h2>
          <ul className="memory-list rejected">
            {rejected.map(note => (
              <li key={note.id}>
                <div className="memory-text">
                  <p>{note.text}</p>
                  <div className="memory-actions">
                    <button type="button" className="quiet-button" disabled={Boolean(busy)} onClick={() => void run(`restore-${note.id}`, () => save(note, fieldsOf(note), "approved"), t("Tieto hyväksytty."))}>
                      {t("Hyväksy sittenkin")}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
