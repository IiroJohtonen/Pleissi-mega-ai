import { type FormEvent, useEffect, useState } from "react";
import { DownloadLink, FactDropdown, usePaged } from "../components/common";
import { formatDate, formatDateOnly, formatDay } from "../format";
import { api, API, errorMessage, isManager, session } from "../session";
import type { Company, KnowledgeDetail, KnowledgeEntry } from "../types";
import { locale, t } from "../i18n";

// Kenelle tietue on: AI-dokumentaatiota AI käyttää vastausehdotuksissa, sisäinen on vain henkilökunnalle.
export type KnowledgeAudience = "ai" | "internal";

function knowledgeStateLabel(state: string) {
  return {
    in_use: t("AI:n käytössä"),
    internal: t("Sisäinen – vain henkilökunnalle"),
    expired: t("Vanhentunut – ei AI:n käytössä"),
    upcoming: t("Ei vielä voimassa – ei AI:n käytössä"),
    unreadable: t("Tekstiä ei saatu luettua – ei AI:n käytössä"),
    replaced: t("Korvattu uudella versiolla"),
    deleted: t("Poistettu")
  }[state] || state;
}

// Tilan lyhyt nimi listan sarakkeeseen.
function knowledgeStateShort(state: string) {
  return {
    in_use: t("AI:n käytössä"),
    internal: t("Sisäinen käyttö"),
    expired: t("Vanhentunut"),
    upcoming: t("Ei vielä voimassa"),
    unreadable: t("Teksti lukematta")
  }[state] || knowledgeStateLabel(state);
}

const kindLabel = (kind: string) => kind === "document" ? t("Dokumentti") : t("Vakiotieto");
const audienceLabel = (audience: string) => audience === "internal" ? t("Sisäinen") : t("AI");
const audienceOptions = [
  { value: "ai", label: t("AI"), pillClass: "knowledge-audience ai" },
  { value: "internal", label: t("Sisäinen"), pillClass: "knowledge-audience internal" }
];

function validityLabel(entry: KnowledgeEntry) {
  if (entry.valid_from && entry.valid_until) return t("Voimassa {0}–{1}", formatDay(entry.valid_from), formatDay(entry.valid_until));
  if (entry.valid_from) return t("Voimassa {0} alkaen", formatDay(entry.valid_from));
  if (entry.valid_until) return t("Voimassa {0} asti", formatDay(entry.valid_until));
  return t("Voimassa toistaiseksi");
}

// Voimassaolo listan sarakkeessa ilman sanaa "Voimassa".
function validityShort(entry: KnowledgeEntry) {
  if (entry.valid_from && entry.valid_until) return `${formatDay(entry.valid_from)}–${formatDay(entry.valid_until)}`;
  if (entry.valid_from) return t("{0} alkaen", formatDay(entry.valid_from));
  if (entry.valid_until) return t("{0} asti", formatDay(entry.valid_until));
  return t("Toistaiseksi");
}

type KnowledgeSortKey = "title" | "kind" | "audience" | "state" | "validity" | "created";
type KnowledgeSort = { key: KnowledgeSortKey; descending: boolean };

// Listan sarakkeet samassa järjestyksessä kuin rivin kentät.
const knowledgeColumns: { key: KnowledgeSortKey; label: string }[] = [
  { key: "title", label: t("Otsikko") },
  { key: "kind", label: t("Tyyppi") },
  { key: "audience", label: t("Käyttö") },
  { key: "state", label: t("Tila") },
  { key: "validity", label: t("Voimassa") },
  { key: "created", label: t("Lisätty") }
];

// Sarakkeessa näkyvä teksti, josta sarakekohtainen haku etsii.
function knowledgeColumnText(entry: KnowledgeEntry, key: KnowledgeSortKey) {
  switch (key) {
    case "title": return `${entry.title} ${entry.tags ?? ""} ${entry.content}`;
    case "kind": return kindLabel(entry.kind);
    case "audience": return audienceLabel(entry.audience);
    case "state": return knowledgeStateShort(entry.state);
    case "validity": return validityShort(entry);
    case "created": return formatDateOnly(entry.created_at);
  }
}

function compareKnowledge(a: KnowledgeEntry, b: KnowledgeEntry, key: KnowledgeSortKey) {
  switch (key) {
    case "title": return a.title.localeCompare(b.title, "fi", { numeric: true });
    // Päättymätön voimassaolo järjestyy viimeiseksi.
    case "validity": return (a.valid_until ?? "9999").localeCompare(b.valid_until ?? "9999");
    case "created": return a.created_at.localeCompare(b.created_at);
    default: return knowledgeColumnText(a, key).localeCompare(knowledgeColumnText(b, key), "fi");
  }
}

type KnowledgeFormState =
  | { mode: "fact" | "document"; replaces?: KnowledgeEntry }
  | { mode: "validity"; entry: KnowledgeEntry };

// Dokumentaatio: audience rajaa näkymän AI-dokumentaatioon tai sisäiseen; ilman sitä näytetään kaikki.
export function Knowledge({
  companyId,
  companies,
  initialEntryId,
  audience,
  onCompanyChange
}: {
  companyId: string;
  companies: Company[];
  initialEntryId: string | null;
  audience?: KnowledgeAudience;
  onCompanyChange: (companyId: string) => void;
}) {
  return (
    <section className="content">
      {audience && <a className="back-link" href="#/knowledge">{t("← Dokumentaatio")}</a>}
      <KnowledgeBase
        companyId={companyId}
        initialEntryId={initialEntryId}
        audience={audience}
        companies={companies}
        onCompanyChange={onCompanyChange}
      />
    </section>
  );
}

export function KnowledgeBase({
  companyId,
  initialEntryId = null,
  audience,
  companies,
  onCompanyChange
}: {
  companyId: string;
  initialEntryId?: string | null;
  audience?: KnowledgeAudience;
  // Taloyhtiön valinta suodattimissa; puuttuu, kun näkymä on taloyhtiön omalla sivulla.
  companies?: Company[];
  onCompanyChange?: (companyId: string) => void;
}) {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [form, setForm] = useState<KnowledgeFormState | null>(null);
  const [openEntryId, setOpenEntryId] = useState<string | null>(initialEntryId);
  const [notice, setNotice] = useState("");
  const [moveListError, setMoveListError] = useState("");
  const [question, setQuestion] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { found: boolean; answer?: string; source?: { id: string; title: string } } | null
  >(null);
  // Suodattimet, sarakekohtainen haku ja järjestys toimivat kuten tehtävälistassa.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // AI:n testaus avataan työkalurivin painikkeesta, jotta lista on heti näkyvissä.
  const [testOpen, setTestOpen] = useState(false);
  const [kindFilter, setKindFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [audienceFilter, setAudienceFilter] = useState("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [columnSearch, setColumnSearch] = useState<Partial<Record<KnowledgeSortKey, string>>>({});
  const [sort, setSort] = useState<KnowledgeSort>({ key: "title", descending: false });

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
    setTestResult(null);
    setQuestion("");
    setNotice("");
    void loadEntries();
  }, [companyId]);

  async function removeEntry(entry: KnowledgeEntry) {
    const question = entry.audience === "internal"
      ? t("Poistetaanko \"{0}\"?", entry.title)
      : t("Poistetaanko \"{0}\"? Se poistuu AI:n käytöstä.", entry.title);
    if (!window.confirm(question)) return;
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

  function sortBy(key: KnowledgeSortKey) {
    setSort(current => current.key === key ? { key, descending: !current.descending } : { key, descending: false });
  }

  // Käyttö-sarake näkyy aina, jotta tietueen voi siirtää suoraan listasta toiseen dokumentaatioon.
  const columns = knowledgeColumns;
  const colsClass = "knowledge-cols with-audience";

  // Siirtää tietueen AI-dokumentaation ja sisäisen dokumentaation välillä suoraan listasta.
  async function changeAudience(entry: KnowledgeEntry, next: KnowledgeAudience) {
    if (next === entry.audience) return;
    setNotice("");
    setMoveListError("");
    try {
      await api(`/knowledge/${entry.id}/audience`, { method: "PUT", body: JSON.stringify({ audience: next }) });
      await loadEntries();
      setNotice(next === "internal"
        ? t("\u201d{0}\u201d siirrettiin sisäiseen dokumentaatioon.", entry.title)
        : t("\u201d{0}\u201d siirrettiin AI:n käyttöön.", entry.title));
    } catch (error) {
      setMoveListError(errorMessage(error, t("Siirto epäonnistui.")));
    }
  }
  const inAudience = entries.filter(entry => !audience || entry.audience === audience);
  const searches = Object.entries(columnSearch).filter(([, value]) => value?.trim()) as [KnowledgeSortKey, string][];
  const visible = inAudience
    .filter(entry => (kindFilter === "all" || entry.kind === kindFilter)
      && (stateFilter === "all" || entry.state === stateFilter)
      && (audience || audienceFilter === "all" || entry.audience === audienceFilter)
      && searches.every(([key, value]) => knowledgeColumnText(entry, key).toLowerCase().includes(value.trim().toLowerCase())))
    .sort((a, b) => compareKnowledge(a, b, sort.key) * (sort.descending ? -1 : 1));
  const paged = usePaged(visible, `${companyId}|${audience}|${kindFilter}|${stateFilter}|${audienceFilter}|${sort.key}|${sort.descending}|${JSON.stringify(columnSearch)}`);

  const states = [...new Set(inAudience.map(entry => entry.state))];
  const activeFilters: { key: string; label: string; value: string; clear: () => void }[] = [
    ...(kindFilter !== "all" ? [{ key: "kind", label: t("Tyyppi"), value: kindLabel(kindFilter), clear: () => setKindFilter("all") }] : []),
    ...(!audience && audienceFilter !== "all"
      ? [{ key: "audience", label: t("Käyttö"), value: audienceLabel(audienceFilter), clear: () => setAudienceFilter("all") }]
      : []),
    ...(stateFilter !== "all" ? [{ key: "state", label: t("Tila"), value: knowledgeStateShort(stateFilter), clear: () => setStateFilter("all") }] : [])
  ];
  const filtersActive = activeFilters.length > 0;

  // Listan otsikkona taloyhtiö, jonka dokumentaatiota näytetään.
  const companyName = companies?.find(company => company.id === companyId)?.name;

  return (
    <div className="knowledge-base">
      {companyName && (
        <h2 className="knowledge-company">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 21h18" /><path d="M5 21V9l7-5 7 5v12" /><path d="M10 21v-5h4v5" />
          </svg>
          {companyName}
        </h2>
      )}
      <p className="muted knowledge-intro">
        {audience === "ai"
          ? t("Yhtiön dokumentit ja vakiotiedot, joiden pohjalta AI tekee luonnokset. AI ei käytä muita lähteitä yhtiön tiedoista, eikä näitä tietoja käytetä muiden yhtiöiden luonnoksissa.")
          : audience === "internal"
          ? t("Henkilökunnan omat ohjeet ja muistiot. AI ei käytä sisäistä dokumentaatiota, eikä sitä näytetä asukkaille.")
          : t("Yhtiön dokumentit ja vakiotiedot. AI tekee luonnokset vain AI-dokumentaation pohjalta; sisäinen dokumentaatio on vain henkilökunnan luettavaksi.")}
      </p>

      {audience !== "internal" && testOpen && (
        <form className="settings-card knowledge-test" onSubmit={runTest}>
          <h2>{t("Testaa")}</h2>
          <p className="muted">{t("Kysy kysymys ja näe, minkä vastauksen ja lähteen AI käyttäisi.")}</p>
          <div className="reporter-link">
            <input
              value={question}
              onChange={event => { setQuestion(event.target.value); setTestResult(null); }}
              placeholder={t("Esim. Miten saunavuoro varataan?")}
            />
            <button type="submit" disabled={testing || !question.trim()}>
              {testing ? t("Haetaan…") : t("Testaa")}
            </button>
          </div>
          {testResult && (testResult.found ? (
            <div className="test-result">
              <p>{testResult.answer}</p>
              <span className="source-pill">{t("Lähde:")}{" "}{testResult.source?.title}</span>
            </div>
          ) : (
            <p className="test-result muted">
              {t("AI ei löytänyt vastausta tämän yhtiön tiedoista. Asia siirtyisi isännöitsijälle.")}
            </p>
          ))}
        </form>
      )}

      {notice && <p className="portal-sent knowledge-notice" role="status">{notice}</p>}
      {moveListError && <p className="send-error">{moveListError}</p>}

      {filtersOpen && (
        <div className="ticket-filters">
          {companies && onCompanyChange && (
            <label>
              <span>{t("Taloyhtiö")}</span>
              <select value={companyId} onChange={event => onCompanyChange(event.target.value)}>
                {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            </label>
          )}
          <label>
            <span>{t("Tyyppi")}</span>
            <select value={kindFilter} onChange={event => setKindFilter(event.target.value)}>
              <option value="all">{t("Kaikki")}</option>
              <option value="document">{t("Dokumentti")}</option>
              <option value="fact">{t("Vakiotieto")}</option>
            </select>
          </label>
          {!audience && (
            <label>
              <span>{t("Käyttö")}</span>
              <select value={audienceFilter} onChange={event => setAudienceFilter(event.target.value)}>
                <option value="all">{t("Kaikki")}</option>
                <option value="ai">{t("AI")}</option>
                <option value="internal">{t("Sisäinen")}</option>
              </select>
            </label>
          )}
          <label>
            <span>{t("Tila")}</span>
            <select value={stateFilter} onChange={event => setStateFilter(event.target.value)}>
              <option value="all">{t("Kaikki")}</option>
              {(states.includes(stateFilter) || stateFilter === "all" ? states : [stateFilter, ...states])
                .map(state => <option key={state} value={state}>{knowledgeStateShort(state)}</option>)}
            </select>
          </label>
          {filtersActive && (
            <button className="clear-filters" onClick={() => {
              setKindFilter("all");
              setAudienceFilter("all");
              setStateFilter("all");
            }}>{t("Tyhjennä suodattimet")}</button>
          )}
        </div>
      )}

      <div className="residents-toolbar">
        <div className="filter-chips">
          <button
            className={`filter-toggle ${filtersOpen || filtersActive ? "active" : ""}`}
            onClick={() => setFiltersOpen(!filtersOpen)}
            title={filtersOpen ? t("Piilota suodattimet") : t("Näytä suodattimet")}
            aria-label={filtersOpen ? t("Piilota suodattimet") : t("Näytä suodattimet")}
            aria-expanded={filtersOpen}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.200"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 5h18l-7 8.500V19l-4 2v-7.500z" />
            </svg>
            {filtersActive && <i />}
          </button>
          <button
            className={`filter-toggle search-toggle ${searchOpen ? "active" : ""}`}
            onClick={() => setSearchOpen(!searchOpen)}
            title={searchOpen ? t("Sulje haku") : t("Hae sarakkeista")}
            aria-label={searchOpen ? t("Sulje haku") : t("Hae sarakkeista")}
            aria-expanded={searchOpen}
          >
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
            {searches.length > 0 && <i />}
          </button>
          <span>{t("{0} tietuetta", visible.length)}</span>
          {activeFilters.map(filter => (
            <span className="filter-chip" key={filter.key}>
              <small>{filter.label}</small>
              {filter.value}
              <button onClick={filter.clear} title={t("Poista suodatin")} aria-label={t("Poista suodatin {0}", filter.label)}>×</button>
            </span>
          ))}
        </div>
        <div className="toolbar-actions">
          {audience !== "internal" && (
            <button className="secondary" aria-expanded={testOpen} onClick={() => setTestOpen(!testOpen)}>
              {testOpen ? t("Sulje testi") : t("Testaa AI:n vastaus")}
            </button>
          )}
          {isManager() && <button className="secondary" onClick={() => setForm({ mode: "document" })}>{t("Lataa dokumentti")}</button>}
          {isManager() && <button className="secondary" onClick={() => setForm({ mode: "fact" })}>{t("Lisää vakiotieto")}</button>}
        </div>
      </div>

      {!loading && !loadError && inAudience.length > 0 && (
        <div className={`ticket-row-header ${colsClass}`}>
          {columns.map(column => {
            const active = sort.key === column.key;
            return (
              <button
                key={column.key}
                className={active ? "active" : ""}
                onClick={() => sortBy(column.key)}
                title={t("Järjestä sarakkeen {0} mukaan", column.label)}
                aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}
              >
                {column.label}
                <svg
                  className={active && !sort.descending ? "up" : ""}
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
            );
          })}
        </div>
      )}
      {!loading && !loadError && inAudience.length > 0 && searchOpen && (
        <div className={`ticket-row-search ${colsClass}`}>
          {columns.map(column => (
            <input
              key={column.key}
              value={columnSearch[column.key] ?? ""}
              onChange={event => setColumnSearch({ ...columnSearch, [column.key]: event.target.value })}
              placeholder={t("Hae…")}
              aria-label={t("Hae sarakkeesta {0}", column.label)}
            />
          ))}
        </div>
      )}

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <div className="empty">{t("Tietojen lataus epäonnistui.")}</div>
        : inAudience.length === 0 ? (
          <div className="empty">
            {audience === "internal" ? t("Tällä taloyhtiöllä ei ole vielä sisäistä dokumentaatiota.")
              : audience === "ai" ? t("Tällä taloyhtiöllä ei ole vielä AI-dokumentaatiota.")
              : t("Tällä taloyhtiöllä ei ole vielä dokumentteja tai vakiotietoja.")}
          </div>
        )
        : visible.length === 0 ? <div className="empty">{t("Ei suodattimia vastaavia tietueita.")}</div>
        : paged.items.map(entry => (
          <article
            className={`ticket-row ${colsClass}`}
            key={entry.id}
            title={t("Avaa tietokortti")}
            onClick={() => setOpenEntryId(entry.id)}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setOpenEntryId(entry.id);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div className="ticket-row-main">
              <strong>{entry.title}</strong>
              <span>{entry.kind === "document" && entry.file_name ? `${entry.file_name} · ` : ""}{entry.content || t("Ei luettua tekstiä.")}</span>
            </div>
            <span className="type">{kindLabel(entry.kind)}</span>
            {isManager() ? (
              <span className="knowledge-audience-pick" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                <FactDropdown
                  value={entry.audience}
                  options={audienceOptions}
                  onChange={next => void changeAudience(entry, next as KnowledgeAudience)}
                />
              </span>
            ) : <span className={`knowledge-audience ${entry.audience}`}>{audienceLabel(entry.audience)}</span>}
            <span className={`knowledge-state ${entry.state}`}>{knowledgeStateShort(entry.state)}</span>
            <span className="ticket-row-contact">{validityShort(entry)}</span>
            <time className="date">{formatDateOnly(entry.created_at)}</time>
          </article>
        ))}

      {!loading && !loadError && paged.pager}

      {openEntryId && !form && (
        <KnowledgeDetailDrawer
          entryId={openEntryId}
          companies={companies}
          onOpenVersion={setOpenEntryId}
          onClose={() => setOpenEntryId(null)}
          onEdit={(mode, entry) => setForm(mode === "validity" ? { mode, entry } : { mode: entry.kind, replaces: entry })}
          onRemove={async entry => {
            await removeEntry(entry);
            setOpenEntryId(null);
          }}
          onChanged={loadEntries}
        />
      )}

      {form && (
        <KnowledgeFormModal
          companyId={companyId}
          form={form}
          audience={audience}
          onClose={() => setForm(null)}
          onDone={async message => {
            setForm(null);
            setOpenEntryId(null);
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
  onRemove,
  onChanged,
  companies = []
}: {
  entryId: string;
  companies?: Company[];
  onOpenVersion: (entryId: string) => void;
  onClose: () => void;
  onEdit: (mode: "validity" | "replace", entry: KnowledgeEntry) => void;
  onRemove: (entry: KnowledgeEntry) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<KnowledgeDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState("");

  useEffect(() => {
    setDetail(null);
    setFailed(false);
    setMoveError("");
    api<KnowledgeDetail>(`/knowledge/${entryId}`)
      .then(setDetail)
      .catch(() => setFailed(true));
  }, [entryId]);

  // Siirtää tietueen AI-dokumentaation ja sisäisen dokumentaation välillä.
  async function moveTo(audience: KnowledgeAudience) {
    setMoving(true);
    setMoveError("");
    try {
      await api(`/knowledge/${entryId}/audience`, { method: "PUT", body: JSON.stringify({ audience }) });
      setDetail(await api<KnowledgeDetail>(`/knowledge/${entryId}`));
      await onChanged();
    } catch (error) {
      setMoveError(errorMessage(error, t("Siirto epäonnistui.")));
    } finally {
      setMoving(false);
    }
  }

  // Siirtää tietueen versioineen toiselle taloyhtiölle.
  async function moveCompany(companyId: string) {
    setMoving(true);
    setMoveError("");
    try {
      await api(`/knowledge/${entryId}/company`, { method: "PUT", body: JSON.stringify({ companyId }) });
      setDetail(await api<KnowledgeDetail>(`/knowledge/${entryId}`));
      await onChanged();
    } catch (error) {
      setMoveError(errorMessage(error, t("Siirto epäonnistui.")));
    } finally {
      setMoving(false);
    }
  }

  const isCurrent = detail?.status === "active";
  const canEdit = isCurrent && isManager();
  // Voimassa olevan tietueen tilaksi voi valita AI:n käytön tai sisäisen dokumentaation.
  const stateEditable = canEdit && (detail?.state === "in_use" || detail?.state === "internal");

  return (
    <div className="overlay">
      <aside className="drawer">
        <button type="button" className="drawer-back" onClick={onClose}>{t("← Takaisin")}</button>
        <button className="close" onClick={onClose}>×</button>
        {failed ? <p className="send-error">{t("Tietojen lataus epäonnistui.")}</p>
          : !detail ? <p className="muted">{t("Ladataan…")}</p> : (
          <>
            <span className="type">{detail.kind === "document" ? t("Dokumentti") : t("Vakiotieto")}</span>
            <h2>{detail.title}</h2>

            <dl className="ticket-facts">
              <div>
                <dt>{t("Taloyhtiö")}</dt>
                <dd>
                  {canEdit && companies.length > 1 ? (
                    <FactDropdown
                      value={detail.company_id}
                      options={companies.map(company => ({ value: company.id, label: company.name }))}
                      disabled={moving}
                      onChange={companyId => void moveCompany(companyId)}
                    />
                  ) : detail.company_name || "-"}
                </dd>
              </div>
              <div>
                <dt>{t("Tila")}</dt>
                <dd>
                  {stateEditable ? (
                    <FactDropdown
                      value={detail.audience}
                      options={[
                        { value: "ai", label: knowledgeStateLabel("in_use"), pillClass: "knowledge-state in_use" },
                        { value: "internal", label: knowledgeStateLabel("internal"), pillClass: "knowledge-state internal" }
                      ]}
                      disabled={moving}
                      onChange={next => void moveTo(next as KnowledgeAudience)}
                    />
                  ) : <span className={`knowledge-state ${detail.state}`}>{knowledgeStateLabel(detail.state)}</span>}
                </dd>
              </div>
              {!stateEditable && (
                <div>
                  <dt>{t("Käyttö")}</dt>
                  <dd>
                    {isCurrent && isManager() ? (
                      <FactDropdown
                        value={detail.audience}
                        options={[
                          { value: "ai", label: t("AI dokumentaatio") },
                          { value: "internal", label: t("Sisäinen dokumentaatio") }
                        ]}
                        disabled={moving}
                        onChange={next => void moveTo(next as KnowledgeAudience)}
                      />
                    ) : detail.audience === "internal" ? t("Sisäinen dokumentaatio") : t("AI dokumentaatio")}
                  </dd>
                </div>
              )}
              <div>
                <dt>{t("Voimassaolo")}</dt>
                <dd>{validityLabel(detail)}</dd>
              </div>
              <div>
                <dt>{t("Versio")}</dt>
                <dd>{detail.version} / {detail.versions.length}</dd>
              </div>
              <div>
                <dt>{t("Lisätty")}</dt>
                <dd>{formatDate(detail.created_at)}</dd>
              </div>
              {detail.kind === "document" && (
                <div>
                  <dt>{t("Tiedosto")}</dt>
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
                  <dt>{t("Luettu teksti")}</dt>
                  <dd>{detail.content_length.toLocaleString(locale)}{" "}{t("merkkiä")}</dd>
                </div>
              )}
            </dl>

            {isCurrent && isManager() && (
              <div className="knowledge-entry-actions">
                <button onClick={() => onEdit("validity", detail)}>{t("Voimassaoloaika")}</button>
                <button onClick={() => onEdit("replace", detail)}>{t("Muokkaa")}</button>
                <button className="danger" onClick={() => onRemove(detail)}>{t("Poista")}</button>
              </div>
            )}
            {moveError && <p className="send-error">{moveError}</p>}

            <section className="drawer-section">
              <h3>{detail.kind === "document" ? t("Dokumentista luettu teksti") : t("Vastaus")}</h3>
              <p className="knowledge-content">
                {detail.content || t("Tekstiä ei saatu luettua, joten AI ei voi käyttää tätä dokumenttia.")}
              </p>
            </section>

            <section className="drawer-section">
              <h3>{t("Versiohistoria")}</h3>
              {detail.versions.map(version => (
                <div className="audit" key={version.id}>
                  {version.id === detail.id
                    ? <strong>{t("Versio")}{" "}{version.version}: {version.title}{" "}{t("(tämä)")}</strong>
                    : (
                      <button className="back-link" onClick={() => onOpenVersion(version.id)}>
                        {t("Versio")}{" "}{version.version}: {version.title}
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
  audience,
  onClose,
  onDone
}: {
  companyId: string;
  form: KnowledgeFormState;
  // Näkymän rajaus: uusi tietue menee suoraan siihen. Ilman rajausta kohde valitaan lomakkeella.
  audience?: KnowledgeAudience;
  onClose: () => void;
  onDone: (notice: string) => Promise<void>;
}) {
  const current = form.mode === "validity" ? form.entry : form.replaces;
  const [title, setTitle] = useState(current?.title ?? "");
  const [answer, setAnswer] = useState(form.mode === "fact" ? current?.content ?? "" : "");
  const [file, setFile] = useState<File | null>(null);
  const [validFrom, setValidFrom] = useState(current?.valid_from ?? "");
  const [validUntil, setValidUntil] = useState(current?.valid_until ?? "");
  const [target, setTarget] = useState<KnowledgeAudience>(audience ?? "ai");
  // Uusi versio perii korvattavan tietueen kohteen, joten kohde valitaan vain uudelle tietueelle.
  const isNew = form.mode !== "validity" && !form.replaces;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const heading = form.mode === "validity" ? t("Merkitse voimassaoloaika")
    : form.mode === "document" ? (form.replaces ? t("Muokkaa dokumenttia") : t("Lataa dokumentti"))
    : (form.replaces ? t("Muokkaa vakiotietoa") : t("Lisää vakiotieto"));

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
          body: JSON.stringify({
            question: title, answer, validFrom, validUntil, replaces: form.replaces?.id, audience: isNew ? target : undefined
          })
        });
        await onDone("");
      } else if (file) {
        const params = new URLSearchParams({ fileName: file.name, mimeType: file.type, title, validFrom, validUntil });
        if (form.replaces) params.set("replaces", form.replaces.id);
        else params.set("audience", target);
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
          : t("Dokumentti \"{0}\" tallennettiin, mutta sen tekstiä ei saatu luettua. Se ei ole AI:n käytössä.", file.name));
      }
    } catch (caught) {
      setError(errorMessage(caught, t("Tallennus epäonnistui.")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay">
      <aside className="drawer form-drawer">
        <button type="button" className="drawer-back" onClick={onClose}>{t("← Takaisin")}</button>
        <button className="close" onClick={onClose}>×</button>
        <h2>{heading}</h2>
        <p className="muted">
          {form.mode === "validity"
            ? t("{0}. Vanhentunut tietue poistuu AI:n käytöstä.", form.entry.title)
            : form.replaces
            ? t("Uusi versio korvaa vanhan. Vanha versio säilyy historiassa.")
            : form.mode === "document"
            ? t("PDF, Word (.docx) tai kuva. Teksti luetaan automaattisesti.")
            : t("Lyhyt kysymys–vastaus-pari, esim. ”saunavuorot varataan huoltoyhtiöltä”.")}
        </p>

        <form className="ticket-form" onSubmit={handleSubmit}>
          {isNew && !audience && (
            <label>
              <span>{t("Käyttö")}</span>
              <select value={target} onChange={event => setTarget(event.target.value as KnowledgeAudience)}>
                <option value="ai">{t("AI dokumentaatio – AI käyttää vastausehdotuksissa")}</option>
                <option value="internal">{t("Sisäinen dokumentaatio – vain henkilökunnalle")}</option>
              </select>
            </label>
          )}
          {form.mode === "document" && (
            <>
              <label>
                <span>{t("Tiedosto")}</span>
                <input
                  type="file"
                  accept=".pdf,.docx,.txt,image/*"
                  onChange={event => setFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <label>
                <span>{t("Otsikko")}</span>
                <input value={title} onChange={event => setTitle(event.target.value)} placeholder={t("Esim. Järjestyssäännöt (oletuksena tiedoston nimi)")} />
              </label>
            </>
          )}

          {form.mode === "fact" && (
            <>
              <label>
                <span>{t("Kysymys tai aihe")}</span>
                <input value={title} onChange={event => setTitle(event.target.value)} placeholder={t("Esim. Miten saunavuoro varataan?")} />
              </label>
              <label>
                <span>{t("Vastaus")}</span>
                <textarea value={answer} onChange={event => setAnswer(event.target.value)} rows={5} placeholder={t("Esim. Saunavuorot varataan huoltoyhtiöltä.")} />
              </label>
            </>
          )}

          <div className="form-columns">
            <label>
              <span>{t("Voimassa alkaen")}</span>
              <input type="date" value={validFrom} onChange={event => setValidFrom(event.target.value)} />
            </label>
            <label>
              <span>{t("Voimassa asti")}</span>
              <input type="date" value={validUntil} onChange={event => setValidUntil(event.target.value)} />
            </label>
          </div>
          <p className="reply-hint">{t("Jätä tyhjäksi, jos tieto on voimassa toistaiseksi.")}</p>

          {error && <p className="send-error">{error}</p>}

          <div className="drawer-actions compact-actions">
            <button type="button" onClick={onClose}>{t("Peruuta")}</button>
            <button className="primary" type="submit" disabled={submitting || !canSubmit}>
              {submitting ? (form.mode === "document" ? t("Luetaan tekstiä…") : t("Tallennetaan…")) : t("Tallenna")}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
