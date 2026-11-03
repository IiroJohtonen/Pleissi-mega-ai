import { useState } from "react";
import { t } from "../i18n";
import { api, errorMessage, isAdmin } from "../session";

export type GuideScope = "company" | "office";
type Conflict = { chunkId: string; knowledgeId: string; title: string; documentTitle: string; reason: string };

// Ohjeen muokkaus ja tallennus AI-dokumentaatioon. Ennen tallennusta ohje tarkistetaan ristiriitojen varalta
// olemassa oleviin ohjeisiin; ristiriidat näytetään, ja tallennus vaatii vielä vahvistuksen.
export function GuideEditor({ companyId, initial, saveLabel, onSave, onCancel, extra }: {
  companyId: string;
  initial: { title: string; content: string };
  saveLabel: string;
  onSave: (guide: { title: string; content: string; scope: GuideScope }) => Promise<void>;
  onCancel?: () => void;
  extra?: React.ReactNode;
}) {
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [scope, setScope] = useState<GuideScope>("company");
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [checked, setChecked] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = title.trim().length > 0 && content.trim().length >= 5;

  const change = (update: () => void) => {
    update();
    setConflicts(null);
  };

  async function save() {
    setBusy(true);
    setError("");
    try {
      if (conflicts === null) {
        const result = await api<{ checked: boolean; conflicts: Conflict[] }>(`/companies/${encodeURIComponent(companyId)}/knowledge-base/conflicts`, {
          method: "POST", body: JSON.stringify({ title: title.trim(), content: content.trim() })
        });
        setChecked(result.checked);
        if (result.conflicts.length) {
          setConflicts(result.conflicts);
          return;
        }
      }
      await onSave({ title: title.trim(), content: content.trim(), scope });
    } catch (caught) {
      setError(errorMessage(caught, t("Tallennus epäonnistui.")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ticket-form guide-editor">
      <label>
        <span>{t("Otsikko")}</span>
        <input value={title} maxLength={120} onChange={event => change(() => setTitle(event.target.value))} />
      </label>
      <label>
        <span>{t("Ohje")}</span>
        <textarea value={content} rows={5} maxLength={1500} onChange={event => change(() => setContent(event.target.value))} />
      </label>
      <fieldset className="role-choices">
        <legend>{t("Kenen ohje")}</legend>
        <label className="role-choice">
          <input type="radio" checked={scope === "company"} onChange={() => setScope("company")} />
          {t("Tämä taloyhtiö")}
        </label>
        {isAdmin() && (
          <label className="role-choice">
            <input type="radio" checked={scope === "office"} onChange={() => setScope("office")} />
            {t("Kaikki toimiston taloyhtiöt")}
          </label>
        )}
      </fieldset>
      {conflicts && conflicts.length > 0 && (
        <div className="send-error" role="alert">
          <strong>{t("Ohje voi olla ristiriidassa näiden kanssa:")}</strong>
          <ul>
            {conflicts.map(conflict => (
              <li key={conflict.chunkId}>{conflict.documentTitle}{conflict.title !== conflict.documentTitle ? ` · ${conflict.title}` : ""}: {conflict.reason}</li>
            ))}
          </ul>
          <small>{t("Korjaa ohje tai vanha tieto, tai tallenna silti.")}</small>
        </div>
      )}
      {!checked && <p className="reply-hint">{t("Ristiriitoja ei voitu tarkistaa, koska AI ei ole käytettävissä.")}</p>}
      {error && <p className="send-error">{error}</p>}
      <div className="draft-actions">
        <button type="button" className="primary" disabled={busy || !valid} onClick={() => void save()}>
          {busy ? t("Tarkistetaan…") : conflicts?.length ? t("Tallenna silti") : saveLabel}
        </button>
        {onCancel && <button type="button" className="secondary" disabled={busy} onClick={onCancel}>{t("Peruuta")}</button>}
        {extra}
      </div>
    </div>
  );
}
