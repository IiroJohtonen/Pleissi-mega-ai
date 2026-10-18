import { useEffect, useState } from "react";
import { Dropdown, NoticeFilters, usePaged } from "../components/common";
import { ReporterCell, ReporterField } from "../components/Reporter";
import { formatDate } from "../format";
import { api, errorMessage } from "../session";
import type { Company } from "../types";
import type { QueueEntry } from "./Bookings";
import type { ParkingSpace } from "./Parking";
import { HeatingOrders } from "./HeatingOrders";
import { locale, t } from "../i18n";

export type WaitlistEntry = {
  id: string;
  company_id: string;
  resource: "parking" | "sauna";
  parking_type: string;
  note: string;
  status: "waiting" | "offered";
  created_at: string;
  position: number;
  resident_id?: string;
  resident_name?: string | null;
  resident_email?: string | null;
  apartment_number?: string | null;
  address?: string | null;
  offered_at?: string | null;
  offered_by?: string | null;
};

export function waitlistLabel(entry: Pick<WaitlistEntry, "resource" | "parking_type">) {
  if (entry.resource === "sauna") return t("Saunan vakiovuoro");
  return entry.parking_type ? `${t("Autopaikka")} · ${t(entry.parking_type)}` : t("Autopaikka");
}

// Toimiston näkymä: jonot ilmoittautumisjärjestyksessä. Vapaan autopaikan voi antaa suoraan jonottajalle.
export function Waitlists({ companies, defaultCompanyId = "" }: { companies: Company[]; defaultCompanyId?: string }) {
  // Oletuksena yläpalkissa valitun taloyhtiön jonot; suodattimesta voi valita toisen tai kaikki.
  const [companyFilter, setCompanyFilter] = useState(companies.some(company => company.id === defaultCompanyId) ? defaultCompanyId : "all");
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [freeSpaces, setFreeSpaces] = useState<ParkingSpace[]>([]);
  const [parkingId, setParkingId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Sauna- ja pyykkitupavuorojen jonot: jonottajat vuoroittain sijoineen.
  const [slotEntries, setSlotEntries] = useState<(QueueEntry & { company_id: string })[]>([]);
  const [slotError, setSlotError] = useState("");

  // Taloyhtiö-sarake vain, kun näkymässä on useita yhtiöitä.

  const multiCompany = companies.length > 1;

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";

  async function loadEntries() {
    try {
      const [lists, slotLists] = await Promise.all([
        Promise.all(companies.map(company => api<WaitlistEntry[]>(`/companies/${encodeURIComponent(company.id)}/waitlist`))),
        Promise.all(companies.map(company => api<(QueueEntry & { company_id: string })[]>(`/companies/${encodeURIComponent(company.id)}/booking-queue`)))
      ]);
      setEntries(lists.flat());
      setSlotEntries(slotLists.flat().sort((a, b) => a.starts_at.localeCompare(b.starts_at) || (a.position ?? 0) - (b.position ?? 0)));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadEntries();
  }, [companies.length]);

  const open = entries.find(entry => entry.id === openId) ?? null;

  // Autopaikkajonottajalle haetaan taloyhtiön vapaat paikat, toivotun tyypin mukaan rajattuna.
  useEffect(() => {
    setFreeSpaces([]);
    setParkingId("");
    if (!open || open.resource !== "parking") return;
    api<ParkingSpace[]>(`/companies/${encodeURIComponent(open.company_id)}/parking`)
      .then(spaces => setFreeSpaces(spaces.filter(space =>
        !space.resident_id && (!open.parking_type || space.type === open.parking_type))))
      .catch(() => setFreeSpaces([]));
  }, [openId]);

  async function act(path: string, body?: unknown, close = true) {
    setSaving(true);
    setError("");
    try {
      await api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
      if (close) setOpenId(null);
      await loadEntries();
    } catch (actionError) {
      setError(errorMessage(actionError, t("Toiminto epäonnistui.")));
    } finally {
      setSaving(false);
    }
  }

  async function removeFromSlotQueue(entryId: string) {
    setSlotError("");
    try {
      await api(`/booking-queue/${encodeURIComponent(entryId)}`, { method: "DELETE" });
      await loadEntries();
    } catch (removeError) {
      setSlotError(errorMessage(removeError, t("Jonosta poistaminen epäonnistui.")));
    }
  }

  const visible = entries.filter(entry => companyFilter === "all" || entry.company_id === companyFilter);
  const paged = usePaged(visible, companyFilter);
  const visibleSlots = slotEntries.filter(entry => companyFilter === "all" || entry.company_id === companyFilter);
  const pagedSlots = usePaged(visibleSlots, `slots|${companyFilter}`);
  const slotTime = (entry: QueueEntry) => {
    const time = (value: string) => new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    return `${new Date(entry.starts_at).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "numeric" })} ${t("klo")} ${time(entry.starts_at)}–${time(entry.ends_at)}`;
  };

  return (
    <section className="content">
      <a className="back-link" href="#/companies">{t("← Taloyhtiöt")}</a>

      <div className="residents-toolbar">
        <span>{visible.length + visibleSlots.length}{" "}{t("jonottajaa")}</span>
      </div>
      <NoticeFilters companies={companies} company={companyFilter} onCompany={setCompanyFilter} />

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <p className="send-error">{t("Jonojen lataus epäonnistui.")}</p>
        : visible.length === 0 ? <div className="empty">{t("Jonoissa ei ole ketään. Asukas ilmoittautuu jonoon asukasportaalissa.")}</div>
        : (
          <div className="table-card">
            <table className="data-table report-topics">
              <thead>
                <tr>
                  <th>{t("Sija")}</th>
                  <th>{t("Ilmoittaja")}</th>
                  <th>{t("Asunto")}</th>
                  {multiCompany && <th>{t("Taloyhtiö")}</th>}
                  <th>{t("Jono")}</th>
                  <th>{t("Jonossa alkaen")}</th>
                  <th>{t("Tila")}</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(entry => (
                  <tr
                    key={entry.id}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title={t("Avaa jonottajan tiedot")}
                    onClick={() => { setOpenId(entry.id); setError(""); }}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenId(entry.id);
                        setError("");
                      }
                    }}
                  >
                    <td><strong>{entry.position}.</strong></td>
                    <td>
                      <ReporterCell name={entry.resident_name} email={entry.resident_email} />
                      {entry.note && <span>{entry.note}</span>}
                    </td>
                    <td>{entry.apartment_number || "–"}</td>
                    {multiCompany && <td>{companyName(entry.company_id)}</td>}
                    <td>{waitlistLabel(entry)}</td>
                    <td>{formatDate(entry.created_at)}</td>
                    <td><span className={`work-order-status ${entry.status === "offered" ? "done" : ""}`}>{entry.status === "offered" ? t("Tarjottu") : t("Jonossa")}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {paged.pager}

      <h2 className="section-heading">{t("Sauna- ja pyykkitupavuorojen jonot")}</h2>
      <p className="muted">{t("Asukas liittyy varatun vuoron jonoon kalenterista. Kun varaaja peruu vuoron, se siirtyy automaattisesti sijalla 1 olevalle.")}</p>
      {!loading && !loadError && (visibleSlots.length === 0 ? (
        <div className="empty">{t("Vuorojen jonoissa ei ole ketään.")}</div>
      ) : (
        <div className="table-card">
          <table className="data-table report-topics">
            <thead>
              <tr>
                <th>{t("Vuoro")}</th>
                <th>{t("Sija")}</th>
                <th>{t("Ilmoittaja")}</th>
                <th>{t("Asunto")}</th>
                {multiCompany && <th>{t("Taloyhtiö")}</th>}
                <th>{t("Nyt varattu")}</th>
                <th>{t("Jonossa alkaen")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pagedSlots.items.map(entry => (
                <tr key={entry.id}>
                  <td>
                    <strong>{entry.resource === "sauna" ? t("Sauna") : t("Pyykkitupa")}</strong>
                    <span>{slotTime(entry)}</span>
                  </td>
                  <td><strong>{entry.position}.</strong></td>
                  <td><ReporterCell name={entry.resident_name} email={entry.resident_email} /></td>
                  <td>{entry.apartment_number || "–"}</td>
                  {multiCompany && <td>{companyName(entry.company_id)}</td>}
                  <td>{entry.current_holder || "–"}</td>
                  <td>{formatDate(entry.created_at)}</td>
                  <td><button className="link-button" onClick={() => void removeFromSlotQueue(entry.id)}>{t("Poista jonosta")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {pagedSlots.pager}
      {slotError && <p className="send-error">{slotError}</p>}

      {open && (
        <div className="overlay">
          <aside className="drawer form-drawer">
            <button type="button" className="drawer-back" onClick={() => setOpenId(null)} disabled={saving}>{t("← Takaisin")}</button>
            <button className="close" onClick={() => setOpenId(null)} disabled={saving}>×</button>
            <h2>{waitlistLabel(open)}</h2>
            <p className="muted">
              {t("Sija")}{" "}{open.position} · {companyName(open.company_id)} · {t("jonossa alkaen")}{" "}{formatDate(open.created_at)}
            </p>
            <ReporterField
              companyId={open.company_id}
              reporter={{ id: open.resident_id, name: open.resident_name, email: open.resident_email, apartment_number: open.apartment_number, address: open.address }}
              onChange={async residentId => {
                await api(`/waitlist/${encodeURIComponent(open.id)}/reporter`, { method: "PUT", body: JSON.stringify({ residentId }) });
                await loadEntries();
              }}
            />
            {open.note && <p className="announcement-body">{open.note}</p>}
            {open.status === "offered" && (
              <p className="reply-hint">{t("Tarjottu")}{" "}{open.offered_at ? formatDate(open.offered_at) : ""}{open.offered_by ? ` · ${open.offered_by}` : ""}</p>
            )}

            {open.resource === "parking" && (
              <div className="ticket-form">
                {freeSpaces.length === 0 ? (
                  <p className="muted">
                    {t("Taloyhtiössä ei ole vapaata")}{" "}{open.parking_type ? t("paikkaa tyyppiä {0}", open.parking_type) : t("autopaikkaa")}.
                  </p>
                ) : (
                  <>
                    <Dropdown
                      label={t("Vapaa autopaikka")}
                      value={parkingId}
                      options={[
                        { value: "", label: t("Valitse paikka") },
                        ...freeSpaces.map(space => ({ value: space.id, label: `${space.label} · ${t(space.type)}` }))
                      ]}
                      onChange={setParkingId}
                    />
                    <div className="draft-actions">
                      <button
                        className="primary"
                        disabled={saving || !parkingId}
                        onClick={() => void act(`/waitlist/${encodeURIComponent(open.id)}/assign-parking`, { parkingId })}
                      >
                        {t("Anna paikka jonottajalle")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="draft-actions">
              {open.status === "waiting" && (
                <button onClick={() => void act(`/waitlist/${encodeURIComponent(open.id)}/offer`, undefined, false)} disabled={saving}>
                  {t("Merkitse tarjotuksi")}
                </button>
              )}
              {open.resource === "sauna" && (
                <button onClick={() => void act(`/waitlist/${encodeURIComponent(open.id)}/close`, { outcome: "done" })} disabled={saving}>
                  {t("Vuoro annettu")}
                </button>
              )}
              <button className="danger" onClick={() => void act(`/waitlist/${encodeURIComponent(open.id)}/close`, { outcome: "cancelled" })} disabled={saving}>
                {t("Poista jonosta")}
              </button>
            </div>
            {error && <p className="send-error">{error}</p>}
          </aside>
        </div>
      )}

      {/* Autopaikkatilaukset: verkkosivun lomakkeelta, asukasportaalista tai Uusi tilaus -painikkeella kirjatut. */}
      <HeatingOrders companies={companies} companyFilter={companyFilter} />
    </section>
  );
}
