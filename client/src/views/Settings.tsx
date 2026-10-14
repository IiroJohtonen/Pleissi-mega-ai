import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Dropdown, usePaged } from "../components/common";
import { formatDate } from "../format";
import { type Language, language, LANGUAGES, setLanguage } from "../i18n";
import {
  api, errorMessage, isAdmin, MANAGEMENT_OFFICE, type OfficeUser, session, setSession, USER_ROLES
} from "../session";
import type { Company, GmailStatus } from "../types";
import { type BookingRules, WEEKLY_DURATION_OPTIONS, weeklyWeeksOf } from "./Bookings";
import { PARKING_TYPES } from "./Parking";
import { t } from "../i18n";

const COLLAPSED_KEY = "kotilo.settingsCollapsed";

function collapsedSections(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

// Tiivistettävä asetusosio: otsikon väkäsestä osio sulkeutuu ja avautuu. Valinta säilyy selaimessa.
// Suljetun osion kentät säilyttävät arvonsa, koska ne ovat näkymän omassa tilassa.
function CollapseSection({ id, title, action, children }: {
  id: string;
  title: string;
  // Otsikon vieressä pysyvä toiminto, esim. lisäyspainike.
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => !collapsedSections().includes(id));

  function toggle() {
    const next = !open;
    setOpen(next);
    try {
      const others = collapsedSections().filter(item => item !== id);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next ? others : [...others, id]));
    } catch {
      // Selaimen tallennustila ei ole käytössä; valinta säilyy vain tämän käynnin ajan.
    }
  }

  const heading = (
    <h2 className="collapse-heading">
      <button
        type="button"
        className="collapse-head"
        onClick={toggle}
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
    </h2>
  );

  return (
    <>
      {action ? <div className="collapse-row">{heading}{action}</div> : heading}
      {open && children}
    </>
  );
}

// Asetukset: jokaisella käyttäjällä omat asetuksensa, pääkäyttäjällä lisäksi toimiston tiedot.
export function Settings(props: { company?: Company; onSaved: () => Promise<void> }) {
  const admin = isAdmin();
  const [tab, setTab] = useState<"user" | "office">("user");

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
  // aiPriority: 1 = AI arvioi saapuvan tehtävän prioriteetin. aiAvailable: palvelimella on AI-avain.
  aiPriority?: number; aiAvailable?: boolean;
  // aiRelevance: 1 = AI tarkistaa, koskeeko saapuva sähköposti taloyhtiön asioita.
  aiRelevance?: number;
};

// Gmail-tili, jolla posti lähtee ja saapuu. target "office" = toimiston tili, muuten taloyhtiön tunniste.
// Tilin vaihto avaa Googlen kirjautumisen uuteen välilehteen; vain pääkäyttäjä voi vaihtaa tilin.
export function GmailAccountCard({ target }: { target: string }) {
  const office = target === "office";
  const [status, setStatus] = useState<(GmailStatus & { own?: boolean }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");

  async function loadStatus() {
    try {
      setStatus(await api<GmailStatus & { own?: boolean }>(office ? "/gmail/status" : `/gmail/status?companyId=${encodeURIComponent(target)}`));
    } catch {
      setStatus({ connected: false });
    }
  }

  useEffect(() => {
    setWaiting(false);
    setError("");
    void loadStatus();
    // Kun käyttäjä palaa Googlen kirjautumisesta tähän välilehteen, tila luetaan uudelleen.
    const onFocus = () => void loadStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [target]);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const { url } = await api<{ url: string }>("/gmail/connect", { method: "POST", body: JSON.stringify({ target }) });
      window.open(url, "_blank", "noopener");
      setWaiting(true);
    } catch (connectError) {
      setError(errorMessage(connectError, t("Gmail-kirjautumisen aloitus epäonnistui.")));
    } finally {
      setBusy(false);
    }
  }

  async function removeOwn() {
    if (!window.confirm(t("Poistetaanko taloyhtiön oma Gmail-tili? Taloyhtiön posti kulkee sen jälkeen toimiston tilin kautta."))) return;
    setBusy(true);
    setError("");
    try {
      await api(`/gmail/accounts/${encodeURIComponent(target)}`, { method: "DELETE" });
      await loadStatus();
    } catch (removeError) {
      setError(errorMessage(removeError, t("Tilin poistaminen epäonnistui.")));
    } finally {
      setBusy(false);
    }
  }

  const admin = isAdmin();
  const own = office || Boolean(status?.own);

  return (
    <div className="settings-card gmail-card">
      <CollapseSection id={office ? "gmail-office" : "gmail-company"} title={office ? t("Toimiston Gmail-tili") : t("Taloyhtiön Gmail-tili")}>
      {!status ? <p className="muted">{t("Tarkistetaan…")}</p> : status.connected ? (
        <>
          <p><strong>{status.emailAddress}</strong>{!own && <span className="gmail-shared">{" "}{t("· toimiston yhteinen tili")}</span>}</p>
          <p className="muted">
            {office
              ? t("Kotilo lukee saapuvat viestit tämän tilin postilaatikosta ja lähettää vastaukset siitä. Taloyhtiö, jolla on oma tili, käyttää omaansa.")
              : own
                ? t("Tämän taloyhtiön viestit saapuvat tähän postilaatikkoon ja lähtevät siitä.")
                : t("Taloyhtiöllä ei ole omaa tiliä, joten sen posti kulkee toimiston tilin kautta. Voit yhdistää taloyhtiölle oman Gmail-tilin.")}
            {status.canSend ? "" : t(" Tililtä puuttuu lähetysoikeus: yhdistä tili uudelleen.")}
          </p>
        </>
      ) : (
        <p className="send-error">{t("Gmail-tiliä ei ole yhdistetty tai yhteys on katkennut. Yhdistä tili uudelleen.")}</p>
      )}
      {admin ? (
        <div className="draft-actions">
          <button className="secondary" onClick={() => void connect()} disabled={busy}>
            {own && status?.connected ? t("Vaihda Gmail-tili") : office ? t("Yhdistä Gmail-tili") : t("Yhdistä oma Gmail-tili")}
          </button>
          {!office && status?.own && <button className="danger" onClick={() => void removeOwn()} disabled={busy}>{t("Poista oma tili")}</button>}
          {waiting && <button onClick={() => void loadStatus()}>{t("Tarkista yhteys")}</button>}
        </div>
      ) : (
        <p className="reply-hint">{t("Vain pääkäyttäjä voi vaihtaa Gmail-tilin.")}</p>
      )}
      {waiting && <p className="reply-hint">{t("Kirjaudu Googlen avaamassa välilehdessä ja hyväksy oikeudet. Palaa sitten tähän välilehteen.")}</p>}
      {error && <p className="send-error">{error}</p>}
      </CollapseSection>
    </div>
  );
}

function OfficeSettings({
  company,
  onSaved
}: {
  company?: Company;
  onSaved: () => Promise<void>;
}) {
  // Toimiston omat tiedot; taloyhtiöstä tällä lomakkeella muutetaan vain tehtävien vastaanotto-osoitetta.
  const [name, setName] = useState(MANAGEMENT_OFFICE.name);
  const [businessId, setBusinessId] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [reminderEmails, setReminderEmails] = useState(false);
  const [aiPriority, setAiPriority] = useState(false);
  const [aiRelevance, setAiRelevance] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [retentionMonths, setRetentionMonths] = useState(0);
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
        setAiPriority(Boolean(office.aiPriority));
        setAiRelevance(Boolean(office.aiRelevance));
        setAiAvailable(office.aiAvailable !== false);
        setRetentionMonths(office.retentionMonths ?? 0);
        setStoredRetention(office.retentionMonths ?? 0);
      })
      .catch(() => setError(t("Toimiston tietojen lataus epäonnistui.")));
  }, []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");


  useEffect(() => {
    setEmailAddress(company?.email_address ?? "");
    setSaved(false);
    setError("");
  }, [company?.id]);

  if (!company) return <div className="empty">{t("Yhtiötä ei ole valittu.")}</div>;
  const companyId = company.id;

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
        body: JSON.stringify({ name, businessId, address, phone, reminderEmails, retentionMonths, aiPriority, aiRelevance })
      });
      MANAGEMENT_OFFICE.name = office.name;
      setStoredRetention(office.retentionMonths ?? 0);
      // Taloyhtiön omat tiedot säilyvät; vain vastaanotto-osoite päivitetään.
      if (company && emailAddress.trim() !== (company.email_address ?? "")) {
        await api(`/companies/${encodeURIComponent(companyId)}`, {
          method: "PUT",
          body: JSON.stringify({
            name: company.name,
            businessId: company.business_id ?? "",
            address: company.address ?? "",
            phone: company.phone ?? "",
            emailAddress
          })
        });
      }
      await onSaved();
      setSaved(true);
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

        <CollapseSection id="office-inbox" title={t("Tehtävien vastaanotto")}>

        <label>
          <span>{t("Sähköposti, johon tehtävät saapuvat (")}{company.name})</span>
          <input
            type="email"
            value={emailAddress}
            onChange={event => { setEmailAddress(event.target.value); setSaved(false); }}
            placeholder={t("esim. asiakaspalvelu@yritys.fi")}
          />
        </label>
        <p className="reply-hint">
          {t("Tähän osoitteeseen lähetetyt viestit ohjataan tämän yhtiön tehtäviksi.")}
        </p>

        </CollapseSection>

        <CollapseSection id="office-reminders" title={t("Muistutukset")}>

        <label className="switch-row">
          <span>
            <strong>{t("Muistutus sähköpostilla")}</strong>
            <small>{t("Käsittelijä saa enintään kerran päivässä koosteen myöhässä olevista tehtävistään.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={reminderEmails}
            onChange={event => { setReminderEmails(event.target.checked); setSaved(false); }}
          />
          <i aria-hidden="true" />
        </label>
        <p className="reply-hint">
          {t("Koosteessa ovat tehtävät, joiden määräaika on mennyt tai joissa asukkaan viesti on odottanut vastausta yli kaksi päivää. Viesti lähtee toimiston Gmail-tililtä käyttäjän kirjautumisosoitteeseen. Myöhässä olevat tehtävät näkyvät sovelluksessa aina.")}
        </p>

        </CollapseSection>

        <CollapseSection id="office-ai" title={t("AI")}>

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

      <ContactRequests />

      <a className="settings-card settings-link" href="#/log">
        <div>
          <h2>{t("Loki")}</h2>
          <p className="muted">{t("Kaikki tehtäviin tehdyt muutokset, päätökset ja lähetetyt sähköpostit.")}</p>
        </div>
        <span aria-hidden="true">→</span>
      </a>

      <GmailAccountCard target="office" />
      </div>

      <OfficeUsers />
    </section>
  );
}

// Asetukset: saako taloyhtiön saunaan ja pyykkitupaan varata yksittäisiä ja viikoittaisia vuoroja.
// Taloyhtiön vuorovaraus- ja autopaikka-asetukset; näytetään taloyhtiön tiedoissa.
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
