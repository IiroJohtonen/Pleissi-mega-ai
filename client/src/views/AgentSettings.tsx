import { useEffect, useState } from "react";
import { t } from "../i18n";
import { api, errorMessage } from "../session";
import { topicLabel } from "../topics";

type AgentCompany = { id: string; name: string; autoStart: boolean | null };
type AgentTopic = {
  topic: string; drafts: number; readyShare: number | null; ready: boolean; handovers: number; agentRuns: number;
  approved: boolean; approvedBy: string | null; approvedAt: string | null; autonomous: boolean;
};
type AgentSettingsData = { autoStart: boolean; timePromise: boolean; companies: AgentCompany[]; companyId: string; topics: AgentTopic[] };

const overrideValue = (value: boolean | null) => (value === null ? "default" : value ? "on" : "off");
const overrideFromValue = (value: string) => (value === "default" ? null : value === "on");
const percent = (share: number | null) => (share === null ? "–" : `${Math.round(share * 1000) / 10} %`);

// Asetukset › AI: AI-reseptionistin automaattinen käynnistys ja aiheiden autonomia. Vain pääkäyttäjälle.
export function AgentSettingsCard() {
  const [data, setData] = useState<AgentSettingsData | null>(null);
  const [error, setError] = useState("");
  // Taloyhtiö, jonka itsenäisiä aiheita tarkastellaan (raja ja hyväksyntä ovat taloyhtiökohtaisia).
  const [companyId, setCompanyId] = useState("");
  const load = (company = companyId) => api<AgentSettingsData>(`/agent/settings${company ? `?companyId=${encodeURIComponent(company)}` : ""}`)
    .then(found => {
      setData({
        autoStart: Boolean(found?.autoStart),
        timePromise: Boolean(found?.timePromise),
        companies: Array.isArray(found?.companies) ? found.companies : [],
        companyId: typeof found?.companyId === "string" ? found.companyId : "",
        topics: Array.isArray(found?.topics) ? found.topics : []
      });
      if (typeof found?.companyId === "string") setCompanyId(found.companyId);
    })
    .catch(() => setError(t("AI-agentin asetusten lataus epäonnistui.")));
  useEffect(() => { void load(); }, []);

  async function save(path: string, body: unknown) {
    setError("");
    try {
      await api(path, { method: "PUT", body: JSON.stringify(body) });
      await load();
    } catch (problem) {
      setError(errorMessage(problem, t("Tallennus epäonnistui.")));
    }
  }

  if (!data) return <div className="settings-card">{error ? <p className="send-error">{error}</p> : <p className="muted">{t("Ladataan…")}</p>}</div>;
  return (
    <div className="settings-card" id="section-agent-receptionist">
      <h2>{t("AI-reseptionisti")}</h2>
      <p className="muted">
        {t("Kun automaattinen käynnistys on päällä, AI-agentti käsittelee uudet tehtävät heti saapuessaan. Oletuksena agentti tekee vastauksesta luonnoksen, jonka käsittelijä tarkistaa ja lähettää, myös kun agentti käynnistetään tehtävältä painikkeesta. Agentti ei vastaa korvauksia, korjausvastuita, poikkeuslupia, riitoja, häiriöitä tai hätätilanteita koskeviin asioihin, vaan siirtää ne henkilökunnalle ja ilmoittaa vastuuisännöitsijälle sähköpostilla.")}
      </p>
      {error && <p className="send-error">{error}</p>}
      <label className="switch-row">
        <span>
          <strong>{t("Käynnistä AI-agentti automaattisesti uusiin tehtäviin")}</strong>
          <small>{t("Koskee taloyhtiöitä, joille ei ole valittu omaa asetusta. Vaatii, että AI-agentti on päällä.")}</small>
        </span>
        <input type="checkbox" role="switch" checked={data.autoStart} onChange={event => void save("/agent/settings", { autoStart: event.target.checked })} />
        <i aria-hidden="true" />
      </label>

      <label className="switch-row">
        <span>
          <strong>{t("Aikalupaus asukkaalle")}</strong>
          <small>{t("Kun agentti ei osaa vastata, tehtävän luonnokseksi tulee viesti, jossa kerrotaan päivä, johon mennessä asiaan palataan. Käsittelijä lähettää sen. Vaatii automaattisen käynnistyksen.")}</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={data.timePromise}
          disabled={!data.timePromise && !data.autoStart && !data.companies.some(company => company.autoStart === true)}
          onChange={event => void save("/agent/settings", { timePromise: event.target.checked })}
        />
        <i aria-hidden="true" />
      </label>

      <h3>{t("Taloyhtiökohtaiset poikkeukset")}</h3>
      <div className="table-card">
        <table className="data-table">
          <thead><tr><th>{t("Taloyhtiö")}</th><th>{t("Automaattinen käynnistys")}</th></tr></thead>
          <tbody>
            {data.companies.map(company => (
              <tr key={company.id}>
                <td>{company.name}</td>
                <td>
                  <select
                    value={overrideValue(company.autoStart)}
                    aria-label={t("Automaattinen käynnistys: {0}", company.name)}
                    onChange={event => void save(`/agent/companies/${encodeURIComponent(company.id)}`, { autoStart: overrideFromValue(event.target.value) })}
                  >
                    <option value="default">{t("Oletus ({0})", data.autoStart ? t("päällä") : t("pois"))}</option>
                    <option value="on">{t("Päällä")}</option>
                    <option value="off">{t("Pois")}</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>{t("Itsenäiset aiheet")}</h3>
      <p className="reply-hint">
        {t("Taloyhtiön aiheeseen agentti voi vastata itse vasta, kun taloyhtiön vähintään 100 luonnoksesta 99 % on lähtenyt sellaisenaan tai pelkällä sävymuokkauksella ja pääkäyttäjä on hyväksynyt aiheen taloyhtiölle. Jos osuus putoaa rajan alle, aihe palaa automaattisesti luonnostilaan.")}
      </p>
      {data.companies.length > 0 && (
        <label className="agent-company">
          <span>{t("Taloyhtiö")}</span>
          <select value={companyId} onChange={event => { setCompanyId(event.target.value); void load(event.target.value); }}>
            {data.companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </label>
      )}
      {data.topics.length === 0 ? <p className="muted">{t("Ei vielä AI-luonnoksista lähetettyjä vastauksia.")}</p> : (
        <div className="table-card">
          <table className="data-table">
            <thead>
              <tr><th>{t("Aihe")}</th><th>{t("Luonnoksia")}</th><th>{t("Kelpaa")}</th><th>{t("Tila")}</th><th /></tr>
            </thead>
            <tbody>
              {data.topics.map(topic => (
                <tr key={topic.topic}>
                  <td>{topicLabel(topic.topic)}</td>
                  <td>{topic.drafts}</td>
                  <td>{percent(topic.readyShare)}</td>
                  <td>
                    {topic.autonomous ? t("Vastaa itse")
                      : topic.approved ? t("Hyväksytty, raja ei täyty: luonnostila")
                      : topic.ready ? t("Raja täyttyy: odottaa hyväksyntää")
                      : t("Luonnostila")}
                  </td>
                  <td>
                    {topic.approved ? (
                      <button type="button" className="quiet-button" onClick={() => void save(`/agent/topics/${encodeURIComponent(topic.topic)}`, { companyId, autonomous: false })}>
                        {t("Palauta luonnostilaan")}
                      </button>
                    ) : topic.ready ? (
                      <button type="button" className="secondary" onClick={() => void save(`/agent/topics/${encodeURIComponent(topic.topic)}`, { companyId, autonomous: true })}>
                        {t("Salli itsenäinen vastaus")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
