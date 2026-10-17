import { type FormEvent, useEffect, useState } from "react";
import { Dropdown, usePaged } from "../components/common";
import { formatDate } from "../format";
import { type Language, language, LANGUAGES, locale, setLanguage } from "../i18n";
import {
  api, errorMessage, isAdmin, MANAGEMENT_OFFICE, type OfficeUser, session, setSession, USER_ROLES
} from "../session";
import type { MailProvider, MailStatus } from "../types";
import { type BookingRules, WEEKLY_DURATION_OPTIONS, weeklyWeeksOf } from "./Bookings";
import { PARKING_TYPES } from "./Parking";
import { saveAiPrompt, storedAiPrompt } from "../preferences";
import { t } from "../i18n";
import { setTheme, storedTheme } from "../theme";
import { MasterDataSettings } from "./MasterData";
import { CollapseSection } from "../components/CollapseSection";


// Asetukset: jokaisella käyttäjällä omat asetuksensa, pääkäyttäjällä lisäksi toimiston tiedot.
export function Settings({ initialTab = "user", ...props }: { onSaved: () => Promise<void>; initialTab?: "user" | "office" }) {
  const admin = isAdmin();
  const [tab, setTab] = useState<"user" | "office">(initialTab);

  return (
    <>
      <div className="card-tabs settings-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "user"} className={tab === "user" ? "active" : ""} onClick={() => setTab("user")}>
          {t("Käyttäjän asetukset")}
        </button>
        {admin && (
          <button role="tab" aria-selected={tab === "office"} className={tab === "office" ? "active" : ""} onClick={() => setTab("office")}>
            {t("Isännöitsijätoimiston tiedot")}
          </button>
        )}
      </div>
      {tab === "office" && admin ? <OfficeSettings {...props} /> : <UserSettings />}
    </>
  );
}

// Kirjautuneen käyttäjän omat tiedot, salasana ja kieli.
// Ulkoasu: tumma tila päälle tai pois. Valinta tallentuu tähän selaimeen ja vaihtuu heti.
function AppearanceCard() {
  const [dark, setDark] = useState(storedTheme() === "dark");
  return (
    <div className="settings-card ticket-form">
      <CollapseSection id="appearance" title={t("Ulkoasu")}>
        <label className="switch-row">
          <span>
            <strong>{t("Tumma tila")}</strong>
            <small>{t("Tummat siniharmaat sävyt, jotka ovat silmille pehmeämmät hämärässä.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={dark}
            onChange={event => {
              setDark(event.target.checked);
              setTheme(event.target.checked ? "dark" : "light");
            }}
          />
          <i aria-hidden="true" />
        </label>
        <p className="reply-hint">{t("Valinta tallentuu tähän selaimeen.")}</p>
      </CollapseSection>
    </div>
  );
}

// AI-ehdotuksen lisätietoikkuna: pois päältä ehdotus pyydetään suoraan ilman ikkunaa.
function AiPromptCard() {
  const [enabled, setEnabled] = useState(storedAiPrompt);
  return (
    <div className="settings-card ticket-form">
      <CollapseSection id="ai-prompt" title={t("AI-ehdotukset")}>
        <label className="switch-row">
          <span>
            <strong>{t("Kysy lisätietoa ennen AI-ehdotusta")}</strong>
            <small>{t("Pyydä AI-ehdotus avaa ikkunan, johon voi kirjoittaa tehtävästä lisätietoa AI:n huomioitavaksi. Pois päältä ehdotus tehdään heti.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            onChange={event => {
              setEnabled(event.target.checked);
              saveAiPrompt(event.target.checked);
            }}
          />
          <i aria-hidden="true" />
        </label>
        <p className="reply-hint">{t("Valinta tallentuu tähän selaimeen.")}</p>
      </CollapseSection>
    </div>
  );
}

type SignatureSettings = { title: string; phone: string; template: string; defaultTemplate: string; preview: string };

const SIGNATURE_FIELDS = ["nimi", "titteli", "puhelin", "sähköposti", "toimisto"];

// Sama täyttö kuin palvelimella: paikkamerkit korvataan, ja rivi, jonka paikkamerkit jäävät tyhjiksi, jätetään pois.
export function fillSignature(template: string, values: Record<string, string>): string {
  return template.replace(/\r\n/g, "\n").split("\n").flatMap(line => {
    const hasField = /\{[^{}]+\}/.test(line);
    const filled = line.replace(/\{([^{}]+)\}/g, (match, key: string) => {
      const field = key.trim().toLowerCase();
      return field in values ? values[field] : match;
    });
    return hasField && !filled.trim() ? [] : [filled.trimEnd()];
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Sähköpostin allekirjoitus, joka lisätään käyttäjän lähettämien vastausten loppuun.
function SignatureCard() {
  const user = session?.user;
  const [settings, setSettings] = useState<SignatureSettings | null>(null);
  const [title, setTitle] = useState("");
  const [phone, setPhone] = useState("");
  const [template, setTemplate] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<SignatureSettings>("/me/signature")
      .then(loaded => {
        setSettings(loaded);
        setTitle(loaded.title ?? "");
        setPhone(loaded.phone ?? "");
        setTemplate(loaded.template ?? "");
      })
      .catch(() => setError(t("Allekirjoituksen lataus epäonnistui.")));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const updated = await api<SignatureSettings>("/me/signature", {
        method: "PUT",
        body: JSON.stringify({ title, phone, template })
      });
      setSettings(updated);
      setSaved(true);
    } catch (saveError) {
      setError(errorMessage(saveError, t("Allekirjoituksen tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  const preview = fillSignature(template, {
    nimi: user?.name ?? "",
    titteli: title.trim(),
    puhelin: phone.trim(),
    "sähköposti": user?.email ?? "",
    toimisto: MANAGEMENT_OFFICE.name
  });
  const change = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setSaved(false);
  };

  return (
    <form className="settings-card ticket-form signature-card" onSubmit={save}>
      <CollapseSection id="signature" title={t("Sähköpostin allekirjoitus")}>
      <p className="muted">{t("Allekirjoitus lisätään tehtäviltä lähettämiesi vastausten loppuun. Sen voi jättää pois yksittäisestä vastauksesta.")}</p>
      <div className="signature-fields">
        <label>
          <span>{t("Titteli")}</span>
          <input value={title} onChange={event => change(setTitle)(event.target.value)} placeholder={t("esim. Isännöitsijä")} maxLength={100} />
        </label>
        <label>
          <span>{t("Puhelinnumero")}</span>
          <input value={phone} onChange={event => change(setPhone)(event.target.value)} placeholder="040 123 4567" maxLength={40} />
        </label>
      </div>
      <label>
        <span>{t("Allekirjoituspohja")}</span>
        <textarea rows={7} value={template} onChange={event => change(setTemplate)(event.target.value)} maxLength={2000} disabled={!settings} />
      </label>
      <p className="reply-hint">
        {t("Paikkamerkit:")}{" "}
        {SIGNATURE_FIELDS.map(field => (
          <button
            key={field}
            type="button"
            className="signature-field"
            onClick={() => change(setTemplate)(`${template.trimEnd()}\n{${field}}`)}
            title={t("Lisää pohjan loppuun")}
          >
            {`{${field}}`}
          </button>
        ))}
        {" "}{t("Rivi jätetään pois, jos sen tieto puuttuu. Tyhjä pohja = ei allekirjoitusta.")}
      </p>
      <div className="signature-preview">
        <span>{t("Esikatselu")}</span>
        {preview ? <pre>{preview}</pre> : <p className="muted">{t("Ei allekirjoitusta.")}</p>}
      </div>
      {error && <p className="send-error">{error}</p>}
      <div className="draft-actions">
        <button className="primary" type="submit" disabled={saving || !settings}>
          {saving ? t("Tallennetaan…") : t("Tallenna allekirjoitus")}
        </button>
        {settings && template !== settings.defaultTemplate && (
          <button type="button" onClick={() => change(setTemplate)(settings.defaultTemplate)}>{t("Palauta oletuspohja")}</button>
        )}
        {saved && <span className="saved-indicator">{t("Tallennettu")}</span>}
      </div>
      </CollapseSection>
    </form>
  );
}

function UserSettings() {
  const user = session?.user;
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!user || !session) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const updated = await api<OfficeUser>(`/users/${encodeURIComponent(user.id)}`, {
        method: "PUT",
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password: password || undefined })
      });
      // Muutos näkyy heti myös sivupalkissa.
      setSession({ ...session, user: updated });
      setPassword("");
      setSaved(true);
    } catch (submitError) {
      setError(errorMessage(submitError, t("Tietojen tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="content settings">
      <form className="settings-card ticket-form" onSubmit={handleSubmit}>
        <CollapseSection id="user-details" title={t("Omat tiedot")}>
        <p className="muted">{MANAGEMENT_OFFICE.name} · {t(user?.role ?? "")}</p>

        <label>
          <span>{t("Nimi")}</span>
          <input value={name} onChange={event => { setName(event.target.value); setSaved(false); }} />
        </label>

        <label>
          <span>{t("Sähköposti (käytetään kirjautumiseen)")}</span>
          <input type="email" value={email} onChange={event => { setEmail(event.target.value); setSaved(false); }} />
        </label>

        <label>
          <span>{t("Uusi salasana")}</span>
          <input
            type="password"
            value={password}
            onChange={event => { setPassword(event.target.value); setSaved(false); }}
            placeholder={t("Jätä tyhjäksi, jos salasanaa ei vaihdeta")}
            autoComplete="new-password"
          />
        </label>
        <p className="reply-hint">{t("Vähintään 8 merkkiä. Vaihto kirjaa sinut ulos muilta laitteilta.")}</p>

        {error && <p className="send-error">{error}</p>}

        <div className="draft-actions">
          <button
            className="primary"
            type="submit"
            disabled={saving || !name.trim() || !email.trim() || (password.length > 0 && password.length < 8)}
          >
            {saving ? t("Tallennetaan…") : t("Tallenna tiedot")}
          </button>
          {saved && <span className="saved-indicator">{t("Tallennettu")}</span>}
        </div>
        </CollapseSection>
      </form>

      <MailAccountCard target="me" />

      <SignatureCard />

      <AppearanceCard />
      <AiPromptCard />

      <div className="settings-card ticket-form">
        <CollapseSection id="language" title={t("Kieli")}>
        <Dropdown label={t("Käyttöliittymän kieli")} value={language} options={LANGUAGES} onChange={value => setLanguage(value as Language)} />
        <p className="reply-hint">{t("Kielivalinta tallentuu tähän selaimeen. Sivu latautuu uudelleen, kun kieli vaihtuu.")}</p>
        </CollapseSection>
      </div>
    </section>
  );
}

// reminderEmails: 1 = käsittelijöille lähetetään muistutuskooste. retentionMonths: 0 = tietoja ei poisteta.
export type OfficeInfo = {
  name: string; businessId: string; address: string; phone: string;
  reminderEmails?: number; retentionMonths?: number;
  // Muistutusten rajat päivinä: asukas odottanut vastausta / määräaikaan jäljellä enintään.
  replyReminderDays?: number; dueReminderDays?: number;
  // aiPriority: 1 = AI arvioi saapuvan tehtävän prioriteetin. aiAvailable: palvelimella on AI-avain.
  aiPriority?: number; aiAvailable?: boolean;
  // aiRelevance: 1 = AI tarkistaa, koskeeko saapuva sähköposti taloyhtiön asioita.
  aiRelevance?: number;
  // AI-kulujen kuukausiraja dollareina (0 = ei rajaa) ja varoitusraja prosentteina rajasta.
  aiMonthlyLimit?: number; aiWarningPercent?: number;
  // twoFactor: kirjautumiskoodi sähköpostiin; twoFactorOverridden: palvelin on kytkenyt sen pois.
  twoFactor?: number; twoFactorOverridden?: boolean;
  // residentStatusUpdates: asukas saa sähköpostin, kun tehtävän tila muuttuu.
  residentStatusUpdates?: number;
  // Taloyhtiö tunnistamatta -jonon käsittelijät: roolit ja käyttäjät. canHandleUnidentified: kuuluuko
  // kirjautunut käyttäjä heihin.
  unidentifiedQueueRoles?: string[]; unidentifiedQueueUsers?: string[]; canHandleUnidentified?: boolean;
};

const providerNames: Record<MailProvider, string> = {
  gmail: "Gmail",
  microsoft: "Microsoft 365",
  imap: t("IMAP/SMTP")
};

// IMAP/SMTP-tilin lomake. Portit ovat yleisimmät salatut oletukset; palvelimen osoite löytyy
// sähköpostipalvelun ohjeista.
const emptyImapForm = { email: "", imapHost: "", imapPort: "993", smtpHost: "", smtpPort: "465", username: "", password: "" };

// Sähköpostitili, jolla posti lähtee ja saapuu. target "office" = toimiston tili, "me" = kirjautuneen
// käyttäjän oma postilaatikko, muuten taloyhtiön tunniste. Gmail ja Microsoft 365 yhdistetään kirjautumalla
// uudessa välilehdessä, muut palvelut IMAP/SMTP-tiedoilla. Oman laatikon yhdistää käyttäjä itse,
// toimiston ja taloyhtiön tilin vain pääkäyttäjä.
export function MailAccountCard({ target }: { target: string }) {
  const office = target === "office";
  const personal = target === "me";
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [providers, setProviders] = useState<Record<MailProvider, boolean>>({ gmail: true, microsoft: false, imap: true });
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<MailProvider | null>(null);
  const [imapOpen, setImapOpen] = useState(false);
  const [imapForm, setImapForm] = useState(emptyImapForm);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  async function loadStatus() {
    try {
      setStatus(await api<MailStatus>(personal ? "/mail/status?target=me" : office ? "/mail/status" : `/mail/status?companyId=${encodeURIComponent(target)}`));
    } catch {
      setStatus({ connected: false });
    }
  }

  useEffect(() => {
    setWaiting(null);
    setImapOpen(false);
    setError("");
    setSaved("");
    void loadStatus();
    api<Record<MailProvider, boolean>>("/mail/providers").then(setProviders).catch(() => undefined);
    // Kun käyttäjä palaa kirjautumisesta tähän välilehteen, tila luetaan uudelleen.
    const onFocus = () => void loadStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [target]);

  async function connectOAuth(provider: "gmail" | "microsoft") {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const { url } = await api<{ url: string }>(provider === "gmail" ? "/gmail/connect" : "/mail/microsoft/connect", {
        method: "POST", body: JSON.stringify({ target })
      });
      window.open(url, "_blank", "noopener");
      setWaiting(provider);
    } catch (connectError) {
      setError(errorMessage(connectError, t("Kirjautumisen aloitus epäonnistui.")));
    } finally {
      setBusy(false);
    }
  }

  function updateImap(key: keyof typeof emptyImapForm, value: string) {
    setImapForm(current => {
      const next = { ...current, [key]: value };
      // SMTP-palvelin on yleensä IMAP-palvelimen kaltainen; ehdotetaan sitä, kunnes käyttäjä muuttaa sen itse.
      if (key === "imapHost" && (!current.smtpHost || current.smtpHost === current.imapHost.replace(/^imap\./i, "smtp."))) {
        next.smtpHost = value.replace(/^imap\./i, "smtp.");
      }
      return next;
    });
  }

  async function connectImap(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const result = await api<{ email: string }>("/mail/imap", {
        method: "POST",
        body: JSON.stringify({
          target,
          email: imapForm.email.trim(),
          imapHost: imapForm.imapHost.trim(),
          imapPort: Number(imapForm.imapPort),
          smtpHost: imapForm.smtpHost.trim(),
          smtpPort: Number(imapForm.smtpPort),
          username: imapForm.username.trim() || undefined,
          password: imapForm.password
        })
      });
      setImapOpen(false);
      setImapForm(emptyImapForm);
      setSaved(t("Tili {0} on yhdistetty.", result.email));
      await loadStatus();
    } catch (connectError) {
      setError(errorMessage(connectError, t("Sähköpostitilin yhdistäminen epäonnistui.")));
    } finally {
      setBusy(false);
    }
  }

  async function removeOwn() {
    if (!window.confirm(personal
      ? t("Poistetaanko oma sähköpostitilisi Pleissistä? Postilaatikkoon tulevista viesteistä ei enää tehdä tehtäviä.")
      : t("Poistetaanko taloyhtiön oma sähköpostitili? Taloyhtiön posti kulkee sen jälkeen toimiston tilin kautta."))) return;
    setBusy(true);
    setError("");
    try {
      await api(personal ? "/mail/accounts/me" : `/gmail/accounts/${encodeURIComponent(target)}`, { method: "DELETE" });
      await loadStatus();
    } catch (removeError) {
      setError(errorMessage(removeError, t("Tilin poistaminen epäonnistui.")));
    } finally {
      setBusy(false);
    }
  }

  const admin = isAdmin();
  const canManage = personal || admin;
  const own = office || personal || Boolean(status?.own);
  const connectedHere = own && status?.connected;

  return (
    <div className="settings-card gmail-card">
      <CollapseSection
        id={personal ? "mail-personal" : office ? "gmail-office" : "gmail-company"}
        title={personal ? t("Oma sähköpostitili") : office ? t("Toimiston sähköpostitili") : t("Taloyhtiön sähköpostitili")}
      >
      {!status ? <p className="muted">{t("Tarkistetaan…")}</p> : status.connected ? (
        <>
          <p>
            <strong>{status.emailAddress}</strong>
            {status.provider && <span className="mail-provider">{providerNames[status.provider]}</span>}
            {!own && <span className="gmail-shared">{" "}{t("· toimiston yhteinen tili")}</span>}
          </p>
          <p className="muted">
            {personal
              ? t("Tähän osoitteeseen tulevista viesteistä tehdään tehtäviä, jotka annetaan sinulle. Vastaukset lähtevät tästä osoitteesta.")
              : office
              ? t("Pleissi lukee saapuvat viestit tämän tilin postilaatikosta ja lähettää vastaukset siitä. Taloyhtiö, jolla on oma tili, käyttää omaansa.")
              : own
                ? t("Tämän taloyhtiön viestit saapuvat tähän postilaatikkoon ja lähtevät siitä.")
                : t("Taloyhtiöllä ei ole omaa tiliä, joten sen posti kulkee toimiston tilin kautta. Voit yhdistää taloyhtiölle oman sähköpostitilin.")}
            {status.canSend === false ? t(" Tililtä puuttuu lähetysoikeus: yhdistä tili uudelleen.") : ""}
          </p>
        </>
      ) : (
        <>
          <p className={personal && !status.emailAddress ? "muted" : "send-error"}>
            {status.emailAddress
              ? t("Yhteys tiliin {0} ei toimi. Yhdistä tili uudelleen.", status.emailAddress)
              : personal
                ? t("Yhdistä oma työsähköpostisi, niin siihen tulevista viesteistä tehdään sinulle tehtäviä ja vastaat niihin samasta osoitteesta.")
                : t("Sähköpostitiliä ei ole yhdistetty. Valitse alta sähköpostipalvelusi.")}
          </p>
          {status.error && <p className="reply-hint">{status.error}</p>}
        </>
      )}
      {canManage ? (
        <>
          <p className="mail-connect-label">{connectedHere ? t("Vaihda tili:") : t("Yhdistä tili:")}</p>
          <div className="draft-actions mail-connect">
            <button className="secondary" onClick={() => void connectOAuth("gmail")} disabled={busy || !providers.gmail}
              title={providers.gmail ? undefined : t("Gmail-yhteyttä ei ole otettu käyttöön palvelimella.")}>
              Gmail
            </button>
            <button className="secondary" onClick={() => void connectOAuth("microsoft")} disabled={busy || !providers.microsoft}
              title={providers.microsoft ? undefined : t("Microsoft 365 -yhteyttä ei ole otettu käyttöön palvelimella.")}>
              Microsoft 365 / Outlook
            </button>
            <button className={`secondary ${imapOpen ? "active" : ""}`} onClick={() => { setImapOpen(!imapOpen); setError(""); }} disabled={busy}>
              {t("Muu sähköposti (IMAP/SMTP)")}
            </button>
            {((personal && (status?.connected || status?.emailAddress)) || (!office && !personal && status?.own)) && (
              <button className="danger" onClick={() => void removeOwn()} disabled={busy}>{personal ? t("Poista tili") : t("Poista oma tili")}</button>
            )}
            {waiting && <button onClick={() => void loadStatus()}>{t("Tarkista yhteys")}</button>}
          </div>
          {!providers.microsoft && admin && (
            <p className="reply-hint">{t("Microsoft 365 -yhteys otetaan käyttöön palvelimen asetuksista (MS_CLIENT_ID ja MS_CLIENT_SECRET).")}</p>
          )}
          {imapOpen && (
            <form className="ticket-form mail-imap-form" onSubmit={connectImap}>
              <p className="reply-hint">
                {t("Palvelimien osoitteet ja portit löytyvät sähköpostipalvelusi ohjeista hakusanalla \"IMAP-asetukset\". Jos tilillä on kaksivaiheinen tunnistautuminen, käytä palvelun antamaa sovellussalasanaa.")}
              </p>
              <label>
                <span>{t("Sähköpostiosoite")}</span>
                <input type="email" value={imapForm.email} onChange={event => updateImap("email", event.target.value)} placeholder={t("esim. posti@toimisto.fi")} required />
              </label>
              <div className="form-columns">
                <label>
                  <span>{t("Saapuvan postin palvelin (IMAP)")}</span>
                  <input value={imapForm.imapHost} onChange={event => updateImap("imapHost", event.target.value)} placeholder="imap.toimisto.fi" required />
                </label>
                <label>
                  <span>{t("IMAP-portti")}</span>
                  <input inputMode="numeric" value={imapForm.imapPort} onChange={event => updateImap("imapPort", event.target.value)} required />
                </label>
                <label>
                  <span>{t("Lähtevän postin palvelin (SMTP)")}</span>
                  <input value={imapForm.smtpHost} onChange={event => updateImap("smtpHost", event.target.value)} placeholder="smtp.toimisto.fi" required />
                </label>
                <label>
                  <span>{t("SMTP-portti")}</span>
                  <input inputMode="numeric" value={imapForm.smtpPort} onChange={event => updateImap("smtpPort", event.target.value)} required />
                </label>
                <label>
                  <span>{t("Käyttäjätunnus (jos eri kuin osoite)")}</span>
                  <input value={imapForm.username} onChange={event => updateImap("username", event.target.value)} autoComplete="off" />
                </label>
                <label>
                  <span>{t("Salasana")}</span>
                  <input type="password" value={imapForm.password} onChange={event => updateImap("password", event.target.value)} autoComplete="new-password" required />
                </label>
              </div>
              <div className="draft-actions">
                <button type="button" onClick={() => setImapOpen(false)} disabled={busy}>{t("Peruuta")}</button>
                <button className="primary" type="submit" disabled={busy}>{busy ? t("Tarkistetaan yhteyttä…") : t("Yhdistä tili")}</button>
              </div>
            </form>
          )}
        </>
      ) : (
        <p className="reply-hint">{t("Vain pääkäyttäjä voi vaihtaa sähköpostitilin.")}</p>
      )}
      {waiting && (
        <p className="reply-hint">
          {waiting === "gmail"
            ? t("Kirjaudu Googlen avaamassa välilehdessä ja hyväksy oikeudet. Palaa sitten tähän välilehteen.")
            : t("Kirjaudu Microsoftin avaamassa välilehdessä ja hyväksy oikeudet. Palaa sitten tähän välilehteen.")}
        </p>
      )}
      {saved && <p className="portal-sent">{saved}</p>}
      {error && <p className="send-error">{error}</p>}
      </CollapseSection>
    </div>
  );
}

// Isännöitsijätoimiston omat tiedot. Ne eivät riipu valitusta taloyhtiöstä.
function OfficeSettings({ onSaved }: { onSaved: () => Promise<void> }) {
  const [name, setName] = useState(MANAGEMENT_OFFICE.name);
  const [businessId, setBusinessId] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [reminderEmails, setReminderEmails] = useState(false);
  const [replyReminderDays, setReplyReminderDays] = useState(2);
  const [dueReminderDays, setDueReminderDays] = useState(1);
  const [aiPriority, setAiPriority] = useState(false);
  const [aiRelevance, setAiRelevance] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [aiMonthlyLimit, setAiMonthlyLimit] = useState(50);
  const [twoFactor, setTwoFactor] = useState(false);
  const [twoFactorOverridden, setTwoFactorOverridden] = useState(false);
  const [residentStatusUpdates, setResidentStatusUpdates] = useState(true);
  const [aiWarningPercent, setAiWarningPercent] = useState(80);
  // Kasvaa jokaisella tallennuksella, jotta kulumittari hakee tilanteen uudelleen.
  const [savedCount, setSavedCount] = useState(0);
  const [retentionMonths, setRetentionMonths] = useState(0);
  const [queueRoles, setQueueRoles] = useState<string[]>([]);
  const [queueUsers, setQueueUsers] = useState<string[]>([]);
  const [queueUserOptions, setQueueUserOptions] = useState<OfficeUser[]>([]);
  useEffect(() => {
    api<OfficeUser[]>("/users").then(setQueueUserOptions).catch(() => setQueueUserOptions([]));
  }, []);
  // Viimeksi tallennettu säilytysaika; lyhentäminen varmistetaan, koska se poistaa tietoja pysyvästi.
  const [storedRetention, setStoredRetention] = useState(0);

  useEffect(() => {
    api<OfficeInfo>("/office")
      .then(office => {
        setName(office.name);
        setBusinessId(office.businessId);
        setAddress(office.address);
        setPhone(office.phone);
        setReminderEmails(Boolean(office.reminderEmails));
        setReplyReminderDays(office.replyReminderDays ?? 2);
        setDueReminderDays(office.dueReminderDays ?? 1);
        setAiPriority(Boolean(office.aiPriority));
        setAiRelevance(Boolean(office.aiRelevance));
        setAiAvailable(office.aiAvailable !== false);
        setAiMonthlyLimit(office.aiMonthlyLimit ?? 50);
        setTwoFactor(Boolean(office.twoFactor));
        setTwoFactorOverridden(Boolean(office.twoFactorOverridden));
        setResidentStatusUpdates(office.residentStatusUpdates !== 0);
        setAiWarningPercent(office.aiWarningPercent ?? 80);
        setRetentionMonths(office.retentionMonths ?? 0);
        setStoredRetention(office.retentionMonths ?? 0);
        setQueueRoles(office.unidentifiedQueueRoles ?? []);
        setQueueUsers(office.unidentifiedQueueUsers ?? []);
      })
      .catch(() => setError(t("Toimiston tietojen lataus epäonnistui.")));
  }, []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");


  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const shortens = retentionMonths > 0 && (storedRetention === 0 || retentionMonths < storedRetention);
    if (shortens && !window.confirm(
      t("Säilytysajaksi tulee {0} kk. Tätä kauemmin suljettuna olleet tehtävät viesteineen ja liitteineen ", retentionMonths)
      + t("sekä tätä vanhemmat lokimerkinnät poistetaan pysyvästi. Jatketaanko?")
    )) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const office = await api<OfficeInfo>("/office", {
        method: "PUT",
        body: JSON.stringify({
          name, businessId, address, phone, reminderEmails, replyReminderDays, dueReminderDays, retentionMonths, aiPriority, aiRelevance,
          aiMonthlyLimit, aiWarningPercent, twoFactor, residentStatusUpdates,
          unidentifiedQueueRoles: queueRoles, unidentifiedQueueUsers: queueUsers
        })
      });
      MANAGEMENT_OFFICE.name = office.name;
      setStoredRetention(office.retentionMonths ?? 0);
      await onSaved();
      setSaved(true);
      setSavedCount(count => count + 1);
    } catch (caught) {
      let message = t("Asetusten tallennus epäonnistui.");
      try {
        message = JSON.parse((caught as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setError(message);
    } finally {
      setSaving(false);
    }
  }


  return (
    <section className="settings-layout">
      <div className="content settings">
      <form className="settings-card ticket-form" onSubmit={handleSubmit}>
        <CollapseSection id="office-details" title={t("Isännöitsijätoimiston tiedot")}>

        <label>
          <span>{t("Toimiston nimi")}</span>
          <input value={name} onChange={event => { setName(event.target.value); setSaved(false); }} />
        </label>

        <label>
          <span>{t("Y-tunnus")}</span>
          <input value={businessId} onChange={event => { setBusinessId(event.target.value); setSaved(false); }} placeholder={t("Valinnainen")} />
        </label>

        <label>
          <span>{t("Osoite")}</span>
          <input value={address} onChange={event => { setAddress(event.target.value); setSaved(false); }} placeholder={t("Valinnainen")} />
        </label>

        <label>
          <span>{t("Puhelin")}</span>
          <input value={phone} onChange={event => { setPhone(event.target.value); setSaved(false); }} placeholder={t("Valinnainen")} />
        </label>

        </CollapseSection>

        <CollapseSection id="office-reminders" title={t("Muistutukset")}>

        <label className="switch-row">
          <span>
            <strong>{t("Muistutus sähköpostilla")}</strong>
            <small>{t("Käsittelijä saa enintään kerran päivässä koosteen tehtävistään, jotka vaativat huomiota.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={reminderEmails}
            onChange={event => { setReminderEmails(event.target.checked); setSaved(false); }}
          />
          <i aria-hidden="true" />
        </label>
        <div className="signature-fields">
          <label>
            <span>{t("Muistuta, kun asukas on odottanut vastausta (päivää)")}</span>
            <input
              type="number"
              min={1}
              max={30}
              value={replyReminderDays}
              onChange={event => { setReplyReminderDays(Math.min(30, Math.max(1, Number(event.target.value) || 1))); setSaved(false); }}
            />
          </label>
          <label>
            <span>{t("Muistuta määräajasta (päivää ennen)")}</span>
            <input
              type="number"
              min={0}
              max={30}
              value={dueReminderDays}
              onChange={event => { setDueReminderDays(Math.min(30, Math.max(0, Number(event.target.value) || 0))); setSaved(false); }}
            />
          </label>
        </div>
        <p className="reply-hint">
          {t("Muistutukset näkyvät aina päätösjonon kärjessä. Sähköpostikooste lähtee toimiston sähköpostitililtä käyttäjän kirjautumisosoitteeseen, kun se on kytketty päälle.")}
        </p>

        </CollapseSection>

        <CollapseSection id="office-security" title={t("Tietoturva")}>

        <label className="switch-row">
          <span>
            <strong>{t("Kirjautumiskoodi sähköpostiin")}</strong>
            <small>{t("Henkilökunta syöttää salasanan jälkeen sähköpostiin tulleen kuusinumeroisen koodin.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={twoFactor}
            onChange={event => { setTwoFactor(event.target.checked); setSaved(false); }}
          />
          <i aria-hidden="true" />
        </label>
        <p className="reply-hint">
          {t("Koodi lähetetään käyttäjän kirjautumisosoitteeseen toimiston sähköpostitililtä ja on voimassa 10 minuuttia. Käyttäjä voi merkitä laitteensa luotetuksi, jolloin koodia ei kysytä samalla laitteella 30 päivään. Salasanan vaihto poistaa luotetut laitteet. Varmista ennen käyttöönottoa, että jokaisen käyttäjän sähköpostiosoite on oikein.")}
        </p>
        {twoFactorOverridden && (
          <p className="send-error">{t("Palvelimen asetus (TWO_FACTOR_DISABLED) on kytkenyt kirjautumiskoodin toistaiseksi pois.")}</p>
        )}

        </CollapseSection>

        <CollapseSection id="office-resident-updates" title={t("Asukasviestintä")}>

        <label className="switch-row">
          <span>
            <strong>{t("Tilapäivitykset asukkaalle")}</strong>
            <small>{t("Asukas saa sähköpostin, kun hänen ilmoituksensa etenee.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={residentStatusUpdates}
            onChange={event => { setResidentStatusUpdates(event.target.checked); setSaved(false); }}
          />
          <i aria-hidden="true" />
        </label>
        <p className="reply-hint">
          {t("Viesti lähtee, kun tehtävästä tehdään työtilaus huoltoyhtiölle, huoltoyhtiö kuittaa työn tehdyksi, tehtävä otetaan käsittelyyn, se siirretään kolmannelle osapuolelle tai se suljetaan. Viesti menee tehtävän ilmoittajille, joilla on sähköpostiosoite, taloyhtiön sähköpostitililtä. Roskapostiksi merkityistä tehtävistä ei ilmoiteta. Lähetetty päivitys näkyy tehtävän aikajanalla.")}
        </p>

        </CollapseSection>

        <CollapseSection id="office-ai" title={t("AI")}>

        <AiUsageMeter refreshKey={savedCount} />
        <div className="signature-fields">
          <label>
            <span>{t("Kuukausiraja ($)")}</span>
            <input
              type="number"
              min={0}
              step={5}
              value={aiMonthlyLimit}
              onChange={event => { setAiMonthlyLimit(Math.max(0, Number(event.target.value) || 0)); setSaved(false); }}
            />
          </label>
          <label>
            <span>{t("Varoita, kun rajasta on käytetty (%)")}</span>
            <input
              type="number"
              min={0}
              max={100}
              step={5}
              value={aiWarningPercent}
              onChange={event => { setAiWarningPercent(Math.min(100, Math.max(0, Number(event.target.value) || 0))); setSaved(false); }}
            />
          </label>
        </div>
        <p className="reply-hint">
          {t("Kun kuukauden AI-kulut saavuttavat rajan, AI kytkeytyy pois kuun loppuun asti: vastausehdotukset tehdään dokumentaatiohaulla ja saapuvat viestit käsitellään ilman AI:ta. Pääkäyttäjät saavat sähköpostin varoitusrajalla ja kun raja täyttyy. 0 = ei rajaa. Kulut ovat arvio Anthropicin hinnaston mukaan dollareina.")}
        </p>

        <label className="switch-row">
          <span>
            <strong>{t("AI arvioi saapuvan tehtävän prioriteetin")}</strong>
            <small>{t("Pois päältä prioriteetti päätellään viestin avainsanoista.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={aiPriority}
            onChange={event => { setAiPriority(event.target.checked); setSaved(false); }}
          />
          <i aria-hidden="true" />
        </label>
        <p className="reply-hint">
          {t("AI lukee sähköpostilla tai asukasportaalista saapuvan viestin ja valitsee prioriteetin, joka määrää tehtävän määräajan. Hätätapaukseksi arvioitu tehtävä hälyttää vastuuisännöitsijän. Käsittelijä voi aina vaihtaa prioriteetin, ja jos AI ei vastaa, käytetään avainsanoja.")}
        </p>
        {aiPriority && !aiAvailable && (
          <p className="send-error">{t("AI ei ole käytössä palvelimella, joten prioriteetti päätellään toistaiseksi avainsanoista.")}</p>
        )}

        <label className="switch-row">
          <span>
            <strong>{t("AI tarkistaa, koskeeko sähköposti taloyhtiön asioita")}</strong>
            <small>{t("Pois päältä jokainen saapuva sähköposti menee päätösjonoon.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={aiRelevance}
            onChange={event => { setAiRelevance(event.target.checked); setSaved(false); }}
          />
          <i aria-hidden="true" />
        </label>
        <p className="reply-hint">
          {t("AI lukee saapuvan sähköpostin ennen päätösjonoa. Mainokset, uutiskirjeet, automaattivastaukset ja muut asiaan kuulumattomat viestit tallentuvat suljettuina tehtävinä merkinnällä AI suodatti: ne löytyvät Kaikista tehtävistä ja ne voi avata uudelleen. Epävarmassa tapauksessa ja AI:n ollessa poissa viesti menee jonoon.")}
        </p>
        {aiRelevance && !aiAvailable && (
          <p className="send-error">{t("AI ei ole käytössä palvelimella, joten sähköposteja ei toistaiseksi suodateta.")}</p>
        )}

        </CollapseSection>

        <CollapseSection id="office-unidentified" title={t("Taloyhtiö tunnistamatta -jono")}>
        <p className="reply-hint">
          {t("Kun saapuvan viestin taloyhtiötä ei tunnisteta vastaanottajasta eikä lähettäjästä, tehtävä menee Taloyhtiö tunnistamatta -jonoon. Valitse, ketkä näkevät jonon ja valitsevat tehtäville taloyhtiön ja käsittelijän. Pääkäyttäjät käsittelevät jonoa aina.")}
        </p>
        <fieldset className="queue-access">
          <legend>{t("Roolit")}</legend>
          {USER_ROLES.map(role => (
            <label key={role} className="checkbox-row">
              <input
                type="checkbox"
                checked={role === "Pääkäyttäjä" || queueRoles.includes(role)}
                disabled={role === "Pääkäyttäjä"}
                onChange={event => {
                  setQueueRoles(current => event.target.checked ? [...new Set([...current, role])] : current.filter(item => item !== role));
                  setSaved(false);
                }}
              />
              {t(role)}
            </label>
          ))}
        </fieldset>
        <fieldset className="queue-access">
          <legend>{t("Lisäksi nämä käyttäjät")}</legend>
          {queueUserOptions.filter(user => user.role !== "Pääkäyttäjä" && !queueRoles.includes(user.role)).map(user => (
            <label key={user.id} className="checkbox-row">
              <input
                type="checkbox"
                checked={queueUsers.includes(user.id)}
                onChange={event => {
                  setQueueUsers(current => event.target.checked ? [...new Set([...current, user.id])] : current.filter(item => item !== user.id));
                  setSaved(false);
                }}
              />
              {user.name}{" "}<span className="muted">({t(user.role)})</span>
            </label>
          ))}
          {queueUserOptions.every(user => user.role === "Pääkäyttäjä" || queueRoles.includes(user.role)) && (
            <p className="muted">{t("Kaikki käyttäjät näkevät jonon jo roolinsa perusteella.")}</p>
          )}
        </fieldset>
        </CollapseSection>

        <CollapseSection id="office-retention" title={t("Tietojen säilytys")}>

        <label>
          <span>{t("Säilytysaika")}</span>
          <select
            value={retentionMonths}
            onChange={event => { setRetentionMonths(Number(event.target.value)); setSaved(false); }}
          >
            <option value={0}>{t("Säilytetään toistaiseksi")}</option>
            {[12, 24, 36, 60, 120].map(months => (
              <option key={months} value={months}>{months / 12} {months === 12 ? t("vuosi") : t("vuotta")}</option>
            ))}
            {retentionMonths > 0 && ![12, 24, 36, 60, 120].includes(retentionMonths) && (
              <option value={retentionMonths}>{retentionMonths}{" "}{t("kk")}</option>
            )}
          </select>
        </label>
        <p className="reply-hint">
          {t("Tätä kauemmin suljettuna olleet tehtävät poistetaan pysyvästi viesteineen ja liitteineen, samoin tätä vanhemmat lokimerkinnät. Poisto tehdään automaattisesti tunnin sisällä tallennuksesta eikä sitä voi perua.")}
        </p>

        </CollapseSection>

        {error && <p className="send-error">{error}</p>}

        <div className="draft-actions">
          <button className="primary" type="submit" disabled={saving || !name.trim()}>
            {saving ? t("Tallennetaan…") : t("Tallenna asetukset")}
          </button>
          {saved && <span className="saved-indicator">{t("Tallennettu")}</span>}
        </div>
      </form>

      <MasterDataSettings />

      <SystemAlertsCard />

      <ContactRequests />

      <a className="settings-card settings-link" href="#/log">
        <div>
          <h2>{t("Loki")}</h2>
          <p className="muted">{t("Kaikki tehtäviin tehdyt muutokset, päätökset ja lähetetyt sähköpostit.")}</p>
        </div>
        <span aria-hidden="true">→</span>
      </a>

      <MailAccountCard target="office" />
      </div>

      <OfficeUsers />
    </section>
  );
}

type AiUsage = {
  month: string; costUsd: number; limitUsd: number; warningPercent: number; exhausted: boolean; calls: number;
  byFeature: { feature: string; calls: number; cost: number }[];
  history: { month: string; calls: number; cost: number }[];
};

const aiFeatureLabels: Record<string, string> = {
  suggest: t("Vastausehdotukset"),
  assess: t("Saapuvien viestien arviointi"),
  topics: t("Toistuvien aiheiden raportit"),
  chunking: t("Dokumenttien pilkonta")
};

export const formatUsd = (value: number) => `${value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

// Tämän kuun AI-kulut suhteessa kuukausirajaan.
function AiUsageMeter({ refreshKey }: { refreshKey: number }) {
  const [usage, setUsage] = useState<AiUsage | null>(null);
  useEffect(() => {
    api<AiUsage>("/office/ai-usage")
      .then(found => setUsage(typeof found?.costUsd === "number" ? found : null))
      .catch(() => undefined);
  }, [refreshKey]);
  if (!usage) return null;
  const percent = usage.limitUsd > 0 ? Math.min(100, (usage.costUsd / usage.limitUsd) * 100) : 0;
  const level = usage.exhausted ? "full" : usage.limitUsd > 0 && percent >= usage.warningPercent ? "warning" : "ok";
  return (
    <div className={`ai-usage ai-usage-${level}`}>
      <div className="ai-usage-head">
        <strong>{t("AI-kulut tässä kuussa")}</strong>
        <span>
          {formatUsd(usage.costUsd)}
          {usage.limitUsd > 0 ? ` / ${formatUsd(usage.limitUsd)}` : ` · ${t("ei rajaa")}`}
        </span>
      </div>
      {usage.limitUsd > 0 && (
        <div className="ai-usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={t("AI-kulut kuukausirajasta")}>
          <i style={{ width: `${percent}%` }} />
        </div>
      )}
      {usage.exhausted && <p className="send-error">{t("Kuukausiraja on täynnä, joten AI on pois käytöstä kuun loppuun asti. Nosta rajaa, jos haluat ottaa AI:n heti takaisin käyttöön.")}</p>}
      <small>
        {usage.calls === 0
          ? t("Ei AI-kutsuja tässä kuussa.")
          : usage.byFeature.map(row => `${aiFeatureLabels[row.feature] ?? row.feature}: ${row.calls} (${formatUsd(row.cost)})`).join(" · ")}
      </small>
      {usage.history.length > 1 && (
        <small>
          {t("Aiemmat kuukaudet:")}{" "}
          {usage.history.filter(row => row.month !== usage.month).map(row => `${row.month} ${formatUsd(row.cost)}`).join(" · ")}
        </small>
      )}
    </div>
  );
}

type SystemAlert = {
  id: string; kind: string; title: string; details: string; count: number;
  created_at: string; last_at: string; resolved_at: string | null;
};

// Järjestelmän tila: palvelimen virheet, katkenneet postiyhteydet, varmuuskopiot ja AI-kulujen raja.
// Samat hälytykset lähtevät pääkäyttäjille sähköpostina.
function SystemAlertsCard() {
  const [alerts, setAlerts] = useState<SystemAlert[] | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState("");
  const load = () => api<SystemAlert[]>("/system/alerts")
    .then(found => setAlerts(Array.isArray(found) ? found : []))
    .catch(() => setError(t("Hälytysten lataus epäonnistui.")));
  useEffect(() => { void load(); }, []);

  async function resolve(alertId: string) {
    try {
      await api(`/system/alerts/${encodeURIComponent(alertId)}/resolve`, { method: "POST" });
      await load();
    } catch (resolveError) {
      setError(errorMessage(resolveError, t("Kuittaus epäonnistui.")));
    }
  }

  const open = (alerts ?? []).filter(alert => !alert.resolved_at);
  const resolved = (alerts ?? []).filter(alert => alert.resolved_at);
  return (
    <div className="settings-card system-alerts">
      <div className="suggest-header">
        <h2>{t("Järjestelmän tila")}</h2>
        <span className={`status-badge ${open.length ? "status-badge-alert" : "status-badge-ok"}`}>
          {open.length ? t("{0} avointa hälytystä", open.length) : t("Kaikki kunnossa")}
        </span>
      </div>
      <p className="muted">
        {t("Pleissi ilmoittaa sähköpostilla pääkäyttäjille, kun palvelimella tapahtuu virhe, sähköpostin vastaanotto katkeaa yli 15 minuutiksi, varmuuskopiointi epäonnistuu tai AI-kulut lähestyvät rajaa.")}
      </p>
      {error && <p className="send-error">{error}</p>}
      {open.map(alert => (
        <div className="system-alert" key={alert.id}>
          <div>
            <strong>{alert.title}</strong>
            <small>
              {formatDate(alert.last_at)}
              {alert.count > 1 && ` · ${t("toistunut {0} kertaa", alert.count)}`}
            </small>
            {alert.details && <details><summary>{t("Lisätiedot")}</summary><pre>{alert.details}</pre></details>}
          </div>
          <button type="button" className="secondary" onClick={() => void resolve(alert.id)}>{t("Kuittaa")}</button>
        </div>
      ))}
      {resolved.length > 0 && (
        <button type="button" className="link-button" onClick={() => setShowResolved(!showResolved)}>
          {showResolved ? t("Piilota kuitatut") : t("Näytä kuitatut ({0})", resolved.length)}
        </button>
      )}
      {showResolved && resolved.map(alert => (
        <div className="system-alert resolved" key={alert.id}>
          <div>
            <strong>{alert.title}</strong>
            <small>{formatDate(alert.last_at)} · {t("kuitattu")} {formatDate(alert.resolved_at as string)}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

// Asetukset: saako taloyhtiön saunaan ja pyykkitupaan varata yksittäisiä ja viikoittaisia vuoroja.
// Taloyhtiön vuorovaraus- ja autopaikka-asetukset; näytetään taloyhtiön tiedoissa.
// Valittavat jonopaikkojen määrät yhdelle vuorolle.
const QUEUE_SIZE_OPTIONS = [1, 2, 3, 4, 5, 10];

export function BookingSettings({ companyId }: { companyId: string }) {
  const [rules, setRules] = useState<BookingRules | null>(null);
  const [parkingPrices, setParkingPrices] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState("");
  const readOnly = !isAdmin();
  // Tiivistetyt osiot ("card" = koko kortti). Osiot ovat kiinni aina, kun asetukset avataan.
  const [collapsed, setCollapsed] = useState<string[]>(["sauna", "laundry", "parking"]);

  function toggleCollapsed(key: string) {
    setCollapsed(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key]);
  }

  useEffect(() => {
    if (!companyId) return;
    setRules(null);
    setParkingPrices(null);
    api<BookingRules>(`/companies/${encodeURIComponent(companyId)}/booking-settings`)
      .then(setRules)
      .catch(() => setError(t("Asetusten lataus epäonnistui.")));
    api<Record<string, number>>(`/companies/${encodeURIComponent(companyId)}/parking-prices`)
      .then(setParkingPrices)
      .catch(() => setError(t("Asetusten lataus epäonnistui.")));
  }, [companyId]);

  function setParkingPrice(type: string, value: string) {
    if (!parkingPrices) return;
    setParkingPrices({ ...parkingPrices, [type]: Math.max(0, Number(value.replace(",", ".")) || 0) });
  }

  async function saveParkingPrices() {
    if (!parkingPrices) return;
    setError("");
    try {
      setParkingPrices(await api<Record<string, number>>(`/companies/${encodeURIComponent(companyId)}/parking-prices`, {
        method: "PUT",
        body: JSON.stringify(parkingPrices)
      }));
    } catch {
      setError(t("Asetuksen tallennus epäonnistui."));
    }
  }

  // Muutos tallentuu heti; jos tallennus epäonnistuu, palataan edelliseen tilaan.
  async function toggle(resource: "sauna" | "laundry", kind: "single" | "weekly") {
    if (!rules) return;
    await save({ ...rules, [resource]: { ...rules[resource], [kind]: !rules[resource][kind] } });
  }

  async function setQueue(resource: "sauna" | "laundry", change: { queueEnabled?: boolean; queueSize?: number }) {
    if (!rules) return;
    await save({ ...rules, [resource]: { ...rules[resource], ...change } });
  }

  async function setWeeklyWeeks(resource: "sauna" | "laundry", weeks: number) {
    if (!rules) return;
    await save({ ...rules, [resource]: { ...rules[resource], weeklyWeeks: weeks } });
  }

  // Hinta päivittyy kenttään kirjoittaessa ja tallennetaan, kun kentästä poistutaan.
  function setPrice(resource: "sauna" | "laundry", key: "singlePrice" | "monthlyPrice", value: string) {
    if (!rules) return;
    const amount = Math.max(0, Number(value.replace(",", ".")) || 0);
    setRules({ ...rules, [resource]: { ...rules[resource], [key]: amount } });
  }

  async function save(next: BookingRules) {
    const previous = rules;
    setRules(next);
    setError("");
    try {
      setRules(await api<BookingRules>(`/companies/${encodeURIComponent(companyId)}/booking-settings`, {
        method: "PUT",
        body: JSON.stringify(next)
      }));
    } catch {
      setRules(previous);
      setError(t("Asetuksen tallennus epäonnistui."));
    }
  }

  const sections: { resource: "sauna" | "laundry"; title: string; shift: string }[] = [
    { resource: "sauna", title: t("Saunavuorot"), shift: t("saunavuoron") },
    { resource: "laundry", title: t("Pyykkitupavuorot"), shift: t("pyykkitupavuoron") }
  ];

  // Otsikko, jota painamalla osio tiivistyy tai avautuu.
  function collapseHead(key: string, title: string, level: "h2" | "h3") {
    const open = !collapsed.includes(key);
    const Heading = level;
    return (
      <Heading className="collapse-heading">
        <button
          type="button"
          className="collapse-head"
          onClick={() => toggleCollapsed(key)}
          aria-expanded={open}
          title={open ? t("Tiivistä osio") : t("Näytä osio")}
        >
          <span>{title}</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </Heading>
    );
  }

  if (collapsed.includes("card")) {
    return (
      <div className="settings-card booking-settings">
        {collapseHead("card", t("Vuorovaraukset ja autopaikat"), "h2")}
      </div>
    );
  }

  return (
    <div className="settings-card booking-settings">
      {collapseHead("card", t("Vuorovaraukset ja autopaikat"), "h2")}
      <p className="muted">{t("Valitse, millaisia vuoroja taloyhtiössä saa varata ja mitä vuorot ja autopaikat maksavat. Pois kytkettyä vuorotyyppiä ei voi varata asukas eikä isännöitsijä.")}</p>
      {readOnly && <p className="reply-hint">{t("Vain pääkäyttäjä voi muuttaa näitä asetuksia.")}</p>}

      {sections.map(section => (
        <div className="booking-settings-section" key={section.resource}>
          {collapseHead(section.resource, section.title, "h3")}
          {!collapsed.includes(section.resource) && (
          <>
          {(["single", "weekly"] as const).map(kind => (
            <label className="switch-row" key={kind}>
              <span>
                <strong>{kind === "single" ? t("Yksittäiset vuorot") : t("Viikoittaiset vuorot")}</strong>
                <small>
                  {kind === "single" ? t("Kertaluontoinen varaus yhdelle vuorolle.") : t("Sama vuoro joka viikko.")}
                </small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={rules?.[section.resource][kind] ?? true}
                disabled={!rules || readOnly}
                onChange={() => void toggle(section.resource, kind)}
              />
              <i aria-hidden="true" />
            </label>
          ))}
          <label className="booking-settings-duration">
            <span>
              <strong>{t("Viikoittaisen vuoron kesto")}</strong>
              <small>{t("Kuinka pitkäksi ajaksi vuoro varataan, kun valitaan viikoittainen.")}</small>
            </span>
            <select
              value={weeklyWeeksOf(rules?.[section.resource])}
              disabled={!rules || readOnly || !rules[section.resource].weekly}
              onChange={event => void setWeeklyWeeks(section.resource, Number(event.target.value))}
            >
              {WEEKLY_DURATION_OPTIONS.map(option => <option key={option.weeks} value={option.weeks}>{option.label}</option>)}
            </select>
          </label>
          <label className="switch-row">
            <span>
              <strong>{t("Jono varatuille vuoroille")}</strong>
              <small>{t("Asukas voi liittyä varatun vuoron jonoon kalenterista. Kun varaaja peruu vuoron, se siirtyy jonon ensimmäiselle.")}</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={rules?.[section.resource].queueEnabled ?? false}
              disabled={!rules || readOnly}
              onChange={() => rules && void setQueue(section.resource, { queueEnabled: !rules[section.resource].queueEnabled })}
            />
            <i aria-hidden="true" />
          </label>
          <label className="booking-settings-duration">
            <span>
              <strong>{t("Jonopaikkoja yhdellä vuorolla")}</strong>
              <small>{t("Kun jono on täynnä, kalenterissa näkyy Jono täynnä.")}</small>
            </span>
            <select
              value={rules?.[section.resource].queueSize ?? 3}
              disabled={!rules || readOnly || !rules[section.resource].queueEnabled}
              onChange={event => void setQueue(section.resource, { queueSize: Number(event.target.value) })}
            >
              {QUEUE_SIZE_OPTIONS.map(size => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <label className="booking-settings-duration">
            <span>
              <strong>{t("Yhden {0} hinta", section.shift)}</strong>
              <small>{t("Laskutetaan jokaisesta yksittäisestä vuorosta.")}</small>
            </span>
            <span className="price-input">
              <input
                type="number"
                min="0"
                step="0.5"
                value={rules?.[section.resource].singlePrice ?? 0}
                disabled={!rules || readOnly}
                onChange={event => setPrice(section.resource, "singlePrice", event.target.value)}
                onBlur={() => rules && void save(rules)}
              />
              €
            </span>
          </label>
          <label className="booking-settings-duration">
            <span>
              <strong>{t("Viikoittaisen {0} kuukausihinta", section.shift)}</strong>
              <small>{t("Laskutetaan kerran kuukaudessa jokaisesta viikkovuorosta.")}</small>
            </span>
            <span className="price-input">
              <input
                type="number"
                min="0"
                step="0.5"
                value={rules?.[section.resource].monthlyPrice ?? 0}
                disabled={!rules || readOnly}
                onChange={event => setPrice(section.resource, "monthlyPrice", event.target.value)}
                onBlur={() => rules && void save(rules)}
              />
              €
            </span>
          </label>
          </>
          )}
        </div>
      ))}

      <div className="booking-settings-section">
        {collapseHead("parking", t("Autopaikat"), "h3")}
        {!collapsed.includes("parking") && PARKING_TYPES.map(type => (
          <label className="booking-settings-duration" key={type}>
            <span>
              <strong>{t(type)}</strong>
              <small>{t("Paikan hinta kuukaudessa.")}</small>
            </span>
            <span className="price-input">
              <input
                type="number"
                min="0"
                step="0.5"
                value={parkingPrices?.[type] ?? 0}
                disabled={!parkingPrices || readOnly}
                onChange={event => setParkingPrice(type, event.target.value)}
                onBlur={() => void saveParkingPrices()}
              />
              {t("€/kk")}
            </span>
          </label>
        ))}
      </div>

      {error && <p className="send-error">{error}</p>}
    </div>
  );
}

function OfficeUsers() {
  const [users, setUsers] = useState<OfficeUser[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<OfficeUser | null>(null);
  // Lomake on auki joko muokkausta (editing) tai uuden käyttäjän luontia (creating) varten.
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const pagedUsers = usePaged(users, "");
  const admin = isAdmin();
  // Muut kuin pääkäyttäjä voivat muokata vain omia tietojaan.
  const canEdit = (user: OfficeUser) => admin || session?.user.id === user.id;

  async function loadUsers() {
    try {
      setUsers(await api<OfficeUser[]>("/users"));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  function openNewUser() {
    setEditing(null);
    setCreating(true);
    setName("");
    setEmail("");
    setRole("Isännöitsijä");
    setPassword("");
    setFormError("");
  }

  function closeForm() {
    setEditing(null);
    setCreating(false);
  }

  function openUser(user: OfficeUser) {
    setCreating(false);
    setEditing(user);
    setName(user.name);
    setEmail(user.email);
    setRole(user.role);
    setPassword("");
    setFormError("");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!editing && !creating) return;
    setSaving(true);
    setFormError("");
    try {
      if (editing) {
        const updated = await api<OfficeUser>(`/users/${encodeURIComponent(editing.id)}`, {
          method: "PUT",
          body: JSON.stringify({ name, email, role: admin ? role : undefined, password: password || undefined })
        });
        // Omien tietojen muutos näkyy heti myös sivupalkissa.
        if (session && session.user.id === updated.id) setSession({ ...session, user: updated });
      } else {
        await api<OfficeUser>("/users", {
          method: "POST",
          body: JSON.stringify({ name, email, role, password })
        });
      }
      closeForm();
      await loadUsers();
    } catch (error) {
      setFormError(errorMessage(error, editing
        ? t("Käyttäjän tietojen tallennus epäonnistui.")
        : t("Käyttäjän lisääminen epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  // Poistaa käyttäjän; hänen keskeneräiset tehtävänsä siirtyvät vastuuisännöitsijälle tai poistajalle.
  async function deleteUser(user: OfficeUser) {
    if (!window.confirm(
      t("Poistetaanko käyttäjä {0}?\n\n", user.name)
      + t("Hän ei voi enää kirjautua. Keskeneräiset tehtävät siirtyvät taloyhtiön vastuuisännöitsijälle tai sinulle.")
    )) return;
    setSaving(true);
    setFormError("");
    try {
      await api(`/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      closeForm();
      await loadUsers();
    } catch (error) {
      setFormError(errorMessage(error, t("Käyttäjän poisto epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="settings-card settings-users">
      <CollapseSection
        id="users"
        title={t("Käyttäjät")}
        action={admin && <button className="secondary" onClick={openNewUser}>{t("Lisää käyttäjä")}</button>}
      >
      <p className="muted">
        {MANAGEMENT_OFFICE.name} · {users.length}{" "}{t("käyttäjää")}
      </p>
      {loadError && <p className="send-error">{t("Käyttäjien lataus epäonnistui.")}</p>}
      <ul>
        {pagedUsers.items.map(user => (
          <li
            key={user.id}
            className={canEdit(user) ? "clickable" : ""}
            title={canEdit(user) ? t("Muokkaa käyttäjän tietoja") : t("Vain pääkäyttäjä voi muokata muita käyttäjiä")}
            role={canEdit(user) ? "button" : undefined}
            tabIndex={canEdit(user) ? 0 : undefined}
            onClick={() => canEdit(user) && openUser(user)}
            onKeyDown={event => {
              if (canEdit(user) && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                openUser(user);
              }
            }}
          >
            <span className="user-avatar">
              {user.name.split(" ").map(part => part[0]).join("").slice(0, 2)}
            </span>
            <div>
              <strong>{user.name}{session?.user.id === user.id ? t(" (sinä)") : ""}</strong>
              <span>{user.email}</span>
              {user.mail_email && <span className="user-mailbox">{t("Postilaatikko: {0}", user.mail_email)}</span>}
            </div>
            <em>{t(user.role)}</em>
          </li>
        ))}
      </ul>
      {pagedUsers.pager}
      </CollapseSection>

      {(editing || creating) && (
        <div className="overlay">
          <aside className="drawer form-drawer resident-drawer">
            <button type="button" className="drawer-back" onClick={closeForm}>{t("← Takaisin")}</button>
            <button className="close" onClick={closeForm}>×</button>
            <h2>{editing ? editing.name : t("Lisää käyttäjä")}</h2>
            <p className="muted">
              {editing ? t("Käyttäjän tiedot") : t("Uusi käyttäjä")} · {MANAGEMENT_OFFICE.name}
            </p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              <label>
                <span>{t("Nimi")}</span>
                <input value={name} onChange={event => setName(event.target.value)} />
              </label>

              <label>
                <span>{t("Sähköposti (käytetään kirjautumiseen)")}</span>
                <input type="email" value={email} onChange={event => setEmail(event.target.value)} />
              </label>

              <label>
                <span>{t("Rooli")}</span>
                <select value={role} onChange={event => setRole(event.target.value)} disabled={!admin}>
                  {USER_ROLES.map(option => <option key={option} value={option}>{t(option)}</option>)}
                </select>
              </label>

              <label>
                <span>{editing ? t("Uusi salasana") : t("Salasana")}</span>
                <input
                  type="password"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  placeholder={editing ? t("Jätä tyhjäksi, jos salasanaa ei vaihdeta") : t("Vähintään 8 merkkiä")}
                  autoComplete="new-password"
                />
              </label>
              <p className="reply-hint">
                {editing
                  ? t("Vähintään 8 merkkiä. Vaihto kirjaa käyttäjän ulos muilta laitteilta.")
                  : t("Käyttäjä kirjautuu tällä sähköpostilla ja salasanalla ja voi vaihtaa salasanan myöhemmin.")}
              </p>

              {formError && <p className="send-error">{formError}</p>}

              <div className="drawer-actions compact-actions">
                {editing && admin && session?.user.id !== editing.id && (
                  <button type="button" className="danger" disabled={saving} onClick={() => deleteUser(editing)}>
                    {t("Poista käyttäjä")}
                  </button>
                )}
                <button type="button" onClick={closeForm}>{t("Peruuta")}</button>
                <button
                  className="primary"
                  type="submit"
                  disabled={saving || !name.trim() || !email.trim() || (creating && password.length < 8)}
                >
                  {editing
                    ? saving ? t("Tallennetaan…") : t("Tallenna muutokset")
                    : saving ? t("Lisätään…") : t("Lisää käyttäjä")}
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </aside>
  );
}

type ContactRequest = {
  id: string; name: string; email: string; phone: string; company: string; message: string; created_at: string;
};

// Kotisivun lomakkeella jätetyt yhteystiedot. Näkymä on vain pääkäyttäjälle.
function ContactRequests() {
  const [requests, setRequests] = useState<ContactRequest[]>([]);
  const [error, setError] = useState("");
  // Osoite, johon uudet pyynnöt lähetetään sähköpostina; tyhjä = ei lähetetä.
  const [notifyEmail, setNotifyEmail] = useState("");
  const [savedEmail, setSavedEmail] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);

  useEffect(() => {
    api<{ email?: string }>("/contact-settings")
      .then(settings => {
        setNotifyEmail(settings.email ?? "");
        setSavedEmail(settings.email ?? "");
      })
      .catch(() => undefined);
  }, []);

  async function saveNotifyEmail(event: FormEvent) {
    event.preventDefault();
    setSavingEmail(true);
    setEmailSaved(false);
    setError("");
    try {
      const saved = await api<{ email: string }>("/contact-settings", {
        method: "PUT",
        body: JSON.stringify({ email: notifyEmail.trim() })
      });
      setNotifyEmail(saved.email);
      setSavedEmail(saved.email);
      setEmailSaved(true);
    } catch (caught) {
      setError(errorMessage(caught, t("Osoitteen tallennus epäonnistui.")));
    } finally {
      setSavingEmail(false);
    }
  }

  async function load() {
    try {
      setRequests(await api<ContactRequest[]>("/contact-requests"));
      setError("");
    } catch (caught) {
      setError(errorMessage(caught, t("Yhteydenottopyyntöjen haku epäonnistui.")));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(request: ContactRequest) {
    if (!window.confirm(t("Poistetaanko yhteydenottopyyntö lähettäjältä {0}?", request.name))) return;
    try {
      await api(`/contact-requests/${encodeURIComponent(request.id)}`, { method: "DELETE" });
      await load();
    } catch (caught) {
      setError(errorMessage(caught, t("Yhteydenottopyynnön poisto epäonnistui.")));
    }
  }

  return (
    <div className="settings-card contact-requests">
      <CollapseSection id="contact-requests" title={t("Yhteydenottopyynnöt")}>
        <p className="muted">{t("Kotisivun lomakkeella jätetyt yhteystiedot, uusin ensin.")}</p>
        <form className="ticket-form contact-notify" onSubmit={saveNotifyEmail}>
          <label>
            <span>{t("Lähetä uudet pyynnöt sähköpostiin")}</span>
            <input
              type="email"
              value={notifyEmail}
              onChange={event => { setNotifyEmail(event.target.value); setEmailSaved(false); }}
              placeholder={t("esim. myynti@yritys.fi")}
              maxLength={200}
            />
          </label>
          <div className="draft-actions">
            <button type="submit" className="primary" disabled={savingEmail || notifyEmail.trim() === savedEmail}>
              {savingEmail ? t("Tallennetaan…") : t("Tallenna")}
            </button>
            {emailSaved && <span className="saved-indicator">{t("Tallennettu")}</span>}
          </div>
          <p className="reply-hint">
            {t("Viesti lähtee toimiston sähköpostitililtä. Vastaus viestiin menee suoraan yhteydenottajalle. Jätä tyhjäksi, jos et halua sähköpostia.")}
          </p>
        </form>
        {error && <p className="send-error">{error}</p>}
        {!error && requests.length === 0 && <p className="drawer-empty">{t("Ei yhteydenottopyyntöjä.")}</p>}
        <ul>
          {requests.map(request => (
            <li key={request.id}>
              <div>
                <strong>{request.name}{request.company ? ` · ${request.company}` : ""}</strong>
                <span>
                  <a href={`mailto:${request.email}`}>{request.email}</a>
                  {request.phone ? ` · ${request.phone}` : ""}
                </span>
                {request.message && <p>{request.message}</p>}
                <small>{formatDate(request.created_at)}</small>
              </div>
              <button type="button" className="secondary" onClick={() => void remove(request)}>{t("Poista")}</button>
            </li>
          ))}
        </ul>
      </CollapseSection>
    </div>
  );
}
