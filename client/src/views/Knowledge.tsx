import { type FormEvent, useEffect, useState } from "react";
import { DownloadLink, usePaged } from "../components/common";
import { formatDate, formatDay } from "../format";
import { api, API, errorMessage, isManager, session } from "../session";
import type { Company, KnowledgeDetail, KnowledgeEntry } from "../types";

function knowledgeStateLabel(state: string) {
  return {
    in_use: "AI:n käytössä",
    expired: "Vanhentunut – ei AI:n käytössä",
    upcoming: "Ei vielä voimassa – ei AI:n käytössä",
    unreadable: "Tekstiä ei saatu luettua – ei AI:n käytössä",
    replaced: "Korvattu uudella versiolla",
    deleted: "Poistettu"
  }[state] || state;
}

function validityLabel(entry: KnowledgeEntry) {
  if (entry.valid_from && entry.valid_until) return `Voimassa ${formatDay(entry.valid_from)}–${formatDay(entry.valid_until)}`;
  if (entry.valid_from) return `Voimassa ${formatDay(entry.valid_from)} alkaen`;
  if (entry.valid_until) return `Voimassa ${formatDay(entry.valid_until)} asti`;
  return "Voimassa toistaiseksi";
}

type KnowledgeFormState =
  | { mode: "fact" | "document"; replaces?: KnowledgeEntry }
  | { mode: "validity"; entry: KnowledgeEntry };

export function Knowledge({
  companyId,
  companies,
  initialEntryId,
  onCompanyChange
}: {
  companyId: string;
  companies: Company[];
  initialEntryId: string | null;
  onCompanyChange: (companyId: string) => void;
}) {
  return (
    <section className="content">
      <div className="ticket-filters">
        <label>
          <span>Taloyhtiö</span>
          <select value={companyId} onChange={event => onCompanyChange(event.target.value)}>
            {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </label>
      </div>
      <KnowledgeBase companyId={companyId} initialEntryId={initialEntryId} />
    </section>
  );
}

export function KnowledgeBase({ companyId, initialEntryId = null }: { companyId: string; initialEntryId?: string | null }) {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [form, setForm] = useState<KnowledgeFormState | null>(null);
  const [openEntryId, setOpenEntryId] = useState<string | null>(initialEntryId);
  const pagedEntries = usePaged(entries, companyId);
  const [notice, setNotice] = useState("");
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<KnowledgeEntry[]>([]);
  const [question, setQuestion] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { found: boolean; answer?: string; source?: { id: string; title: string } } | null
  >(null);

  async function loadEntries() {
    try {
      setEntries(await api<KnowledgeEntry[]>(`/companies/${encodeURIComponent(companyId)}/knowledge`));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setHistoryFor(null);
    setTestResult(null);
    setQuestion("");
    setNotice("");
    void loadEntries();
  }, [companyId]);

  async function toggleHistory(entry: KnowledgeEntry) {
    if (historyFor === entry.id) {
      setHistoryFor(null);
      return;
    }
    setHistory(await api<KnowledgeEntry[]>(`/knowledge/${entry.id}/history`));
    setHistoryFor(entry.id);
  }

  async function removeEntry(entry: KnowledgeEntry) {
    if (!window.confirm(`Poistetaanko "${entry.title}"? Se poistuu AI:n käytöstä.`)) return;
    await api(`/knowledge/${entry.id}`, { method: "DELETE" });
    setNotice("");
    await loadEntries();
  }

  async function runTest(event: FormEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    setTesting(true);
    try {
      setTestResult(await api(`/companies/${encodeURIComponent(companyId)}/knowledge/test`, {
        method: "POST",
        body: JSON.stringify({ question })
      }));
    } catch {
      setTestResult(null);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="knowledge-base">
      <p className="muted knowledge-intro">
        Yhtiön dokumentit ja vakiotiedot, joiden pohjalta AI tekee luonnokset. AI ei käytä muita lähteitä
        yhtiön tiedoista, eikä näitä tietoja käytetä muiden yhtiöiden luonnoksissa.
      </p>

      <div className="residents-toolbar">
        <span>{entries.length} tietuetta</span>
        {isManager() && (
          <div className="toolbar-actions">
            <button className="secondary" onClick={() => setForm({ mode: "document" })}>Lataa dokumentti</button>
            <button className="secondary" onClick={() => setForm({ mode: "fact" })}>Lisää vakiotieto</button>
          </div>
        )}
      </div>

      <form className="settings-card knowledge-test" onSubmit={runTest}>
        <h2>Testaa</h2>
        <p className="muted">Kysy kysymys ja näe, minkä vastauksen ja lähteen AI käyttäisi.</p>
        <div className="reporter-link">
          <input
            value={question}
            onChange={event => { setQuestion(event.target.value); setTestResult(null); }}
            placeholder="Esim. Miten saunavuoro varataan?"
          />
          <button type="submit" disabled={testing || !question.trim()}>
            {testing ? "Haetaan…" : "Testaa"}
          </button>
        </div>
        {testResult && (testResult.found ? (
          <div className="test-result">
            <p>{testResult.answer}</p>
            <span className="source-pill">Lähde: {testResult.source?.title}</span>
          </div>
        ) : (
          <p className="test-result muted">
            AI ei löytänyt vastausta tämän yhtiön tiedoista. Asia siirtyisi isännöitsijälle.
          </p>
        ))}
      </form>

      {notice && <p className="send-error">{notice}</p>}

      {loading ? <div className="empty">Ladataan…</div>
        : loadError ? <div className="empty">Tietojen lataus epäonnistui.</div>
        : entries.length === 0 ? <div className="empty">Tällä taloyhtiöllä ei ole vielä dokumentteja tai vakiotietoja.</div>
        : pagedEntries.items.map(entry => (
          <article
            className="knowledge-entry clickable"
            key={entry.id}
            title="Avaa tietokortti"
            onClick={() => setOpenEntryId(entry.id)}
            onKeyDown={event => {
              if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                setOpenEntryId(entry.id);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div className="knowledge-entry-top">
              <span className="type">{entry.kind === "document" ? "Dokumentti" : "Vakiotieto"}</span>
              <span className={`knowledge-state ${entry.state}`}>{knowledgeStateLabel(entry.state)}</span>
              <span className="date">{validityLabel(entry)} · versio {entry.version}</span>
            </div>
            <h2>{entry.title}</h2>
            {entry.tags && (
              <div className="knowledge-tags">
                {entry.tags.split(",").map(tag => tag.trim()).filter(Boolean).map(tag => <span key={tag}>{tag}</span>)}
              </div>
            )}
            {entry.kind === "document" && entry.file_name && (
              <DownloadLink className="knowledge-file" path={`/knowledge/${entry.id}/file`} filename={entry.file_name}>
                {entry.file_name}
              </DownloadLink>
            )}
            <p>
              {entry.content || "Ei luettua tekstiä."}
              {entry.content_length > entry.content.length ? "…" : ""}
            </p>
            <div className="knowledge-entry-actions" onClick={event => event.stopPropagation()}>
              {isManager() && <button onClick={() => setForm({ mode: "validity", entry })}>Voimassaoloaika</button>}
              {isManager() && <button onClick={() => setForm({ mode: entry.kind, replaces: entry })}>Korvaa</button>}
              <button onClick={() => toggleHistory(entry)}>
                {historyFor === entry.id ? "Piilota historia" : "Historia"}
              </button>
              {isManager() && <button className="danger" onClick={() => removeEntry(entry)}>Poista</button>}
            </div>
            {historyFor === entry.id && (
              <div className="knowledge-history" onClick={event => event.stopPropagation()}>
                {history.map(version => (
                  <div className="audit" key={version.id}>
                    <strong>Versio {version.version}: {version.title}</strong>
                    <span>
                      {version.id === entry.id ? "Nykyinen" : knowledgeStateLabel(version.state)} · {formatDate(version.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}

      {!loading && !loadError && pagedEntries.pager}

      {openEntryId && !form && (
        <KnowledgeDetailDrawer
          entryId={openEntryId}
          onOpenVersion={setOpenEntryId}
          onClose={() => setOpenEntryId(null)}
          onEdit={(mode, entry) => setForm(mode === "validity" ? { mode, entry } : { mode: entry.kind, replaces: entry })}
          onRemove={async entry => {
            await removeEntry(entry);
            setOpenEntryId(null);
          }}
        />
      )}

      {form && (
        <KnowledgeFormModal
          companyId={companyId}
          form={form}
          onClose={() => setForm(null)}
          onDone={async message => {
            setForm(null);
            setOpenEntryId(null);
            setHistoryFor(null);
            setNotice(message);
            await loadEntries();
          }}
        />
      )}
    </div>
  );
}

function KnowledgeDetailDrawer({
  entryId,
  onOpenVersion,
  onClose,
  onEdit,
  onRemove
}: {
  entryId: string;
  onOpenVersion: (entryId: string) => void;
  onClose: () => void;
  onEdit: (mode: "validity" | "replace", entry: KnowledgeEntry) => void;
  onRemove: (entry: KnowledgeEntry) => Promise<void>;
}) {
  const [detail, setDetail] = useState<KnowledgeDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setDetail(null);
    setFailed(false);
    api<KnowledgeDetail>(`/knowledge/${entryId}`)
      .then(setDetail)
      .catch(() => setFailed(true));
  }, [entryId]);

  const isCurrent = detail?.status === "active";

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer" onClick={event => event.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        {failed ? <p className="send-error">Tietojen lataus epäonnistui.</p>
          : !detail ? <p className="muted">Ladataan…</p> : (
          <>
            <span className="type">{detail.kind === "document" ? "Dokumentti" : "Vakiotieto"}</span>
            <h2>{detail.title}</h2>

            <dl className="ticket-facts">
              <div>
                <dt>Taloyhtiö</dt>
                <dd>{detail.company_name || "-"}</dd>
              </div>
              <div>
                <dt>Tila</dt>
                <dd><span className={`knowledge-state ${detail.state}`}>{knowledgeStateLabel(detail.state)}</span></dd>
              </div>
              <div>
                <dt>Voimassaolo</dt>
                <dd>{validityLabel(detail)}</dd>
              </div>
              <div>
                <dt>Versio</dt>
                <dd>{detail.version} / {detail.versions.length}</dd>
              </div>
              <div>
                <dt>Lisätty</dt>
                <dd>{formatDate(detail.created_at)}</dd>
              </div>
              {detail.kind === "document" && (
                <div>
                  <dt>Tiedosto</dt>
                  <dd>
                    {detail.file_name ? (
                      <DownloadLink className="knowledge-file" path={`/knowledge/${detail.id}/file`} filename={detail.file_name}>
                        {detail.file_name}
                      </DownloadLink>
                    ) : "-"}
                  </dd>
                </div>
              )}
              {detail.kind === "document" && (
                <div>
                  <dt>Luettu teksti</dt>
                  <dd>{detail.content_length.toLocaleString("fi-FI")} merkkiä</dd>
                </div>
              )}
            </dl>

            {isCurrent && isManager() && (
              <div className="knowledge-entry-actions">
                <button onClick={() => onEdit("validity", detail)}>Voimassaoloaika</button>
                <button onClick={() => onEdit("replace", detail)}>Korvaa</button>
                <button className="danger" onClick={() => onRemove(detail)}>Poista</button>
              </div>
            )}

            <section className="drawer-section">
              <h3>{detail.kind === "document" ? "Dokumentista luettu teksti" : "Vastaus"}</h3>
              <p className="knowledge-content">
                {detail.content || "Tekstiä ei saatu luettua, joten AI ei voi käyttää tätä dokumenttia."}
              </p>
            </section>

            <section className="drawer-section">
              <h3>Versiohistoria</h3>
              {detail.versions.map(version => (
                <div className="audit" key={version.id}>
                  {version.id === detail.id
                    ? <strong>Versio {version.version}: {version.title} (tämä)</strong>
                    : (
                      <button className="back-link" onClick={() => onOpenVersion(version.id)}>
                        Versio {version.version}: {version.title}
                      </button>
                    )}
                  <span>{knowledgeStateLabel(version.state)} · {formatDate(version.created_at)}</span>
                </div>
              ))}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

function KnowledgeFormModal({
  companyId,
  form,
  onClose,
  onDone
}: {
  companyId: string;
  form: KnowledgeFormState;
  onClose: () => void;
  onDone: (notice: string) => Promise<void>;
}) {
  const current = form.mode === "validity" ? form.entry : form.replaces;
  const [title, setTitle] = useState(current?.title ?? "");
  const [answer, setAnswer] = useState(form.mode === "fact" ? current?.content ?? "" : "");
  const [file, setFile] = useState<File | null>(null);
  const [validFrom, setValidFrom] = useState(current?.valid_from ?? "");
  const [validUntil, setValidUntil] = useState(current?.valid_until ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const heading = form.mode === "validity" ? "Merkitse voimassaoloaika"
    : form.mode === "document" ? (form.replaces ? "Korvaa dokumentti" : "Lataa dokumentti")
    : (form.replaces ? "Korvaa vakiotieto" : "Lisää vakiotieto");

  const canSubmit = form.mode === "validity" ? true
    : form.mode === "document" ? Boolean(file)
    : Boolean(title.trim() && answer.trim());

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (form.mode === "validity") {
        await api(`/knowledge/${form.entry.id}/validity`, {
          method: "PUT",
          body: JSON.stringify({ validFrom, validUntil })
        });
        await onDone("");
      } else if (form.mode === "fact") {
        await api(`/companies/${encodeURIComponent(companyId)}/knowledge/facts`, {
          method: "POST",
          body: JSON.stringify({ question: title, answer, validFrom, validUntil, replaces: form.replaces?.id })
        });
        await onDone("");
      } else if (file) {
        const params = new URLSearchParams({ fileName: file.name, mimeType: file.type, title, validFrom, validUntil });
        if (form.replaces) params.set("replaces", form.replaces.id);
        const response = await fetch(
          `${API}/companies/${encodeURIComponent(companyId)}/knowledge/documents?${params}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              ...(session ? { Authorization: `Bearer ${session.token}` } : {})
            },
            body: file
          }
        );
        if (!response.ok) throw new Error(await response.text());
        const result = await response.json() as { extractionOk: boolean };
        await onDone(result.extractionOk
          ? ""
          : `Dokumentti "${file.name}" tallennettiin, mutta sen tekstiä ei saatu luettua. Se ei ole AI:n käytössä.`);
      }
    } catch (caught) {
      setError(errorMessage(caught, "Tallennus epäonnistui."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer form-drawer" onClick={event => event.stopPropagation()}>
        <button className="close" onClick={onClose}>×</button>
        <h2>{heading}</h2>
        <p className="muted">
          {form.mode === "validity"
            ? `${form.entry.title}. Vanhentunut tietue poistuu AI:n käytöstä.`
            : form.replaces
            ? "Uusi versio korvaa vanhan. Vanha versio säilyy historiassa."
            : form.mode === "document"
            ? "PDF, Word (.docx) tai kuva. Teksti luetaan automaattisesti."
            : "Lyhyt kysymys–vastaus-pari, esim. ”saunavuorot varataan huoltoyhtiöltä”."}
        </p>

        <form className="ticket-form" onSubmit={handleSubmit}>
          {form.mode === "document" && (
            <>
              <label>
                <span>Tiedosto</span>
                <input
                  type="file"
                  accept=".pdf,.docx,.txt,image/*"
                  onChange={event => setFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <label>
                <span>Otsikko</span>
                <input value={title} onChange={event => setTitle(event.target.value)} placeholder="Esim. Järjestyssäännöt (oletuksena tiedoston nimi)" />
              </label>
            </>
          )}

          {form.mode === "fact" && (
            <>
              <label>
                <span>Kysymys tai aihe</span>
                <input value={title} onChange={event => setTitle(event.target.value)} placeholder="Esim. Miten saunavuoro varataan?" />
              </label>
              <label>
                <span>Vastaus</span>
                <textarea value={answer} onChange={event => setAnswer(event.target.value)} rows={5} placeholder="Esim. Saunavuorot varataan huoltoyhtiöltä." />
              </label>
            </>
          )}

          <div className="form-columns">
            <label>
              <span>Voimassa alkaen</span>
              <input type="date" value={validFrom} onChange={event => setValidFrom(event.target.value)} />
            </label>
            <label>
              <span>Voimassa asti</span>
              <input type="date" value={validUntil} onChange={event => setValidUntil(event.target.value)} />
            </label>
          </div>
          <p className="reply-hint">Jätä tyhjäksi, jos tieto on voimassa toistaiseksi.</p>

          {error && <p className="send-error">{error}</p>}

          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>Peruuta</button>
            <button className="primary" type="submit" disabled={submitting || !canSubmit}>
              {submitting ? (form.mode === "document" ? "Luetaan tekstiä…" : "Tallennetaan…") : "Tallenna"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
