import { type ReactNode, useEffect, useState } from "react";
import { API, downloadFile } from "../session";
import type { TicketTab } from "../types";
import { language, setLanguage } from "../i18n";
import { t } from "../i18n";

// Linkki, joka lataa rajapinnasta tiedoston (liite tai tietopankin dokumentti).
export function DownloadLink({ path, filename, className, title, children }: {
  path: string;
  filename: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <a
      className={className}
      href={`${API}${path}`}
      title={failed ? t("Lataus epäonnistui. Yritä uudelleen.") : title}
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        setFailed(false);
        downloadFile(path, filename).catch(() => setFailed(true));
      }}
    >
      {children}
    </a>
  );
}

// Paikkamerkkikuvakkeet näkymille (24×24, viivapiirros).
const tabIcons: Record<TicketTab, string[]> = {
  queue: [
    "M22 12h-6l-2 3h-4l-2-3H2",
    "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
  ],
  "my-tickets": [
    "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2",
    "M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0"
  ],
  "ai-handled": ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
  tickets: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  knowledge: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  "knowledge-ai": ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
  "knowledge-internal": [
    "M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z",
    "M8 11V7a4 4 0 0 1 8 0v4"
  ],
  reports: ["M18 20V10", "M12 20V4", "M6 20v-6"],
  log: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  sauna: ["M12 2c1 3 4.500 5 4.500 9.500a4.500 4.500 0 0 1-9 0c0-1.600.6-2.800 1.600-3.800C9.300 9.500 9.800 6 12 2z"],
  moves: [
    "M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2",
    "M15 18H9",
    "M19 18h2a1 1 0 0 0 1-1v-3.650a1 1 0 0 0-.220-.624l-3.480-4.350A1 1 0 0 0 17.520 8H14",
    "M15 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
    "M5 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0"
  ],
  renovations: [
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
  ],
  keys: [
    "M2.5 15.5a5 5 0 1 0 10 0a5 5 0 1 0-10 0",
    "m11 12 10-10",
    "m16 7 3 3",
    "m19 4 2 2"
  ],
  meters: [
    "M12 14 16 10",
    "M3.34 19a10 10 0 1 1 17.32 0"
  ],
  waitlist: [
    "M10 6h11",
    "M10 12h11",
    "M10 18h11",
    "M4 6h1v4",
    "M4 10h2",
    "M6 18H4c0-1 2-2 2-3s-1-1.500-2-1"
  ],
  announcements: [
    "m3 11 18-5v12L3 14v-3z",
    "M11.6 16.8a3 3 0 1 1-5.8-1.6"
  ],
  parking: [
    "M5 17h14v-5l-1.600-4.500A2 2 0 0 0 15.500 6h-7a2 2 0 0 0-1.900 1.500L5 12z",
    "M5 17v2h2v-2",
    "M17 17v2h2v-2",
    "M8 13.500h.01",
    "M16 13.500h.01"
  ],
  laundry: [
    "M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
    "M8 13.500a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
    "M7.500 6.500h.01"
  ],
  companies: [
    "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    "M9 22V12h6v10"
  ],
  residents: [
    "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2",
    "M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
    "M23 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75"
  ],
  settings: [
    "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
  ]
};

export function TabIcon({ tab }: { tab: TicketTab }) {
  return (
    <svg
      className="tab-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {tabIcons[tab].map(d => <path key={d} d={d} />)}
    </svg>
  );
}

// Ilmoitustaulujen suodattimet: taloyhtiö, kun yhtiöitä on useita, ja tila, kun taululla on tiloja.
export function NoticeFilters({ companies, company, onCompany, status, onStatus, statuses }: {
  companies: { id: string; name: string }[];
  company: string;
  onCompany: (value: string) => void;
  status?: string;
  onStatus?: (value: string) => void;
  statuses?: { value: string; label: string }[];
}) {
  const showCompany = companies.length > 1;
  if (!showCompany && !statuses) return null;
  return (
    <div className="ticket-filters">
      {showCompany && (
        <Dropdown
          label={t("Taloyhtiö")}
          value={company}
          options={[{ value: "all", label: t("Kaikki") }, ...companies.map(item => ({ value: item.id, label: item.name }))]}
          onChange={onCompany}
        />
      )}
      {statuses && onStatus && (
        <Dropdown
          label={t("Tila")}
          value={status ?? "all"}
          options={[{ value: "all", label: t("Kaikki") }, ...statuses]}
          onChange={onStatus}
        />
      )}
    </div>
  );
}

// Vaihtaa käyttöliittymän kielen; painikkeessa lukee toisen kielen nimi sillä kielellä.
export function LanguageToggle({ className }: { className?: string }) {
  return (
    <button type="button" className={className} lang={language === "en" ? "fi" : "en"} onClick={() => setLanguage(language === "en" ? "fi" : "en")}>
      {language === "en" ? "Suomeksi" : "In English"}
    </button>
  );
}

export function NavToggle({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  const title = `${open ? t("Piilota") : t("Näytä")} ${label}`;
  return (
    <button
      className={`nav-toggle ${open ? "open" : ""}`}
      onClick={onToggle}
      title={title}
      aria-label={title}
      aria-expanded={open}
    >
      <svg
        className="tab-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}

// Onko näyttö kapea (puhelin). Päivittyy, kun ikkunan koko muuttuu.
export function useNarrowScreen(maxWidth = 760) {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return narrow;
}

const PAGE_SIZE = 15;

// Sivuttaa listan 15 tietueen sivuihin. resetKey vaihtuu, kun listan rajaus tai järjestys muuttuu,
// jolloin palataan ensimmäiselle sivulle; taustapäivitys ei vaihda sivua.
export function usePaged<T>(items: T[], resetKey: string) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const first = (current - 1) * PAGE_SIZE;

  // Sivun vaihto palauttaa näkymän listan alkuun.
  function goTo(next: number) {
    setPage(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return {
    items: items.slice(first, first + PAGE_SIZE),
    pager: pageCount > 1 ? (
      <nav className="pager" aria-label={t("Sivutus")}>
        <button onClick={() => goTo(current - 1)} disabled={current === 1}>{t("← Edellinen")}</button>
        <span>
          {t("Sivu")}{" "}{current} / {pageCount} · {first + 1}–{Math.min(first + PAGE_SIZE, items.length)} / {items.length}
        </span>
        <button onClick={() => goTo(current + 1)} disabled={current === pageCount}>{t("Seuraava →")}</button>
      </nav>
    ) : null
  };
}

// Lomakkeiden ja suodattimien alasvetovalikko: kentän näköinen painike ja pyöristetty lista
// selaimen vakiovalikon tilalla.
export function Dropdown({
  label,
  value,
  options,
  onChange,
  disabled
}: {
  label?: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find(option => option.value === value);

  return (
    <div
      className="dropdown"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      {label && <span className="dropdown-label">{label}</span>}
      <button
        type="button"
        className="dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span>{current?.label ?? value}</span>
        <svg
          className={open ? "up" : ""}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.500"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul role="listbox">
          {options.map(option => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={option.value === value ? "selected" : ""}
                onClick={() => {
                  setOpen(false);
                  if (option.value !== value) onChange(option.value);
                }}
              >
                {option.label}
                {option.value === value && (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.500"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M5 12l5 5 9-10" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Tehtävän tietokentän oma alasvetovalikko: näyttää tekstiltä, avautuu pyöristettynä listana.
export function FactDropdown({
  value,
  options,
  disabled,
  onChange
}: {
  value: string;
  options: { value: string; label: string; pillClass?: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find(option => option.value === value);

  return (
    <div
      className="fact-dropdown"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        className={`fact-dropdown-trigger ${current?.pillClass ?? ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {current?.label ?? value}
        <svg
          className={open ? "up" : ""}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.500"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul role="listbox">
          {options.map(option => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={option.value === value ? "selected" : ""}
                onClick={() => {
                  setOpen(false);
                  if (option.value !== value) onChange(option.value);
                }}
              >
                {option.pillClass ? <span className={option.pillClass}>{option.label}</span> : option.label}
                {option.value === value && (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.500"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M5 12l5 5 9-10" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
