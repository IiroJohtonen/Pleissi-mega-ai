import { type FormEvent, useEffect, useState } from "react";
import { Dropdown } from "../components/common";
import { formatDateOnly } from "../format";
import { t } from "../i18n";
import { api, errorMessage, isManager } from "../session";
import { topicLabel } from "../topics";
import type { Company } from "../types";

type BaseItem = {
  type: "memory" | "documentation"; id: string; title: string; text: string; scope: "company" | "office";
  reviewAt: string | null; validUntil: string | null; knowledgeId: string | null; page: number | null;
};
type TypeFilter = "all" | "memory" | "documentation";

const typeLabels: Record<BaseItem["type"], string> = { memory: t("Muisti"), documentation: t("Dokumentaatio") };
const today = () => new Date().toLocaleDateString("sv-SE");

// Tietopohja: taloyhtiön muisti ja AI:n käyttämä dokumentaatio yhdessä. Tallennus on erillinen; tässä yksi
// haku palauttaa molemmat tyyppimerkinnällä, ja ohjeiden tarkistuspäivät näkyvät ja päivittyvät.
export function KnowledgeBase({ companies, companyId }: { companies: Company[]; companyId: string }) {
  const [company, setCompany] = useState(companyId && companyId !== "all" ? companyId : companies[0]?.id ?? "");
  const [type, setType] = useState<TypeFilter>("all");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<BaseItem[] | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    if (!company) return;
    setError("");
    api<{ items: BaseItem[] }>(`/companies/${encodeURIComponent(company)}/knowledge-base?type=${type}&q=${encodeURIComponent(submitted)}`)
      .then(result => setItems(result.items ?? []))
      .catch(caught => setError(errorMessage(caught, t("Tietopohjan lataus epäonnistui."))));
  };
  useEffect(load, [company, type, submitted]);

  async function reviewed(item: BaseItem) {
    try {
      await api(`/knowledge/${encodeURIComponent(item.knowledgeId!)}/review`, { method: "PUT", body: JSON.stringify({ reviewed: true }) });
      load();
    } catch (caught) {
      setError(errorMessage(caught, t("Tarkistuspäivän tallennus epäonnistui.")));
    }
  }

  return (
    <div className="metrics knowledge-base">
      <form className="ticket-filters metrics-filters" onSubmit={(event: FormEvent) => { event.preventDefault(); setSubmitted(query.trim()); }}>
        <Dropdown label={t("Taloyhtiö")} value={company} options={companies.map(item => ({ value: item.id, label: item.name }))} onChange={setCompany} />
        <Dropdown
          label={t("Tyyppi")}
          value={type}
          options={[{ value: "all", label: t("Kaikki") }, { value: "documentation", label: t("Dokumentaatio") }, { value: "memory", label: t("Muisti") }]}
          onChange={value => setType(value as TypeFilter)}
        />
        <label>
          <span>{t("Haku")}</span>
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("Esim. sauna, avain, jäte")} />
        </label>
        <button type="submit" className="secondary">{t("Hae")}</button>
      </form>
      <div className="report-card">
        <h2>{t("Tietopohja")}</h2>
        <p className="muted">
          {t("AI käyttää vastauksissa taloyhtiön muistia (rakennuksen tiedot) ja AI-dokumentaatiota (ohjeet asukkaille). Molemmat näkyvät tässä; haku palauttaa ne tyyppimerkinnällä.")}
        </p>
        {error && <p className="send-error">{error}</p>}
        {!items ? (!error && <p className="muted">{t("Ladataan…")}</p>)
          : items.length === 0 ? <p className="muted">{submitted ? t("Ei osumia.") : t("Ei tietoja.")}</p>
          : (
            <ul className="memory-list knowledge-base-list">
              {items.map(item => {
                const due = item.reviewAt !== null && item.reviewAt <= today();
                return (
                  <li key={`${item.type}-${item.id}`}>
                    <div className="memory-text">
                      <p>
                        <span className={`memory-target memory-target-${item.type}`}>{typeLabels[item.type]}</span>{" "}
                        <strong>{item.title}</strong>
                        {item.page ? <small> · {t("s. {0}", item.page)}</small> : null}
                        {item.scope === "office" && <small> · {t("kaikki toimiston taloyhtiöt")}</small>}
                      </p>
                      <p>{item.text}</p>
                    </div>
                    <p className="memory-meta">
                      {item.validUntil && <span>{t("voimassa {0} asti", formatDateOnly(item.validUntil))}</span>}
                      {item.reviewAt && (
                        <span className={due ? "metric-alert" : undefined}>
                          {due ? t("Tarkistus myöhässä ({0})", formatDateOnly(item.reviewAt)) : t("Tarkistetaan viimeistään {0}", formatDateOnly(item.reviewAt))}
                        </span>
                      )}
                      {item.type === "documentation" && item.knowledgeId && isManager() && (
                        <button type="button" className="link-button" onClick={() => void reviewed(item)}>{t("Merkitse tarkistetuksi")}</button>
                      )}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
      </div>
    </div>
  );
}

type GapReport = {
  topics: { topic: string; total: number; questions: { question: string; count: number; lastAt: string }[] }[];
  weeks: { week: string; topic: string; runs: number; handovers: number }[];
};

// Osaamisaukot: kysymykset, joihin AI-agentti ei löytänyt vastausta, aiheittain, ja siirtojen osuus viikoittain.
export function KnowledgeGaps({ companies, companyId }: { companies: Company[]; companyId: string }) {
  const [company, setCompany] = useState(companyId && companyId !== "all" ? companyId : "all");
  const [report, setReport] = useState<GapReport | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    api<GapReport>(`/reports/knowledge-gaps?companyId=${encodeURIComponent(company)}`)
      .then(result => setReport({ topics: result.topics ?? [], weeks: result.weeks ?? [] }))
      .catch(caught => setError(errorMessage(caught, t("Raportin lataus epäonnistui."))));
  }, [company]);

  return (
    <div className="metrics">
      <div className="ticket-filters metrics-filters no-print">
        <Dropdown label={t("Taloyhtiö")} value={company} options={[{ value: "all", label: t("Kaikki taloyhtiöt") }, ...companies.map(item => ({ value: item.id, label: item.name }))]} onChange={setCompany} />
      </div>
      {error && <p className="send-error">{error}</p>}
      <div className="report-card">
        <h2>{t("Kysymykset, joihin AI ei osannut vastata (12 viikkoa)")}</h2>
        <p className="muted">{t("Kun toimisto vastaa näihin, ratkaisu nousee taloyhtiön muistin ehdotuksissa kärkeen.")}</p>
        {!report ? <p className="muted">{t("Ladataan…")}</p>
          : report.topics.length === 0 ? <p className="muted">{t("Ei osaamisaukkoja.")}</p>
          : report.topics.map(topic => (
            <div key={topic.topic} className="gap-topic">
              <h3>{topicLabel(topic.topic)} ({topic.total})</h3>
              <ul className="trend-list">
                {topic.questions.map(question => (
                  <li key={question.question}>{question.question} <small>· {t("{0} kertaa", question.count)} · {formatDateOnly(question.lastAt)}</small></li>
                ))}
              </ul>
            </div>
          ))}
      </div>
      <div className="report-card">
        <h2>{t("AI-agentin siirrot henkilökunnalle viikoittain")}</h2>
        {!report ? null : report.weeks.length === 0 ? <p className="muted">{t("Ei agentin ajoja.")}</p> : (
          <table className="data-table">
            <thead><tr><th>{t("Viikko")}</th><th>{t("Aihe")}</th><th className="num">{t("Ajot")}</th><th className="num">{t("Siirrot")}</th><th className="num">{t("Osuus")}</th></tr></thead>
            <tbody>
              {report.weeks.map(row => (
                <tr key={`${row.week}-${row.topic}`}>
                  <td>{row.week}</td><th scope="row">{topicLabel(row.topic)}</th><td className="num">{row.runs}</td><td className="num">{row.handovers}</td>
                  <td className="num">{Math.round((row.handovers / row.runs) * 100)} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
