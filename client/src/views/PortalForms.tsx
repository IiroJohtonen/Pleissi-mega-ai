import { type FormEvent, type ReactNode, useState } from "react";
import { t } from "../i18n";
import { api, errorMessage, type ResidentAccount } from "../session";
import { PortalFilePicker, portalAttachments } from "./Portal";

// Asukasportaalin lomakkeet: huoltotyötilaus, häiriöilmoitus, irtisanomisilmoitus ja asuntohakemus.
// Lähetetty lomake on isännöitsijälle tehtävä, ja asukas näkee sen Tehtävät-sivulla.
export type PortalFormKey = "service" | "disturbance" | "termination" | "application";

const SERVICE_TARGETS = ["Oma asunto", "Porraskäytävä tai yhteiset tilat", "Piha tai ulkoalueet", "Autopaikka tai autotalli"];
const SERVICE_ENTRY = ["Huolto saa mennä asuntoon yleisavaimella", "Sovitaan käyntiaika ensin"];
const DISTURBANCE_TYPES = ["Melu", "Tupakointi", "Järjestyssääntöjen rikkominen", "Roskaaminen tai sotkeminen", "Lemmikit", "Muu häiriö"];
const APARTMENT_SIZES = ["Yksiö", "Kaksio", "Kolmio", "Neljä huonetta tai enemmän"];

const formIntro: Record<PortalFormKey, string> = {
  service: t("Ilmoita viasta tai huoltoa vaativasta asiasta asunnossa tai yhteisissä tiloissa. Kiireellisessä hätätilanteessa, kuten vesivuodossa, soita huoltoyhtiön päivystykseen."),
  disturbance: t("Ilmoita toistuvasta tai vakavasta häiriöstä. Kerro mahdollisimman tarkasti, milloin ja mistä häiriö tulee."),
  termination: t("Vuokralaisen irtisanomisaika on yksi kuukausi. Se lasketaan sen kuukauden lopusta, jona irtisanot sopimuksen."),
  application: t("Hae uutta asuntoa tai vaihtoa toiseen asuntoon. Isännöitsijä ottaa sinuun yhteyttä, kun sopiva asunto vapautuu.")
};

const sentText: Record<PortalFormKey, string> = {
  service: t("Huoltotyötilaus on lähetetty."),
  disturbance: t("Häiriöilmoitus on lähetetty."),
  termination: t("Irtisanomisilmoitus on lähetetty."),
  application: t("Asuntohakemus on lähetetty.")
};

// Vuokrasuhde voi päättyä aikaisintaan seuraavan kalenterikuukauden viimeisenä päivänä.
export function earliestTerminationDate(from = new Date()) {
  const last = new Date(from.getFullYear(), from.getMonth() + 2, 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;
}

function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="switch-row">
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={() => onChange(!checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function PortalForm({ form, resident, onOpenTickets }: { form: PortalFormKey; resident: ResidentAccount; onOpenTickets: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  // Lomake tyhjennetään lähetyksen jälkeen vaihtamalla avainta.
  const [round, setRound] = useState(0);

  async function submit(payload: Record<string, unknown>, files: File[] = []) {
    setSaving(true);
    setError("");
    try {
      const created = await api<{ attachmentError?: string | null }>(`/portal/forms/${form}`, {
        method: "POST",
        body: JSON.stringify({ ...payload, ...(files.length ? { attachments: await portalAttachments(files) } : {}) })
      });
      if (created.attachmentError) setError(t("Lomake lähetettiin, mutta liitteitä ei tallennettu: {0}", created.attachmentError));
      setSent(true);
      setRound(round + 1);
      window.scrollTo({ top: 0 });
    } catch (submitError) {
      setError(errorMessage(submitError, t("Lomakkeen lähetys epäonnistui. Yritä uudelleen.")));
    } finally {
      setSaving(false);
    }
  }

  const props = { resident, saving, error, submit };
  const key = `${form}-${round}`;
  return (
    <>
      <p className="muted portal-form-intro">{formIntro[form]}</p>
      {sent && (
        <p className="portal-sent">
          {sentText[form]}{" "}
          {t("Näet sen ja isännöitsijän vastaukset Tehtävät-sivulla.")}{" "}
          <button type="button" className="link-button" onClick={onOpenTickets}>{t("Avaa Tehtävät")}</button>
        </p>
      )}
      {form === "service" ? <ServiceForm key={key} {...props} />
        : form === "disturbance" ? <DisturbanceForm key={key} {...props} />
        : form === "termination" ? <TerminationForm key={key} {...props} />
        : <ApplicationForm key={key} {...props} />}
    </>
  );
}

type FormProps = {
  resident: ResidentAccount;
  saving: boolean;
  error: string;
  submit: (payload: Record<string, unknown>, files?: File[]) => Promise<void>;
};

function ReporterFacts({ resident }: { resident: ResidentAccount }) {
  return (
    <dl className="ticket-facts">
      <div>
        <dt>{t("Ilmoittaja")}</dt>
        <dd>{resident.name}</dd>
      </div>
      <div>
        <dt>{t("Asunto")}</dt>
        <dd>{resident.apartmentNumber || "–"}</dd>
      </div>
    </dl>
  );
}

function Actions({ saving, error, label }: { saving: boolean; error: string; label: string }) {
  return (
    <>
      {error && <p className="send-error">{error}</p>}
      <div className="portal-ticket-actions">
        <button type="submit" className="portal-new" disabled={saving}>{saving ? t("Lähetetään…") : label}</button>
      </div>
    </>
  );
}

function ServiceForm({ resident, saving, error, submit }: FormProps) {
  const [target, setTarget] = useState(SERVICE_TARGETS[0]);
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [entry, setEntry] = useState(SERVICE_ENTRY[0]);
  const [pets, setPets] = useState(false);
  const [phone, setPhone] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const ownApartment = target === SERVICE_TARGETS[0];

  return (
    <form className="ticket-form portal-ticket-form" onSubmit={(event: FormEvent) => {
      event.preventDefault();
      void submit({ target, location: location.trim(), description: description.trim(), entry: ownApartment ? entry : "", pets: ownApartment && pets, phone: phone.trim() }, files);
    }}>
      <ReporterFacts resident={resident} />
      <Field label={t("Kohde")}>
        <select value={target} onChange={event => setTarget(event.target.value)}>
          {SERVICE_TARGETS.map(option => <option key={option} value={option}>{t(option)}</option>)}
        </select>
      </Field>
      <Field label={t("Tarkempi paikka (valinnainen)")}>
        <input value={location} onChange={event => setLocation(event.target.value)} maxLength={120} placeholder={t("Esim. keittiö, kylpyhuone tai B-rappu")} />
      </Field>
      <Field label={t("Vian kuvaus")}>
        <textarea value={description} onChange={event => setDescription(event.target.value)} rows={5} maxLength={3000} minLength={5} required
          placeholder={t("Kerro, mikä on rikki ja milloin vika alkoi.")} />
      </Field>
      {ownApartment && (
        <>
          <Field label={t("Saako huolto mennä asuntoon?")}>
            <select value={entry} onChange={event => setEntry(event.target.value)}>
              {SERVICE_ENTRY.map(option => <option key={option} value={option}>{t(option)}</option>)}
            </select>
          </Field>
          <Switch label={t("Asunnossa on lemmikki")} checked={pets} onChange={setPets} />
        </>
      )}
      <Field label={t("Puhelinnumero (valinnainen)")}>
        <input type="tel" value={phone} onChange={event => setPhone(event.target.value)} maxLength={40} />
      </Field>
      <PortalFilePicker files={files} onChange={setFiles} />
      <Actions saving={saving} error={error} label={t("Lähetä huoltotyötilaus")} />
    </form>
  );
}

function DisturbanceForm({ resident, saving, error, submit }: FormProps) {
  const [category, setCategory] = useState(DISTURBANCE_TYPES[0]);
  const [source, setSource] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [recurring, setRecurring] = useState(false);
  const [description, setDescription] = useState("");
  const [discussed, setDiscussed] = useState(false);
  const [nameAllowed, setNameAllowed] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  return (
    <form className="ticket-form portal-ticket-form" onSubmit={(event: FormEvent) => {
      event.preventDefault();
      void submit({ category, source: source.trim(), date, time: time.trim(), recurring, description: description.trim(), discussed, nameAllowed }, files);
    }}>
      <ReporterFacts resident={resident} />
      <Field label={t("Häiriön laji")}>
        <select value={category} onChange={event => setCategory(event.target.value)}>
          {DISTURBANCE_TYPES.map(option => <option key={option} value={option}>{t(option)}</option>)}
        </select>
      </Field>
      <Field label={t("Mistä häiriö tulee (valinnainen)")}>
        <input value={source} onChange={event => setSource(event.target.value)} maxLength={120} placeholder={t("Esim. asunto B 12 tai pihan grillikatos")} />
      </Field>
      <div className="portal-form-row">
        <Field label={t("Päivä")}>
          <input type="date" value={date} onChange={event => setDate(event.target.value)} required />
        </Field>
        <Field label={t("Kellonaika (valinnainen)")}>
          <input value={time} onChange={event => setTime(event.target.value)} maxLength={40} placeholder={t("Esim. 23–02")} />
        </Field>
      </div>
      <Switch label={t("Häiriö toistuu")} checked={recurring} onChange={setRecurring} />
      <Field label={t("Kuvaus")}>
        <textarea value={description} onChange={event => setDescription(event.target.value)} rows={5} maxLength={3000} minLength={5} required
          placeholder={t("Kerro, mitä tapahtui ja miten se häiritsee.")} />
      </Field>
      <Switch label={t("Olen puhunut asiasta häiritsijän kanssa")} checked={discussed} onChange={setDiscussed} />
      <Switch label={t("Nimeni saa kertoa häiritsijälle")} hint={t("Valintasi näkyy isännöitsijälle ilmoituksen tiedoissa.")} checked={nameAllowed} onChange={setNameAllowed} />
      <PortalFilePicker files={files} onChange={setFiles} />
      <Actions saving={saving} error={error} label={t("Lähetä häiriöilmoitus")} />
    </form>
  );
}

function TerminationForm({ resident, saving, error, submit }: FormProps) {
  const earliest = earliestTerminationDate();
  const [endDate, setEndDate] = useState(earliest);
  const [tenants, setTenants] = useState(resident.name);
  const [newAddress, setNewAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [checkError, setCheckError] = useState("");

  return (
    <form className="ticket-form portal-ticket-form" onSubmit={(event: FormEvent) => {
      event.preventDefault();
      if (!confirm) {
        setCheckError(t("Vahvista irtisanominen ennen lähetystä."));
        return;
      }
      setCheckError("");
      void submit({ endDate, tenants: tenants.trim(), newAddress: newAddress.trim(), phone: phone.trim(), note: note.trim(), confirm: true });
    }}>
      <ReporterFacts resident={resident} />
      <Field label={t("Vuokrasuhde päättyy")}>
        <input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} required />
      </Field>
      {endDate && endDate < earliest && (
        <p className="portal-form-warning">
          {t("Irtisanomisajan mukaan vuokrasuhde voi päättyä aikaisintaan {0}. Aiemmasta päivästä pitää sopia vuokranantajan kanssa.",
            new Date(`${earliest}T12:00:00`).toLocaleDateString("fi-FI"))}
        </p>
      )}
      <Field label={t("Kaikkien vuokralaisten nimet")}>
        <input value={tenants} onChange={event => setTenants(event.target.value)} maxLength={300} required />
      </Field>
      <Field label={t("Uusi osoite (valinnainen)")}>
        <input value={newAddress} onChange={event => setNewAddress(event.target.value)} maxLength={200} placeholder={t("Vakuuden palautusta ja yhteydenottoja varten")} />
      </Field>
      <Field label={t("Puhelinnumero (valinnainen)")}>
        <input type="tel" value={phone} onChange={event => setPhone(event.target.value)} maxLength={40} />
      </Field>
      <Field label={t("Lisätiedot (valinnainen)")}>
        <textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={2000} placeholder={t("Esim. avainten palautus tai asunnon esittely")} />
      </Field>
      <Switch label={t("Vahvistan irtisanovani vuokrasopimuksen")} checked={confirm} onChange={setConfirm} />
      {checkError && <p className="send-error">{checkError}</p>}
      <Actions saving={saving} error={error} label={t("Lähetä irtisanomisilmoitus")} />
    </form>
  );
}

function ApplicationForm({ resident, saving, error, submit }: FormProps) {
  const [sizes, setSizes] = useState<string[]>([]);
  const [area, setArea] = useState("");
  const [maxRent, setMaxRent] = useState("");
  const [moveDate, setMoveDate] = useState("");
  const [adults, setAdults] = useState("1");
  const [children, setChildren] = useState("0");
  const [pets, setPets] = useState(false);
  const [reason, setReason] = useState("");
  const [phone, setPhone] = useState("");
  const [checkError, setCheckError] = useState("");

  return (
    <form className="ticket-form portal-ticket-form" onSubmit={(event: FormEvent) => {
      event.preventDefault();
      if (sizes.length === 0) {
        setCheckError(t("Valitse vähintään yksi asuntotyyppi."));
        return;
      }
      setCheckError("");
      void submit({
        sizes, area: area.trim(), maxRent: maxRent ? Number(maxRent) : null, moveDate,
        adults: Number(adults), children: Number(children), pets, reason: reason.trim(), phone: phone.trim()
      });
    }}>
      <ReporterFacts resident={resident} />
      <fieldset className="portal-chips">
        <legend>{t("Haettava asunto")}</legend>
        {APARTMENT_SIZES.map(size => (
          <button
            key={size}
            type="button"
            className={sizes.includes(size) ? "active" : ""}
            aria-pressed={sizes.includes(size)}
            onClick={() => setSizes(sizes.includes(size) ? sizes.filter(item => item !== size) : APARTMENT_SIZES.filter(item => item === size || sizes.includes(item)))}
          >
            {t(size)}
          </button>
        ))}
      </fieldset>
      <Field label={t("Toivottu alue tai taloyhtiö (valinnainen)")}>
        <input value={area} onChange={event => setArea(event.target.value)} maxLength={200} />
      </Field>
      <div className="portal-form-row">
        <Field label={t("Vuokra enintään, €/kk (valinnainen)")}>
          <input type="number" min="0" step="10" value={maxRent} onChange={event => setMaxRent(event.target.value)} />
        </Field>
        <Field label={t("Toivottu muuttopäivä (valinnainen)")}>
          <input type="date" value={moveDate} onChange={event => setMoveDate(event.target.value)} />
        </Field>
      </div>
      <div className="portal-form-row">
        <Field label={t("Aikuisia")}>
          <input type="number" min="1" max="20" value={adults} onChange={event => setAdults(event.target.value)} required />
        </Field>
        <Field label={t("Lapsia")}>
          <input type="number" min="0" max="20" value={children} onChange={event => setChildren(event.target.value)} required />
        </Field>
      </div>
      <Switch label={t("Taloudessa on lemmikkejä")} checked={pets} onChange={setPets} />
      <Field label={t("Hakemuksen syy ja lisätiedot (valinnainen)")}>
        <textarea value={reason} onChange={event => setReason(event.target.value)} rows={4} maxLength={2000} />
      </Field>
      <Field label={t("Puhelinnumero (valinnainen)")}>
        <input type="tel" value={phone} onChange={event => setPhone(event.target.value)} maxLength={40} />
      </Field>
      {checkError && <p className="send-error">{checkError}</p>}
      <Actions saving={saving} error={error} label={t("Lähetä asuntohakemus")} />
    </form>
  );
}
