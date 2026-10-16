import { useEffect, useState } from "react";
import { api, errorMessage, isManager } from "../session";
import type { KnowledgeDetail } from "../types";
import { t } from "../i18n";

type ComparedChunk = { id: string; title: string; content: string; page: number | null; origin: string; verified: number };
type ComparisonItem = {
  key: string;
  kind: "new" | "changed" | "removed" | "unchanged" | "conflict";
  oldChunk: ComparedChunk | null;
  newChunk: ComparedChunk | null;
};
type Comparison = {
  state: "processing" | "ready";
  previous: { id: string; title: string; version: number };
  items: ComparisonItem[];
};

const kindTitles: Record<ComparisonItem["kind"], string> = {
  conflict: t("Ristiriidat"),
  changed: t("Muuttuneet"),
  new: t("Uudet"),
  removed: t("Poistuneet"),
  unchanged: t("Ennallaan")
};

const kindHelp: Record<ComparisonItem["kind"], string> = {
  conflict: t("Tarkistamasi tai kirjoittamasi tieto muuttuisi. Sitä ei muuteta, ellet valitse uutta."),
  changed: t("Tieto muuttuu uuden version mukaiseksi."),
  new: t("Uusi tieto lisätään."),
  removed: t("Tietoa ei ole uudessa versiossa, joten se poistuu."),
  unchanged: t("Tieto säilyy ennallaan tarkistuksineen.")
};

function ChunkText({ label, chunk }: { label: string; chunk: ComparedChunk }) {
  return (
    <div className="version-chunk">
      <small>{label}{chunk.page ? ` · ${t("s. {0}", String(chunk.page))}` : ""}</small>
      <strong>{chunk.title}</strong>
      <p className="knowledge-content">{chunk.content}</p>
    </div>
  );
}

// Uuden version muutokset edelliseen ja niiden hyväksyminen. Vasta hyväksynnän jälkeen uusi versio
// korvaa vanhan.
export function KnowledgeVersionReview({ detail, onApplied, onRejected }: {
  detail: KnowledgeDetail;
  onApplied: () => Promise<void>;
  onRejected: () => Promise<void>;
}) {
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [failed, setFailed] = useState(false);
  const [oneByOne, setOneByOne] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, "accept" | "reject">>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let timer = 0;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await api<Comparison>(`/knowledge/${detail.id}/comparison`);
        if (cancelled) return;
        setComparison(result);
        setFailed(false);
        // Uutta versiota pilkotaan vielä; vertailu valmistuu sen jälkeen.
        if (result.state === "processing") timer = window.setTimeout(() => void load(), 3000);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [detail.id]);

  const decisionFor = (item: ComparisonItem) => decisions[item.key] ?? (item.kind === "conflict" ? "reject" : "accept");

  async function apply(withDecisions: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(`/knowledge/${detail.id}/apply-version`, {
        method: "POST",
        body: JSON.stringify({ decisions: withDecisions ? decisions : {} })
      });
      await onApplied();
    } catch (problem) {
      setError(errorMessage(problem, t("Hyväksyntä epäonnistui.")));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!window.confirm(t("Hylätäänkö uusi versio? Nykyinen versio jää voimaan."))) return;
    setBusy(true);
    try {
      await api(`/knowledge/${detail.id}`, { method: "DELETE" });
      await onRejected();
    } catch (problem) {
      setError(errorMessage(problem, t("Hylkäys epäonnistui.")));
    } finally {
      setBusy(false);
    }
  }

  if (failed) return <p className="send-error">{t("Muutosten lataus epäonnistui.")}</p>;
  if (!comparison) return <p className="muted">{t("Ladataan…")}</p>;

  const groups = (["conflict", "changed", "new", "removed", "unchanged"] as const)
    .map(kind => ({ kind, items: comparison.items.filter(item => item.kind === kind) }))
    .filter(group => group.items.length > 0);
  const canDecide = isManager();

  return (
    <section className="drawer-section version-review">
      <h3>{t("Muutokset edelliseen versioon")}</h3>
      <p className="muted">
        {t("Uusi versio odottaa hyväksyntää. AI käyttää edellistä versiota ({0}, versio {1}), kunnes hyväksyt muutokset.",
          comparison.previous.title, String(comparison.previous.version))}
      </p>
      {comparison.state === "processing" ? <p className="muted">{t("Uutta versiota käsitellään…")}</p> : (
        <>
          <p className="version-counts">
            {groups.map(group => (
              <span key={group.kind} className={`version-count ${group.kind}`}>{kindTitles[group.kind]}{" "}{group.items.length}</span>
            ))}
          </p>
          {groups.filter(group => oneByOne || group.kind !== "unchanged").map(group => (
            <div key={group.kind} className={`version-group ${group.kind}`}>
              <h4>{kindTitles[group.kind]}</h4>
              <p className="muted">{kindHelp[group.kind]}</p>
              {group.items.map(item => (
                <div key={item.key} className="version-item">
                  <div className="version-pair">
                    {item.oldChunk && <ChunkText label={t("Nyt")} chunk={item.oldChunk} />}
                    {item.newChunk && <ChunkText label={t("Uusi versio")} chunk={item.newChunk} />}
                  </div>
                  {oneByOne && item.kind !== "unchanged" && (
                    <div className="version-choice" role="radiogroup">
                      <label>
                        <input
                          type="radio"
                          checked={decisionFor(item) === "accept"}
                          onChange={() => setDecisions(current => ({ ...current, [item.key]: "accept" }))}
                        />
                        {item.kind === "removed" || (item.kind === "conflict" && !item.newChunk) ? t("Poista")
                          : item.kind === "new" ? t("Lisää") : t("Käytä uutta")}
                      </label>
                      <label>
                        <input
                          type="radio"
                          checked={decisionFor(item) === "reject"}
                          onChange={() => setDecisions(current => ({ ...current, [item.key]: "reject" }))}
                        />
                        {item.kind === "new" ? t("Älä lisää") : t("Säilytä nykyinen")}
                      </label>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
          {canDecide && (
            <div className="chunk-buttons">
              {oneByOne ? (
                <button type="button" className="primary" disabled={busy} onClick={() => void apply(true)}>{t("Hyväksy valinnat")}</button>
              ) : (
                <>
                  <button type="button" className="primary" disabled={busy} onClick={() => void apply(false)}>{t("Hyväksy muutokset")}</button>
                  <button type="button" className="secondary" onClick={() => setOneByOne(true)}>{t("Käy läpi yksitellen")}</button>
                </>
              )}
              <button type="button" className="secondary danger" disabled={busy} onClick={() => void reject()}>{t("Hylkää uusi versio")}</button>
            </div>
          )}
        </>
      )}
      {error && <p className="send-error">{error}</p>}
    </section>
  );
}
