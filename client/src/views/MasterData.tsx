import { type FormEvent, useEffect, useState } from "react";
import { CollapseSection } from "../components/CollapseSection";
import { api, errorMessage } from "../session";
import { t } from "../i18n";

type MasterData = {
  emergencyKeywords: string[];
  sensitiveKeywords: string[];
  masking: { phone: boolean; email: boolean; personalId: boolean; iban: boolean };
  priorityDays: { emergency: number; urgent: number; normal: number; low: number };
  aiModels: { reply: string; assess: string; fast: string; reports: string };
};

type MasterDataResponse = { values: MasterData; defaults: MasterData; modelChoices: string[] };

const toText = (words: string[]) => words.join("\n");
const toList = (text: string) => text.split(/[\n,]/).map(word => word.trim().toLowerCase()).filter(Boolean);

const maskingLabels: { key: keyof MasterData["masking"]; label: string; example: string }[] = [
  { key: "phone", label: t("Puhelinnumerot"), example: "040 123 4567 → [puhelin]" },
  { key: "email", label: t("Sähköpostiosoitteet"), example: "matti@example.com → [sähköposti]" },
  { key: "personalId", label: t("Henkilötunnukset"), example: "010190-123A → [henkilötunnus]" },
  { key: "iban", label: t("Tilinumerot (IBAN)"), example: "FI21 1234 5600 0007 85 → [tilinumero]" }
];

const priorityLabels: { key: keyof MasterData["priorityDays"]; label: string }[] = [
  { key: "emergency", label: t("Hätä") },
  { key: "urgent", label: t("Kiireellinen") },
  { key: "normal", label: t("Normaali") },
  { key: "low", label: t("Matala") }
];

const modelLabels: { key: keyof MasterData["aiModels"]; label: string }[] = [
  { key: "reply", label: t("Vastausehdotukset") },
  { key: "assess", label: t("Saapuvien viestien arviointi") },
  { key: "fast", label: t("Dokumenttien pilkonta ja vertailu") },
  { key: "reports", label: t("Toistuvien aiheiden raportit") }
];

const modelNames: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5"
};

// Mikä osa määrittelyistä näytetään: perustiedot (hätäsanat ja määräajat), tietoturva (arkaluonteiset
// tiedot ja maskaus) tai AI (mallit). Tallennus lähettää aina kaikki määrittelyt; muut osat pysyvät ennallaan.
export type MasterDataPart = "basic" | "security" | "ai";

// Perustiedot: pääkäyttäjän muokattavat määrittelyt, jotka koskevat kaikkia taloyhtiöitä.
export function MasterDataSettings({ part }: { part: MasterDataPart }) {
  const [data, setData] = useState<MasterDataResponse | null>(null);
  const [emergency, setEmergency] = useState("");
  const [sensitive, setSensitive] = useState("");
  const [masking, setMasking] = useState<MasterData["masking"] | null>(null);
  const [days, setDays] = useState<MasterData["priorityDays"] | null>(null);
  const [models, setModels] = useState<MasterData["aiModels"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  function apply(values: MasterData) {
    setEmergency(toText(values.emergencyKeywords));
    setSensitive(toText(values.sensitiveKeywords));
    setMasking(values.masking);
    setDays(values.priorityDays);
    setModels(values.aiModels);
  }

  useEffect(() => {
    api<MasterDataResponse>("/master-data")
      .then(result => { setData(result); apply(result.values); })
      .catch(() => setError(t("Perustietojen lataus epäonnistui.")));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!masking || !days || !models) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const values = await api<MasterData>("/master-data", {
        method: "PUT",
        body: JSON.stringify({
          emergencyKeywords: toList(emergency),
          sensitiveKeywords: toList(sensitive),
          masking,
          priorityDays: days,
          aiModels: models
        })
      });
      apply(values);
      setSaved(true);
    } catch (problem) {
      setError(errorMessage(problem, t("Perustietojen tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  const changed = () => setSaved(false);

  const ready = data && masking && days && models;
  const footer = (
    <>
      {error && ready && <p className="send-error">{error}</p>}
      <div className="draft-actions">
        <button className="primary" type="submit" disabled={saving || !data}>
          {saving ? t("Tallennetaan…") : part === "basic" ? t("Tallenna perustiedot") : t("Tallenna")}
        </button>
        {saved && <span className="saved-indicator">{t("Tallennettu")}</span>}
      </div>
    </>
  );
  const loading = !ready && (error ? <p className="send-error">{error}</p> : <p className="muted">{t("Ladataan…")}</p>);

  if (part === "security") {
    return (
      <form className="settings-card ticket-form master-data" onSubmit={save}>
        <CollapseSection id="sensitive-data" title={t("Arkaluonteiset tiedot")}>
          {!ready ? loading : (
            <>
              <label>
                <span>{t("Viesti merkitään arkaluonteiseksi, jos jokin sen sanoista alkaa jollakin näistä (esim. \"sairau\" osuu sanoihin sairaus ja sairauden). Arkaluonteista tehtävää ei lähetetä AI:lle. Yksi sana riville.")}</span>
                <textarea rows={6} value={sensitive} onChange={event => { setSensitive(event.target.value); changed(); }} />
              </label>
              <button type="button" className="back-link" onClick={() => { setSensitive(toText(data.defaults.sensitiveKeywords)); changed(); }}>
                {t("Palauta oletukset")}
              </button>
            </>
          )}
        </CollapseSection>
        <CollapseSection id="ai-masking" title={t("Maskaus ennen AI:ta")}>
          {ready && (
            <>
              <p className="reply-hint">{t("Asukkaan tekstistä korvataan valitut tiedot merkinnällä ennen kuin teksti lähetetään AI:lle. Pleissiin tallentuu aina alkuperäinen viesti.")}</p>
              {maskingLabels.map(item => (
                <label className="switch-row" key={item.key}>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.example}</small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={masking[item.key]}
                    onChange={event => { setMasking({ ...masking, [item.key]: event.target.checked }); changed(); }}
                  />
                  <i aria-hidden="true" />
                </label>
              ))}
            </>
          )}
        </CollapseSection>
        {footer}
      </form>
    );
  }

  if (part === "ai") {
    return (
      <form className="settings-card ticket-form master-data" onSubmit={save}>
        <CollapseSection id="ai-models" title={t("AI-mallit")}>
          {!ready ? loading : (
            <>
              <div className="signature-fields">
                {modelLabels.map(item => (
                  <label key={item.key}>
                    <span>{item.label}</span>
                    <select value={models[item.key]} onChange={event => { setModels({ ...models, [item.key]: event.target.value }); changed(); }}>
                      <option value="">{t("Palvelimen oletus")}</option>
                      {data.modelChoices.map(model => <option key={model} value={model}>{modelNames[model] ?? model}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <p className="reply-hint">{t("Haiku on edullisin ja nopein, Opus tarkin ja kallein. Palvelimen oletus: vastausehdotukset Sonnet, pilkonta Haiku, muut Opus.")}</p>
            </>
          )}
          {footer}
        </CollapseSection>
      </form>
    );
  }

  return (
    <form className="settings-card ticket-form master-data" onSubmit={save}>
      <CollapseSection id="master-data" title={t("Hätäsanat ja määräajat")}>
        <p className="muted">{t("Määrittelyt koskevat kaikkia taloyhtiöitä. Vain pääkäyttäjä näkee ja muokkaa niitä.")}</p>
        {!ready ? loading : (
          <>
            <h3>{t("Hätäsanat")}</h3>
            <label>
              <span>{t("Viesti tunnistetaan hätätapaukseksi, jos siinä on jokin näistä sanoista tai ilmauksista. Käytetään, kun AI ei arvioi prioriteettia. Yksi sana tai ilmaus riville.")}</span>
              <textarea rows={6} value={emergency} onChange={event => { setEmergency(event.target.value); changed(); }} />
            </label>
            <button type="button" className="back-link" onClick={() => { setEmergency(toText(data.defaults.emergencyKeywords)); changed(); }}>
              {t("Palauta oletukset")}
            </button>

            <h3>{t("Määräajat prioriteetin mukaan")}</h3>
            <div className="signature-fields master-days">
              {priorityLabels.map(item => (
                <label key={item.key}>
                  <span>{item.label}{" "}({t("päivää")})</span>
                  <input
                    type="number"
                    min={0}
                    max={365}
                    value={days[item.key]}
                    onChange={event => { setDays({ ...days, [item.key]: Math.max(0, Math.min(365, Number(event.target.value) || 0)) }); changed(); }}
                  />
                </label>
              ))}
            </div>
            <p className="reply-hint">{t("Uusi tehtävä saa määräajan prioriteetin mukaan; 0 = sama päivä. Muutos koskee uusia tehtäviä.")}</p>
          </>
        )}
        {footer}
      </CollapseSection>
    </form>
  );
}
