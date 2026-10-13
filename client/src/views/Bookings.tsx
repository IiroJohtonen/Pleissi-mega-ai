import { type FormEvent, useEffect, useState } from "react";
import { Dropdown } from "../components/common";
import { api, errorMessage, type ResidentAccount } from "../session";
import type { Company, Resident } from "../types";
import { locale, t } from "../i18n";

export type Booking = {
  id: string;
  starts_at: string;
  ends_at: string;
  // Henkilökunnan näkymän tiedot; asukasportaalissa näistä kerrotaan vain "mine".
  resident_id?: string | null;
  note?: string;
  created_by?: string;
  resident_name?: string | null;
  apartment_number?: string | null;
  mine?: boolean;
  // Viikoittaisen varauksen vuoroilla on yhteinen sarjatunniste.
  series_id?: string | null;
};

// Taloyhtiön asetukset: mitä vuorotyyppejä kuhunkin tilaan saa varata.
// weeklyWeeks = kuinka monelle viikolle viikoittainen vuoro varataan kerralla.
// singlePrice = yhden vuoron hinta, monthlyPrice = viikoittaisen vuoron hinta kuukaudessa (euroa).
type BookingRule = { single: boolean; weekly: boolean; weeklyWeeks: number; singlePrice: number; monthlyPrice: number };
export type BookingRules = Record<"sauna" | "laundry", BookingRule>;

export const DEFAULT_BOOKING_RULES: BookingRules = {
  sauna: { single: true, weekly: true, weeklyWeeks: 12, singlePrice: 0, monthlyPrice: 0 },
  laundry: { single: true, weekly: true, weeklyWeeks: 12, singlePrice: 0, monthlyPrice: 0 }
};

// Asetuksissa valittavat viikoittaisen vuoron kestot.
export const WEEKLY_DURATION_OPTIONS = [
  { weeks: 4, label: t("4 viikkoa (noin 1 kk)") },
  { weeks: 8, label: t("8 viikkoa (noin 2 kk)") },
  { weeks: 12, label: t("12 viikkoa (noin 3 kk)") },
  { weeks: 26, label: t("26 viikkoa (puoli vuotta)") }
];

// Asetuksen kesto, jos se on jokin valittavista; muuten oletus 12 viikkoa.
export function weeklyWeeksOf(rule: { weeklyWeeks?: number } | undefined) {
  return WEEKLY_DURATION_OPTIONS.some(option => option.weeks === rule?.weeklyWeeks) ? rule!.weeklyWeeks! : 12;
}

// Tilakohtaiset asetukset: varattavat tunnit ja yhden vuoron pituus tunteina.
const BOOKING_RESOURCES: Record<"sauna" | "laundry", { name: string; firstHour: number; lastHour: number; slotHours: number }> = {
  sauna: { name: t("Sauna"), firstHour: 15, lastHour: 22, slotHours: 1 },
  laundry: { name: t("Pyykkitupa"), firstHour: 7, lastHour: 21, slotHours: 1 }
};

function startOfWeek(date: Date) {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

// Viikkokalenteri yhteistilan vuoroille. Sama komponentti saunalle ja pyykkituvalle;
// erot (tunnit, vuoron pituus) tulevat BOOKING_RESOURCES-asetuksista.
export function BookingCalendar({
  resource,
  companyId,
  companies,
  onCompanyChange,
  portalResident,
  embedded = false
}: {
  // embedded = näytetään taloyhtiön tietueen sisällä, jolloin yhtiö on jo valittu.
  embedded?: boolean;
  resource: "sauna" | "laundry";
  companyId: string;
  companies: Company[];
  onCompanyChange: (companyId: string) => void;
  // Asukasportaali: asukas varaa vain itselleen oman yhtiönsä vuoroja eikä näe muiden nimiä.
  portalResident?: ResidentAccount;
}) {
  const portal = Boolean(portalResident);
  // Asukkaan varaus täyttyy hänen omilla tiedoillaan.
  const residentFacts = portalResident && (
    <dl className="ticket-facts">
      <div>
        <dt>{t("Varaaja")}</dt>
        <dd>{portalResident.name}</dd>
      </div>
      <div>
        <dt>{t("Asunto")}</dt>
        <dd>{portalResident.apartmentNumber}</dd>
      </div>
      <div>
        <dt>{t("Taloyhtiö")}</dt>
        <dd>{portalResident.companyName}</dd>
      </div>
      <div>
        <dt>{t("Sähköposti")}</dt>
        <dd>{portalResident.email || "–"}</dd>
      </div>
    </dl>
  );
  const config = BOOKING_RESOURCES[resource];
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [residents, setResidents] = useState<Resident[]>([]);
  const [loadError, setLoadError] = useState(false);
  // Avoin vuoro: joko vapaa aika (uusi varaus) tai olemassa oleva varaus.
  const [slot, setSlot] = useState<{ start: Date; booking: Booking | null } | null>(null);
  const [residentId, setResidentId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [repeat, setRepeat] = useState<"once" | "weekly">("once");
  // Suodattimet: näytettävä kellonaikaväli ja se, näytetäänkö vapaat, varatut vai kaikki vuorot.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fromHour, setFromHour] = useState(config.firstHour);
  const [toHour, setToHour] = useState(config.lastHour);
  const [show, setShow] = useState<"all" | "free" | "booked">("all");
  const calendarFiltered = fromHour !== config.firstHour || toHour !== config.lastHour || show !== "all";
  // Viikoittaisen varauksen tulos: montako vuoroa varattiin ja montako viikkoa ohitettiin.
  const [bookingNotice, setBookingNotice] = useState("");
  const [rules, setRules] = useState(DEFAULT_BOOKING_RULES[resource]);
  const bookingDisabled = !rules.single && !rules.weekly;

  useEffect(() => {
    api<BookingRules>(portal ? "/portal/booking-settings" : `/companies/${encodeURIComponent(companyId)}/booking-settings`)
      .then(all => setRules(all[resource]))
      .catch(() => setRules(DEFAULT_BOOKING_RULES[resource]));
  }, [companyId, resource, portal]);

  const days = Array.from({ length: 7 }, (_, index) =>
    new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + index));
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
  const hours: number[] = [];
  for (let hour = config.firstHour; hour + config.slotHours <= config.lastHour; hour += config.slotHours) hours.push(hour);
  const visibleHours = hours.filter(hour => hour >= fromHour && hour + config.slotHours <= toHour);
  const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}.00`;

  async function loadBookings() {
    try {
      const query = `resource=${resource}&from=${encodeURIComponent(weekStart.toISOString())}&to=${encodeURIComponent(weekEnd.toISOString())}`;
      setBookings(await api<Booking[]>(portal
        ? `/portal/bookings?${query}`
        : `/companies/${encodeURIComponent(companyId)}/bookings?${query}`));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }

  useEffect(() => {
    void loadBookings();
  }, [companyId, resource, weekStart.getTime()]);

  useEffect(() => {
    if (portal) return;
    api<Resident[]>(`/companies/${encodeURIComponent(companyId)}/residents`)
      .then(setResidents)
      .catch(() => setResidents([]));
  }, [companyId, portal]);

  function shiftWeek(weeks: number) {
    setWeekStart(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + weeks * 7));
  }

  function openSlot(start: Date, booking: Booking | null) {
    setSlot({ start, booking });
    setResidentId("");
    setNote("");
    setFormError("");
    // Oletuksena kertaluontoinen; jos se on kytketty pois, viikoittainen.
    setRepeat(rules.single ? "once" : "weekly");
  }

  const slotEnd = (start: Date) => new Date(start.getTime() + config.slotHours * 60 * 60 * 1000);
  const timeLabel = (date: Date) => date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const now = Date.now();
  const today = new Date().toDateString();

  async function handleBook(event: FormEvent) {
    event.preventDefault();
    if (!slot) return;
    setSaving(true);
    setFormError("");
    try {
      // Sama viikonpäivä ja kellonaika seuraavina viikkoina, paikallisessa ajassa.
      const repeats = repeat === "weekly"
        ? Array.from({ length: weeklyWeeksOf(rules) - 1 }, (_, index) => {
            const start = new Date(slot.start);
            start.setDate(start.getDate() + (index + 1) * 7);
            return { startsAt: start.toISOString(), endsAt: slotEnd(start).toISOString() };
          })
        : [];
      const result = await api<{ created: number; skipped: string[] }>(
        portal ? "/portal/bookings" : `/companies/${encodeURIComponent(companyId)}/bookings`,
        {
          method: "POST",
          body: JSON.stringify({
            resource,
            startsAt: slot.start.toISOString(),
            endsAt: slotEnd(slot.start).toISOString(),
            repeats,
            ...(portal ? {} : { residentId: residentId || undefined, note })
          })
        }
      );
      setBookingNotice(repeat === "weekly"
        ? t("Viikoittainen varaus tehty: {0} vuoroa varattu", result.created)
          + (result.skipped.length > 0
            ? t(", {0} viikkoa ohitettiin, koska vuoro oli jo varattu: ", result.skipped.length)
              + result.skipped.map(time => new Date(time).toLocaleDateString(locale, { day: "numeric", month: "numeric" })).join(", ") + "."
            : ".")
        : "");
      setSlot(null);
      await loadBookings();
    } catch (error) {
      setFormError(errorMessage(error, t("Varauksen tallennus epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(wholeSeries = false) {
    if (!slot?.booking) return;
    setSaving(true);
    setFormError("");
    try {
      await api(
        `${portal ? "/portal" : ""}/bookings/${encodeURIComponent(slot.booking.id)}${wholeSeries ? "?series=1" : ""}`,
        { method: "DELETE" }
      );
      setBookingNotice("");
      setSlot(null);
      await loadBookings();
    } catch (error) {
      setFormError(errorMessage(error, t("Varauksen poistaminen epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="content">
      {!portal && !embedded && <a className="back-link" href="#/companies">{t("← Taloyhtiöt")}</a>}

      {filtersOpen && (
        <div className="ticket-filters">
          {!portal && !embedded && (
            <Dropdown
              label={t("Taloyhtiö")}
              value={companyId}
              options={companies.map(company => ({ value: company.id, label: company.name }))}
              onChange={onCompanyChange}
            />
          )}
          <Dropdown
            label={t("Kellonaika alkaen")}
            value={String(fromHour)}
            options={hours.filter(hour => hour < toHour).map(hour => ({ value: String(hour), label: hourLabel(hour) }))}
            onChange={value => setFromHour(Number(value))}
          />
          <Dropdown
            label={t("Kellonaika asti")}
            value={String(toHour)}
            options={hours.map(hour => hour + config.slotHours).filter(hour => hour > fromHour)
              .map(hour => ({ value: String(hour), label: hourLabel(hour) }))}
            onChange={value => setToHour(Number(value))}
          />
          <Dropdown
            label={t("Näytä")}
            value={show}
            options={[
              { value: "all", label: t("Kaikki vuorot") },
              { value: "free", label: t("Vain vapaat") },
              { value: "booked", label: t("Vain varatut") }
            ]}
            onChange={value => setShow(value as typeof show)}
          />
          {calendarFiltered && (
            <button className="clear-filters" onClick={() => {
              setFromHour(config.firstHour);
              setToHour(config.lastHour);
              setShow("all");
            }}>{t("Tyhjennä suodattimet")}</button>
          )}
        </div>
      )}

      <div className="calendar-toolbar">
        <button
          className={`filter-toggle ${filtersOpen || calendarFiltered ? "active" : ""}`}
          onClick={() => setFiltersOpen(!filtersOpen)}
          title={filtersOpen ? t("Piilota suodattimet") : t("Näytä suodattimet")}
          aria-label={filtersOpen ? t("Piilota suodattimet") : t("Näytä suodattimet")}
          aria-expanded={filtersOpen}
        >
          <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.200"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 5h18l-7 8.500V19l-4 2v-7.500z" />
            </svg>
          {calendarFiltered && <i />}
        </button>
        {!portal && !embedded && <strong className="calendar-company">{companies.find(company => company.id === companyId)?.name}</strong>}
        <div className="calendar-week">
          <button onClick={() => shiftWeek(-1)} aria-label={t("Edellinen viikko")}>←</button>
          <strong>
            {days[0].toLocaleDateString(locale, { day: "numeric", month: "numeric" })}–
            {days[6].toLocaleDateString(locale, { day: "numeric", month: "numeric", year: "numeric" })}
          </strong>
          <button onClick={() => shiftWeek(1)} aria-label={t("Seuraava viikko")}>→</button>
          <button className="calendar-today" onClick={() => setWeekStart(startOfWeek(new Date()))}>{t("Tämä viikko")}</button>
        </div>
        <span className="calendar-count">
          {portal
            ? t("{0} omaa varausta tällä viikolla", bookings.filter(item => item.mine).length)
            : t("{0} varausta tällä viikolla", bookings.length)}
        </span>
      </div>

      {loadError && <div className="empty">{t("Varausten lataus epäonnistui.")}</div>}
      {bookingNotice && <p className="ai-reason created booking-notice">{bookingNotice}</p>}
      {bookingDisabled && (
        <p className="ai-reason missing booking-notice">
          {t("{0}vuorojen varaaminen on kytketty pois tämän taloyhtiön asetuksista.", config.name)}
        </p>
      )}

      <div className="calendar">
        <div className="calendar-corner" />
        {days.map(day => (
          <div key={day.getTime()} className={`calendar-day ${day.toDateString() === today ? "today" : ""}`}>
            <strong>{day.toLocaleDateString(locale, { weekday: "short" })}</strong>
            <span>{day.toLocaleDateString(locale, { day: "numeric", month: "numeric" })}</span>
          </div>
        ))}
        {visibleHours.map(hour => (
          <div className="calendar-row" key={hour}>
            <div className="calendar-time">
              {String(hour).padStart(2, "0")}–{String(hour + config.slotHours).padStart(2, "0")}
            </div>
            {days.map(day => {
              const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
              const end = slotEnd(start);
              const booking = bookings.find(item =>
                Date.parse(item.starts_at) < end.getTime() && Date.parse(item.ends_at) > start.getTime()) ?? null;
              const past = end.getTime() <= now;
              // Suodatettu pois: ruutu jää tyhjäksi, jotta viikon rakenne säilyy.
              if ((show === "free" && booking) || (show === "booked" && !booking)) {
                return <div key={start.getTime()} className="calendar-slot hidden-slot" />;
              }
              return booking ? (
                <button
                  key={start.getTime()}
                  className={`calendar-slot booked ${past ? "past" : ""} ${portal && !booking.mine ? "other" : ""}`}
                  onClick={() => openSlot(start, booking)}
                  // Asukas voi avata vain oman varauksensa.
                  disabled={portal && !booking.mine}
                  title={portal && !booking.mine ? t("Vuoro on varattu") : t("Avaa varaus")}
                >
                  <strong>
                    {portal ? (booking.mine ? t("Oma varaus") : t("Varattu")) : booking.resident_name || booking.note || t("Varattu")}
                  </strong>
                  {!portal && booking.apartment_number && <span>{booking.apartment_number}</span>}
                </button>
              ) : (
                <button
                  key={start.getTime()}
                  className="calendar-slot free"
                  onClick={() => openSlot(start, null)}
                  disabled={past || bookingDisabled}
                  title={past ? t("Aika on jo mennyt") : bookingDisabled ? t("Varaaminen ei ole käytössä") : t("Varaa vuoro")}
                >
                  {past || bookingDisabled ? "" : t("+ Varaa")}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {slot && (
        <div className="overlay" onClick={() => setSlot(null)}>
          <aside className="drawer form-drawer resident-drawer" onClick={event => event.stopPropagation()}>
            <button className="close" onClick={() => setSlot(null)}>×</button>
            <h2>{slot.booking ? t("Varaus") : t("Uusi varaus")}</h2>
            <p className="muted">
              {config.name} · {portalResident?.companyName ?? companies.find(company => company.id === companyId)?.name ?? ""}{" "}·{" "}
              {slot.start.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "numeric", year: "numeric" })}{" "}
              {t("klo")}{" "}{timeLabel(slot.start)}–{timeLabel(slotEnd(slot.start))}
            </p>

            {slot.booking && portal ? (
              <>
                <p className="topic-text">{t("Tämä on oma varauksesi.")}</p>
                {residentFacts}
                {formError && <p className="send-error">{formError}</p>}
                <div className="drawer-actions compact-actions">
                  <button type="button" onClick={() => setSlot(null)}>{t("Sulje")}</button>
                  {slot.booking.series_id && (
                    <button className="danger" type="button" onClick={() => handleDelete(true)} disabled={saving}>
                      {t("Peru tämä ja tulevat viikot")}
                    </button>
                  )}
                  <button className="danger" type="button" onClick={() => handleDelete()} disabled={saving}>
                    {saving ? t("Perutaan…") : slot.booking.series_id ? t("Peru vain tämä vuoro") : t("Peru varaus")}
                  </button>
                </div>
              </>
            ) : slot.booking ? (
              <>
                <dl className="ticket-facts">
                  <div>
                    <dt>{t("Varaaja")}</dt>
                    <dd>{slot.booking.resident_name || "–"}</dd>
                  </div>
                  <div>
                    <dt>{t("Asunto")}</dt>
                    <dd>{slot.booking.apartment_number || "–"}</dd>
                  </div>
                  <div>
                    <dt>{t("Lisätieto")}</dt>
                    <dd>{slot.booking.note || "–"}</dd>
                  </div>
                  <div>
                    <dt>{t("Varauksen teki")}</dt>
                    <dd>{slot.booking.created_by}</dd>
                  </div>
                </dl>
                {formError && <p className="send-error">{formError}</p>}
                <div className="drawer-actions compact-actions">
                  <button type="button" onClick={() => setSlot(null)}>{t("Sulje")}</button>
                  {slot.booking.series_id && (
                    <button className="danger" type="button" onClick={() => handleDelete(true)} disabled={saving}>
                      {t("Poista tämä ja tulevat viikot")}
                    </button>
                  )}
                  <button className="danger" type="button" onClick={() => handleDelete()} disabled={saving}>
                    {saving ? t("Poistetaan…") : slot.booking.series_id ? t("Poista vain tämä vuoro") : t("Poista varaus")}
                  </button>
                </div>
              </>
            ) : (
              <form className="ticket-form" onSubmit={handleBook}>
                {portal && (
                  <>
                    <p className="topic-text">{t("Varaus tehdään alla olevilla tiedoillasi. Vahvista vuoro.")}</p>
                    {residentFacts}
                  </>
                )}
                {!portal && (
                <>
                <label>
                  <span>{t("Asukas")}</span>
                  <select value={residentId} onChange={event => setResidentId(event.target.value)}>
                    <option value="">{t("Ei asukasta (esim. huolto tai yleinen varaus)")}</option>
                    {residents.map(resident => (
                      <option key={resident.id} value={resident.id}>
                        {[resident.name, resident.apartment_number].filter(Boolean).join(" · ")}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>{t("Lisätieto")}</span>
                  <input value={note} onChange={event => setNote(event.target.value)} placeholder={t("Valinnainen, esim. Huoltokatko")} />
                </label>
                </>
                )}

                <fieldset className="repeat-choice">
                  <legend>{t("Onko varaus kertaluontoinen vai viikoittainen?")}</legend>
                  <label>
                    <input type="radio" name="repeat" checked={repeat === "once"} onChange={() => setRepeat("once")} disabled={!rules.single} />
                    <span>
                      <strong>{t("Kertaluontoinen")}</strong>
                      <small>{rules.single ? t("Vain tämä vuoro.") : t("Ei käytössä tässä taloyhtiössä.")}</small>
                    </span>
                  </label>
                  <label>
                    <input type="radio" name="repeat" checked={repeat === "weekly"} onChange={() => setRepeat("weekly")} disabled={!rules.weekly} />
                    <span>
                      <strong>{t("Viikoittainen")}</strong>
                      <small>
                        {rules.weekly
                          ? t("Sama vuoro joka viikko, seuraavat {0} viikkoa.", weeklyWeeksOf(rules))
                          : t("Ei käytössä tässä taloyhtiössä.")}
                      </small>
                    </span>
                  </label>
                </fieldset>

                {formError && <p className="send-error">{formError}</p>}

                <div className="drawer-actions compact-actions">
                  <button type="button" onClick={() => setSlot(null)}>{t("Peruuta")}</button>
                  <button className="primary" type="submit" disabled={saving || (!portal && !residentId && !note.trim())}>
                    {saving ? t("Varataan…") : t("Varaa vuoro")}
                  </button>
                </div>
              </form>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
