import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatDate, formatTicketNumber } from "../format";
import type { HistoryEntry } from "../history";
import { language, setLanguage, t } from "../i18n";
import { logout, MANAGEMENT_OFFICE, type OfficeUser } from "../session";
import { setTheme, storedTheme } from "../theme";

// Avautuva valikko, joka sulkeutuu ulkopuolelle klikatessa ja Escape-näppäimellä.
function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const chevron = <Icon><path d="M6 9l6 6 6-6" /></Icon>;

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join("") || "?";
}

// Viimeksi avatut tehtävät.
function HistoryMenu({ history, onOpenTicket }: { history: HistoryEntry[]; onOpenTicket: (ticketId: string) => void }) {
  const { open, setOpen, ref } = useDropdown();
  return (
    <div className="topbar-menu" ref={ref}>
      <button type="button" className="topbar-button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        <Icon><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></Icon>
        {t("Historia")}
        {chevron}
      </button>
      {open && (
        <div className="topbar-dropdown history-dropdown" role="menu">
          <p className="topbar-dropdown-title">{t("Viimeksi avatut tehtävät")}</p>
          {history.length === 0 && <p className="topbar-dropdown-empty">{t("Et ole vielä avannut tehtäviä.")}</p>}
          {history.map(entry => (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenTicket(entry.id);
              }}
            >
              <span className="history-number">#{formatTicketNumber(entry.number)}</span>
              <span className="history-text">
                <strong>{entry.subject}</strong>
                <small>{entry.companyName} · {formatDate(entry.openedAt)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Profiilivalikko: asetukset, kieli, tumma tila ja uloskirjautuminen.
function ProfileMenu({ user, onOpenSettings }: { user: OfficeUser; onOpenSettings: () => void }) {
  const { open, setOpen, ref } = useDropdown();
  const [dark, setDark] = useState(storedTheme() === "dark");
  return (
    <div className="topbar-menu" ref={ref}>
      <button
        type="button"
        className="topbar-profile"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("Profiili")}
        title={user.name}
      >
        <span className="user-avatar">{initials(user.name)}</span>
        {chevron}
      </button>
      {open && (
        <div className="topbar-dropdown profile-dropdown" role="menu">
          <div className="profile-head">
            <span className="user-avatar">{initials(user.name)}</span>
            <span>
              <strong>{user.name}</strong>
              <small>{user.email}</small>
              <small>{t(user.role)} · {MANAGEMENT_OFFICE.name}</small>
            </span>
          </div>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenSettings(); }}>
            <Icon><path d="M12 15a3 3 0 1 0 0-6a3 3 0 0 0 0 6z" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3a1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8a1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Icon>
            {t("Asetukset")}
          </button>
          <div className="profile-row">
            <Icon><path d="M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18z" /><path d="M3.6 9h16.8M3.6 15h16.8" /><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" /></Icon>
            <span>{t("Kieli")}</span>
            <span className="profile-segment" role="group" aria-label={t("Kieli")}>
              <button type="button" className={language === "fi" ? "active" : ""} onClick={() => setLanguage("fi")} lang="fi">Suomi</button>
              <button type="button" className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")} lang="en">English</button>
            </span>
          </div>
          <label className="profile-row switch-row">
            <Icon><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></Icon>
            <span>{t("Tumma tila")}</span>
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
          <button type="button" role="menuitem" className="profile-logout" onClick={logout}>
            <Icon><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></Icon>
            {t("Kirjaudu ulos")}
          </button>
        </div>
      )}
    </div>
  );
}

// Yläpalkki: logo, historia ja toimiston nimi vasemmalla; haku, taloyhtiövalinta ja profiili oikealla.
export function Topbar({
  user,
  searchText,
  onSearchTextChange,
  onSearch,
  history,
  onOpenTicket,
  onOpenSettings,
  onOpenMenu
}: {
  user: OfficeUser;
  searchText: string;
  onSearchTextChange: (text: string) => void;
  onSearch: () => void;
  history: HistoryEntry[];
  onOpenTicket: (ticketId: string) => void;
  onOpenSettings: () => void;
  onOpenMenu: () => void;
}) {
  return (
    <header className="topbar">
      <button type="button" className="topbar-hamburger" onClick={onOpenMenu} aria-label={t("Avaa valikko")}>
        <Icon><path d="M4 6h16M4 12h16M4 18h16" /></Icon>
      </button>
      <a className="topbar-brand" href="#/queue" title={t("Päätösjonoon")}>
        <img src="/pleissi-logo.svg" alt="Pleissi" />
      </a>
      <HistoryMenu history={history} onOpenTicket={onOpenTicket} />
      <span className="topbar-office">{MANAGEMENT_OFFICE.name}</span>

      <div className="topbar-right">
        {/* Haku: #123 avaa tehtävän numerolla, muu teksti avaa hakutulokset kaikesta alustan tiedosta. */}
        <form className="topbar-search" role="search" onSubmit={event => { event.preventDefault(); onSearch(); }}>
          <Icon><path d="M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0" /><path d="M21 21l-4.3-4.3" /></Icon>
          <input
            type="search"
            value={searchText}
            onChange={event => onSearchTextChange(event.target.value)}
            placeholder={t("Hae tai #numero")}
            aria-label={t("Hae alustalta")}
          />
        </form>
        <ProfileMenu user={user} onOpenSettings={onOpenSettings} />
      </div>
    </header>
  );
}
