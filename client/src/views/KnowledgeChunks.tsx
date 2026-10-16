import { type FormEvent, useEffect, useState } from "react";
import { formatDateOnly } from "../format";
import { api, API, errorMessage, isManager, session } from "../session";
import type { KnowledgeChunk, KnowledgeDetail } from "../types";
import { t } from "../i18n";

const tagList = (tags: string) => tags.split(",").map(tag => tag.trim()).filter(Boolean);

// Avaa alkuperäisen PDF:n halutulta sivulta uuteen välilehteen. Tiedosto haetaan kirjautuneena, joten
// välilehti avataan heti (ponnahdusikkunan esto) ja osoite asetetaan, kun tiedosto on ladattu.
async function openPage(knowledgeId: string, page: number) {
  const tab = window.open("", "_blank");
  try {
    const response = await fetch(`${API}/knowledge/${knowledgeId}/file`, {
      headers: session ? { Authorization: `Bearer ${session.token}` } : {}
    });
    if (!response.ok) throw new Error(await response.text());
    const url = URL.createObjectURL(new Blob([await response.blob()], { type: "application/pdf" }));
    if (tab) tab.location.href = `${url}#page=${page}`;
    else window.location.href = `${url}#page=${page}`;
  } catch {
    tab?.close();
  }
}

// Tarkistamaton tieto merkitään tarkistetuksi painikkeella; sisältö ei muutu.
function ChunkStatus({ chunk, onVerify, busy }: { chunk: KnowledgeChunk; onVerify?: () => void; busy?: boolean }) {
  if (chunk.verified && !chunk.needs_review) return <span className="chunk-status verified">{t("✓ Tarkistettu")}</span>;
  const label = chunk.needs_review ? t("⚠ Tarkista") : t("Tarkistamatta");
  if (!onVerify) return <span className={`chunk-status${chunk.needs_review ? " review" : ""}`}>{label}</span>;
  return (
    <span className={`chunk-status${chunk.needs_review ? " review" : ""}`}>
      {label}
      <button type="button" className="chunk-verify" disabled={busy} onClick={onVerify} title={t("Merkitse tieto tarkistetuksi")}>
        {t("Merkitse tarkistetuksi")}
      </button>
    </span>
  );
}

// Muokkauslomake: otsikko, teksti ja avainsanat tavallisina kenttinä.
function ChunkEditor({ initial, submitLabel, busy, onSubmit, onCancel }: {
  initial: { title: string; content: string; tags: string };
  submitLabel: string;
  busy: boolean;
  onSubmit: (value: { title: string; content: string; tags: string[] }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [tags, setTags] = useState(initial.tags);
  return (
    <form
      className="chunk-editor"
      onSubmit={event => { event.preventDefault(); onSubmit({ title, content, tags: tagList(tags) }); }}
    >
      <label><span>{t("Otsikko")}</span><input value={title} onChange={event => setTitle(event.target.value)} required /></label>
      <label><span>{t("Teksti")}</span><textarea rows={5} value={content} onChange={event => setContent(event.target.value)} required /></label>
      <label>
        <span>{t("Avainsanat")}</span>
        <input value={tags} onChange={event => setTags(event.target.value)} placeholder={t("Esim. fillari, pyörä")} />
      </label>
      <div className="chunk-buttons">
        <button className="primary" type="submit" disabled={busy || !title.trim() || !content.trim()}>{busy ? t("Tallennetaan…") : submitLabel}</button>
        <button type="button" className="secondary" onClick={onCancel}>{t("Peru")}</button>
      </div>
    </form>
  );
}

type Draft = { title: string; content: string; tags: string[]; similar: { id: string; title: string; content: string } | null };
type Proposal = { title: string; content: string; tags: string[]; page: number | null; needsReview: boolean };
type Panel = "add" | "missing" | "test" | null;

// "Mitä AI poimi tästä": dokumentin palat, niiden tarkistus ja korjaaminen.
export function KnowledgeChunks({ detail, highlightChunkId, onValidityChanged }: {
  detail: KnowledgeDetail;
  highlightChunkId?: string | null;
  onValidityChanged: () => Promise<void>;
}) {
  const [chunks, setChunks] = useState<KnowledgeChunk[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [testHits, setTestHits] = useState<{ id: string; label: string; title: string; knowledgeId: string }[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(highlightChunkId ?? null);
  const canEdit = isManager() && detail.status === "active";
  const isPdf = /\.pdf$/i.test(detail.file_name ?? "");

  async function load() {
    try {
      setChunks(await api<KnowledgeChunk[]>(`/knowledge/${detail.id}/chunks`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    setChunks(null);
    setPanel(null);
    setEditing(null);
    void load();
  }, [detail.id, detail.state]);

  // Tehtävältä avattu lähdepala näytetään auki ja vieritetään näkyviin.
  useEffect(() => {
    if (!highlightChunkId || !chunks) return;
    setExpanded(highlightChunkId);
    document.getElementById(`chunk-${highlightChunkId}`)?.scrollIntoView({ block: "center" });
  }, [highlightChunkId, chunks]);

  function openPanel(next: Panel) {
    setPanel(current => current === next ? null : next);
    setText("");
    setDraft(null);
    setProposals(null);
    setTestHits(null);
    setError("");
  }

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (problem) {
      setError(errorMessage(problem, fallback));
    } finally {
      setBusy(false);
    }
  }

  const saveEdit = (chunkId: string, value: { title: string; content: string; tags: string[] }) => run(async () => {
    await api(`/knowledge-chunks/${chunkId}`, { method: "PUT", body: JSON.stringify(value) });
    setEditing(null);
    await load();
  }, t("Tallennus epäonnistui."));

  const verify = (chunkIds: string[]) => run(async () => {
    for (const chunkId of chunkIds) await api(`/knowledge-chunks/${chunkId}/verify`, { method: "POST" });
    await load();
  }, t("Tarkistetuksi merkitseminen epäonnistui."));
  const unverified = (chunks ?? []).filter(chunk => !chunk.verified || chunk.needs_review);

  const remove = (chunk: KnowledgeChunk) => {
    if (!window.confirm(t("Poistetaanko tieto \"{0}\"? AI ei enää käytä sitä.", chunk.title))) return;
    void run(async () => {
      await api(`/knowledge-chunks/${chunk.id}`, { method: "DELETE" });
      await load();
    }, t("Poisto epäonnistui."));
  };

  const acceptValidUntil = (date: string) => run(async () => {
    await api(`/knowledge/${detail.id}/validity`, {
      method: "PUT",
      body: JSON.stringify({ validFrom: detail.valid_from ?? "", validUntil: date })
    });
    await onValidityChanged();
  }, t("Voimassaolon tallennus epäonnistui."));

  const makeDraft = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setDraft(await api<Draft>(`/knowledge/${detail.id}/chunks/draft`, { method: "POST", body: JSON.stringify({ text }) }));
    }, t("Tiedon muotoilu epäonnistui."));
  };

  const saveDraft = (value: { title: string; content: string; tags: string[] }, replaceChunkId?: string) => run(async () => {
    await api(`/knowledge/${detail.id}/chunks`, {
      method: "POST",
      body: JSON.stringify({ ...value, origin: "manual", ...(replaceChunkId ? { replaceChunkId } : {}) })
    });
    openPanel(null);
    await load();
  }, t("Tallennus epäonnistui."));

  const findMissing = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await api<{ proposals: Proposal[] }>(`/knowledge/${detail.id}/chunks/missing`, {
        method: "POST", body: JSON.stringify({ note: text })
      });
      setProposals(result.proposals);
      setChosen(new Set(result.proposals.map((_, index) => index)));
    }, t("Sivujen lukeminen epäonnistui."));
  };

  const saveProposals = () => run(async () => {
    for (const [index, proposal] of (proposals ?? []).entries()) {
      if (!chosen.has(index)) continue;
      await api(`/knowledge/${detail.id}/chunks`, {
        method: "POST",
        body: JSON.stringify({ title: proposal.title, content: proposal.content, tags: proposal.tags, page: proposal.page, origin: "ai" })
      });
    }
    openPanel(null);
    await load();
  }, t("Tallennus epäonnistui."));

  const runTest = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await api<{ chunks: { id: string; label: string; title: string; knowledgeId: string }[] }>(
        `/companies/${encodeURIComponent(detail.company_id)}/knowledge/test`,
        { method: "POST", body: JSON.stringify({ question: text }) }
      );
      setTestHits(result.chunks);
    }, t("Haku epäonnistui."));
  };

  // AI:n dokumentista löytämä päättymispäivä, jota ei ole vielä otettu käyttöön.
  const suggestedUntil = !detail.valid_until
    ? chunks?.find(chunk => chunk.suggested_valid_until)?.suggested_valid_until ?? null
    : null;
  const hitIds = new Set((testHits ?? []).map(hit => hit.id));

  return (
    <section className="drawer-section knowledge-chunks">
      <div className="chunk-header">
        <h3>{t("Mitä AI poimi tästä")}</h3>
        {canEdit && unverified.length > 1 && (
          <button type="button" className="chunk-verify" disabled={busy} onClick={() => void verify(unverified.map(chunk => chunk.id))}>
            {t("Merkitse kaikki tarkistetuiksi ({0})", unverified.length)}
          </button>
        )}
      </div>
      <p className="muted chunk-summary">
        {detail.state === "processing" ? t("Käsitellään…")
          : chunks ? t("{0} tietoa · {1} tarkistamatta", String(chunks.length), String(unverified.length)) : null}
      </p>
      {failed && <p className="send-error">{t("Tietojen lataus epäonnistui.")}</p>}

      {suggestedUntil && (
        <div className="chunk-suggestion">
          <span>{t("AI löysi dokumentista päättymispäivän {0}. Sitä ei ole otettu käyttöön.", formatDateOnly(suggestedUntil))}</span>
          {canEdit && (
            <button type="button" className="secondary" disabled={busy} onClick={() => void acceptValidUntil(suggestedUntil)}>
              {t("Aseta voimassaolon päättymiseksi")}
            </button>
          )}
        </div>
      )}

      {chunks && chunks.length === 0 && <p className="muted">{t("Dokumentista ei ole vielä poimittu tietoja.")}</p>}
      <ul className="chunk-list">
        {chunks?.map(chunk => (
          <li
            key={chunk.id}
            id={`chunk-${chunk.id}`}
            className={`chunk-row${chunk.id === highlightChunkId ? " highlight" : ""}${hitIds.has(chunk.id) ? " hit" : ""}`}
          >
            {editing === chunk.id ? (
              <ChunkEditor
                initial={{ title: chunk.title, content: chunk.content, tags: chunk.tags }}
                submitLabel={t("Tallenna")}
                busy={busy}
                onSubmit={value => void saveEdit(chunk.id, value)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <>
                <div className="chunk-head">
                  <button type="button" className="chunk-title" onClick={() => setExpanded(current => current === chunk.id ? null : chunk.id)}>
                    {chunk.title}
                  </button>
                  <ChunkStatus chunk={chunk} busy={busy} onVerify={canEdit ? () => void verify([chunk.id]) : undefined} />
                  {chunk.page ? (
                    isPdf ? (
                      <button type="button" className="back-link chunk-page" onClick={() => void openPage(detail.id, chunk.page!)}>
                        {t("s. {0}", String(chunk.page))}
                      </button>
                    ) : <span className="chunk-page">{t("s. {0}", String(chunk.page))}</span>
                  ) : null}
                  {canEdit && (
                    <span className="knowledge-entry-actions">
                      <button type="button" onClick={() => setEditing(chunk.id)}>{t("Muokkaa")}</button>
                      <button type="button" className="danger" disabled={busy} onClick={() => remove(chunk)}>{t("Poista")}</button>
                    </span>
                  )}
                </div>
                {expanded === chunk.id && (
                  <>
                    <p className="knowledge-content">{chunk.content}</p>
                    {chunk.tags && <p className="muted chunk-tags">{t("Avainsanat:")}{" "}{chunk.tags}</p>}
                  </>
                )}
              </>
            )}
          </li>
        ))}
      </ul>

      <div className="knowledge-entry-actions">
        {canEdit && <button type="button" onClick={() => openPanel("add")}>{t("+ Lisää tieto")}</button>}
        {canEdit && detail.kind === "document" && (
          <button type="button" onClick={() => openPanel("missing")}>{t("Jäikö jotain puuttumaan?")}</button>
        )}
        <button type="button" onClick={() => openPanel("test")}>{t("Kokeile kysymyksellä")}</button>
      </div>

      {panel === "add" && (
        draft ? (
          <div className="chunk-panel">
            {draft.similar && (
              <p className="chunk-suggestion">
                {t("Dokumentissa on jo samankaltainen tieto \"{0}\". Voit päivittää sen uuden lisäämisen sijaan.", draft.similar.title)}
              </p>
            )}
            <ChunkEditor
              initial={{ title: draft.title, content: draft.content, tags: draft.tags.join(", ") }}
              submitLabel={draft.similar ? t("Lisää uutena") : t("Tallenna")}
              busy={busy}
              onSubmit={value => void saveDraft(value)}
              onCancel={() => openPanel(null)}
            />
            {draft.similar && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void saveDraft({ title: draft.title, content: draft.content, tags: draft.tags }, draft.similar!.id)}
              >
                {t("Päivitä \"{0}\"", draft.similar.title)}
              </button>
            )}
          </div>
        ) : (
          <form className="chunk-panel" onSubmit={makeDraft}>
            <label>
              <span>{t("Kirjoita tieto omin sanoin. AI muotoilee sen ja ehdottaa avainsanat, ja näet tuloksen ennen tallennusta.")}</span>
              <textarea rows={4} value={text} onChange={event => setText(event.target.value)} />
            </label>
            <div className="chunk-buttons">
              <button className="primary" type="submit" disabled={busy || !text.trim()}>{busy ? t("Muotoillaan…") : t("Esikatsele")}</button>
              <button type="button" className="secondary" onClick={() => openPanel(null)}>{t("Peru")}</button>
            </div>
          </form>
        )
      )}

      {panel === "missing" && (
        proposals ? (
          <div className="chunk-panel">
            {proposals.length === 0 ? <p className="muted">{t("Mainituilta sivuilta ei löytynyt uusia tietoja.")}</p> : (
              <ul className="chunk-list">
                {proposals.map((proposal, index) => (
                  <li key={index} className="chunk-row">
                    <label className="chunk-choice">
                      <input
                        type="checkbox"
                        checked={chosen.has(index)}
                        onChange={event => setChosen(current => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(index); else next.delete(index);
                          return next;
                        })}
                      />
                      <strong>{proposal.title}</strong>
                      {proposal.page ? <span className="chunk-page">{t("s. {0}", String(proposal.page))}</span> : null}
                      {proposal.needsReview && <span className="chunk-status review">{t("⚠ tarkista")}</span>}
                    </label>
                    <p className="knowledge-content">{proposal.content}</p>
                  </li>
                ))}
              </ul>
            )}
            <div className="chunk-buttons">
              {proposals.length > 0 && (
                <button className="primary" type="button" disabled={busy || chosen.size === 0} onClick={() => void saveProposals()}>
                  {t("Tallenna valitut")}
                </button>
              )}
              <button type="button" className="secondary" onClick={() => openPanel(null)}>{t("Peru")}</button>
            </div>
          </div>
        ) : (
          <form className="chunk-panel" onSubmit={findMissing}>
            <label>
              <span>{t("Kerro, mitä puuttuu ja miltä sivulta. AI lukee vain mainitut sivut uudelleen.")}</span>
              <input value={text} onChange={event => setText(event.target.value)} placeholder={t("Esim. pysäköintisäännöt sivulta 7 puuttuu")} />
            </label>
            <div className="chunk-buttons">
              <button className="primary" type="submit" disabled={busy || !text.trim()}>{busy ? t("Luetaan…") : t("Hae puuttuvat")}</button>
              <button type="button" className="secondary" onClick={() => openPanel(null)}>{t("Peru")}</button>
            </div>
          </form>
        )
      )}

      {panel === "test" && (
        <form className="chunk-panel" onSubmit={runTest}>
          <label>
            <span>{t("Kysy kuten asukas kysyisi. Näet, mitkä tiedot AI saisi vastausehdotukseen.")}</span>
            <input value={text} onChange={event => { setText(event.target.value); setTestHits(null); }} placeholder={t("Esim. Miten saunavuoro varataan?")} />
          </label>
          <div className="chunk-buttons">
            <button className="primary" type="submit" disabled={busy || !text.trim()}>{busy ? t("Haetaan…") : t("Kokeile")}</button>
          </div>
          {testHits && (testHits.length === 0
            ? <p className="muted">{t("Kysymykseen ei osunut yhtään tietoa. AI ei saisi dokumentaatiosta mitään.")}</p>
            : (
              <ol className="chunk-hits">
                {testHits.map(hit => (
                  <li key={hit.id}>
                    {hit.title}{" "}<span className="muted">({hit.label}){hit.knowledgeId !== detail.id ? ` · ${t("toinen dokumentti")}` : ""}</span>
                  </li>
                ))}
              </ol>
            ))}
        </form>
      )}

      {error && <p className="send-error">{error}</p>}
    </section>
  );
}
