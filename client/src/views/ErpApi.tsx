import { type FormEvent, useEffect, useState } from "react";
import { formatDate } from "../format";
import { t } from "../i18n";
import { api, errorMessage } from "../session";

type Scope = "events:write" | "events:read" | "sync:write";

type ApiKey = {
  id: string; name: string; key_prefix: string; scopes: Scope[]; created_at: string; created_by: string;
  last_used_at: string | null; revoked_at: string | null; revoked_by: string | null; last_cursor: string | null; last_fetched_at: string | null;
};

type ApiSettings = { adapter: string | null; pull: boolean; pullSetting: boolean; pullForced: boolean; scopes: Scope[]; keys: ApiKey[] };

const scopeLabels: Record<Scope, { label: string; hint: string }> = {
  "events:write": { label: t("Lähettää muutoksia"), hint: t("ERP lähettää taloyhtiöt, asunnot, asukkaat ja poismuutot.") },
  "events:read": { label: t("Hakee muutoksia"), hint: t("ERP hakee tehtävät ja asukkaille näkyvät viestit jonosta.") },
  "sync:write": { label: t("Ensilataus"), hint: t("ERP lähettää kaikki taloyhtiöt ja asukkaat kerralla.") }
};

const ALL_SCOPES: Scope[] = ["events:write", "events:read", "sync:write"];

// Palvelimen vastaus asetuksiksi; puuttuvat kentät oletusarvoilla.
function normalize(value: Partial<ApiSettings> | null | undefined): ApiSettings {
  return {
    adapter: value?.adapter ?? null,
    pull: Boolean(value?.pull),
    pullSetting: Boolean(value?.pullSetting),
    pullForced: Boolean(value?.pullForced),
    scopes: Array.isArray(value?.scopes) ? value.scopes : ALL_SCOPES,
    keys: Array.isArray(value?.keys) ? value.keys : []
  };
}

// ERP-rajapinta: ERP:n haku jonosta ja API-avaimet. Vain pääkäyttäjälle. Avain näytetään vain kerran.
export function ErpApiSettings() {
  const [settings, setSettings] = useState<ApiSettings | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(ALL_SCOPES);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<ApiSettings>("/integration/api").then(result => setSettings(normalize(result))).catch(loadError => setError(errorMessage(loadError, t("ERP-rajapinnan asetusten lataus epäonnistui."))));
  }, []);

  async function togglePull(enabled: boolean) {
    setError("");
    try {
      setSettings(normalize(await api<ApiSettings>("/integration/api/pull", { method: "PUT", body: JSON.stringify({ enabled }) })));
    } catch (saveError) {
      setError(errorMessage(saveError, t("Asetuksen tallennus epäonnistui.")));
    }
  }

  async function createKey(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await api<{ key: string; apiKey: ApiKey }>("/integration/api-keys", { method: "POST", body: JSON.stringify({ name, scopes }) });
      setCreated({ key: result.key, name: result.apiKey.name });
      setName("");
      setSettings(normalize(await api<ApiSettings>("/integration/api")));
    } catch (saveError) {
      setError(errorMessage(saveError, t("Avaimen luonti epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function revoke(apiKey: ApiKey) {
    if (!window.confirm(t("Mitätöidäänkö avain {0}? ERP ei voi enää käyttää sitä.", apiKey.name))) return;
    setError("");
    try {
      await api(`/integration/api-keys/${encodeURIComponent(apiKey.id)}`, { method: "DELETE" });
      setSettings(normalize(await api<ApiSettings>("/integration/api")));
    } catch (revokeError) {
      setError(errorMessage(revokeError, t("Avaimen mitätöinti epäonnistui.")));
    }
  }

  return (
    <div className="settings-card ticket-form erp-api" id="section-integration-api">
      <h2>{t("ERP-rajapinta")}</h2>
      <p className="muted">
        {t("Toiminnanohjausjärjestelmä (ERP) lähettää Pleissiin taloyhtiöt, asunnot ja asukkaat ja hakee Pleissistä tehtävien tilan. ERP tunnistautuu API-avaimella.")}
      </p>
      {error && <p className="send-error">{error}</p>}
      {!settings ? (!error && <p className="muted">{t("Ladataan…")}</p>) : (
        <>
          <label className="switch-row">
            <span>
              <strong>{t("ERP hakee muutokset jonosta")}</strong>
              <small>
                {settings.adapter
                  ? t("Pleissi lähettää muutokset ERP:hen itse (käytössä: {0}), joten hakua ei tarvita.", settings.adapter === "mock" ? t("simuloitu ERP") : settings.adapter)
                  : settings.pullForced
                    ? t("Haku on kytketty päälle palvelimen asetuksissa (INTEGRATION_PULL), joten sitä ei voi kytkeä pois täältä.")
                    : t("Tehtävien muutokset ja asukkaille näkyvät viestit kirjataan jonoon, josta ERP hakee ne. Sisäiset muistiinpanot eivät mene jonoon.")}
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={settings.pull}
              disabled={Boolean(settings.adapter) || settings.pullForced}
              onChange={event => void togglePull(event.target.checked)}
            />
            <i aria-hidden="true" />
          </label>

          <h3>{t("API-avaimet")}</h3>
          {created && (
            <div className="api-key-created" role="status">
              <p><strong>{t("Avain {0} luotu. Kopioi se nyt: avainta ei näytetä uudelleen.", created.name)}</strong></p>
              <code className="api-key-value">{created.key}</code>
              <div className="draft-actions">
                <button type="button" className="secondary" onClick={() => void navigator.clipboard?.writeText(created.key)}>{t("Kopioi")}</button>
                <button type="button" className="secondary" onClick={() => setCreated(null)}>{t("Valmis")}</button>
              </div>
            </div>
          )}
          {settings.keys.length === 0 ? <p className="muted">{t("Ei avaimia.")}</p> : (
            <div className="table-card">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("Nimi")}</th>
                    <th>{t("Oikeudet")}</th>
                    <th>{t("Luotu")}</th>
                    <th>{t("Käyttö")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {settings.keys.map(apiKey => (
                    <tr key={apiKey.id} className={apiKey.revoked_at ? "muted" : ""}>
                      <td>{apiKey.name}<br /><code>{apiKey.key_prefix}</code></td>
                      <td>{apiKey.scopes.map(scope => scopeLabels[scope]?.label ?? scope).join(", ")}</td>
                      <td>{formatDate(apiKey.created_at)}<br /><small>{apiKey.created_by}</small></td>
                      <td>
                        {apiKey.last_used_at ? t("Viimeksi käytetty {0}", formatDate(apiKey.last_used_at)) : t("Ei käytetty")}
                        {apiKey.last_fetched_at && (
                          <><br /><small>{t("Viimeisin haku {0}", formatDate(apiKey.last_fetched_at))} · <code>{apiKey.last_cursor}</code></small></>
                        )}
                      </td>
                      <td>
                        {apiKey.revoked_at
                          ? <small>{t("Mitätöity {0}", formatDate(apiKey.revoked_at))}</small>
                          : <button type="button" className="secondary" onClick={() => void revoke(apiKey)}>{t("Mitätöi")}</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form onSubmit={createKey}>
            <label>
              <span>{t("Uuden avaimen nimi")}</span>
              <input value={name} onChange={event => setName(event.target.value)} placeholder={t("Esim. ERP tuotanto")} maxLength={80} />
            </label>
            <fieldset className="role-choices">
              <legend>{t("Oikeudet")}</legend>
              {settings.scopes.map(scope => (
                <label key={scope} className="role-choice" title={scopeLabels[scope]?.hint}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={event => setScopes(current => event.target.checked ? [...current, scope] : current.filter(item => item !== scope))}
                  />
                  {scopeLabels[scope]?.label ?? scope}
                </label>
              ))}
            </fieldset>
            <div className="draft-actions">
              <button className="primary" type="submit" disabled={saving || !name.trim() || scopes.length === 0}>
                {saving ? t("Luodaan…") : t("Luo avain")}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
