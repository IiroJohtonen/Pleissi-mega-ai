import { t } from "../i18n";

// Ilmoitus näytön yläreunassa. Alareunan palkki kuluu näyttöajan mukana, ja ilmoitus poistuu, kun
// palkki on tyhjä. Hiiren ollessa ilmoituksen päällä aika pysähtyy. Ruksista ilmoituksen saa pois heti.
export function Toast({
  title,
  message,
  durationMs = 9000,
  onClose
}: {
  title: string;
  message?: string;
  durationMs?: number;
  onClose: () => void;
}) {
  return (
    <div className="toast" role="status" aria-live="polite">
      <button type="button" className="toast-close" onClick={onClose} aria-label={t("Sulje ilmoitus")} title={t("Sulje ilmoitus")}>×</button>
      <div className="toast-body">
        <strong>{title}</strong>
        {message && <p>{message}</p>}
      </div>
      <span className="toast-timer" style={{ animationDuration: `${durationMs}ms` }} onAnimationEnd={onClose} aria-hidden="true" />
    </div>
  );
}
