import { useEffect, useState } from "react";
import { t } from "../i18n";
import { api, errorMessage } from "../session";

type AgentCompany = { id: string; name: string; autoStart: boolean | null };
type AgentSettingsData = { autoStart: boolean; timePromise: boolean; agentName: string; signature: string; note: string; companies: AgentCompany[] };

const overrideValue = (value: boolean | null) => (value === null ? "default" : value ? "on" : "off");
const overrideFromValue = (value: string) => (value === "default" ? null : value === "on");

// Asetukset › AI: AI-reseptionistin automaattinen käynnistys, aikalupaus ja allekirjoitus. Vain pääkäyttäjälle.
export function AgentSettingsCard() {
  const [data, setData] = useState<AgentSettingsData | null>(null);
  const [error, setError] = useState("");
  // Agentin nimi allekirjoituksessa; tallennetaan erikseen.
  const [nameDraft, setNameDraft] = useState("");
  const load = () => api<AgentSettingsData>("/agent/settings")
    .then(found => {
      setData({
        autoStart: Boolean(found?.autoStart),
        timePromise: Boolean(found?.timePromise),
        agentName: typeof found?.agentName === "string" ? found.agentName : "",
        signature: typeof found?.signature === "string" ? found.signature : "",
        note: typeof found?.note === "string" ? found.note : "",
        companies: Array.isArray(found?.companies) ? found.companies : []
      });
      if (typeof found?.agentName === "string") setNameDraft(found.agentName);
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
        {t("AI-agentti hoitaa sille annetun tehtävän itse: vastaa asukkaalle ja tekee varaukset. Kun automaattinen käynnistys on päällä, agentti ottaa uudet tehtävät hoitaakseen heti niiden saapuessa. Jos aiheesta ei ole dokumentaatiota, agentti ohjaa tehtävän vastuuisännöitsijälle ja ilmoittaa hänelle sähköpostilla. Korvauksia, korjausvastuita, poikkeuslupia, riitoja, häiriöitä ja hätätilanteita koskeviin asioihin agentti ei vastaa, vaan siirtää ne henkilökunnalle.")}
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

      <h3>{t("Agentin allekirjoitus")}</h3>
      <p className="reply-hint">
        {t("AI-agentin vastauksissa on aina allekirjoitus, josta asukas näkee, että vastauksen kirjoitti tekoäly. Kun käsittelijä lähettää agentin luonnoksen, allekirjoituksessa kerrotaan myös, kuka vastauksen tarkisti.")}
      </p>
      <div className="agent-name-form">
        <label>
          <span>{t("Agentin nimi")}</span>
          <input value={nameDraft} maxLength={40} onChange={event => setNameDraft(event.target.value)} />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={!nameDraft.trim() || nameDraft.trim() === data.agentName}
          onClick={() => void save("/agent/settings", { agentName: nameDraft.trim() })}
        >
          {t("Tallenna nimi")}
        </button>
      </div>
      {data.signature && (
        <div className="agent-signature-preview">
          <pre>{data.signature}</pre>
          {data.note && <p className="ai-note">{data.note}</p>}
        </div>
      )}

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
    </div>
  );
}
