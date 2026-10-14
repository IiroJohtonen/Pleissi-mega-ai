import { type FormEvent, useEffect, useState } from "react";
import { formatDate, formatTicketNumber } from "../format";
import { api, errorMessage } from "../session";
import { WorkOrderReport } from "../tickets/TicketWorkOrders";
import type { Company, Ticket } from "../types";
import { BillingReports } from "./Billing";
import { locale, t } from "../i18n";

type ReportPeriod = "week" | "month" | "year";

const reportPeriodLabels: Record<ReportPeriod, string> = {
  week: t("Viikko"),
  month: t("Kuukausi"),
  year: t("Vuosi")
};

const reportPeriodNames: Record<ReportPeriod, string> = {
  week: t("viimeiset 7 päivää"),
  month: t("viimeiset 30 päivää"),
  year: t("viimeiset 12 kuukautta")
};

type TopicReport = {
  generatedAt: string;
  generatedBy: string;
  ticketCount: number;
  // documentation = AI:n luonnos dokumentaatiotietueen sisällöksi (puuttuu ennen tätä muutosta luoduista raporteista).
  topics: { title: string; summary: string; documentation?: string; ticketIds: string[] }[];
  // Aiheet, jotka AI jätti pois, koska niistä on jo dokumentaatio (puuttuu vanhoista raporteista).
  covered?: { title: string; knowledgeId: string; knowledgeTitle: string }[];
};

type ReportBucket = { start: number; end: number; label: string; title: string; count: number };

// Jakaa valitun jakson pylväiksi: viikko ja kuukausi päivittäin, vuosi kuukausittain.
function reportBuckets(period: ReportPeriod, now: Date): ReportBucket[] {
  const buckets: ReportBucket[] = [];
  if (period === "year") {
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({
        start: start.getTime(),
        end: end.getTime(),
        label: start.toLocaleDateString(locale, { month: "short" }),
        title: start.toLocaleDateString(locale, { month: "long", year: "numeric" }),
        count: 0
      });
    }
    return buckets;
  }
  const days = period === "week" ? 7 : 30;
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
    buckets.push({
      start: start.getTime(),
      end: end.getTime(),
      label: period === "week"
        ? start.toLocaleDateString(locale, { weekday: "short" })
        : i % 5 === 0 ? `${start.getDate()}.${start.getMonth() + 1}.` : "",
      title: start.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "numeric", year: "numeric" }),
      count: 0
    });
  }
  return buckets;
}

function ticketCountLabel(count: number) {
  return count === 1 ? t("1 tehtävä") : t("{0} tehtävää", count);
}

const reportStopWords = new Set([
  "että", "joka", "jotka", "tämä", "tässä", "ovat", "olla", "onko", "voisi", "voiko", "kiitos", "terve",
  "asukas", "kysyy", "ilmoittaa", "haluaa", "koskien", "liittyen", "myös", "kuin", "mutta", "sekä", "minun",
  "meidän", "teidän", "milloin", "miten", "missä", "pitäisi", "asunto", "asunnon", "taloyhtiö", "tiedustelu"
].map(word => word.slice(0, 5)));

// Karkea avainsanapoiminta: sanan viisi ensimmäistä kirjainta toimii taivutusmuodot yhdistävänä vartalona.
function ticketKeywords(ticket: Ticket) {
  const words = `${ticket.subject} ${ticket.summary}`.toLowerCase().match(/[a-zåäö]{4,}/g) ?? [];
  return new Set(words.map(word => word.slice(0, 5)).filter(stem => !reportStopWords.has(stem)));
}

type TicketGroup = { tickets: Ticket[]; keywords: Set<string> };

// Alustava ryhmittely: tehtävä liitetään ryhmään, jonka kanssa sillä on vähintään kaksi yhteistä
// avainsanaa ja yhteisiä sanoja on vähintään puolet lyhyemmän tehtävän avainsanoista.
function groupSimilarTickets(tickets: Ticket[]): TicketGroup[] {
  const groups: TicketGroup[] = [];
  for (const ticket of tickets) {
    const keywords = ticketKeywords(ticket);
    const match = groups.find(group => {
      const shared = [...keywords].filter(word => group.keywords.has(word)).length;
      return shared >= 2 && shared / Math.min(keywords.size, group.keywords.size) >= 0.5;
    });
    if (match) match.tickets.push(ticket);
    else groups.push({ tickets: [ticket], keywords });
  }
  return groups.filter(group => group.tickets.length > 1).sort((a, b) => b.tickets.length - a.tickets.length);
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

export function Reports({
  tickets,
  loading,
  companyId,
  companies,
  onCompanyChange
}: {
  tickets: Ticket[];
  loading: boolean;
  companyId: string;
  companies: Company[];
  onCompanyChange: (companyId: string) => void;
}) {
  const [period, setPeriod] = useState<ReportPeriod>("month");

  const buckets = reportBuckets(period, new Date());
  const periodStart = buckets[0].start;
  const periodEnd = buckets[buckets.length - 1].end;
  const previousStart = period === "year"
    ? new Date(new Date(periodStart).getFullYear() - 1, new Date(periodStart).getMonth(), 1).getTime()
    : periodStart - (periodEnd - periodStart);

  const periodTickets: Ticket[] = [];
  let previousCount = 0;
  for (const ticket of tickets) {
    const createdAt = Date.parse(ticket.created_at);
    if (Number.isNaN(createdAt)) continue;
    if (createdAt >= previousStart && createdAt < periodStart) previousCount++;
    const bucket = buckets.find(candidate => createdAt >= candidate.start && createdAt < candidate.end);
    if (!bucket) continue;
    bucket.count++;
    periodTickets.push(ticket);
  }

  const total = periodTickets.length;
  const change = total - previousCount;
  const maxCount = Math.max(...buckets.map(bucket => bucket.count));
  const axisMax = Math.max(2, maxCount + (maxCount % 2));

  const typeCounts = new Map<string, number>();
  for (const ticket of periodTickets) typeCounts.set(ticket.type, (typeCounts.get(ticket.type) ?? 0) + 1);
  const types = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);

  const groups = groupSimilarTickets(periodTickets);

  // AI:n luoma raportti toistuvista aiheista; tallennetaan palvelimelle yhtiö- ja jaksokohtaisesti.
  const [topicReport, setTopicReport] = useState<TopicReport | null>(null);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [ticketTab, setTicketTab] = useState<"incoming" | "types" | "topics" | "orders">("incoming");
  const [topicError, setTopicError] = useState("");
  const [openTopic, setOpenTopic] = useState<TopicReport["topics"][number] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTopicReport(null);
    setTopicError("");
    api<{ report: TopicReport | null; aiAvailable: boolean }>(
      `/companies/${encodeURIComponent(companyId)}/reports/topics?period=${period}`
    )
      .then(result => {
        if (cancelled) return;
        setTopicReport(result.report);
        setAiAvailable(result.aiAvailable);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [companyId, period]);

  async function generateTopicReport() {
    setGenerating(true);
    setTopicError("");
    try {
      const result = await api<{ report: TopicReport | null }>(
        `/companies/${encodeURIComponent(companyId)}/reports/topics`,
        { method: "POST", body: JSON.stringify({ period, since: new Date(periodStart).toISOString() }) }
      );
      setTopicReport(result.report);
    } catch (error) {
      setTopicError(errorMessage(error, t("AI-raportin luominen epäonnistui.")));
    } finally {
      setGenerating(false);
    }
  }

  const ticketTabs = (
    <div className="billing-tabs-head">
      <h2>{t("Tehtäväraportit")}</h2>
      <div className="billing-tabs" role="tablist">
        {([["incoming", t("Saapuneet tehtävät")], ["types", t("Tehtävät tyypeittäin")], ["topics", t("Toistuvat aiheet")], ["orders", t("Työtilaukset")]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={ticketTab === key}
            className={ticketTab === key ? "active" : ""}
            onClick={() => setTicketTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section className="content">
      <div className="ticket-filters">
        <label>
          <span>{t("Yhtiö")}</span>
          <select value={companyId} onChange={event => onCompanyChange(event.target.value)}>
            {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </label>
        <div className="report-period">
          <span>{t("Jakso")}</span>
          <div className="card-tabs">
            {(Object.keys(reportPeriodLabels) as ReportPeriod[]).map(option => (
              <button key={option} className={period === option ? "active" : ""} onClick={() => setPeriod(option)}>
                {reportPeriodLabels[option]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? <div className="empty">{t("Ladataan…")}</div> : (
        <>
          <div className="queue-summary">
            <div>
              <span>{t("Tehtäviä")}</span>
              <strong>{total}</strong>
              <small>{reportPeriodNames[period]}</small>
            </div>
            <div>
              <span>{t("Muutos")}</span>
              <strong>{change > 0 ? `+${change}` : change}</strong>
              <small>{t("edellisellä jaksolla")}{" "}{ticketCountLabel(previousCount)}</small>
            </div>
            <div>
              <span>{t("Toistuvia aiheita")}</span>
              <strong>{groups.length}</strong>
              <small>{t("vähintään kaksi samanlaista tehtävää")}</small>
            </div>
          </div>

          {ticketTab === "incoming" && (
          <div className="report-card">
            {ticketTabs}
            <h2>{t("Saapuneet tehtävät")}</h2>
            <p className="muted">
              {period === "year" ? t("Tehtäviä kuukaudessa") : t("Tehtäviä päivässä")}, {reportPeriodNames[period]}.
            </p>
            <div className="report-chart">
              <div className="report-axis">
                <span>{axisMax}</span>
                <span>{axisMax / 2}</span>
                <span>0</span>
              </div>
              <div className="report-plot">
                <div className="report-bars">
                  {buckets.map(bucket => (
                    <div key={bucket.start} className="report-bar-col">
                      <div className="report-tooltip">{bucket.title}: {ticketCountLabel(bucket.count)}</div>
                      <div className="report-bar" style={{ height: `${(bucket.count / axisMax) * 100}%` }} />
                    </div>
                  ))}
                </div>
                <div className="report-labels">
                  {buckets.map(bucket => <span key={bucket.start}>{bucket.label}</span>)}
                </div>
              </div>
            </div>
          </div>
          )}

          {ticketTab === "types" && (
          <div className="report-card">
            {ticketTabs}
            <h2>{t("Tehtävät tyypeittäin")}</h2>
            {types.length === 0 ? <p className="muted">{t("Ei tehtäviä valitulla jaksolla.")}</p> : (
              <div className="report-rows">
                {types.map(([type, count]) => (
                  <div key={type} className="report-row">
                    <span>{t(type)}</span>
                    <div className="report-row-track">
                      <div className="report-row-fill" style={{ width: `${(count / types[0][1]) * 100}%` }} />
                    </div>
                    <strong>{count}</strong>
                    <small>{Math.round((count / total) * 100)} %</small>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}

          {ticketTab === "topics" && (
          <div className="report-card">
            {ticketTabs}
            <div className="suggest-header report-ai-head">
              <h2>
                {t("Toistuvat aiheet")}
                <span className="report-tag">{topicReport ? t("AI-raportti") : t("Alustava")}</span>
              </h2>
              <button
                className="ai-button"
                onClick={generateTopicReport}
                disabled={generating || !aiAvailable}
                title={aiAvailable ? undefined : t("AI ei ole käytössä palvelimella.")}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2l1.900 5.600a4 4 0 0 0 2.500 2.500L22 12l-5.600 1.900a4 4 0 0 0-2.500 2.500L12 22l-1.900-5.600a4 4 0 0 0-2.500-2.500L2 12l5.600-1.900a4 4 0 0 0 2.500-2.500z" />
                </svg>
                {generating ? t("AI analysoi tehtäviä…") : topicReport ? t("Päivitä AI:lla") : t("Luo AI-raportti")}
              </button>
            </div>
            {topicError && <p className="send-error">{topicError}</p>}

            {topicReport ? (
              <>
                <p className="muted">
                  {t("AI ryhmitteli")}{" "}{ticketCountLabel(topicReport.ticketCount)}{" "}{t("merkityksen perusteella · luotu")}{" "}
                  {formatDate(topicReport.generatedAt)} · {topicReport.generatedBy}{t(". Raportti ei päivity itsestään, kun uusia tehtäviä saapuu.")}
                </p>
                {(topicReport.covered ?? []).length > 0 && (
                  <p className="covered-topics">
                    <strong>{t("Jätetty pois, koska aiheesta on jo dokumentaatio:")}</strong>{" "}
                    {(topicReport.covered ?? []).map((item, index) => (
                      <span key={`${item.knowledgeId}-${index}`}>
                        {index > 0 && ", "}
                        {item.title}{" "}
                        (<a href={`#/knowledge/${encodeURIComponent(item.knowledgeId)}`} title={t("Avaa dokumentti uuteen välilehteen")} target="_blank" rel="noreferrer">{item.knowledgeTitle}</a>)
                      </span>
                    ))}
                  </p>
                )}
                {topicReport.topics.length === 0 ? (
                  <p className="muted">
                    {(topicReport.covered ?? []).length > 0
                      ? t("Kaikista jakson toistuvista aiheista on jo dokumentaatio.")
                      : t("AI ei löytänyt jaksolta toistuvia aiheita.")}
                  </p>
                ) : (
                  <div className="table-card">
                    <table className="data-table report-topics">
                      <thead>
                        <tr>
                          <th>{t("Aihe")}</th>
                          <th>{t("Tehtäviä")}</th>
                          <th>{t("Osuus")}</th>
                          <th>{t("Esimerkit")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topicReport.topics.map(topic => {
                          const numbers = topic.ticketIds
                            .map(id => tickets.find(ticket => ticket.id === id))
                            .filter((ticket): ticket is Ticket => Boolean(ticket))
                            .map(ticket => `#${formatTicketNumber(ticket.ticket_number)}`);
                          return (
                            <tr
                              key={topic.title}
                              className="clickable"
                              title={t("Avaa aiheen tiedot")}
                              role="button"
                              tabIndex={0}
                              onClick={() => setOpenTopic(topic)}
                              onKeyDown={event => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  setOpenTopic(topic);
                                }
                              }}
                            >
                              <td>
                                <strong>{topic.title}</strong>
                                <span>{topic.summary}</span>
                              </td>
                              <td>{topic.ticketIds.length}</td>
                              <td>{Math.round((topic.ticketIds.length / Math.max(1, topicReport.ticketCount)) * 100)} %</td>
                              <td>
                                {numbers.slice(0, 3).join(", ")}
                                {numbers.length > 3 && " …"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="muted">
                  {t("Samankaltaiset tehtävät ryhmiteltynä otsikon ja tiivistelmän yhteisten sanojen perusteella. Luo AI-raportti, niin aiheet ryhmitellään merkityksen perusteella ja saat ehdotukset automatisoinnista.")}
                </p>
                {groups.length === 0 ? <p className="muted">{t("Valitulla jaksolla ei löytynyt toistuvia aiheita.")}</p> : (
                  <div className="table-card">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>{t("Aihe")}</th>
                          <th>{t("Tyyppi")}</th>
                          <th>{t("Tehtäviä")}</th>
                          <th>{t("Osuus")}</th>
                          <th>{t("Esimerkit")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups.map(group => (
                          <tr key={group.tickets[0].id}>
                            <td><strong>{mostCommon(group.tickets.map(ticket => ticket.subject))}</strong></td>
                            <td>{t(mostCommon(group.tickets.map(ticket => ticket.type)))}</td>
                            <td>{group.tickets.length}</td>
                            <td>{Math.round((group.tickets.length / total) * 100)} %</td>
                            <td>
                              {group.tickets.slice(0, 3).map(ticket => `#${formatTicketNumber(ticket.ticket_number)}`).join(", ")}
                              {group.tickets.length > 3 && " …"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
          )}

          {ticketTab === "orders" && <WorkOrderReport companyId={companyId} tabs={ticketTabs} />}

          <BillingReports companyId={companyId} />
        </>
      )}

      {openTopic && topicReport && (
        <TopicDrawer
          topic={openTopic}
          ticketCount={topicReport.ticketCount}
          tickets={tickets}
          companyId={companyId}
          companies={companies}
          onClose={() => setOpenTopic(null)}
        />
      )}
    </section>
  );
}

// Toistuvan aiheen tietokortti. Aiheesta voi luoda dokumentaatiotietueen, jota AI käyttää
// jatkossa samantapaisiin tehtäviin.
function TopicDrawer({
  topic,
  ticketCount,
  tickets,
  companyId,
  companies,
  onClose
}: {
  topic: TopicReport["topics"][number];
  ticketCount: number;
  tickets: Ticket[];
  companyId: string;
  companies: Company[];
  onClose: () => void;
}) {
  const topicTickets = topic.ticketIds
    .map(id => tickets.find(ticket => ticket.id === id))
    .filter((ticket): ticket is Ticket => Boolean(ticket));

  const [creating, setCreating] = useState(false);
  const [targetCompany, setTargetCompany] = useState(companyId);
  const [title, setTitle] = useState(topic.title);
  // Sisältö esitäytetään AI:n luonnoksella; käyttäjä tarkistaa ja muokkaa sen ennen luomista.
  const [content, setContent] = useState(topic.documentation ?? "");
  // Ehdotetaan avainsanoiksi aiheen otsikon sanoja; käyttäjä voi muokata.
  const [tags, setTags] = useState(
    [...new Set(topic.title.toLowerCase().match(/[a-zåäö]{4,}/g) ?? [])].join(", ")
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [createdId, setCreatedId] = useState("");

  const tagList = [...new Set(tags.split(",").map(tag => tag.trim()).filter(Boolean))];

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await api<{ knowledgeId: string }>(
        `/companies/${encodeURIComponent(targetCompany)}/knowledge/facts`,
        { method: "POST", body: JSON.stringify({ question: title.trim(), answer: content.trim(), tags: tagList }) }
      );
      setCreatedId(result.knowledgeId);
      setCreating(false);
    } catch (submitError) {
      setError(errorMessage(submitError, t("Dokumentaation luominen epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay">
      <aside className="drawer form-drawer resident-drawer topic-drawer">
        <button type="button" className="drawer-back" onClick={onClose}>{t("← Takaisin")}</button>
        <button className="close" onClick={onClose}>×</button>
        <span className="report-tag">{t("Toistuva aihe")}</span>
        <h2>{topic.title}</h2>
        <p className="muted">{topic.summary}</p>

        <dl className="ticket-facts">
          <div>
            <dt>{t("Tehtäviä")}</dt>
            <dd>{topic.ticketIds.length}</dd>
          </div>
          <div>
            <dt>{t("Osuus jakson tehtävistä")}</dt>
            <dd>{Math.round((topic.ticketIds.length / Math.max(1, ticketCount)) * 100)} %</dd>
          </div>
        </dl>

        <section className="drawer-section">
          <h3>{t("Aiheen tehtävät")}</h3>
          {topicTickets.map(ticket => (
            <a className="topic-ticket" key={ticket.id} href={`#/tickets/${encodeURIComponent(ticket.id)}`} target="_blank" rel="noreferrer">
              <span className="ticket-number">#{formatTicketNumber(ticket.ticket_number)}</span>
              <span>
                <strong>{ticket.subject}</strong>
                <small>{ticket.summary}</small>
              </span>
            </a>
          ))}
          {topicTickets.length === 0 && <p className="drawer-empty">{t("Aiheen tehtäviä ei löytynyt valitusta yhtiöstä.")}</p>}
        </section>

        <section className="drawer-section">
          <h3>{t("Dokumentaatio")}</h3>
          {createdId ? (
            <p className="ai-reason created">
              {t("Dokumentaatio luotu. AI käyttää sitä jatkossa samantapaisten tehtävien vastausehdotuksissa.")}{" "}
              <a href={`#/knowledge/${encodeURIComponent(createdId)}`} target="_blank" rel="noreferrer">{t("Avaa tietue ↗")}</a>
            </p>
          ) : !creating ? (
            <>
              <p className="topic-text">
                {t("Luo aiheesta dokumentaatiotietue, niin AI osaa käyttää sitä vastausehdotuksissa, kun samasta asiasta tulee uusi tehtävä.")}
              </p>
              <button className="ai-button topic-create" onClick={() => setCreating(true)}>{t("Luo dokumentaatio")}</button>
            </>
          ) : (
            <form className="ticket-form" onSubmit={handleSubmit}>
              <label>
                <span>{t("Taloyhtiö")}</span>
                <select value={targetCompany} onChange={event => setTargetCompany(event.target.value)}>
                  {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
                </select>
              </label>

              <label>
                <span>{t("Otsikko")}</span>
                <input value={title} onChange={event => setTitle(event.target.value)} />
              </label>

              <label>
                <span>{t("Sisältö (tieto, jonka pohjalta AI vastaa asukkaalle)")}</span>
                <textarea
                  value={content}
                  onChange={event => setContent(event.target.value)}
                  placeholder={t("Kirjoita taloyhtiön ohje tai vastaus tähän aiheeseen, esim. miten asia hoidetaan ja keneen otetaan yhteyttä.")}
                />
              </label>
              <p className="reply-hint">
                {topic.documentation
                  ? t("AI:n luonnos tehtävien ja lähetettyjen vastausten pohjalta. Tarkista teksti ja täydennä hakasulkeissa olevat kohdat ennen luomista.")
                  : t("Tälle aiheelle ei ole AI:n luonnosta. Päivitä raportti AI:lla tai kirjoita sisältö itse.")}
              </p>
              {/\[[^\]]*\]/.test(content) && (
                <p className="send-error">{t("Sisällössä on vielä täydennettäviä kohtia hakasulkeissa.")}</p>
              )}

              <label>
                <span>{t("Tagit (pilkulla erotettuna)")}</span>
                <input value={tags} onChange={event => setTags(event.target.value)} placeholder={t("esim. sauna, varaus, yhteistilat")} />
              </label>
              {tagList.length > 0 && (
                <div className="knowledge-tags">
                  {tagList.map(tag => <span key={tag}>{tag}</span>)}
                </div>
              )}

              {error && <p className="send-error">{error}</p>}

              <div className="drawer-actions compact-actions">
                <button type="button" onClick={() => setCreating(false)}>{t("Peruuta")}</button>
                <button className="primary" type="submit" disabled={saving || !title.trim() || !content.trim()}>
                  {saving ? t("Luodaan…") : t("Luo dokumentaatio")}
                </button>
              </div>
            </form>
          )}
        </section>
      </aside>
    </div>
  );
}
