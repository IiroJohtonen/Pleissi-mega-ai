import { type ReactNode, useEffect, useState } from "react";
import { formatDate, formatEuros } from "../format";
import { api, errorMessage, isAdmin, isManager } from "../session";
import { type Booking, type BookingRules, DEFAULT_BOOKING_RULES } from "./Bookings";
import { PARKING_TYPES } from "./Parking";
import { locale, t } from "../i18n";

// Raportti laskutusta varten: valitun kuukauden saunavuorot asukkaittain. Yksittäiset vuorot
// laskutetaan kappalehinnalla ja viikoittaiset vuorot kuukausihinnalla taloyhtiön asetuksista.
function SaunaBilling({ companyId, tabs }: { companyId: string; tabs: ReactNode }) {
  const [kind, setKind] = useState<"all" | "single" | "weekly">("all");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [prices, setPrices] = useState(DEFAULT_BOOKING_RULES.sauna);
  const [failed, setFailed] = useState(false);
  // 0 = kuluva kuukausi, -1 = edellinen ja niin edelleen.
  const [monthOffset, setMonthOffset] = useState(0);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1);
  const monthName = monthStart.toLocaleDateString(locale, { month: "long", year: "numeric" });

  useEffect(() => {
    setFailed(false);
    const query = `resource=sauna&from=${encodeURIComponent(monthStart.toISOString())}&to=${encodeURIComponent(monthEnd.toISOString())}`;
    api<Booking[]>(`/companies/${encodeURIComponent(companyId)}/bookings?${query}`)
      // Mukaan vain valitussa kuussa alkavat vuorot.
      .then(list => setBookings(list.filter(item =>
        Date.parse(item.starts_at) >= monthStart.getTime() && Date.parse(item.starts_at) < monthEnd.getTime())))
      .catch(() => setFailed(true));
  }, [companyId, monthStart.getTime()]);

  useEffect(() => {
    api<BookingRules>(`/companies/${encodeURIComponent(companyId)}/booking-settings`)
      .then(all => setPrices(all.sauna))
      .catch(() => setPrices(DEFAULT_BOOKING_RULES.sauna));
  }, [companyId]);

  const withResident = bookings.filter(item => item.resident_id);
  const withoutResident = bookings.length - withResident.length;
  // Rajaus: kaikki vuorot, vain yksittäiset tai vain viikkovuorot.
  const billable = withResident.filter(item => kind === "all" || (kind === "weekly") === Boolean(item.series_id));

  type Row = { name: string; apartment: string; singles: Booking[]; series: Set<string> };
  const byResident = new Map<string, Row>();
  for (const booking of billable) {
    const row = byResident.get(booking.resident_id!) ?? {
      name: booking.resident_name || t("Tuntematon asukas"),
      apartment: booking.apartment_number || "–",
      singles: [],
      series: new Set<string>()
    };
    // Viikkovuoro laskutetaan kerran kuukaudessa sarjaa kohden, ei jokaisesta vuorosta.
    if (booking.series_id) row.series.add(booking.series_id);
    else row.singles.push(booking);
    byResident.set(booking.resident_id!, row);
  }
  const rows = [...byResident.values()]
    .map(row => ({ ...row, total: row.singles.length * prices.singlePrice + row.series.size * prices.monthlyPrice }))
    .sort((a, b) => a.name.localeCompare(b.name, "fi"));
  const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const pricesMissing = prices.singlePrice === 0 && prices.monthlyPrice === 0;
  const monthKey = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
  const billing = useBillingPeriod(companyId, "sauna", monthKey);
  // Laskutetuksi merkitään aina koko kuukausi, ei rajattua näkymää. Merkinnän tekee isännöitsijä tai pääkäyttäjä.
  const markButton = (
    <button
      className="secondary"
      disabled={billing.busy || rows.length === 0 || kind !== "all" || !isManager()}
      title={kind !== "all" ? t("Valitse Kaikki vuorot, niin koko kuukausi merkitään laskutetuksi.") : undefined}
      onClick={() => void billing.mark({
        total: grandTotal,
        prices: { "Yksittäinen vuoro": prices.singlePrice, "Viikkovuoro / kk": prices.monthlyPrice },
        rows: rows.map(row => ({
          name: row.name,
          apartment: row.apartment,
          detail: [
            row.singles.length > 0
              ? t("{0} yksittäistä ({1})", row.singles.length, row.singles.map(shift => new Date(shift.starts_at).toLocaleDateString(locale, { day: "numeric", month: "numeric" })).join(", "))
              : "",
            row.series.size > 0 ? `${row.series.size} viikkovuoroa` : ""
          ].filter(Boolean).join(" · "),
          total: row.total
        }))
      })}
    >
      {t("Merkitse laskutetuksi")}
    </button>
  );

  function downloadCsv() {
    const lines = [
      [t("Asukas"), t("Asunto"), t("Yksittäisiä vuoroja"), t("Viikkovuoroja"), t("Summa (EUR)"), t("Yksittäisten vuorojen päivät")],
      ...rows.map(row => [
        row.name,
        row.apartment,
        String(row.singles.length),
        String(row.series.size),
        row.total.toFixed(2).replace(".", ","),
        row.singles.map(shift => new Date(shift.starts_at).toLocaleDateString(locale)).join(", ")
      ]),
      [t("Yhteensä"), "", "", "", grandTotal.toFixed(2).replace(".", ","), ""]
    ];
    const csv = lines.map(cells => cells.map(cell => `"${cell.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    // BOM, jotta Excel avaa ääkköset oikein.
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    const suffix = kind === "single" ? "-yksittaiset" : kind === "weekly" ? "-viikkovuorot" : "";
    link.download = `saunavuorot${suffix}-${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (billing.period) {
    return (
      <BilledPeriodView
        tabs={tabs}
        title={t("Saunavuorojen laskutus")}
        monthName={monthName}
        monthOffset={monthOffset}
        onMonth={setMonthOffset}
        period={billing.period}
        fileName={`saunavuorot-${monthKey}-laskutettu.csv`}
        busy={billing.busy}
        error={billing.error}
        onUnmark={() => void billing.unmark()}
      />
    );
  }

  return (
    <div className="report-card">
      {tabs}
      {billing.error && <p className="send-error">{billing.error}</p>}
      <div className="suggest-header report-ai-head">
        <h2>{t("Saunavuorojen laskutus")}</h2>
        <div className="calendar-week">
          <button onClick={() => setMonthOffset(monthOffset - 1)} aria-label={t("Edellinen kuukausi")}>←</button>
          <strong>{monthName}</strong>
          <button onClick={() => setMonthOffset(monthOffset + 1)} disabled={monthOffset >= 0} aria-label={t("Seuraava kuukausi")}>→</button>
          <button className="secondary" onClick={downloadCsv} disabled={rows.length === 0}>{t("Lataa CSV")}</button>
          {markButton}
        </div>
      </div>
      <p className="muted">
        {t("Yksittäinen vuoro")}{" "}{formatEuros(prices.singlePrice)}{" "}{t("/ vuoro, viikoittainen vuoro")}{" "}{formatEuros(prices.monthlyPrice)}{" "}{t("/ kk.")}
        {withoutResident > 0 && t(" {0} varausta ilman asukasta (esim. huolto) on jätetty pois.", withoutResident)}
      </p>
      <div className="card-tabs billing-filter" role="group" aria-label={t("Näytettävät vuorot")}>
        {([["all", t("Kaikki vuorot")], ["single", t("Yksittäiset")], ["weekly", t("Viikkovuorot")]] as const).map(([key, label]) => (
          <button key={key} className={kind === key ? "active" : ""} aria-pressed={kind === key} onClick={() => setKind(key)}>
            {label}
          </button>
        ))}
      </div>
      {pricesMissing && (
        <p className="send-error">{t("Hintoja ei ole asetettu. Aseta saunavuorojen hinnat Asetuksista, niin summat lasketaan.")}</p>
      )}
      {failed ? <p className="send-error">{t("Saunavuorojen lataus epäonnistui.")}</p>
        : rows.length === 0 ? <p className="muted">{t("Valitulla kuukaudella ei ole laskutettavia saunavuoroja.")}</p>
        : (
          <div className="table-card">
            <table className="data-table report-topics">
              <thead>
                <tr>
                  <th>{t("Asukas")}</th>
                  <th>{t("Asunto")}</th>
                  <th>{t("Yksittäisiä vuoroja")}</th>
                  <th>{t("Viikkovuoroja")}</th>
                  <th>{t("Summa")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.name + row.apartment}>
                    <td><strong>{row.name}</strong></td>
                    <td>{row.apartment}</td>
                    <td>
                      {row.singles.length}
                      {row.singles.length > 0 && (
                        <span>
                          {row.singles
                            .map(shift => new Date(shift.starts_at).toLocaleDateString(locale, { day: "numeric", month: "numeric" }))
                            .join(", ")}
                        </span>
                      )}
                    </td>
                    <td>{row.series.size}</td>
                    <td><strong>{formatEuros(row.total)}</strong></td>
                  </tr>
                ))}
                <tr>
                  <td><strong>{t("Yhteensä")}</strong></td>
                  <td />
                  <td><strong>{rows.reduce((sum, row) => sum + row.singles.length, 0)}</strong></td>
                  <td><strong>{rows.reduce((sum, row) => sum + row.series.size, 0)}</strong></td>
                  <td><strong>{formatEuros(grandTotal)}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// Haltijajakso, joka oli voimassa laskutettavan kuukauden aikana.
type ParkingBillingRow = {
  id: string;
  label: string;
  type: string;
  resident_id: string;
  resident_name: string | null;
  apartment_number: string | null;
  start_date: string;
  end_date: string | null;
};

// Autopaikkojen laskutus: valitun kuukauden aikana paikkaa hallinneet asukkaat ja tyypin kuukausihinta.
// Haltijahistoria tallentuu aina, kun paikan haltija vaihtuu, joten myös menneet kuukaudet näkyvät.
function ParkingBilling({ companyId, tabs }: { companyId: string; tabs: ReactNode }) {
  const [spaces, setSpaces] = useState<ParkingBillingRow[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  // 0 = kuluva kuukausi, -1 = edellinen ja niin edelleen.
  const [monthOffset, setMonthOffset] = useState(0);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const monthKey = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;
  const monthName = monthStart.toLocaleDateString(locale, { month: "long", year: "numeric" });

  useEffect(() => {
    if (!companyId) return;
    setFailed(false);
    Promise.all([
      api<ParkingBillingRow[]>(`/companies/${encodeURIComponent(companyId)}/parking-billing?month=${monthKey}`),
      api<Record<string, number>>(`/companies/${encodeURIComponent(companyId)}/parking-prices`)
    ])
      .then(([spaceList, priceList]) => {
        setSpaces(spaceList);
        setPrices(priceList);
      })
      .catch(() => setFailed(true));
  }, [companyId, monthKey]);

  const priceOf = (type: string) => prices[type] ?? 0;
  const taken = spaces.filter(space => typeFilter === "all" || space.type === typeFilter);

  type Row = { name: string; apartment: string; spaces: ParkingBillingRow[]; total: number };
  const byResident = new Map<string, Row>();
  for (const space of taken) {
    const row = byResident.get(space.resident_id!) ?? {
      name: space.resident_name || t("Tuntematon asukas"),
      apartment: space.apartment_number || "–",
      spaces: [],
      total: 0
    };
    row.spaces.push(space);
    row.total += priceOf(space.type);
    byResident.set(space.resident_id!, row);
  }
  const rows = [...byResident.values()].sort((a, b) => a.name.localeCompare(b.name, "fi"));
  const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const pricesMissing = PARKING_TYPES.every(type => priceOf(type) === 0);
  const billing = useBillingPeriod(companyId, "parking", monthKey);
  // Laskutetuksi merkitään aina koko kuukausi, ei rajattua näkymää.
  const markButton = (
    <button
      className="secondary"
      disabled={billing.busy || rows.length === 0 || typeFilter !== "all" || !isManager()}
      title={typeFilter !== "all" ? t("Valitse Kaikki tyypit, niin koko kuukausi merkitään laskutetuksi.") : undefined}
      onClick={() => void billing.mark({
        total: grandTotal,
        prices: Object.fromEntries(PARKING_TYPES.map(type => [type, priceOf(type)])),
        rows: rows.map(row => ({
          name: row.name,
          apartment: row.apartment,
          detail: row.spaces.map(space => `${space.label} (${t(space.type)})`).join(", "),
          total: row.total
        }))
      })}
    >
      {t("Merkitse laskutetuksi")}
    </button>
  );

  function downloadCsv() {
    const lines = [
      [t("Asukas"), t("Asunto"), t("Paikka"), t("Tyyppi"), t("Hinta / kk (EUR)")],
      ...rows.flatMap(row => row.spaces.map(space => [
        row.name,
        row.apartment,
        space.label,
        space.type,
        priceOf(space.type).toFixed(2).replace(".", ",")
      ])),
      [t("Yhteensä"), "", "", "", grandTotal.toFixed(2).replace(".", ",")]
    ];
    const csv = lines.map(cells => cells.map(cell => `"${cell.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    // BOM, jotta Excel avaa ääkköset oikein.
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `autopaikat-${monthKey}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (billing.period) {
    return (
      <BilledPeriodView
        tabs={tabs}
        title={t("Autopaikkojen laskutus")}
        monthName={monthName}
        monthOffset={monthOffset}
        onMonth={setMonthOffset}
        period={billing.period}
        fileName={`autopaikat-${monthKey}-laskutettu.csv`}
        busy={billing.busy}
        error={billing.error}
        onUnmark={() => void billing.unmark()}
      />
    );
  }

  return (
    <div className="report-card">
      {tabs}
      {billing.error && <p className="send-error">{billing.error}</p>}
      <div className="suggest-header report-ai-head">
        <h2>{t("Autopaikkojen laskutus")}</h2>
        <div className="calendar-week">
          <button onClick={() => setMonthOffset(monthOffset - 1)} aria-label={t("Edellinen kuukausi")}>←</button>
          <strong>{monthName}</strong>
          <button onClick={() => setMonthOffset(monthOffset + 1)} disabled={monthOffset >= 0} aria-label={t("Seuraava kuukausi")}>→</button>
          <button className="secondary" onClick={downloadCsv} disabled={rows.length === 0}>{t("Lataa CSV")}</button>
          {markButton}
        </div>
      </div>
      <p className="muted">
        {PARKING_TYPES.map(type => `${t(type)} ${formatEuros(priceOf(type))} / ${t("kk")}`).join(", ")}.
        {" "}{t("Mukana ovat asukkaat, joilla paikka oli kuukauden aikana; koko kuukausi laskutetaan, vaikka paikka olisi ollut vain osan kuusta.")}
      </p>
      <div className="card-tabs billing-filter" role="group" aria-label={t("Näytettävät paikkatyypit")}>
        {["all", ...PARKING_TYPES].map(option => (
          <button
            key={option}
            className={typeFilter === option ? "active" : ""}
            aria-pressed={typeFilter === option}
            onClick={() => setTypeFilter(option)}
          >
            {option === "all" ? t("Kaikki tyypit") : option}
          </button>
        ))}
      </div>
      {pricesMissing && (
        <p className="send-error">{t("Hintoja ei ole asetettu. Aseta autopaikkojen hinnat Asetuksista, niin summat lasketaan.")}</p>
      )}
      {failed ? <p className="send-error">{t("Autopaikkojen lataus epäonnistui.")}</p>
        : rows.length === 0 ? <p className="muted">{t("Valitulla kuukaudella ei ole laskutettavia autopaikkoja.")}</p>
        : (
          <div className="table-card">
            <table className="data-table report-topics">
              <thead>
                <tr>
                  <th>{t("Asukas")}</th>
                  <th>{t("Asunto")}</th>
                  <th>{t("Paikat")}</th>
                  <th>{t("Summa / kk")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.name + row.apartment}>
                    <td><strong>{row.name}</strong></td>
                    <td>{row.apartment}</td>
                    <td>
                      {row.spaces.length}
                      <span>{row.spaces.map(space => `${space.label} (${t(space.type)})`).join(", ")}</span>
                    </td>
                    <td><strong>{formatEuros(row.total)}</strong></td>
                  </tr>
                ))}
                <tr>
                  <td><strong>{t("Yhteensä")}</strong></td>
                  <td />
                  <td><strong>{taken.length}</strong></td>
                  <td><strong>{formatEuros(grandTotal)}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// Laskutetuksi merkitty kuukausi: rivit ja hinnat sellaisina kuin ne olivat merkintähetkellä.
type BillingPeriod = {
  billedAt: string;
  billedBy: string;
  total: number;
  prices: Record<string, number>;
  rows: { name: string; apartment: string; detail: string; total: number }[];
};

function useBillingPeriod(companyId: string, kind: "sauna" | "parking", month: string) {
  const [period, setPeriod] = useState<BillingPeriod | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = `/companies/${encodeURIComponent(companyId)}/billing-periods`;

  async function load() {
    try {
      setPeriod(await api<BillingPeriod | null>(`${base}?kind=${kind}&month=${month}`));
    } catch {
      setPeriod(null);
    }
  }

  useEffect(() => {
    setError("");
    if (companyId) void load();
  }, [companyId, kind, month]);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (actionError) {
      setError(errorMessage(actionError, fallback));
    } finally {
      setBusy(false);
    }
  }

  return {
    period,
    busy,
    error,
    mark: (payload: Pick<BillingPeriod, "total" | "prices" | "rows">) => run(
      () => api(base, { method: "POST", body: JSON.stringify({ kind, month, ...payload }) }),
      t("Laskutetuksi merkitseminen epäonnistui.")
    ),
    unmark: () => run(
      () => api(`${base}?kind=${kind}&month=${month}`, { method: "DELETE" }),
      t("Laskutusmerkinnän poistaminen epäonnistui.")
    )
  };
}

// Laskutetun kuukauden näkymä: lukittu taulukko tallennetuista riveistä.
function BilledPeriodView({
  tabs, title, monthName, monthOffset, onMonth, period, fileName, busy, error, onUnmark
}: {
  tabs: ReactNode;
  title: string;
  monthName: string;
  monthOffset: number;
  onMonth: (offset: number) => void;
  period: BillingPeriod;
  fileName: string;
  busy: boolean;
  error: string;
  onUnmark: () => void;
}) {
  function downloadCsv() {
    const lines = [
      [t("Asukas"), t("Asunto"), t("Erittely"), t("Summa (EUR)")],
      ...period.rows.map(row => [row.name, row.apartment, row.detail, row.total.toFixed(2).replace(".", ",")]),
      [t("Yhteensä"), "", "", period.total.toFixed(2).replace(".", ",")]
    ];
    const csv = lines.map(cells => cells.map(cell => `"${cell.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="report-card">
      {tabs}
      <div className="suggest-header report-ai-head">
        <h2>{title}</h2>
        <div className="calendar-week">
          <button onClick={() => onMonth(monthOffset - 1)} aria-label={t("Edellinen kuukausi")}>←</button>
          <strong>{monthName}</strong>
          <button onClick={() => onMonth(monthOffset + 1)} disabled={monthOffset >= 0} aria-label={t("Seuraava kuukausi")}>→</button>
          <button className="secondary" onClick={downloadCsv}>{t("Lataa CSV")}</button>
        </div>
      </div>
      <p className="portal-sent">
        {t("Laskutettu")}{" "}{formatDate(period.billedAt)} · {period.billedBy}{t(". Rivit ja hinnat on lukittu merkintähetken mukaisiksi (")}{Object.entries(period.prices).map(([name, price]) => `${name} ${formatEuros(price)}`).join(", ")}).
      </p>
      <div className="table-card">
        <table className="data-table report-topics">
          <thead>
            <tr>
              <th>{t("Asukas")}</th>
              <th>{t("Asunto")}</th>
              <th>{t("Erittely")}</th>
              <th>{t("Summa")}</th>
            </tr>
          </thead>
          <tbody>
            {period.rows.map((row, index) => (
              <tr key={index}>
                <td><strong>{row.name}</strong></td>
                <td>{row.apartment}</td>
                <td>{row.detail}</td>
                <td><strong>{formatEuros(row.total)}</strong></td>
              </tr>
            ))}
            <tr>
              <td><strong>{t("Yhteensä")}</strong></td>
              <td />
              <td />
              <td><strong>{formatEuros(period.total)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      {isAdmin() && (
        <div className="draft-actions">
          <button className="danger" onClick={onUnmark} disabled={busy}>{t("Poista laskutusmerkintä")}</button>
        </div>
      )}
      {error && <p className="send-error">{error}</p>}
    </div>
  );
}

// Laskutusraportit: saunavuorot ja autopaikat välilehtinä samassa kortissa.
export function BillingReports({ companyId }: { companyId: string }) {
  const [tab, setTab] = useState<"sauna" | "parking">("sauna");
  const tabs = (
    <div className="billing-tabs-head">
      <h2>{t("Laskutusraportit")}</h2>
      <div className="billing-tabs" role="tablist">
        {([["sauna", t("Saunavuorot")], ["parking", t("Autopaikat")]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
  return tab === "sauna"
    ? <SaunaBilling companyId={companyId} tabs={tabs} />
    : <ParkingBilling companyId={companyId} tabs={tabs} />;
}
