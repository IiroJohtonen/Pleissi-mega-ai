import { type FormEvent, useState } from "react";
import { LanguageToggle } from "../components/common";
import { api, errorMessage, MANAGEMENT_OFFICE, type Session, setSession } from "../session";
import { t } from "../i18n";

// Palautuslinkin tunniste osoitteesta #/reset/<tunniste>.
function resetTokenFromHash() {
  return window.location.hash.match(/^#\/reset\/([0-9a-f]{20,})$/i)?.[1] ?? "";
}

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // login = kirjautuminen, forgot = palautuslinkin pyyntö, reset = uuden salasanan asetus linkistä.
  const [resetToken, setResetToken] = useState(resetTokenFromHash);
  const [mode, setMode] = useState<"login" | "forgot" | "reset">(resetToken ? "reset" : "login");
  const [repeat, setRepeat] = useState("");
  const [notice, setNotice] = useState("");

  function show(next: "login" | "forgot") {
    setMode(next);
    setError("");
    setPassword("");
    setRepeat("");
  }

  async function requestReset(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api("/auth/forgot", { method: "POST", body: JSON.stringify({ email: email.trim() }) });
      setNotice(t("Jos osoitteella on tunnus, lähetimme siihen linkin salasanan vaihtoon. Linkki on voimassa tunnin."));
      show("login");
    } catch (resetError) {
      setError(errorMessage(resetError, t("Palautuslinkin pyyntö epäonnistui. Tarkista, että palvelin on käynnissä.")));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitNewPassword(event: FormEvent) {
    event.preventDefault();
    if (password !== repeat) {
      setError(t("Salasanat eivät täsmää."));
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await api("/auth/reset", { method: "POST", body: JSON.stringify({ token: resetToken, password }) });
      window.history.replaceState(null, "", window.location.pathname);
      setResetToken("");
      setNotice(t("Salasana on vaihdettu. Kirjaudu sisään uudella salasanalla."));
      show("login");
    } catch (resetError) {
      setError(errorMessage(resetError, t("Salasanan vaihto epäonnistui.")));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      setSession(await api<Session>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      }));
    } catch (loginError) {
      let message = t("Kirjautuminen epäonnistui. Tarkista, että palvelin on käynnissä.");
      try {
        message = JSON.parse((loginError as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === "forgot") {
    return (
      <div className="login-page">
        <form className="login-card" onSubmit={requestReset}>
          <img src="/pleissi-logo-dark.svg" alt="Pleissi" />
          <h1>{t("Unohtunut salasana")}</h1>
          <p>{t("Anna sähköpostiosoitteesi, niin lähetämme linkin, jolla voit asettaa uuden salasanan.")}</p>
          <label>
            <span>{t("Sähköposti")}</span>
            <input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" autoFocus required />
          </label>
          {error && <p className="send-error">{error}</p>}
          <button type="submit" disabled={submitting || !email.trim()}>
            {submitting ? t("Lähetetään…") : t("Lähetä palautuslinkki")}
          </button>
          <button type="button" className="login-link" onClick={() => show("login")}>{t("← Takaisin kirjautumiseen")}</button>
        </form>
      </div>
    );
  }

  if (mode === "reset") {
    return (
      <div className="login-page">
        <form className="login-card" onSubmit={submitNewPassword}>
          <img src="/pleissi-logo-dark.svg" alt="Pleissi" />
          <h1>{t("Aseta uusi salasana")}</h1>
          <p>{t("Salasanassa pitää olla vähintään 8 merkkiä.")}</p>
          <label>
            <span>{t("Uusi salasana")}</span>
            <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" autoFocus required />
          </label>
          <label>
            <span>{t("Uusi salasana uudelleen")}</span>
            <input type="password" value={repeat} onChange={event => setRepeat(event.target.value)} autoComplete="new-password" required />
          </label>
          {error && <p className="send-error">{error}</p>}
          <button type="submit" disabled={submitting || password.length < 8 || !repeat}>
            {submitting ? t("Tallennetaan…") : t("Vaihda salasana")}
          </button>
          <button
            type="button"
            className="login-link"
            onClick={() => {
              window.history.replaceState(null, "", window.location.pathname);
              setResetToken("");
              show("login");
            }}
          >
            {t("← Takaisin kirjautumiseen")}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <img src="/pleissi-logo-dark.svg" alt="Pleissi" />
        <h1>{t("Kirjaudu sisään")}</h1>
        <p>{MANAGEMENT_OFFICE.name}</p>

        <label>
          <span>{t("Sähköposti")}</span>
          <input
            type="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label>
          <span>{t("Salasana")}</span>
          <input
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && <p className="send-error">{error}</p>}

        {notice && <p className="login-notice">{notice}</p>}

        <button type="submit" disabled={submitting || !email.trim() || !password}>
          {submitting ? t("Kirjaudutaan…") : t("Kirjaudu")}
        </button>
        <button type="button" className="login-link" onClick={() => { setNotice(""); show("forgot"); }}>{t("Unohditko salasanan?")}</button>
        <LanguageToggle className="login-link" />
      </form>
    </div>
  );
}
