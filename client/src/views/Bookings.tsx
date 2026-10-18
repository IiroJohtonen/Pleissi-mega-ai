import { type FormEvent, useEffect, useRef, useState } from "react";
import { Dropdown, useNarrowScreen } from "../components/common";
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
  // Vuoron jono: jonottajien määrä sekä asukasportaalissa oma jonopaikka ja sija.
  queue_count?: number;
  queue_entry_id?: string | null;
  queue_position?: number | null;
};

// Jonopaikka varatulle vuorolle. Asukkaalla omat, henkilökunnalla kaikki jonottajat sijoineen.
export type QueueEntry = {
  id: string;
  resource: "sauna" | "laundry";
  starts_at: string;
  ends_at: string;
  status?: "waiting" | "granted";
  position: number | null;
  created_at: string;
  resident_id?: string | null;
  resident_name?: string | null;
  resident_email?: string | null;
  apartment_number?: string | null;
  current_holder?: string | null;
};

// ISO-viikkonumero (maanantaista alkava viikko).
function weekNumber(date: Date) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

// Jonoon voi liittyä viimeistään kolme tuntia ennen vuoron alkua (sama raja tarkistetaan palvelimella).
export const QUEUE_JOIN_CUTOFF_MS = 3 * 60 * 60 * 1000;

// Taloyhtiön asetukset: mitä vuorotyyppejä kuhunkin tilaan saa varata.
// weeklyWeeks = kuinka monelle viikolle viikoittainen vuoro varataan kerralla.
// singlePrice = yhden vuoron hinta, monthlyPrice = viikoittaisen vuoron hinta kuukaudessa (euroa).
// queueEnabled = voiko varatun vuoron jonoon liittyä, queueSize = jonopaikkoja yhdellä vuorolla.
// firstHour–lastHour = varattava aikaikkuna (esim. 8–22), asetetaan taloyhtiön tiedoissa.
type BookingRule = {
  single: boolean; weekly: boolean; weeklyWeeks: number; singlePrice: number; monthlyPrice: number;
  queueEnabled: boolean; queueSize: number; firstHour: number; lastHour: number;
};
export type BookingRules = Record<"sauna" | "laundry", BookingRule>;

export const DEFAULT_BOOKING_RULES: BookingRules = {
  sauna: { single: true, weekly: true, weeklyWeeks: 12, singlePrice: 0, monthlyPrice: 0, queueEnabled: false, queueSize: 3, firstHour: 15, lastHour: 22 },
  laundry: { single: true, weekly: true, weeklyWeeks: 12, singlePrice: 0, monthlyPrice: 0, queueEnabled: false, queueSize: 3, firstHour: 7, lastHour: 21 }
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

// Tilakohtaiset asetukset: yhden vuoron pituus tunteina. Varattavat tunnit tulevat taloyhtiön asetuksista.
const BOOKING_RESOURCES: Record<"sauna" | "laundry", { name: string; slotHours: number }> = {
  sauna: { name: t("Sauna"), slotHours: 1 },
  laundry: { name: t("Pyykkitupa"), slotHours: 1 }
};

// Vuoron tunniste osoitteessa (#/sauna/2026-10-20T15): paikallinen päivä ja alkutunti.
function slotKey(start: Date) {
  return `${start.toLocaleDateString("sv-SE")}T${String(start.getHours()).padStart(2, "0")}`;
}
function parseSlotKey(key: string | null | undefined): Date | null {
  const match = key?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4])) : null;
}

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
  embedded = false,
  routeSlot = null,
  onOpenSlot
}: {
  // Annettuna avattu vuoro on osoitteessa (routeSlot) ja näytetään omana sivunaan kalenterin tilalla.
  routeSlot?: string | null;
  onOpenSlot?: (slotKey: string | null) => void;
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
  // Osoitteesta avattu vuoro aloittaa kalenterin vuoron viikolta.
  const [weekStart, setWeekStart] = useState(() => startOfWeek(parseSlotKey(onOpenSlot ? routeSlot : null) ?? new Date()));
  const currentWeek = useRef(weekStart.getTime());
  currentWeek.current = weekStart.getTime();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [residents, setResidents] = useState<Resident[]>([]);
  const [loadError, setLoadError] = useState(false);
  // Avoin vuoro: joko vapaa aika (uusi varaus) tai olemassa oleva varaus. Osoitteen ohjaamana vuoro luetaan
  // osoitteesta ja sen varaus ladatuista varauksista.
  const [localSlot, setLocalSlot] = useState<{ start: Date; booking: Booking | null } | null>(null);
  const routed = Boolean(onOpenSlot);
  const routeStart = routed ? parseSlotKey(routeSlot) : null;
  const [residentId, setResidentId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [repeat, setRepeat] = useState<"once" | "weekly">("once");
  // Suodattimet: näytettävä kellonaikaväli ja se, näytetäänkö vapaat, varatut vai kaikki vuorot.
  const [fromHour, setFromHour] = useState(DEFAULT_BOOKING_RULES[resource].firstHour);
  const [toHour, setToHour] = useState(DEFAULT_BOOKING_RULES[resource].lastHour);
  const [show, setShow] = useState<"all" | "free" | "booked">("all");
  // Viikoittaisen varauksen tulos: montako vuoroa varattiin ja montako viikkoa ohitettiin.
  const [bookingNotice, setBookingNotice] = useState("");
  const [rules, setRules] = useState(DEFAULT_BOOKING_RULES[resource]);
  const calendarFiltered = fromHour !== rules.firstHour || toHour !== rules.lastHour || show !== "all";
  const bookingDisabled = !rules.single && !rules.weekly;
  // Asukkaan omat jonopaikat tämän tilan vuoroihin.
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([]);
  // Puhelimella asukas näkee yhden päivän kerrallaan isoina riveinä.
  const narrow = useNarrowScreen();
  const dayView = portal && narrow;
  const [dayIndex, setDayIndex] = useState(() => (new Date().getDay() + 6) % 7);

  useEffect(() => {
    api<BookingRules>(portal ? "/portal/booking-settings" : `/companies/${encodeURIComponent(companyId)}/booking-settings`)
      .then(all => {
        // Vanha palvelin ei palauta aikaikkunaa; silloin käytetään tilan oletusta.
        const rule = { ...DEFAULT_BOOKING_RULES[resource], ...all[resource] };
        setRules(rule);
        setFromHour(rule.firstHour);
        setToHour(rule.lastHour);
      })
      .catch(() => setRules(DEFAULT_BOOKING_RULES[resource]));
  }, [companyId, resource, portal]);

  const days = Array.from({ length: 7 }, (_, index) =>
    new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + index));
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
  const hours: number[] = [];
  for (let hour = rules.firstHour; hour + config.slotHours <= rules.lastHour; hour += config.slotHours) hours.push(hour);
  const visibleHours = hours.filter(hour => hour >= fromHour && hour + config.slotHours <= toHour);
  const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}.00`;

  async function loadBookings() {
    const week = weekStart.getTime();
    try {
      const query = `resource=${resource}&from=${encodeURIComponent(weekStart.toISOString())}&to=${encodeURIComponent(weekEnd.toISOString())}`;
      const loaded = await api<Booking[]>(portal
        ? `/portal/bookings?${query}`
        : `/companies/${encodeURIComponent(companyId)}/bookings?${query}`);
      // Viikkoa vaihdettaessa vanhan viikon myöhässä saapuva vastaus ohitetaan.
      if (week !== currentWeek.current) return;
      setBookings(loaded);
      setLoadedWeek(week);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }

  async function loadQueue() {
    if (!portal) return;
    try {
      setQueueEntries(await api<QueueEntry[]>(`/portal/booking-queue?resource=${resource}`));
    } catch {
      setQueueEntries([]);
    }
  }

  useEffect(() => {
    void loadBookings();
  }, [companyId, resource, weekStart.getTime()]);

  useEffect(() => {
    void loadQueue();
  }, [companyId, resource, portal]);

  useEffect(() => {
    if (portal) return;
    api<Resident[]>(`/companies/${encodeURIComponent(companyId)}/residents`)
      .then(setResidents)
      .catch(() => setResidents([]));
  }, [companyId, portal]);

  // Osoitteesta avattu vuoro: kalenteri siirtyy vuoron viikolle, jotta sen varaus ladataan.
  const [loadedWeek, setLoadedWeek] = useState<number | null>(null);
  useEffect(() => {
    if (routeStart && startOfWeek(routeStart).getTime() !== weekStart.getTime()) setWeekStart(startOfWeek(routeStart));
  }, [routeSlot]);
  const routeBooking = routeStart
    ? bookings.find(item => Date.parse(item.starts_at) < routeStart.getTime() + config.slotHours * 3_600_000
      && Date.parse(item.ends_at) > routeStart.getTime()) ?? null
    : null;
  const slot = routed ? (routeStart ? { start: routeStart, booking: routeBooking } : null) : localSlot;
  const slotLoading = Boolean(routeStart) && loadedWeek !== startOfWeek(routeStart!).getTime();
  function setSlot(next: { start: Date; booking: Booking | null } | null) {
    if (onOpenSlot) onOpenSlot(next ? slotKey(next.start) : null);
    else setLocalSlot(next);
  }

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

  // Asukas liittyy varatun vuoron jonoon. Jos varaaja peruu vuoron, se siirtyy jonon ensimmäiselle.
  async function joinQueue() {
    if (!slot) return;
    setSaving(true);
    setFormError("");
    try {
      const joined = await api<{ position: number }>("/portal/booking-queue", {
        method: "POST",
        body: JSON.stringify({ resource, startsAt: slot.start.toISOString(), endsAt: slotEnd(slot.start).toISOString() })
      });
      setBookingNotice(t("Liityit jonoon sijalle {0}. Saat sähköpostin, jos vuoro siirtyy sinulle.", joined.position));
      setSlot(null);
      await Promise.all([loadBookings(), loadQueue()]);
    } catch (error) {
      setFormError(errorMessage(error, t("Jonoon liittyminen epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function leaveQueue(entryId: string) {
    setSaving(true);
    setFormError("");
    try {
      await api(`/portal/booking-queue/${encodeURIComponent(entryId)}`, { method: "DELETE" });
      setBookingNotice("");
      setSlot(null);
      await Promise.all([loadBookings(), loadQueue()]);
    } catch (error) {
      setFormError(errorMessage(error, t("Jonosta poistuminen epäonnistui.")));
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
      await Promise.all([loadBookings(), loadQueue()]);
    } catch (error) {
      setFormError(errorMessage(error, t("Varauksen poistaminen epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  // Yhden vuoron tila: varaus, voiko sen avata ja mitä siinä lukee.
  function cellAt(day: Date, hour: number) {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
    const end = slotEnd(start);
    const booking = bookings.find(item =>
      Date.parse(item.starts_at) < end.getTime() && Date.parse(item.ends_at) > start.getTime()) ?? null;
    const past = end.getTime() <= now;
    const hidden = (show === "free" && Boolean(booking)) || (show === "booked" && !booking);
    // Toisen varaaman vuoron jonoon voi liittyä, jos jono on käytössä, siinä on tilaa ja vuoron
    // alkuun on vähintään kolme tuntia. Oman jonopaikan voi avata aina.
    const queued = portal && Boolean(booking?.queue_entry_id);
    const queueFull = Boolean(booking) && (booking?.queue_count ?? 0) >= rules.queueSize;
    const queueClosed = start.getTime() - now < QUEUE_JOIN_CUTOFF_MS;
    const canQueue = portal && Boolean(booking) && !booking?.mine && !past && rules.queueEnabled && !queueFull && !queueClosed;
    let state = "free";
    let label = t("Vapaa");
    let action = t("Varaa");
    let title = t("Varaa vuoro");
    if (booking) {
      state = booking.mine ? "mine" : "other";
      label = booking.mine ? t("Oma varaus")
        : queued ? t("Jonossa, sija {0}", booking.queue_position ?? "–")
        : portal && rules.queueEnabled && !past && queueFull ? t("Jono täynnä")
        : t("Varattu");
      action = booking.mine || queued ? t("Avaa") : canQueue ? t("Liity jonoon") : "";
      title = portal && !booking.mine
        ? (queued ? t("Olet tämän vuoron jonossa.")
          : canQueue ? t("Vuoro on varattu. Voit liittyä jonoon.")
          : rules.queueEnabled && !past && queueFull ? t("Vuoro on varattu, ja sen jono on täynnä.")
          : rules.queueEnabled && !past && queueClosed ? t("Vuoro on varattu. Jonoon voi liittyä viimeistään kolme tuntia ennen vuoron alkua.")
          : t("Vuoro on varattu"))
        : t("Avaa varaus");
      if (queued) state = "requested";
    } else if (past || bookingDisabled) {
      state = "unavailable";
      label = past ? t("Mennyt") : t("Ei varattavissa");
      action = "";
      title = past ? t("Aika on jo mennyt") : t("Varaaminen ei ole käytössä");
    }
    if (past) state += " past";
    const clickable = booking ? (!portal || booking.mine || canQueue || queued) : !past && !bookingDisabled;
    return { start, booking, past, hidden, clickable: Boolean(clickable), state, label, action, title };
  }

  // Toimiston näkymä varatusta vuorosta: vuoron jonottajat ja asukkaan lisääminen jonoon.
  const [slotQueue, setSlotQueue] = useState<QueueEntry[]>([]);
  const [queueResidentId, setQueueResidentId] = useState("");
  const openBookingStart = !portal && slot?.booking ? slot.start.getTime() : null;
  async function loadSlotQueue() {
    if (openBookingStart === null) return setSlotQueue([]);
    try {
      const all = await api<QueueEntry[]>(`/companies/${encodeURIComponent(companyId)}/booking-queue?resource=${resource}`);
      setSlotQueue(all.filter(entry => Date.parse(entry.starts_at) === openBookingStart));
    } catch {
      setSlotQueue([]);
    }
  }
  useEffect(() => {
    setQueueResidentId("");
    void loadSlotQueue();
  }, [openBookingStart, companyId]);

  async function addToQueue() {
    if (!slot || !queueResidentId) return;
    setSaving(true);
    setFormError("");
    try {
      const added = await api<{ position: number }>(`/companies/${encodeURIComponent(companyId)}/booking-queue`, {
        method: "POST",
        body: JSON.stringify({
          resource, residentId: queueResidentId, startsAt: slot.start.toISOString(), endsAt: slotEnd(slot.start).toISOString()
        })
      });
      setBookingNotice(t("Asukas lisättiin jonoon sijalle {0}.", added.position));
      setQueueResidentId("");
      await Promise.all([loadSlotQueue(), loadBookings()]);
    } catch (error) {
      setFormError(errorMessage(error, t("Jonoon lisääminen epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function removeFromQueue(entryId: string) {
    setSaving(true);
    setFormError("");
    try {
      await api(`/booking-queue/${encodeURIComponent(entryId)}`, { method: "DELETE" });
      await Promise.all([loadSlotQueue(), loadBookings()]);
    } catch (error) {
      setFormError(errorMessage(error, t("Jonosta poistaminen epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  // Viikon yhteenveto: tulevat vapaat vuorot ja jonottajat näkyvillä tunneilla.
  const weekStats = { free: 0, queued: 0 };
  for (const day of days) {
    for (const hour of visibleHours) {
      const cell = cellAt(day, hour);
      if (!cell.booking && !cell.past && !bookingDisabled) weekStats.free++;
      weekStats.queued += cell.booking?.queue_count ?? 0;
    }
  }

  // Vuoron tiedot: toimistossa oma sivunsa (osoite #/sauna/<vuoro>), asukasportaalissa sivulta avautuva paneeli.
  const Frame = routed ? "section" : "div";
  const slotView = slot ? (
        <Frame className={routed ? "record-page booking-record" : "overlay"}>
          <aside className="drawer form-drawer resident-drawer">
            <button type="button" className="drawer-back" onClick={() => setSlot(null)}>{routed ? t("← Kalenteriin") : t("← Takaisin")}</button>
            <button className="close" onClick={() => setSlot(null)}>×</button>
            <h2>{slot.booking ? (portal && !slot.booking.mine ? t("Varattu vuoro") : t("Varaus")) : t("Uusi varaus")}</h2>
            <p className="muted">
              {config.name} · {portalResident?.companyName ?? companies.find(company => company.id === companyId)?.name ?? ""}{" "}·{" "}
              {slot.start.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "numeric", year: "numeric" })}{" "}
              {t("klo")}{" "}{timeLabel(slot.start)}–{timeLabel(slotEnd(slot.start))}
            </p>

            {slot.booking && portal && !slot.booking.mine ? (() => {
              const entryId = slot.booking.queue_entry_id;
              return entryId ? (
                <>
                  <p className="topic-text">
                    {t("Olet tämän vuoron jonossa sijalla {0}. Jos varaaja peruu vuoron, se siirtyy jonon ensimmäiselle, ja saat siitä sähköpostin.", slot.booking.queue_position ?? "–")}
                  </p>
                  {formError && <p className="send-error">{formError}</p>}
                  <div className="drawer-actions compact-actions">
                    <button type="button" onClick={() => setSlot(null)}>{t("Sulje")}</button>
                    <button className="danger" type="button" onClick={() => void leaveQueue(entryId)} disabled={saving}>
                      {saving ? t("Poistutaan…") : t("Poistu jonosta")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="topic-text">
                    {t("Vuoro on jo varattu. Voit liittyä jonoon: jos varaaja peruu vuoron, se siirtyy jonon ensimmäiselle, ja saat siitä sähköpostin.")}
                  </p>
                  <p className="muted">
                    {t("Jonossa nyt {0} / {1}.", slot.booking.queue_count ?? 0, rules.queueSize)}
                  </p>
                  {residentFacts}
                  {formError && <p className="send-error">{formError}</p>}
                  <div className="drawer-actions compact-actions">
                    <button type="button" onClick={() => setSlot(null)}>{t("Peruuta")}</button>
                    <button className="primary" type="button" onClick={() => void joinQueue()} disabled={saving}>
                      {saving ? t("Liitytään…") : t("Liity jonoon")}
                    </button>
                  </div>
                </>
              );
            })() : slot.booking && portal ? (
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
                {/* Vuoron jono: jos varaaja peruu, vuoro siirtyy jonon ensimmäiselle. Toimisto voi lisätä asukkaan jonoon. */}
                <section className="booking-slot-queue">
                  <h3>{t("Jono")}{" "}<b>{slotQueue.length} / {rules.queueSize}</b></h3>
                  {slotQueue.length === 0 ? <p className="muted">{t("Vuoron jonossa ei ole ketään.")}</p> : (
                    <ol>
                      {slotQueue.map(entry => (
                        <li key={entry.id}>
                          <span>{[entry.resident_name, entry.apartment_number].filter(Boolean).join(" · ") || t("Tuntematon asukas")}</span>
                          <button type="button" className="secondary" onClick={() => void removeFromQueue(entry.id)} disabled={saving}>
                            {t("Poista jonosta")}
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                  {slotEnd(slot.start).getTime() > now && slotQueue.length < rules.queueSize && (
                    <div className="booking-queue-add">
                      <select value={queueResidentId} onChange={event => setQueueResidentId(event.target.value)} aria-label={t("Asukas jonoon")}>
                        <option value="">{t("Valitse asukas jonoon")}</option>
                        {residents
                          .filter(resident => resident.id !== slot.booking?.resident_id && !slotQueue.some(entry => entry.resident_id === resident.id))
                          .map(resident => (
                            <option key={resident.id} value={resident.id}>
                              {[resident.name, resident.apartment_number].filter(Boolean).join(" · ")}
                            </option>
                          ))}
                      </select>
                      <button type="button" className="primary" onClick={() => void addToQueue()} disabled={saving || !queueResidentId}>
                        {t("Lisää jonoon")}
                      </button>
                    </div>
                  )}
                </section>
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
        </Frame>
  ) : null;

  if (routed && routeStart) {
    return (
      <section className={`content booking-page booking-${resource}`}>
        {slotLoading ? <div className="empty">{t("Ladataan…")}</div> : slotView}
      </section>
    );
  }

  return (
    <section className={`content booking-page booking-${resource}`}>
      {!portal && !embedded && <a className="back-link" href="#/companies">{t("← Taloyhtiöt")}</a>}

      {/* Viikkonavigaatio ja suodattimet ovat aina näkyvissä yhdessä palkissa. */}
      <div className="booking-toolbar">
        <div className="booking-week" role="group" aria-label={t("Viikko")}>
          <button type="button" onClick={() => shiftWeek(-1)} aria-label={t("Edellinen viikko")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.400" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
          </button>
          <strong>
            <small>{t("Viikko {0}", weekNumber(days[0]))}</small>
            {days[0].toLocaleDateString(locale, { day: "numeric", month: "numeric" })}–{days[6].toLocaleDateString(locale, { day: "numeric", month: "numeric", year: "numeric" })}
          </strong>
          <button type="button" onClick={() => shiftWeek(1)} aria-label={t("Seuraava viikko")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.400" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </button>
          <button type="button" className="booking-today" onClick={() => setWeekStart(startOfWeek(new Date()))}>{t("Tämä viikko")}</button>
        </div>

        <div className="booking-filters">
          {!portal && !embedded && (
            <Dropdown
              label={t("Taloyhtiö")}
              value={companyId}
              options={companies.map(company => ({ value: company.id, label: company.name }))}
              onChange={onCompanyChange}
            />
          )}
          <Dropdown
            label={t("Alkaen")}
            value={String(fromHour)}
            options={hours.filter(hour => hour < toHour).map(hour => ({ value: String(hour), label: hourLabel(hour) }))}
            onChange={value => setFromHour(Number(value))}
          />
          <Dropdown
            label={t("Asti")}
            value={String(toHour)}
            options={hours.map(hour => hour + config.slotHours).filter(hour => hour > fromHour)
              .map(hour => ({ value: String(hour), label: hourLabel(hour) }))}
            onChange={value => setToHour(Number(value))}
          />
          <div className="booking-show">
            <span className="dropdown-label">{t("Näytä")}</span>
            <div className="booking-segmented" role="group" aria-label={t("Näytä")}>
              {([["all", t("Kaikki")], ["free", t("Vapaat")], ["booked", t("Varatut")]] as const).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={show === value} className={show === value ? "active" : ""} onClick={() => setShow(value)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {calendarFiltered && (
            <button type="button" className="clear-filters" onClick={() => {
              setFromHour(rules.firstHour);
              setToHour(rules.lastHour);
              setShow("all");
            }}>{t("Tyhjennä suodattimet")}</button>
          )}
        </div>
      </div>

      <div className="booking-stats" aria-live="polite">
        {portal ? (
          <span className="booking-stat booked"><b>{bookings.filter(item => item.mine).length}</b>{t("omaa varausta tällä viikolla")}</span>
        ) : (
          <>
            <span className="booking-stat booked"><b>{bookings.length}</b>{t("varausta")}</span>
            <span className="booking-stat free"><b>{weekStats.free}</b>{t("vapaata vuoroa jäljellä")}</span>
            {weekStats.queued > 0 && <span className="booking-stat queued"><b>{weekStats.queued}</b>{t("jonossa")}</span>}
          </>
        )}
      </div>

      {loadError && <div className="empty">{t("Varausten lataus epäonnistui.")}</div>}
      {bookingNotice && <p className="ai-reason created booking-notice">{bookingNotice}</p>}
      {bookingDisabled && (
        <p className="ai-reason missing booking-notice">
          {t("{0}vuorojen varaaminen on kytketty pois tämän taloyhtiön asetuksista.", config.name)}
        </p>
      )}

      {portal && rules.queueEnabled && (
        <p className="muted booking-queue-hint">
          {t("Varatun vuoron päältä voit liittyä jonoon valitsemalla vuoron ja Liity jonoon. Jos varaaja peruu vuoron, se siirtyy jonon ensimmäiselle, ja saat siitä sähköpostin. Jonoon voi liittyä viimeistään kolme tuntia ennen vuoron alkua, ja yhden vuoron jonossa on enintään {0} paikkaa.", rules.queueSize)}
        </p>
      )}

      {dayView ? (
        <>
          <div className="calendar-days" role="tablist" aria-label={t("Viikonpäivä")}>
            {days.map((day, index) => (
              <button
                key={day.getTime()}
                role="tab"
                aria-selected={index === dayIndex}
                className={`${index === dayIndex ? "active" : ""} ${day.toDateString() === today ? "today" : ""}`}
                onClick={() => setDayIndex(index)}
              >
                <strong>{day.toLocaleDateString(locale, { weekday: "short" })}</strong>
                <span>{day.toLocaleDateString(locale, { day: "numeric", month: "numeric" })}</span>
              </button>
            ))}
          </div>
          <div className="calendar-list">
            {visibleHours.map(hour => {
              const cell = cellAt(days[dayIndex], hour);
              if (cell.hidden) return null;
              return (
                <button
                  key={hour}
                  className={`calendar-list-slot ${cell.state}`}
                  onClick={() => openSlot(cell.start, cell.booking)}
                  disabled={!cell.clickable}
                >
                  <strong>{timeLabel(cell.start)}–{timeLabel(slotEnd(cell.start))}</strong>
                  <span>{cell.label}</span>
                  {cell.action && <em>{cell.action}</em>}
                </button>
              );
            })}
          </div>
        </>
      ) : (
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
              const cell = cellAt(day, hour);
              const { start, booking, past } = cell;
              // Suodatettu pois: ruutu jää tyhjäksi, jotta viikon rakenne säilyy.
              if (cell.hidden) {
                return <div key={start.getTime()} className="calendar-slot hidden-slot" />;
              }
              const waiting = booking?.queue_count ?? 0;
              return booking ? (
                <button
                  key={start.getTime()}
                  className={`calendar-slot booked ${past ? "past" : ""} ${portal && !booking.mine ? "other" : ""} ${(portal ? booking.queue_entry_id : waiting > 0) ? "requested" : ""}`}
                  onClick={() => openSlot(start, booking)}
                  disabled={!cell.clickable}
                  title={cell.title}
                >
                  <strong>
                    {portal ? cell.label : booking.resident_name || booking.note || t("Varattu")}
                  </strong>
                  {!portal && booking.apartment_number && <span>{booking.apartment_number}</span>}
                  {!portal && waiting > 0 && <span className="request-badge">{t("{0} jonossa", waiting)}</span>}
                </button>
              ) : (
                <button
                  key={start.getTime()}
                  className="calendar-slot free"
                  onClick={() => openSlot(start, null)}
                  disabled={!cell.clickable}
                  title={cell.title}
                >
                  {past || bookingDisabled ? "" : t("+ Varaa")}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      )}

      {portal && queueEntries.length > 0 && (
        <SlotQueueList entries={queueEntries} onLeave={entryId => void leaveQueue(entryId)} disabled={saving} />
      )}

      {!routed && slotView}
    </section>
  );
}

// Asukkaan omat jonopaikat: vuoro, sija ja tila. Listalta voi poistua jonosta, mutta uuteen jonoon
// liitytään aina kalenterista varatun vuoron päältä.
export function SlotQueueList({ entries, onLeave, disabled, showResource = false }: {
  entries: QueueEntry[];
  onLeave: (entryId: string) => void;
  disabled?: boolean;
  showResource?: boolean;
}) {
  const time = (value: string) => new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="booking-requests own">
      <h2>{t("Omat jonopaikat")}</h2>
      {entries.map(entry => (
        <div className="booking-request" key={entry.id}>
          <div>
            <strong>
              {showResource ? `${BOOKING_RESOURCES[entry.resource]?.name ?? entry.resource} · ` : ""}
              {new Date(entry.starts_at).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "numeric" })}{" "}
              {t("klo")}{" "}{time(entry.starts_at)}–{time(entry.ends_at)}
            </strong>
            <span className={`request-status ${entry.status === "granted" ? "approved" : "pending"}`}>
              {entry.status === "granted" ? t("Sait vuoron") : t("Jonossa, sija {0}", entry.position ?? "–")}
            </span>
          </div>
          {entry.status !== "granted" && (
            <div className="drawer-actions booking-request-actions">
              <button type="button" onClick={() => onLeave(entry.id)} disabled={disabled}>{t("Poistu jonosta")}</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
