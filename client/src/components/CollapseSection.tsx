import { type ReactNode, useEffect, useState } from "react";
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

const OPEN_EVENT = "kotilo:open-section";

// Siirtyy osioon (esim. asetusten aliotsikosta): avaa tiivistetyn osion ja vierittää sen näkyviin.
export function jumpToSection(id: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
  // Avattu osio piirtyy seuraavassa ruudussa; vieritetään vasta sitten.
  requestAnimationFrame(() => document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

// Tiivistettävä asetusosio: otsikon väkäsestä osio sulkeutuu ja avautuu. Valinta säilyy selaimessa.
// Suljetun osion kentät säilyttävät arvonsa, koska ne ovat näkymän omassa tilassa.
export function CollapseSection({ id, title, action, children }: {
  id: string;
  title: string;
  // Otsikon vieressä pysyvä toiminto, esim. lisäyspainike.
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => !collapsedSections().includes(id));

  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail === id) setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, listener);
    return () => window.removeEventListener(OPEN_EVENT, listener);
  }, [id]);

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
    <h2 className="collapse-heading" id={`section-${id}`}>
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
