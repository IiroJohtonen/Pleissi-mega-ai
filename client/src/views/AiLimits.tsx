import { type FormEvent, useEffect, useState } from "react";
import { t } from "../i18n";
import { api, errorMessage } from "../session";

type Group = "agent" | "assess" | "suggest" | "other";
type AiLimits = {
  monthlyLimit: number; dailyLimit: number; featureLimits: Record<Group, number>; agentRunsPerDay: number; assessPerSenderHour: number;
};

const groupLabels: Record<Group, string> = {
  agent: t("AI-agentti"),
  assess: t("Saapuvien viestien arviointi"),
  suggest: t("Vastausehdotukset"),
  other: t("Raportit, dokumentit ja muisti")
};
const GROUPS: Group[] = ["agent", "assess", "suggest", "other"];

// AI:n rajat pääkäyttäjälle: päiväraja kuukausirajan rinnalle, toimintojen osuudet kuukausirajasta sekä
// agentin ja saapuvien viestien arvioinnin käyttörajat. Hätätilanteen tunnistus toimii aina avainsanoilla.
export function AiLimitsCard() {
  const [limits, setLimits] = useState<AiLimits | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<AiLimits>("/office/ai-limits")
      .then(found => setLimits(found?.featureLimits ? found : null))
      .catch(loadError => setError(errorMessage(loadError, t("AI-rajojen lataus epäonnistui."))));
  }, []);

  const change = (next: Partial<AiLimits>) => {
    setLimits(current => (current ? { ...current, ...next } : current));
    setSaved(false);
  };
  const number = (value: string) => Math.max(0, Number(value) || 0);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!limits) return;
    setSaving(true);
    setError("");
    try {
      const { dailyLimit, featureLimits, agentRunsPerDay, assessPerSenderHour } = limits;
      setLimits(await api<AiLimits>("/office/ai-limits", {
        method: "PUT", body: JSON.stringify({ dailyLimit, featureLimits, agentRunsPerDay, assessPerSenderHour })
      }));
      setSaved(true);
    } catch (saveError) {
      setError(errorMessage(saveError, t("AI-rajojen tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  if (!limits) return error ? <p className="send-error">{error}</p> : null;
  return (
    <form className="settings-card ticket-form" id="section-ai-limits" onSubmit={save}>
      <h2>{t("AI-rajat")}</h2>
      <p className="muted">
        {t("Rajat estävät yksittäistä toimintoa tai lähettäjää kuluttamasta koko AI-budjettia. Kun raja täyttyy, Pleissi toimii ilman AI:ta: hätätilanteet tunnistetaan aina avainsanoilla.")}
      </p>
      <div className="signature-fields">
        <label>
          <span>{t("Päiväraja ($)")}</span>
          <input type="number" min={0} step={1} value={limits.dailyLimit} onChange={event => change({ dailyLimit: number(event.target.value) })} />
        </label>
        <label>
          <span>{t("AI-agentin ajot tehtävää kohden vuorokaudessa")}</span>
          <input type="number" min={0} max={100} value={limits.agentRunsPerDay} onChange={event => change({ agentRunsPerDay: Math.round(number(event.target.value)) })} />
        </label>
        <label>
          <span>{t("Saapuvien viestien AI-arvioinnit lähettäjää kohden tunnissa")}</span>
          <input type="number" min={0} max={1000} value={limits.assessPerSenderHour} onChange={event => change({ assessPerSenderHour: Math.round(number(event.target.value)) })} />
        </label>
      </div>
      <p className="reply-hint">
        {t("0 = ei rajaa. Kun agentin ajot täyttyvät, tehtävä siirtyy henkilökunnalle perustelun kanssa. Kun lähettäjän arvioinnit täyttyvät, saman tunnin viestit luokitellaan avainsanoilla.")}
      </p>
      <h3>{t("Toimintojen osuudet kuukausirajasta (%)")}</h3>
      <div className="signature-fields">
        {GROUPS.map(group => (
          <label key={group}>
            <span>{groupLabels[group]}</span>
            <input
              type="number" min={0} max={100} value={limits.featureLimits[group]}
              onChange={event => change({ featureLimits: { ...limits.featureLimits, [group]: Math.min(100, Math.round(number(event.target.value))) } })}
            />
          </label>
        ))}
      </div>
      <p className="reply-hint">
        {t("0 = ei omaa osuutta (toiminto voi käyttää koko kuukausirajan). Esimerkiksi agentti 40 % ja muut 30 % jättävät vähintään 30 % arvioinnille ja vastausehdotuksille.")}
        {limits.monthlyLimit <= 0 && ` ${t("Osuudet ovat käytössä vain, kun kuukausiraja on asetettu.")}`}
      </p>
      {error && <p className="send-error">{error}</p>}
      <div className="draft-actions">
        <button className="primary" type="submit" disabled={saving}>{saving ? t("Tallennetaan…") : t("Tallenna rajat")}</button>
        {saved && <span className="saved-indicator">{t("Tallennettu")}</span>}
      </div>
    </form>
  );
}
