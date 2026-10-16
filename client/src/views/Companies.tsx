import { type FormEvent, useEffect, useState } from "react";
import { usePaged } from "../components/common";
import { api, isManager, type OfficeUser } from "../session";
import type { Company } from "../types";
import { BoardMembersCard } from "./Board";
import { BookingCalendar } from "./Bookings";
import { KnowledgeBase } from "./Knowledge";
import { ParkingSpaces } from "./Parking";
import { Residents } from "./Residents";
import { BookingSettings, MailAccountCard } from "./Settings";
import { t } from "../i18n";

export function Companies({
  companies,
  openCompanyId,
  onOpenCompany: setOpenCompanyId,
  onChanged
}: {
  companies: Company[];
  openCompanyId: string | null;
  onOpenCompany: (companyId: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [detailTab, setDetailTab] = useState<"residents" | "material" | "sauna" | "laundry" | "parking">("residents");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  function closeForm() {
    setAdding(false);
    setFormError("");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError("");
    try {
      await api("/companies", {
        method: "POST",
        body: JSON.stringify({ name, businessId, address, phone, emailAddress })
      });
      setName("");
      setBusinessId("");
      setAddress("");
      setPhone("");
      setEmailAddress("");
      setAdding(false);
      await onChanged();
    } catch (error) {
      let message = t("Taloyhtiön lisääminen epäonnistui.");
      try {
        message = JSON.parse((error as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  const pagedCompanies = usePaged(companies, "");
  const openCompany = companies.find(company => company.id === openCompanyId);

  if (openCompany) {
    return (
      <section className="content">
        <button className="back-link" onClick={() => setOpenCompanyId(null)}>{t("← Kaikki taloyhtiöt")}</button>

        <CompanyCard company={openCompany} onSaved={onChanged} />
        <MailAccountCard target={openCompany.id} />
        <BoardMembersCard key={`board-${openCompany.id}`} companyId={openCompany.id} />
        <BookingSettings key={openCompany.id} companyId={openCompany.id} />

        <div className="card-tabs">
          <button className={detailTab === "residents" ? "active" : ""} onClick={() => setDetailTab("residents")}>
            {t("Asukkaat")}
          </button>
          <button className={detailTab === "material" ? "active" : ""} onClick={() => setDetailTab("material")}>
            {t("Materiaalit")}
          </button>
          <button className={detailTab === "sauna" ? "active" : ""} onClick={() => setDetailTab("sauna")}>
            {t("Saunavuorot")}
          </button>
          <button className={detailTab === "laundry" ? "active" : ""} onClick={() => setDetailTab("laundry")}>
            {t("Pyykkitupavuorot")}
          </button>
          <button className={detailTab === "parking" ? "active" : ""} onClick={() => setDetailTab("parking")}>
            {t("Autopaikat")}
          </button>
        </div>
        {detailTab === "residents" ? (
          <Residents
            companyId={openCompany.id}
            companies={companies}
            onChanged={onChanged}
          />
        ) : detailTab === "material" ? (
          <KnowledgeBase companyId={openCompany.id} />
        ) : detailTab === "parking" ? (
          <ParkingSpaces key={openCompany.id} embedded companies={[openCompany]} defaultCompanyId={openCompany.id} />
        ) : (
          <BookingCalendar
            key={`${openCompany.id}-${detailTab}`}
            embedded
            resource={detailTab}
            companyId={openCompany.id}
            companies={[openCompany]}
            onCompanyChange={() => undefined}
          />
        )}
      </section>
    );
  }

  return (
    <section className="content">
      <div className="residents-toolbar">
        <span>{companies.length}{" "}{t("taloyhtiötä")}</span>
        {isManager() && <button className="secondary" onClick={() => setAdding(true)}>{t("Lisää taloyhtiö")}</button>}
      </div>

      {companies.length === 0 ? <div className="empty">{t("Ei taloyhtiöitä.")}</div> : (
        <div className="table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("Nimi")}</th>
                <th>{t("Y-tunnus")}</th>
                <th>{t("Osoite")}</th>
                <th>{t("Puhelin")}</th>
                <th>{t("Sähköposti")}</th>
                <th>{t("Vastuuisännöitsijä")}</th>
                <th>{t("Asukkaita")}</th>
              </tr>
            </thead>
            <tbody>
              {pagedCompanies.items.map(company => (
                <tr
                  key={company.id}
                  className="clickable"
                  title={t("Avaa taloyhtiön tiedot ja asukkaat")}
                  onClick={() => setOpenCompanyId(company.id)}
                  onKeyDown={event => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setOpenCompanyId(company.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <td><strong>{company.name}</strong></td>
                  <td>{company.business_id || "–"}</td>
                  <td>{company.address || "–"}</td>
                  <td>{company.phone || "–"}</td>
                  <td>{company.email_address || "–"}</td>
                  <td>{company.manager_name || "–"}</td>
                  <td>{company.resident_count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pagedCompanies.pager}

      {adding && (
        <div className="overlay">
          <aside className="drawer form-drawer">
            <button type="button" className="drawer-back" onClick={closeForm}>{t("← Takaisin")}</button>
            <button className="close" onClick={closeForm}>×</button>
            <h2>{t("Lisää taloyhtiö")}</h2>
            <p className="muted">{t("Taloyhtiö tulee valittavaksi tehtävänäkymiin ja asukastietokantaan.")}</p>

            <form className="ticket-form" onSubmit={handleSubmit}>
              <label>
                <span>{t("Nimi")}</span>
                <input value={name} onChange={event => setName(event.target.value)} placeholder={t("Esim. As Oy Koivikko")} />
              </label>

              <label>
                <span>{t("Y-tunnus")}</span>
                <input value={businessId} onChange={event => setBusinessId(event.target.value)} placeholder={t("Valinnainen")} />
              </label>

              <label>
                <span>{t("Osoite")}</span>
                <input value={address} onChange={event => setAddress(event.target.value)} placeholder={t("Valinnainen")} />
              </label>

              <label>
                <span>{t("Puhelin")}</span>
                <input value={phone} onChange={event => setPhone(event.target.value)} placeholder={t("Valinnainen")} />
              </label>

              <label>
                <span>{t("Sähköposti, johon tehtävät saapuvat")}</span>
                <input type="email" value={emailAddress} onChange={event => setEmailAddress(event.target.value)} placeholder={t("Valinnainen")} />
              </label>

              {formError && <p className="send-error">{formError}</p>}

              <div className="drawer-actions compact-actions">
                <button type="button" onClick={closeForm}>{t("Peruuta")}</button>
                <button className="primary" type="submit" disabled={submitting || !name.trim()}>
                  {submitting ? t("Lisätään…") : t("Lisää taloyhtiö")}
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </section>
  );
}

function CompanyCard({
  company,
  onSaved
}: {
  company: Company;
  onSaved: () => Promise<void>;
}) {
  const initialValues = {
    name: company.name,
    businessId: company.business_id ?? "",
    address: company.address ?? "",
    phone: company.phone ?? "",
    emailAddress: company.email_address ?? "",
    managerId: company.manager_id ?? "",
    // Muut isännöitsijät pilkuilla erotettuna, jotta muutoksen tunnistus toimii kuten muissa kentissä.
    managerIds: [...(company.manager_ids ?? [])].sort().join(","),
    maintenanceName: company.maintenance_name ?? "",
    maintenancePhone: company.maintenance_phone ?? "",
    maintenanceEmail: company.maintenance_email ?? "",
    maintenanceEmergencyPhone: company.maintenance_emergency_phone ?? ""
  };
  const [values, setValues] = useState(initialValues);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  // Vastuuisännöitsijäksi voi valita isännöitsijän tai pääkäyttäjän.
  const [managers, setManagers] = useState<OfficeUser[]>([]);
  useEffect(() => {
    api<OfficeUser[]>("/users")
      .then(users => setManagers(users.filter(user => user.role === "Isännöitsijä" || user.role === "Pääkäyttäjä")))
      .catch(() => setManagers([]));
  }, []);

  useEffect(() => {
    setValues(initialValues);
    setSaved(false);
    setError("");
  }, [company.id]);

  function field(key: keyof typeof initialValues) {
    return {
      value: values[key],
      onChange: (event: { target: { value: string } }) => {
        setValues(prev => ({ ...prev, [key]: event.target.value }));
        setSaved(false);
      }
    };
  }

  const dirty = (Object.keys(initialValues) as (keyof typeof initialValues)[])
    .some(key => values[key] !== initialValues[key]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await api(`/companies/${encodeURIComponent(company.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: values.name,
          businessId: values.businessId,
          address: values.address,
          phone: values.phone,
          emailAddress: values.emailAddress,
          managerId: values.managerId || null,
          managerIds: values.managerIds.split(",").filter(id => id && id !== values.managerId),
          maintenance: {
            name: values.maintenanceName,
            phone: values.maintenancePhone,
            email: values.maintenanceEmail,
            emergencyPhone: values.maintenanceEmergencyPhone
          }
        })
      });
      await onSaved();
      setSaved(true);
    } catch (caught) {
      let message = t("Tietojen tallennus epäonnistui.");
      try {
        message = JSON.parse((caught as Error).message).error || message;
      } catch {
        // Palvelin ei palauttanut JSON-virhettä.
      }
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-card ticket-form" onSubmit={handleSubmit}>
      <h2>{t("Taloyhtiön tiedot")}</h2>
      <div className="form-columns">
        <label>
          <span>{t("Nimi")}</span>
          <input {...field("name")} />
        </label>
        <label>
          <span>{t("Y-tunnus")}</span>
          <input {...field("businessId")} />
        </label>
        <label>
          <span>{t("Osoite")}</span>
          <input {...field("address")} />
        </label>
        <label>
          <span>{t("Puhelin")}</span>
          <input {...field("phone")} />
        </label>
        <label>
          <span>{t("Sähköposti, johon tehtävät saapuvat")}</span>
          <input type="email" {...field("emailAddress")} />
        </label>
        <label>
          <span>{t("Vastuuisännöitsijä")}</span>
          <select {...field("managerId")}>
            <option value="">{t("Ei valittu")}</option>
            {managers.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </label>
        <fieldset className="manager-picks">
          <legend>{t("Muut isännöitsijät")}</legend>
          {managers.filter(user => user.id !== values.managerId).map(user => {
            const selectedIds = values.managerIds.split(",").filter(Boolean);
            const checked = selectedIds.includes(user.id);
            return (
              <label key={user.id} className={checked ? "checked" : ""}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = checked ? selectedIds.filter(id => id !== user.id) : [...selectedIds, user.id];
                    setValues(prev => ({ ...prev, managerIds: next.sort().join(",") }));
                    setSaved(false);
                  }}
                />
                {user.name}
              </label>
            );
          })}
          {managers.filter(user => user.id !== values.managerId).length === 0 && <span className="muted">{t("Ei muita isännöitsijöitä.")}</span>}
        </fieldset>
      </div>

      <h2>{t("Huoltoyhtiön tiedot")}</h2>
      <div className="form-columns">
        <label>
          <span>{t("Huoltoyhtiön nimi")}</span>
          <input {...field("maintenanceName")} />
        </label>
        <label>
          <span>{t("Sähköposti")}</span>
          <input type="email" {...field("maintenanceEmail")} />
        </label>
        <label>
          <span>{t("Puhelin")}</span>
          <input {...field("maintenancePhone")} />
        </label>
        <label>
          <span>{t("Päivystysnumero")}</span>
          <input {...field("maintenanceEmergencyPhone")} />
        </label>
      </div>

      {error && <p className="send-error">{error}</p>}

      {isManager() ? (
        <div className="draft-actions">
          <button className="primary" type="submit" disabled={saving || !dirty || !values.name.trim()}>
            {saving ? t("Tallennetaan…") : t("Tallenna muutokset")}
          </button>
          {saved && !dirty && <span className="saved-indicator">{t("Tallennettu")}</span>}
        </div>
      ) : (
        <p className="reply-hint">{t("Taloyhtiön tietoja voi muuttaa isännöitsijä tai pääkäyttäjä.")}</p>
      )}
    </form>
  );
}
