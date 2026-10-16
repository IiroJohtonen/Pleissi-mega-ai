import { useEffect, useState } from "react";
import { t } from "../i18n";
import { api, isAdmin } from "../session";

const POLL_MS = 5 * 60 * 1000;

// Pääkäyttäjälle näytettävä ilmoitus avoimista järjestelmähälytyksistä (palvelinvirheet, postiyhteys,
// varmuuskopiot, AI-kulut). Hälytykset kuitataan asetuksista; ilmoituksen voi piilottaa tältä käynniltä.
export function SystemAlertBanner() {
  const [count, setCount] = useState(0);
  const [hidden, setHidden] = useState(false);
  const admin = isAdmin();

  useEffect(() => {
    if (!admin) return;
    const load = () => api<{ resolved_at: string | null }[]>("/system/alerts")
      .then(alerts => setCount(Array.isArray(alerts) ? alerts.filter(alert => !alert.resolved_at).length : 0))
      .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [admin]);

  if (!admin || count === 0 || hidden) return null;
  return (
    <div className="system-alert-banner" role="status">
      <span>{count === 1 ? t("Järjestelmässä on avoin hälytys.") : t("Järjestelmässä on {0} avointa hälytystä.", count)}</span>
      <a href="#/settings/office" onClick={() => setHidden(true)}>{t("Näytä järjestelmän tila")}</a>
      <button type="button" onClick={() => setHidden(true)} aria-label={t("Piilota ilmoitus")}>×</button>
    </div>
  );
}
