import { t } from "../i18n";

// Verkkosivun lomakkeen kentät tietueella (lukema, muuttoilmoitus, lämmityspaikkatilaus). Palvelin
// antaa kentät otsikoineen ja tyyppeineen, joten sama komponentti näyttää ja muokkaa kaikkia.
export type DetailField = { key: string; label: string; type: "text" | "tel" | "email" | "select"; options: string[]; value: string };

export const detailValues = (fields: DetailField[] = []) => Object.fromEntries(fields.map(field => [field.key, field.value]));
export const detailValue = (fields: DetailField[] | undefined, key: string) => fields?.find(field => field.key === key)?.value ?? "";

// Lähde listassa ja tietueella.
export function sourceLabel(source?: string | null) {
  return source === "email" ? t("verkkosivun lomake") : source === "portal" ? t("asukasportaali") : t("toimisto");
}

export function DetailFacts({ title, fields }: { title: string; fields?: DetailField[] }) {
  const filled = (fields ?? []).filter(field => field.value);
  if (filled.length === 0) return null;
  return (
    <section className="ticket-form-card detail-facts">
      <h3>{title}</h3>
      <dl>
        {filled.map(field => (
          <div key={field.key}>
            <dt>{t(field.label)}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function DetailEditor({ title, fields, values, onChange }: {
  title: string;
  fields: DetailField[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  return (
    <fieldset className="detail-editor">
      <legend>{title}</legend>
      {fields.map(field => {
        const current = values[field.key] ?? "";
        const set = (value: string) => onChange({ ...values, [field.key]: value });
        return (
          <label key={field.key}>
            <span>{t(field.label)}</span>
            {field.type === "select" ? (
              <select value={current} onChange={event => set(event.target.value)}>
                <option value="">–</option>
                {/* Lomakkeelta tullut arvo säilyy, vaikka se ei olisi valmiissa vaihtoehdoissa. */}
                {[...field.options, ...(current && !field.options.includes(current) ? [current] : [])].map(option => (
                  <option key={option} value={option}>{t(option)}</option>
                ))}
              </select>
            ) : (
              <input type={field.type} value={current} onChange={event => set(event.target.value)} maxLength={500} />
            )}
          </label>
        );
      })}
    </fieldset>
  );
}
