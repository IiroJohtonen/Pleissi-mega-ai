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
  embedding: { similarTickets: boolean; hybridKnowledge: boolean };
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

const embeddingLabels: { key: keyof MasterData["embedding"]; label: string; hint: string }[] = [
  {
    key: "similarTickets",
    label: t("Aiemmat tehtävät esimerkkeinä"),
    hint: t("Vastausehdotus ja AI-agentti saavat 2–3 samankaltaista ratkaistua tehtävää sävyn ja käsittelytavan malliksi. Tosiasiat tulevat aina dokumentaatiosta.")
  },
  {
    key: "hybridKnowledge",
    label: t("Hybridihaku dokumentaatioon"),
    hint: t("Dokumentaatiosta haetaan sanojen lisäksi merkityksen perusteella, esim. \"löylyhuone kylmä\" löytää ohjeen \"sauna ei lämpene\".")
  }
];

type EmbeddingCompany = {
  id: string; name: string; similarTickets: boolean | null; hybridKnowledge: boolean | null;
  vectors: { ticket: number; chunk: number; memory: number };
};
type EmbeddingStatus = {
  killed: boolean;
  backend: string;
  model: { model: string; loaded: boolean; memoryMb: number | null; error: string | null };
  index: { running: boolean; lastRunAt: string | null; lastError: string | null };
  companies: EmbeddingCompany[];
};

const overrideValue = (value: boolean | null) => (value === null ? "" : value ? "on" : "off");
const overrideFromValue = (value: string) => (value === "" ? null : value === "on");

// Merkityshaun tila ja taloyhtiökohtaiset poikkeukset: pilottitaloyhtiössä voi kokeilla ennen kuin
// toiminto kytketään kaikille. Muutos tallentuu heti.
function EmbeddingCompanies() {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [error, setError] = useState("");

  const load = () => api<EmbeddingStatus>("/embedding/status")
    .then(setStatus)
    .catch(() => setError(t("Merkityshaun tilan lataus epäonnistui.")));
  useEffect(() => { void load(); }, []);

  async function change(company: EmbeddingCompany, key: keyof MasterData["embedding"], value: string) {
    setError("");
    try {
      await api(`/embedding/companies/${encodeURIComponent(company.id)}`, { method: "PUT", body: JSON.stringify({ [key]: overrideFromValue(value) }) });
      await load();
    } catch (problem) {
      setError(errorMessage(problem, t("Tallennus epäonnistui.")));
    }
  }

  if (!status) return error ? <p className="send-error">{error}</p> : <p className="muted">{t("Ladataan…")}</p>;
  const option = (value: string, label: string) => <option value={value}>{label}</option>;
  return (
    <>
      {status.killed && <p className="send-error">{t("Merkityshaku on kytketty pois palvelimen asetuksella (EMBEDDING_ENABLED=false).")}</p>}
      <p className="reply-hint">
        {t("Malli: {0}", status.model.model)}
        {" · "}
        {status.model.loaded ? t("ladattu ({0} Mt muistia)", status.model.memoryMb ?? "?") : t("ei vielä ladattu")}
        {" · "}
        {status.backend === "sqlite-vec" ? t("hakuindeksi sqlite-vec") : t("vertailu muistissa")}
        {status.index.running ? ` · ${t("vektoreita lasketaan…")}` : ""}
      </p>
      {(status.model.error || status.index.lastError) && (
        <p className="send-error">{t("Virhe: {0}", status.model.error || status.index.lastError || "")}</p>
      )}
      <div className="table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("Taloyhtiö")}</th>
              <th>{t("Aiemmat tehtävät esimerkkeinä")}</th>
              <th>{t("Hybridihaku dokumentaatioon")}</th>
              <th>{t("Vektorit")}</th>
            </tr>
          </thead>
          <tbody>
            {status.companies.map(company => (
              <tr key={company.id}>
                <td>{company.name}</td>
                {embeddingLabels.map(item => (
                  <td key={item.key}>
                    <select
                      aria-label={`${company.name}: ${item.label}`}
                      value={overrideValue(company[item.key])}
                      onChange={event => void change(company, item.key, event.target.value)}
                    >
                      {option("", t("Yleinen asetus"))}
                      {option("on", t("Päällä"))}
                      {option("off", t("Pois"))}
                    </select>
                  </td>
                ))}
                <td>{t("{0} tehtävää, {1} palaa, {2} muistitietoa", company.vectors.ticket, company.vectors.chunk, company.vectors.memory)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="send-error">{error}</p>}
    </>
  );
}

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
  const [embedding, setEmbedding] = useState<MasterData["embedding"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  function apply(values: MasterData) {
    setEmergency(toText(values.emergencyKeywords));
    setSensitive(toText(values.sensitiveKeywords));
    setMasking(values.masking);
    setDays(values.priorityDays);
    setModels(values.aiModels);
    // Vanhempi palvelin ei palauta merkityshaun asetuksia: ne ovat silloin pois.
    setEmbedding(values.embedding ?? { similarTickets: false, hybridKnowledge: false });
  }

  useEffect(() => {
    api<MasterDataResponse>("/master-data")
      .then(result => { setData(result); apply(result.values); })
      .catch(() => setError(t("Perustietojen lataus epäonnistui.")));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!masking || !days || !models || !embedding) return;
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
          aiModels: models,
          embedding
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

  const ready = data && masking && days && models && embedding;
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
        <CollapseSection id="embedding" title={t("Merkityshaku")}>
          {ready && (
            <>
              <p className="reply-hint">{t("Pleissi laskee tehtävistä ja dokumentaatiosta merkitystä kuvaavat vektorit omalla palvelimellaan. Teksti ei lähde palvelimelta. Kun asetus kytketään päälle, vektorit lasketaan taustalla; siihen asti haku toimii kuten ennen.")}</p>
              {embeddingLabels.map(item => (
                <label className="switch-row" key={item.key}>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={embedding[item.key]}
                    onChange={event => { setEmbedding({ ...embedding, [item.key]: event.target.checked }); changed(); }}
                  />
                  <i aria-hidden="true" />
                </label>
              ))}
              {footer}
              <h3>{t("Taloyhtiökohtaiset poikkeukset")}</h3>
              <p className="reply-hint">{t("Kokeile ensin yhdessä pilottitaloyhtiössä: valitse sille Päällä ja jätä yleinen asetus pois.")}</p>
              <EmbeddingCompanies />
            </>
          )}
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
