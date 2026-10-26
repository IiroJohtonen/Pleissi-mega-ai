import { type FormEvent, useEffect, useState } from "react";
import { Dropdown, usePaged } from "../components/common";
import { formatDate } from "../format";
import { type Language, language, LANGUAGES, locale, setLanguage } from "../i18n";
import {
  ADMIN_ROLE, api, errorMessage, isAdmin, MANAGEMENT_OFFICE, type OfficeUser, session, setSession
} from "../session";
import { roleTableGroups, roleTableTitles } from "../role-tables";
import type { MailProvider, MailStatus } from "../types";
import { type BookingRules, WEEKLY_DURATION_OPTIONS, weeklyWeeksOf } from "./Bookings";
import { ParkingOptionsEditor } from "./Parking";
import { t } from "../i18n";
import { setTheme, storedTheme } from "../theme";
import { MasterDataSettings } from "./MasterData";
import { CollapseSection, jumpToSection } from "../components/CollapseSection";
import { topicLabel, topicOptions } from "../topics";


// Asetukset: jokaisella käyttäjällä omat asetuksensa, pääkäyttäjällä lisäksi toimiston tiedot.
export function Settings({ initialTab = "user", ...props }: { onSaved: () => Promise<void>; initialTab?: "user" | "office" }) {
  const admin = isAdmin();
  const [tab, setTab] = useState<"user" | "office">(initialTab);
  const [officeTab, setOfficeTab] = useState<OfficeTab>("office");
  // Hakutuloksesta valittu osio: siirrytään oikealle välilehdelle ja vieritetään osioon, kun se on piirretty.
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  useEffect(() => {
    if (!jumpTo) return;
    const frame = requestAnimationFrame(() => {
      jumpToSection(jumpTo);
      setJumpTo(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpTo, tab, officeTab]);

  function openResult(result: SettingsSearchEntry) {
    setTab(result.scope);
    if (result.officeTab) setOfficeTab(result.officeTab);
    setJumpTo(result.id);
  }

  return (
    <div className="settings-page">
      <SettingsSearch admin={admin} onOpen={openResult} />
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
      {tab === "office" && admin ? <OfficeSettings {...props} officeTab={officeTab} onTabChange={setOfficeTab} /> : <UserSettings />}
    </div>
  );
}

type SettingsSearchEntry = { id: string; label: string; scope: "user" | "office"; officeTab?: OfficeTab; place: string; keywords: string };

// Hakusanat osioittain: haku osuu myös asetuksiin, joiden nimi ei ole osion otsikossa.
const SECTION_KEYWORDS: Record<string, string> = {
  "user-details": "nimi sähköposti salasana kirjautuminen",
  "mail-personal": "gmail outlook microsoft imap posti postilaatikko yhdistä",
  signature: "allekirjoitus titteli puhelin vastaus",
  appearance: "tumma tila teema värit",
  language: "kieli englanti suomi language",
  "office-details": "nimi y-tunnus osoite puhelin",
  "office-reminders": "muistutus kooste määräaika odottanut",
  "office-resident-updates": "tilapäivitys asukas sähköposti ilmoitus",
  "office-unidentified": "tunnistamattomat jono käsittelijät roolit",
  "gmail-office": "gmail outlook microsoft imap posti postilaatikko toimiston tili",
  "office-security": "kirjautumiskoodi kaksivaiheinen tunnistautuminen koodi",
  "office-retention": "säilytysaika poisto gdpr vanhat tehtävät",
  "sensitive-data": "arkaluonteinen terveys sairaus avainsanat",
  "ai-masking": "maskaus puhelinnumero henkilötunnus tilinumero iban sähköposti peitto tietosuoja",
  log: "loki muutokset tapahtumat ai:lle lähetetty",
  "integration-log": "erp toiminnanohjausjärjestelmä integraatio sanoma lähetys",
  "office-ai": "kulut kuukausiraja prioriteetti suodatus relevanssi budjetti",
  "ai-prompt": "lisätieto ikkuna vastausehdotus ehdotus",
  "ai-models": "malli opus sonnet haiku claude",
  "master-data": "hätäsanat hätä määräajat prioriteetti päivät",
  users: "käyttäjät roolit lisää käyttäjä",
  roles: "roolit oikeudet pääsy taulut näkymät käyttöoikeudet",
  "system-alerts": "järjestelmän tila hälytykset virheet varmuuskopio"
};

function settingsSearchIndex(admin: boolean): SettingsSearchEntry[] {
  const user = userSections.map(section => ({
    ...section, scope: "user" as const, place: t("Käyttäjän asetukset"), keywords: SECTION_KEYWORDS[section.id] ?? ""
  }));
  if (!admin) return user;
  return [...user, ...officeTabs.flatMap(tab => tab.sections.map(section => ({
    ...section, scope: "office" as const, officeTab: tab.tab, place: `${t("Isännöitsijätoimiston tiedot")} › ${tab.label}`,
    keywords: SECTION_KEYWORDS[section.id] ?? ""
  })))];
}

// Haku asetuksista: osuu osioiden otsikoihin ja hakusanoihin; valinta avaa osion.
function SettingsSearch({ admin, onOpen }: { admin: boolean; onOpen: (entry: SettingsSearchEntry) => void }) {
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = words.length
    ? settingsSearchIndex(admin).filter(entry => {
      const text = `${entry.label} ${entry.place} ${entry.keywords}`.toLowerCase();
      return words.every(word => text.includes(word));
    })
    : [];
  return (
    <div className="settings-search">
      <input
        type="search"
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && results[0]) {
            onOpen(results[0]);
            setQuery("");
          }
        }}
        placeholder={t("Hae asetuksista, esim. maskaus tai allekirjoitus")}
        aria-label={t("Hae asetuksista")}
      />
      {words.length > 0 && (
        <div className="settings-search-results" role="listbox" aria-label={t("Hakutulokset")}>
          {results.length === 0 && <p className="muted">{t("Ei osumia.")}</p>}
          {results.map(entry => (
            <button
              key={`${entry.scope}-${entry.id}`}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => { onOpen(entry); setQuery(""); }}
            >
              <strong>{entry.label}</strong>
              <small>{entry.place}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Asetussivun aliotsikot: valinta avaa osion ja vierittää siihen.
function SettingsNav({ items }: { items: { id: string; label: string }[] }) {
  return (
    <nav className="settings-nav" aria-label={t("Tämän sivun osiot")}>
      <span>{t("Tällä sivulla")}</span>
      {items.map(item => (
        <button key={item.id} type="button" onClick={() => jumpToSection(item.id)}>{item.label}</button>
      ))}
    </nav>
  );
}

const userSections = [
  { id: "user-details", label: t("Omat tiedot") },
  { id: "mail-personal", label: t("Oma sähköpostitili") },
  { id: "signature", label: t("Sähköpostin allekirjoitus") },
  { id: "appearance", label: t("Ulkoasu") },
  { id: "language", label: t("Kieli") }
];

// Isännöitsijätoimiston asetukset välilehdittäin; kunkin välilehden osiot ovat aliotsikoina.
type OfficeTab = "office" | "security" | "ai" | "master" | "users" | "roles";
const officeTabs: { tab: OfficeTab; label: string; sections: { id: string; label: string }[] }[] = [
  {
    tab: "office", label: t("Toimisto"), sections: [
      { id: "office-details", label: t("Toimiston tiedot") },
      { id: "office-reminders", label: t("Muistutukset") },
      { id: "office-resident-updates", label: t("Asukasviestintä") },
      { id: "office-unidentified", label: t("Taloyhtiö tunnistamatta -jono") },
      { id: "gmail-office", label: t("Toimiston sähköpostitili") }
    ]
  },
  {
    tab: "security", label: t("Tietoturva"), sections: [
      { id: "office-security", label: t("Kirjautuminen") },
      { id: "office-retention", label: t("Tietojen säilytys") },
      { id: "sensitive-data", label: t("Arkaluonteiset tiedot") },
      { id: "ai-masking", label: t("Maskaus ennen AI:ta") },
      { id: "log", label: t("Loki") },
      { id: "integration-log", label: t("Integraatioloki") }
    ]
  },
  {
    tab: "ai", label: t("AI"), sections: [
      { id: "office-ai", label: t("AI-käyttö ja -asetukset") },
      { id: "ai-prompt", label: t("AI-ehdotukset") },
      { id: "ai-models", label: t("AI-mallit") }
    ]
  },
  {
    tab: "master", label: t("Perustiedot"), sections: [
      { id: "master-data", label: t("Hätäsanat ja määräajat") },
      { id: "system-alerts", label: t("Järjestelmän tila") }
    ]
  },
  { tab: "users", label: t("Käyttäjät"), sections: [{ id: "users", label: t("Käyttäjät") }] },
  { tab: "roles", label: t("Roolit"), sections: [{ id: "roles", label: t("Roolit") }] }
];

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
  const [currentPassword, setCurrentPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  // Nykyistä salasanaa kysytään vain, kun käyttäjä vaihtaa sähköpostiaan tai salasanaansa.
  const needsCurrent = Boolean(password) || email.trim().toLowerCase() !== (user?.email ?? "").toLowerCase();
  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!user || !session) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const updated = await api<OfficeUser>(`/users/${encodeURIComponent(user.id)}`, {
        method: "PUT",
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password: password || undefined, currentPassword: currentPassword || undefined })
      });
      // Muutos näkyy heti myös sivupalkissa.
      setSession({ ...session, user: updated });
      setPassword("");
      setCurrentPassword("");
      setSaved(true);
    } catch (submitError) {
      setError(errorMessage(submitError, t("Tietojen tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-shell">
    <SettingsNav items={userSections} />
    <section className="content settings settings-main">
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

        {needsCurrent && (
          <label>
            <span>{t("Nykyinen salasana")}</span>
            <input
              type="password"
              value={currentPassword}
              onChange={event => { setCurrentPassword(event.target.value); setSaved(false); }}
              placeholder={t("Vahvista sähköpostin tai salasanan vaihto")}
              autoComplete="current-password"
            />
          </label>
        )}

        {error && <p className="send-error">{error}</p>}

        <div className="draft-actions">
          <button
            className="primary"
            type="submit"
            disabled={saving || !name.trim() || !email.trim() || (password.length > 0 && password.length < 8) || (needsCurrent && !currentPassword)}
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

      <div className="settings-card ticket-form">
        <CollapseSection id="language" title={t("Kieli")}>
        <Dropdown label={t("Käyttöliittymän kieli")} value={language} options={LANGUAGES} onChange={value => setLanguage(value as Language)} />
        <p className="reply-hint">{t("Kielivalinta tallentuu tähän selaimeen. Sivu latautuu uudelleen, kun kieli vaihtuu.")}</p>
        </CollapseSection>
      </div>
    </section>
    </div>
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
  // aiAgent: 1 = tehtävällä on Anna AI-agentin hoitaa -painike.
  aiAgent?: number;
  // incidentDetection: 1 = usean asunnon samanaiheiset ilmoitukset näytetään mahdollisena yhteisenä vikana.
  incidentDetection?: number;
  // Tunnistuksen rajat aiheittain: seurataanko, montako asuntoa ja minkä ajan (tuntia) sisällä.
  incidentRules?: IncidentRule[];
  // memoryAuto: 1 = AI ehdottaa taloyhtiön muistiin tietoja kerran viikossa.
  memoryAuto?: number;
  // AI-kulujen kuukausiraja dollareina (0 = ei rajaa) ja varoitusraja prosentteina rajasta.
  aiMonthlyLimit?: number; aiWarningPercent?: number;
  // twoFactor: kirjautumiskoodi sähköpostiin; twoFactorOverridden: palvelin on kytkenyt sen pois.
  twoFactor?: number; twoFactorOverridden?: boolean;
  // residentStatusUpdates: asukas saa sähköpostin, kun tehtävän tila muuttuu.
  residentStatusUpdates?: number;
  // aiPrompt: AI-ehdotusta pyydettäessä avataan ikkuna lisätiedoille.
  aiPrompt?: number;
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
function OfficeSettings({ onSaved, officeTab, onTabChange }: {
  onSaved: () => Promise<void>;
  officeTab: OfficeTab;
  onTabChange: (tab: OfficeTab) => void;
}) {
  const [name, setName] = useState(MANAGEMENT_OFFICE.name);
  const [businessId, setBusinessId] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [reminderEmails, setReminderEmails] = useState(false);
  const [replyReminderDays, setReplyReminderDays] = useState(2);
  const [dueReminderDays, setDueReminderDays] = useState(1);
  const [aiPriority, setAiPriority] = useState(false);
  const [aiRelevance, setAiRelevance] = useState(false);
  const [aiAgent, setAiAgent] = useState(false);
  const [incidentDetection, setIncidentDetection] = useState(true);
  const [incidentRules, setIncidentRules] = useState<IncidentRule[]>([]);
  const [memoryAuto, setMemoryAuto] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [aiMonthlyLimit, setAiMonthlyLimit] = useState(50);
  const [twoFactor, setTwoFactor] = useState(false);
  const [twoFactorOverridden, setTwoFactorOverridden] = useState(false);
  const [residentStatusUpdates, setResidentStatusUpdates] = useState(true);
  const [aiPrompt, setAiPrompt] = useState(true);
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
  const roleNames = useRoleNames();
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
        setAiAgent(Boolean(office.aiAgent));
        setIncidentDetection(office.incidentDetection !== 0);
        setIncidentRules(office.incidentRules ?? []);
        setMemoryAuto(Boolean(office.memoryAuto));
        setAiAvailable(office.aiAvailable !== false);
        setAiMonthlyLimit(office.aiMonthlyLimit ?? 50);
        setTwoFactor(Boolean(office.twoFactor));
        setTwoFactorOverridden(Boolean(office.twoFactorOverridden));
        setResidentStatusUpdates(office.residentStatusUpdates !== 0);
        setAiPrompt(office.aiPrompt !== 0);
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
  const activeTab = officeTabs.find(item => item.tab === officeTab) ?? officeTabs[0];
  // Välilehdet, joiden asetukset tallennetaan yhteisellä Tallenna asetukset -painikkeella.
  const formTab = officeTab === "office" || officeTab === "security" || officeTab === "ai";


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
          name, businessId, address, phone, reminderEmails, replyReminderDays, dueReminderDays, retentionMonths, aiPriority, aiRelevance, aiAgent, incidentDetection, memoryAuto,
          incidentRules: incidentRules.map(({ topic, tracked, threshold, windowHours }) => ({ topic, tracked, threshold, windowHours })),
          aiMonthlyLimit, aiWarningPercent, twoFactor, residentStatusUpdates, aiPrompt,
          unidentifiedQueueRoles: queueRoles, unidentifiedQueueUsers: queueUsers
        })
      });
      MANAGEMENT_OFFICE.name = office.name;
      MANAGEMENT_OFFICE.aiPrompt = office.aiPrompt !== 0;
      MANAGEMENT_OFFICE.aiAgent = Boolean(office.aiAgent) && office.aiAvailable !== false;
      setIncidentRules(office.incidentRules ?? []);
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
    <div className="settings-office">
      <div className="settings-subtabs" role="tablist" aria-label={t("Isännöitsijätoimiston asetukset")}>
        {officeTabs.map(item => (
          <button
            key={item.tab}
            role="tab"
            aria-selected={officeTab === item.tab}
            className={officeTab === item.tab ? "active" : ""}
            onClick={() => onTabChange(item.tab)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="settings-shell">
      <SettingsNav items={activeTab.sections} />
      <div className="content settings settings-main">
      {formTab && (
      <form className="settings-card ticket-form" onSubmit={handleSubmit}>
        {officeTab === "office" && (
          <>
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

        <CollapseSection id="office-unidentified" title={t("Taloyhtiö tunnistamatta -jono")}>
        <p className="reply-hint">
          {t("Kun saapuvan viestin taloyhtiötä ei tunnisteta vastaanottajasta eikä lähettäjästä, tehtävä menee Taloyhtiö tunnistamatta -jonoon. Valitse, ketkä näkevät jonon ja valitsevat tehtäville taloyhtiön ja käsittelijän. Pääkäyttäjät käsittelevät jonoa aina.")}
        </p>
        <fieldset className="queue-access">
          <legend>{t("Roolit")}</legend>
          {roleNames.map(role => (
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
          </>
        )}
        {officeTab === "security" && (
          <>
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
          </>
        )}
        {officeTab === "ai" && (
          <>
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

        <label className="switch-row">
          <span>
            <strong>{t("AI-agentti käytössä")}</strong>
            <small>{t("Sauna-, pyykkitupa- ja autopaikka-asiat käsittelijän pyynnöstä.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={aiAgent}
            onChange={event => { setAiAgent(event.target.checked); setSaved(false); }}
          />
          <i aria-hidden="true" />
        </label>
        <p className="reply-hint">
          {t("Tehtävällä näkyy Anna AI-agentin hoitaa -painike. Agentti käsittelee tehtävän vasta, kun painiketta painetaan, joten AI-kutsuja ei tehdä turhaan. Jos asukas haluaa varata saunan tai pyykkituvan, agentti varaa vapaan vuoron tai ehdottaa varatun tilalle vapaita vuoroja ja varaa asukkaan valitseman, kun asukas vastaa – myös toimiston ollessa kiinni. Autopaikoista se kertoo vapaat paikat ja hinnat ja lisää asukkaan jonoon. Agentin hoitamat tehtävät näkyvät AI tehtävissä. Muut asiat agentti jättää käsittelijälle perustelun kanssa.")}
        </p>
        {aiAgent && !aiAvailable && (
          <p className="send-error">{t("AI ei ole käytössä palvelimella, joten agentti ei toistaiseksi käsittele tehtäviä.")}</p>
        )}

        <label className="switch-row">
          <span>
            <strong>{t("Tunnista yhteiset viat")}</strong>
            <small>{t("Usean asunnon samanaiheiset ilmoitukset näytetään päätösjonossa mahdollisena yhteisenä vikana.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={incidentDetection}
            onChange={event => { setIncidentDetection(event.target.checked); setSaved(false); }}
          />
          <i aria-hidden="true" />
        </label>
        <p className="reply-hint">
          {t("Jokainen tehtävä saa aiheen (esim. lämmitys, hissi tai vesivuoto). Kun useampi asunto ilmoittaa samasta aiheesta lyhyessä ajassa ja selvästi tavallista enemmän, vastuuisännöitsijä saa sähköpostin ja asia näkyy päätösjonon yläosassa. Tunnistus on laskentaa eikä käytä AI:ta; AI-tulkinnan voi pyytää erikseen.")}
        </p>
        {incidentDetection && incidentRules.length > 0 && (
          <IncidentRulesTable rules={incidentRules} onChange={rules => { setIncidentRules(rules); setSaved(false); }} />
        )}

        <label className="switch-row">
          <span>
            <strong>{t("Ehdota taloyhtiön muistiin tietoja kerran viikossa")}</strong>
            <small>{t("AI käy läpi viikon aikana ratkaistut tehtävät ja ehdottaa niistä tietoja hyväksyttäväksi.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={memoryAuto}
            onChange={event => { setMemoryAuto(event.target.checked); setSaved(false); }}
          />
          <i aria-hidden="true" />
        </label>
        <p className="reply-hint">
          {t("Ehdotukset näkyvät kohdassa Raportit › Taloyhtiön muisti. AI:ta kutsutaan vain, jos taloyhtiössä on uusia ratkaistuja tehtäviä. Ehdotukset voi hakea myös käsin samasta paikasta.")}
        </p>
        {memoryAuto && !aiAvailable && (
          <p className="send-error">{t("AI ei ole käytössä palvelimella, joten ehdotuksia ei toistaiseksi haeta.")}</p>
        )}

        </CollapseSection>

        <CollapseSection id="ai-prompt" title={t("AI-ehdotukset")}>
        <label className="switch-row">
          <span>
            <strong>{t("Kysy lisätietoa ennen AI-ehdotusta")}</strong>
            <small>{t("Pyydä AI-ehdotus avaa ikkunan, johon voi kirjoittaa tehtävästä lisätietoa AI:n huomioitavaksi. Pois päältä ehdotus tehdään heti.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={aiPrompt}
            onChange={event => { setAiPrompt(event.target.checked); setSaved(false); }}
          />
          <i aria-hidden="true" />
        </label>
        <p className="reply-hint">{t("Valinta koskee kaikkia toimiston käyttäjiä.")}</p>
        </CollapseSection>
          </>
        )}

        {error && <p className="send-error">{error}</p>}

        <div className="draft-actions">
          <button className="primary" type="submit" disabled={saving || !name.trim()}>
            {saving ? t("Tallennetaan…") : t("Tallenna asetukset")}
          </button>
          {saved && <span className="saved-indicator">{t("Tallennettu")}</span>}
        </div>
      </form>
      )}

      {officeTab === "office" && <MailAccountCard target="office" />}

      {officeTab === "security" && <MasterDataSettings part="security" />}
      {officeTab === "ai" && <MasterDataSettings part="ai" />}

      {officeTab === "security" && (
        <a className="settings-card settings-link" href="#/log" id="section-log">
          <div>
            <h2>{t("Loki")}</h2>
            <p className="muted">{t("Kaikki tehtäviin tehdyt muutokset, päätökset ja lähetetyt sähköpostit.")}</p>
          </div>
          <span aria-hidden="true">→</span>
        </a>
      )}

      {officeTab === "security" && (
        <a className="settings-card settings-link" href="#/integration" id="section-integration-log">
          <div>
            <h2>{t("Integraatioloki")}</h2>
            <p className="muted">{t("Toiminnanohjausjärjestelmään (ERP) lähtevät sanomat ja niiden tila. Vain pääkäyttäjälle.")}</p>
          </div>
          <span aria-hidden="true">→</span>
        </a>
      )}

      {officeTab === "master" && (
        <>
          <MasterDataSettings part="basic" />
          <div id="section-system-alerts"><SystemAlertsCard /></div>
        </>
      )}
      {officeTab === "users" && <OfficeUsers />}
      {officeTab === "roles" && <OfficeRoles />}
      </div>
      </div>
    </div>
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
  chunking: t("Dokumenttien pilkonta"),
  agent: t("AI-agentti"),
  incident: t("Yhteisten vikojen tulkinnat"),
  memory: t("Taloyhtiön muistin ehdotukset")
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
    api<BookingRules>(`/companies/${encodeURIComponent(companyId)}/booking-settings`)
      .then(setRules)
      .catch(() => setError(t("Asetusten lataus epäonnistui.")));
  }, [companyId]);

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
          {/* Varattava aikaikkuna (esim. 8–22): kalenterissa näytetään ja varataan vain nämä tunnit. */}
          <div className="booking-settings-duration">
            <span>
              <strong>{t("Varattavissa")}</strong>
              <small>{t("Kellonajat, joille vuoroja voi varata.")}</small>
            </span>
            <span className="booking-hours">
              <select
                value={rules?.[section.resource].firstHour ?? 0}
                disabled={!rules || readOnly}
                aria-label={t("Varattavissa alkaen")}
                onChange={event => rules && void save({ ...rules, [section.resource]: { ...rules[section.resource], firstHour: Number(event.target.value) } })}
              >
                {Array.from({ length: 24 }, (_, hour) => hour)
                  .filter(hour => !rules || hour < rules[section.resource].lastHour)
                  .map(hour => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}.00</option>)}
              </select>
              –
              <select
                value={rules?.[section.resource].lastHour ?? 24}
                disabled={!rules || readOnly}
                aria-label={t("Varattavissa asti")}
                onChange={event => rules && void save({ ...rules, [section.resource]: { ...rules[section.resource], lastHour: Number(event.target.value) } })}
              >
                {Array.from({ length: 24 }, (_, index) => index + 1)
                  .filter(hour => !rules || hour > rules[section.resource].firstHour)
                  .map(hour => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}.00</option>)}
              </select>
            </span>
          </div>
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
        {!collapsed.includes("parking") && <ParkingOptionsEditor companyId={companyId} />}
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
  const roleNames = useRoleNames();
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
    setRole(roleNames.includes("Isännöitsijä") ? "Isännöitsijä" : roleNames[1] ?? ADMIN_ROLE);
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
                  {[...new Set([...roleNames, role])].map(option => <option key={option} value={option}>{t(option)}</option>)}
                </select>
              </label>

              <p className="reply-hint">{t("Rooli määrää, mitkä taulut käyttäjä näkee. Roolit muokataan Roolit-välilehdellä.")}</p>

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

type OfficeRole = { id: string; name: string; base: "Isännöitsijä" | "Asiakaspalvelu"; tables: string[] | null; userCount: number };

const ROLE_BASE_LABELS: Record<OfficeRole["base"], string> = {
  "Isännöitsijä": t("Isännöitsijän oikeudet"),
  "Asiakaspalvelu": t("Asiakaspalvelun oikeudet")
};

// Valittavat roolit: pääkäyttäjä ja toimiston omat roolit.
function useRoleNames() {
  const [names, setNames] = useState<string[]>([ADMIN_ROLE, "Isännöitsijä", "Asiakaspalvelu"]);
  useEffect(() => {
    api<OfficeRole[]>("/roles").then(roles => setNames([ADMIN_ROLE, ...roles.map(role => role.name)])).catch(() => undefined);
  }, []);
  return names;
}

// Roolit: nimi, oikeustaso ja taulut, jotka roolin käyttäjät näkevät. Pääkäyttäjä näkee aina kaiken.
function OfficeRoles() {
  const allTables = roleTableGroups.flatMap(group => group.tabs);
  const [roles, setRoles] = useState<OfficeRole[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<OfficeRole | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [base, setBase] = useState<OfficeRole["base"]>("Asiakaspalvelu");
  const [tables, setTables] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  async function loadRoles() {
    try {
      setRoles(await api<OfficeRole[]>("/roles"));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }

  useEffect(() => {
    void loadRoles();
  }, []);

  function openRole(role: OfficeRole | null) {
    setEditing(role);
    setCreating(!role);
    setName(role?.name ?? "");
    setBase(role?.base ?? "Asiakaspalvelu");
    setTables(role ? role.tables ?? allTables : []);
    setFormError("");
  }

  function closeForm() {
    setEditing(null);
    setCreating(false);
  }

  function toggleTables(changed: string[], checked: boolean) {
    setTables(current => checked ? [...new Set([...current, ...changed])] : current.filter(item => !changed.includes(item)));
  }

  // Taulujen määrä roolin listarivillä.
  function tablesLabel(role: OfficeRole) {
    if (role.tables === null) return t("Kaikki taulut");
    const count = allTables.filter(table => role.tables?.includes(table)).length;
    return t("{0}/{1} taulua", count, allTables.length);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    // Kun kaikki taulut on valittu, rooli näkee myös myöhemmin lisättävät taulut.
    const selected = allTables.every(table => tables.includes(table)) ? null : allTables.filter(table => tables.includes(table));
    try {
      await api(editing ? `/roles/${encodeURIComponent(editing.id)}` : "/roles", {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify({ name, base, tables: selected })
      });
      closeForm();
      await loadRoles();
    } catch (error) {
      setFormError(errorMessage(error, t("Roolin tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function deleteRole(role: OfficeRole) {
    if (!window.confirm(t("Poistetaanko rooli {0}?", role.name))) return;
    setSaving(true);
    setFormError("");
    try {
      await api(`/roles/${encodeURIComponent(role.id)}`, { method: "DELETE" });
      closeForm();
      await loadRoles();
    } catch (error) {
      setFormError(errorMessage(error, t("Roolin poisto epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="settings-card settings-users settings-roles">
      <CollapseSection
        id="roles"
        title={t("Roolit")}
        action={<button className="secondary" onClick={() => openRole(null)}>{t("Lisää rooli")}</button>}
      >
      <p className="muted">
        {t("Rooli määrää, mitkä taulut sen käyttäjät näkevät. Roolin voi valita käyttäjälle Käyttäjät-välilehdellä. Uudet taulut tulevat tähän valittaviksi automaattisesti.")}
      </p>
      {loadError && <p className="send-error">{t("Roolien lataus epäonnistui.")}</p>}
      <ul>
        <li title={t("Pääkäyttäjä näkee aina kaikki taulut")}>
          <span className="user-avatar" aria-hidden="true">{ADMIN_ROLE.slice(0, 2)}</span>
          <div>
            <strong>{t(ADMIN_ROLE)}</strong>
            <span>{t("Hallitsee asetuksia ja käyttäjiä")}</span>
          </div>
          <em>{t("Kaikki taulut aina")}</em>
        </li>
        {roles.map(role => (
          <li
            key={role.id}
            className="clickable"
            title={t("Muokkaa roolia")}
            role="button"
            tabIndex={0}
            onClick={() => openRole(role)}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openRole(role);
              }
            }}
          >
            <span className="user-avatar" aria-hidden="true">{role.name.slice(0, 2)}</span>
            <div>
              <strong>{t(role.name)}</strong>
              <span>{ROLE_BASE_LABELS[role.base]} · {t("{0} käyttäjää", role.userCount)}</span>
            </div>
            <em>{tablesLabel(role)}</em>
          </li>
        ))}
      </ul>
      </CollapseSection>

      {(editing || creating) && (
        <div className="overlay">
          <aside className="drawer form-drawer resident-drawer">
            <button type="button" className="drawer-back" onClick={closeForm}>{t("← Takaisin")}</button>
            <button className="close" onClick={closeForm}>×</button>
            <h2>{editing ? t(editing.name) : t("Lisää rooli")}</h2>
            <p className="muted">{t("Rooli")} · {MANAGEMENT_OFFICE.name}</p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              <label>
                <span>{t("Roolin nimi")}</span>
                <input value={name} onChange={event => setName(event.target.value)} maxLength={60} />
              </label>

              <label>
                <span>{t("Oikeustaso")}</span>
                <select value={base} onChange={event => setBase(event.target.value as OfficeRole["base"])}>
                  {(Object.keys(ROLE_BASE_LABELS) as OfficeRole["base"][]).map(option => (
                    <option key={option} value={option}>{ROLE_BASE_LABELS[option]}</option>
                  ))}
                </select>
              </label>
              <p className="reply-hint">
                {t("Isännöitsijän oikeuksilla käyttäjä muokkaa taloyhtiöiden tietoja ja näkee vain yhtiöt, joiden isännöitsijä hän on. Asiakaspalvelun oikeuksilla hän näkee kaikki yhtiöt mutta muokkaa vähemmän.")}
              </p>

              <div className="role-tables">
                <div className="role-tables-head">
                  <strong>{t("Taulut, jotka rooli näkee")}</strong>
                  <button type="button" className="secondary" onClick={() => toggleTables(allTables, tables.length < allTables.length)}>
                    {tables.length < allTables.length ? t("Valitse kaikki") : t("Poista valinnat")}
                  </button>
                </div>
                {roleTableGroups.map(group => (
                  <fieldset key={group.key} className="queue-access">
                    <legend>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={group.tabs.every(table => tables.includes(table))}
                          onChange={event => toggleTables(group.tabs, event.target.checked)}
                        />
                        {group.label}
                      </label>
                    </legend>
                    {group.tabs.map(table => (
                      <label key={table} className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={tables.includes(table)}
                          onChange={event => toggleTables([table], event.target.checked)}
                        />
                        {roleTableTitles[table] ?? table}
                      </label>
                    ))}
                  </fieldset>
                ))}
                <p className="reply-hint">
                  {t("Kun kaikki taulut on valittu, rooli näkee myös myöhemmin lisättävät taulut. Asetukset ja haku näkyvät aina.")}
                </p>
              </div>

              {formError && <p className="send-error">{formError}</p>}

              <div className="drawer-actions compact-actions">
                {editing && (
                  <button
                    type="button"
                    className="danger"
                    disabled={saving || editing.userCount > 0}
                    title={editing.userCount > 0 ? t("Roolilla on käyttäjiä. Vaihda heille ensin toinen rooli.") : undefined}
                    onClick={() => deleteRole(editing)}
                  >
                    {t("Poista rooli")}
                  </button>
                )}
                <button type="button" onClick={closeForm}>{t("Peruuta")}</button>
                <button className="primary" type="submit" disabled={saving || !name.trim()}>
                  {saving ? t("Tallennetaan…") : editing ? t("Tallenna muutokset") : t("Lisää rooli")}
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </aside>
  );
}

export type IncidentRule = {
  topic: string; label: string; tracked: boolean; threshold: number; windowHours: number;
  defaults: { tracked: boolean; threshold: number; windowHours: number };
};

// Aikaikkuna tunteina valintoina; muu tallennettu arvo näytetään omana vaihtoehtonaan.
const WINDOW_CHOICES = [6, 12, 24, 48, 72, 168, 336];
const THRESHOLD_CHOICES = [2, 3, 4, 5, 6, 8, 10, 15, 20];
// Aiheet samassa järjestyksessä kuin tehtävän Aihe-valikossa.
const topicOrder = (topic: string) => topicOptions.findIndex(option => option.value === topic);
const windowLabel = (hours: number) =>
  hours % 24 === 0 ? (hours === 24 ? t("1 vuorokausi") : t("{0} vuorokautta", hours / 24)) : t("{0} tuntia", hours);

// Yhteisten vikojen rajat aiheittain: seurataanko aihetta, montako eri asuntoa ja minkä ajan sisällä.
function IncidentRulesTable({ rules, onChange }: { rules: IncidentRule[]; onChange: (rules: IncidentRule[]) => void }) {
  const update = (topic: string, change: Partial<IncidentRule>) =>
    onChange(rules.map(rule => (rule.topic === topic ? { ...rule, ...change } : rule)));
  const changed = rules.some(rule => rule.tracked !== rule.defaults.tracked || rule.threshold !== rule.defaults.threshold
    || rule.windowHours !== rule.defaults.windowHours);
  return (
    <div className="incident-rules">
      <table>
        <thead>
          <tr>
            <th scope="col">{t("Aihe")}</th>
            <th scope="col">{t("Seurataan")}</th>
            <th scope="col">{t("Asuntoja vähintään")}</th>
            <th scope="col">{t("Aikaikkuna")}</th>
          </tr>
        </thead>
        <tbody>
          {[...rules].sort((a, b) => topicOrder(a.topic) - topicOrder(b.topic)).map(rule => (
            <tr key={rule.topic} className={rule.tracked ? "" : "rule-off"}>
              <th scope="row">{topicLabel(rule.topic)}</th>
              <td>
                <input
                  type="checkbox"
                  checked={rule.tracked}
                  aria-label={t("Seurataan: {0}", topicLabel(rule.topic))}
                  onChange={event => update(rule.topic, { tracked: event.target.checked })}
                />
              </td>
              <td>
                <select
                  value={rule.threshold}
                  disabled={!rule.tracked}
                  aria-label={t("Asuntoja vähintään: {0}", topicLabel(rule.topic))}
                  onChange={event => update(rule.topic, { threshold: Number(event.target.value) })}
                >
                  {[...new Set([...THRESHOLD_CHOICES, rule.threshold])].sort((a, b) => a - b).map(count => (
                    <option key={count} value={count}>{count}</option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  value={rule.windowHours}
                  disabled={!rule.tracked}
                  aria-label={t("Aikaikkuna: {0}", topicLabel(rule.topic))}
                  onChange={event => update(rule.topic, { windowHours: Number(event.target.value) })}
                >
                  {[...new Set([...WINDOW_CHOICES, rule.windowHours])].sort((a, b) => a - b).map(hours => (
                    <option key={hours} value={hours}>{windowLabel(hours)}</option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="reply-hint">
        {t("Yhteinen vika syntyy, kun vähintään näin moni eri asunto ilmoittaa aiheesta aikaikkunan sisällä ja ilmoituksia on selvästi tavallista enemmän. Saman asunnon useampi viesti lasketaan yhdeksi.")}
      </p>
      {changed && (
        <div className="draft-actions">
          <button
            type="button"
            onClick={() => onChange(rules.map(rule => ({ ...rule, ...rule.defaults })))}
          >
            {t("Palauta oletusrajat")}
          </button>
        </div>
      )}
    </div>
  );
}
