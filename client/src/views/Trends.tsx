import { useEffect, useState } from "react";
import { Dropdown } from "../components/common";
import { formatDateOnly, formatDuration } from "../format";
import { t } from "../i18n";
import { api, errorMessage } from "../session";
import { placeLabel, topicLabel } from "../topics";
import type { Company } from "../types";

type TrendResult = {
  months: string[];
  topics: { topic: string; series: number[]; total: number; lastMonth: number; average: number }[];
  repeats: { kind: "apartment" | "stairwell"; companyName: string; place: string; topic: string; count: number; firstAt: string; lastAt: string }[];
  resolution: { topic: string; closed: number; medianHours: number }[];
  contractors: { name: string; orders: number; open: number; medianHours: number | null }[];
  incidents: { topic: string; stairwell: string; status: string; firstReportAt: string; resolution: string | null; companyName: string; reports: number }[];
  promises?: { promises: number; kept: number; broken: number; open: number; keptShare: number | null };
  trendAlerts?: { companyId: string; companyName: string; topic: string; current: number; previous: number; firstSeenAt: string | null }[];
  aiDrafts?: {
    topic: string; drafts: number; unchanged: number; light: number; heavy: number; rewritten: number; tone: number; fact: number;
    unclassified: number; readyShare: number | null; ready: boolean; agentRuns: number; handovers: number; handoverShare: number | null;
  }[];
};

const percent = (value: number | null) => (value === null ? "–" : `${Math.floor(value * 1000) / 10} %`);

const monthLabel = (month: string) => `${Number(month.slice(5, 7))}/${month.slice(2, 4)}`;
const hours = (value: number | null) => (value === null ? "–" : formatDuration(value * 3_600_000));
// Viimeinen kuukausi on selvästi tavallista vilkkaampi.
const rising = (row: TrendResult["topics"][number]) => row.lastMonth >= 3 && row.lastMonth >= row.average * 1.5;

// Trendit: mistä taloyhtiöissä ilmoitetaan, mikä toistuu ja kauanko asioiden hoito kestää. Pelkkää laskentaa.
export function Trends({ companies, companyId }: { companies: Company[]; companyId: string }) {
  const [company, setCompany] = useState(companyId && companyId !== "all" ? companyId : "all");
  const [months, setMonths] = useState("12");
  const [result, setResult] = useState<TrendResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setError("");
    api<TrendResult>(`/reports/trends?companyId=${encodeURIComponent(company)}&months=${months}`)
      .then(data => { if (!cancelled) setResult(data); })
      .catch(caught => { if (!cancelled) setError(errorMessage(caught, t("Trendien lataus epäonnistui."))); });
    return () => {
      cancelled = true;
    };
  }, [company, months]);

  const many = company === "all";
  return (
    <div className="metrics trends">
      <div className="ticket-filters metrics-filters no-print">
        <Dropdown
          label={t("Taloyhtiö")}
          value={company}
          options={[{ value: "all", label: t("Kaikki taloyhtiöt") }, ...companies.map(item => ({ value: item.id, label: item.name }))]}
          onChange={setCompany}
        />
        <Dropdown
          label={t("Aikaväli")}
          value={months}
          options={["3", "6", "12", "24"].map(value => ({ value, label: t("{0} kuukautta", value) }))}
          onChange={setMonths}
        />
      </div>
      {error && <p className="send-error">{error}</p>}
      {!result && !error && <div className="empty">{t("Ladataan…")}</div>}
      {result && (
        <>
          <div className="report-card">
            <h2>{t("Aiheet kuukausittain")}</h2>
            <p className="muted">{t("Saapuneet tehtävät aiheittain. Korostettu kuukausi on selvästi aiempien kuukausien keskiarvoa vilkkaampi.")}</p>
            {result.topics.length === 0 ? <p className="muted">{t("Aikavälillä ei ole tehtäviä.")}</p> : (
              <div className="table-card trends-table-wrap">
                <table className="data-table trends-table">
                  <thead>
                    <tr>
                      <th>{t("Aihe")}</th>
                      {result.months.map(month => <th key={month} className="num">{monthLabel(month)}</th>)}
                      <th className="num">{t("Yhteensä")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.topics.map(row => (
                      <tr key={row.topic}>
                        <th scope="row">{topicLabel(row.topic)}</th>
                        {row.series.map((count, index) => (
                          <td
                            key={result.months[index]}
                            className={`num${count === 0 ? " zero" : ""}${index === row.series.length - 1 && rising(row) ? " metric-alert" : ""}`}
                          >
                            {count}
                          </td>
                        ))}
                        <td className="num total">{row.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="report-card">
            <h2>{t("Toistuvat viat (6 kk)")}</h2>
            <p className="muted">{t("Sama aihe samassa asunnossa vähintään kahdesti tai samassa portaassa vähintään kolmesti. Näissä syy on usein rakenteessa tai laitteessa.")}</p>
            {result.repeats.length === 0 ? <p className="muted">{t("Ei toistuvia vikoja.")}</p> : (
              <ul className="trend-list">
                {result.repeats.map(item => (
                  <li key={`${item.kind}-${item.companyName}-${item.place}-${item.topic}`}>
                    <strong>{topicLabel(item.topic)}, {item.kind === "apartment" ? t("asunto {0}", item.place) : placeLabel(item.place)}</strong>
                    {many && <span>{item.companyName}</span>}
                    <span>{t("{0} ilmoitusta {1}–{2}", item.count, formatDateOnly(item.firstAt), formatDateOnly(item.lastAt))}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="trends-grid">
            <div className="report-card">
              <h2>{t("Hoitoaika aiheittain")}</h2>
              <p className="muted">{t("Aika saapumisesta sulkemiseen, mediaani.")}</p>
              {result.resolution.length === 0 ? <p className="muted">{t("Ei suljettuja tehtäviä.")}</p> : (
                <table className="data-table">
                  <thead><tr><th>{t("Aihe")}</th><th className="num">{t("Suljettuja")}</th><th className="num">{t("Mediaani")}</th></tr></thead>
                  <tbody>
                    {result.resolution.map(row => (
                      <tr key={row.topic}><th scope="row">{topicLabel(row.topic)}</th><td className="num">{row.closed}</td><td className="num">{hours(row.medianHours)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="report-card">
              <h2>{t("Huoltoyhtiöt")}</h2>
              <p className="muted">{t("Työtilaukset ja aika tilauksesta kuittaukseen, mediaani.")}</p>
              {result.contractors.length === 0 ? <p className="muted">{t("Ei työtilauksia.")}</p> : (
                <table className="data-table">
                  <thead><tr><th>{t("Huoltoyhtiö")}</th><th className="num">{t("Tilauksia")}</th><th className="num">{t("Avoinna")}</th><th className="num">{t("Mediaani")}</th></tr></thead>
                  <tbody>
                    {result.contractors.map(row => (
                      <tr key={row.name}>
                        <th scope="row">{row.name}</th><td className="num">{row.orders}</td>
                        <td className={`num${row.open > 0 ? " metric-alert" : ""}`}>{row.open}</td><td className="num">{hours(row.medianHours)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="report-card">
            <h2>{t("AI-luonnosten muokkaus")}</h2>
            <p className="muted">
              {t("Kuinka paljon käsittelijät muokkaavat AI:n vastausehdotuksia ennen lähetystä, koko historialta. AI-agentti voi vastata aiheeseen itse vasta, kun vähintään 100 luonnoksesta 99 % on lähtenyt sellaisenaan tai pelkällä sävymuokkauksella.")}
            </p>
            {!result.aiDrafts?.length ? <p className="muted">{t("Ei vielä AI-luonnoksista lähetettyjä vastauksia.")}</p> : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("Aihe")}</th><th className="num">{t("Luonnoksia")}</th><th className="num">{t("Sellaisenaan")}</th>
                    <th className="num">{t("Sävymuokkaus")}</th><th className="num">{t("Asiakorjaus")}</th><th className="num">{t("Uudelleen kirjoitettu")}</th>
                    <th className="num">{t("Kelpaa")}</th><th>{t("Agentin raja")}</th><th className="num">{t("Agentin siirrot")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.aiDrafts.map(row => (
                    <tr key={row.topic}>
                      <th scope="row">{topicLabel(row.topic)}</th>
                      <td className="num">{row.drafts}</td>
                      <td className="num">{row.unchanged}</td>
                      <td className="num">{row.tone}</td>
                      <td className="num" title={row.unclassified ? t("{0} muokkausta luokittelematta", row.unclassified) : undefined}>{row.fact}</td>
                      <td className="num">{row.rewritten}</td>
                      <td className="num">{percent(row.readyShare)}</td>
                      <td>{row.ready ? t("Täyttyy") : row.drafts < 100 ? t("Luonnoksia {0}/100", row.drafts) : t("Ei täyty")}</td>
                      <td className="num">{row.agentRuns ? `${row.handovers}/${row.agentRuns} (${percent(row.handoverShare)})` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="report-card">
            <h2>{t("Kasvavat aiheet")}</h2>
            <p className="muted">
              {t("Aihe, jonka ilmoituksia on viimeisen kolmen kuukauden aikana vähintään kaksi kertaa niin paljon kuin edellisen kolmen kuukauden aikana (vähintään 5 ilmoitusta). Laskenta ei käytä AI:ta.")}
            </p>
            {!result.trendAlerts?.length ? <p className="muted">{t("Ei selvästi kasvavia aiheita.")}</p> : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("Aihe")}</th>{many && <th>{t("Taloyhtiö")}</th>}
                    <th className="num">{t("Viimeiset 3 kk")}</th><th className="num">{t("Edelliset 3 kk")}</th><th>{t("Havaittu")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trendAlerts.map(alert => (
                    <tr key={`${alert.companyId}-${alert.topic}`}>
                      <th scope="row">{topicLabel(alert.topic)}</th>
                      {many && <td>{alert.companyName}</td>}
                      <td className="num">{alert.current}</td>
                      <td className="num">{alert.previous}</td>
                      <td>{alert.firstSeenAt ? formatDateOnly(alert.firstSeenAt) : t("Uusi")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="report-card">
            <h2>{t("Aikalupaukset")}</h2>
            <p className="muted">
              {t("Kun AI-agentti siirtää tehtävän henkilökunnalle, asukkaalle kerrotaan päivä, johon mennessä asiaan palataan. Lupaus pitää, kun asukkaalle vastattiin tai tehtävä suljettiin viimeistään luvattuna päivänä.")}
            </p>
            {!result.promises?.promises ? <p className="muted">{t("Aikavälillä ei ole annettu aikalupauksia.")}</p> : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="num">{t("Lupauksia")}</th><th className="num">{t("Pitivät")}</th><th className="num">{t("Myöhästyivät")}</th>
                    <th className="num">{t("Avoinna")}</th><th className="num">{t("Pitävyys")}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="num">{result.promises.promises}</td>
                    <td className="num">{result.promises.kept}</td>
                    <td className="num">{result.promises.broken}</td>
                    <td className="num">{result.promises.open}</td>
                    <td className="num">{percent(result.promises.keptShare)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>

          <div className="report-card">
            <h2>{t("Yhteiset viat")}</h2>
            {result.incidents.length === 0 ? <p className="muted">{t("Aikavälillä ei ole tunnistettu yhteisiä vikoja.")}</p> : (
              <ul className="trend-list">
                {result.incidents.map(item => (
                  <li key={`${item.companyName}-${item.topic}-${item.firstReportAt}`}>
                    <strong>{topicLabel(item.topic)}, {placeLabel(item.stairwell)}</strong>
                    {many && <span>{item.companyName}</span>}
                    <span>{t("{0}, {1} asuntoa", formatDateOnly(item.firstReportAt), item.reports)}</span>
                    {item.resolution && <p>{t("Ratkaisu: {0}", item.resolution)}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
