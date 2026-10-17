import { useEffect, useState } from "react";
import { NoticeFilters, usePaged } from "../components/common";
import { ReporterCell } from "../components/Reporter";
import { formatDateOnly, formatTicketNumber, statusLabel } from "../format";
import { navigate } from "../routing";
import { api } from "../session";
import type { Company } from "../types";
import { t } from "../i18n";

// Lomakkeelta tullut tehtävä Lomakkeet-taulussa.
type FormRow = {
  ticketId: string;
  ticketNumber?: number;
  form: string;
  title: string;
  source: "email" | "portal";
  status: string;
  createdAt: string;
  subject: string;
  reporter: string;
  reporterEmail: string;
  apartmentNumber: string;
  linked: boolean;
  assigneeName: string;
  summary: { label: string; value: string }[];
  restricted: boolean;
};

// Lomaketyyppien välilehdet samassa järjestyksessä kuin verkkosivulla.
const FORM_TABS: { form: string; label: string }[] = [
  { form: "all", label: t("Kaikki") },
  { form: "meter", label: t("Mittarilukemat") },
  { form: "move", label: t("Muuttoilmoitukset") },
  { form: "service", label: t("Huoltotyötilaukset") },
  { form: "heating", label: t("Lämmityspaikat") },
  { form: "application", label: t("Asuntohakemukset") },
  { form: "disturbance", label: t("Häiriöilmoitukset") },
  { form: "termination", label: t("Irtisanomiset") }
];

const CLOSED = ["closed", "spam"];

// Lomakkeet: verkkosivun lomakkeilta sähköpostilla ja asukasportaalista tulleet ilmoitukset
// lomaketyypeittäin. Rivi avaa tehtävän, jolla on kaikki lomakkeen kentät.
export function FormSubmissions({ companies, defaultCompanyId = "" }: { companies: Company[]; defaultCompanyId?: string }) {
  const [rows, setRows] = useState<FormRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [companyFilter, setCompanyFilter] = useState(companies.some(company => company.id === defaultCompanyId) ? defaultCompanyId : "all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [formTab, setFormTab] = useState("all");

  const companyName = (id: string) => companies.find(company => company.id === id)?.name ?? "";

  useEffect(() => {
    void (async () => {
      try {
        const lists = await Promise.all(companies.map(async company =>
          (await api<FormRow[]>(`/companies/${encodeURIComponent(company.id)}/forms`)).map(row => ({ ...row, companyId: company.id }))));
        setRows(lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        setLoadError(false);
      } catch {
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [companies.length]);

  const inCompany = (rows as (FormRow & { companyId: string })[])
    .filter(row => companyFilter === "all" || row.companyId === companyFilter)
    .filter(row => statusFilter === "all" || (statusFilter === "open" ? !CLOSED.includes(row.status) : CLOSED.includes(row.status)));
  const visible = inCompany.filter(row => formTab === "all" || row.form === formTab);
  const paged = usePaged(visible, `${companyFilter}|${statusFilter}|${formTab}`);
  const showCompany = companies.length > 1 && companyFilter === "all";
  const count = (form: string) => inCompany.filter(row => form === "all" || row.form === form).length;

  return (
    <section className="content">
      <NoticeFilters
        companies={companies}
        company={companyFilter}
        onCompany={setCompanyFilter}
        status={statusFilter}
        onStatus={setStatusFilter}
        statuses={[{ value: "open", label: t("Keskeneräiset") }, { value: "closed", label: t("Suljetut") }]}
      />

      <div className="billing-tabs form-tabs" role="tablist" aria-label={t("Lomaketyyppi")}>
        {FORM_TABS.map(tab => (
          <button
            key={tab.form}
            role="tab"
            aria-selected={formTab === tab.form}
            className={formTab === tab.form ? "active" : ""}
            onClick={() => setFormTab(tab.form)}
          >
            {tab.label}
            <b>{count(tab.form)}</b>
          </button>
        ))}
      </div>

      {loading ? <div className="empty">{t("Ladataan…")}</div>
        : loadError ? <p className="send-error">{t("Lomakkeiden lataus epäonnistui.")}</p>
        : rows.length === 0 ? (
          <div className="empty">
            {t("Ei vielä lomakkeita. Verkkosivun lomakkeet tulevat tänne, kun toimiston sähköpostiin saapuu viesti, jonka otsikossa on lomakkeen nimi (esim. Huoltotyötilaus). Myös asukasportaalin lomakkeet näkyvät täällä.")}
          </div>
        )
        : visible.length === 0 ? <div className="empty">{t("Ei suodattimia vastaavia lomakkeita.")}</div>
        : (
          <div className="table-card">
            <table className="data-table report-topics notice-table form-table">
              <thead>
                <tr>
                  <th>{t("Tehtävä")}</th>
                  {formTab === "all" && <th>{t("Lomake")}</th>}
                  <th>{t("Ilmoittaja")}</th>
                  {showCompany && <th>{t("Taloyhtiö")}</th>}
                  <th>{t("Tiedot")}</th>
                  <th>{t("Tila")}</th>
                  <th>{t("Saapunut")}</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map(row => (
                  <tr
                    key={row.ticketId}
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    title={t("Avaa tehtävä")}
                    onClick={() => navigate("tickets", row.ticketId)}
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        navigate("tickets", row.ticketId);
                      }
                    }}
                  >
                    <td>#{formatTicketNumber(row.ticketNumber)}</td>
                    {formTab === "all" && <td><span className="type">{t(row.title)}</span></td>}
                    <td>
                      {row.restricted ? <span className="muted">🔒 {t("Arkaluonteinen tehtävä")}</span> : (
                        <>
                          <ReporterCell name={row.reporter} apartment={row.apartmentNumber} email={row.reporterEmail} fallback={t("Ei ilmoittajaa")} />
                          {!row.linked && row.reporter && <span className="late-note">{t("Ei liitetty asukastauluun")}</span>}
                        </>
                      )}
                    </td>
                    {showCompany && <td>{companyName(row.companyId)}</td>}
                    <td>
                      <dl className="form-summary">
                        {row.summary.map(field => (
                          <div key={field.label}>
                            <dt>{t(field.label)}</dt>
                            <dd>{field.value.length > 90 ? `${field.value.slice(0, 90)}…` : field.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </td>
                    <td>
                      <span className={`status-badge status-${row.status}`}>{statusLabel(row.status)}</span>
                      {row.assigneeName && <span>{row.assigneeName}</span>}
                    </td>
                    <td>
                      {formatDateOnly(row.createdAt)}
                      <span className="muted">{row.source === "email" ? t("Sähköposti") : t("Asukasportaali")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {paged.pager}
    </section>
  );
}
