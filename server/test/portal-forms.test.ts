import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, PASSWORD, startServer, type TestServer } from "./helpers.js";

describe("asukasportaalin lomakkeet", () => {
  let server: TestServer;
  let admin: string;
  let manager: string;
  let resident: string;

  before(async () => {
    server = await startServer();
    admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34", password: PASSWORD
    });
    resident = await login(server, "liisa@example.com");
  });

  after(() => server.stop());

  async function form(ticketId: string) {
    const detail = (await call(server, manager, "GET", `/tickets/${ticketId}`)).data;
    return { ticket: detail.ticket, form: detail.form as { title: string; fields: { label: string; value: string }[] } };
  }

  it("huoltotyötilaus luo tehtävän, jolla kentät näkyvät otsikoineen", async () => {
    const created = await call(server, resident, "POST", "/portal/forms/service", {
      target: "Oma asunto", location: "Keittiö", description: "Astianpesukoneen alta tihkuu vettä.",
      entry: "Huolto saa mennä asuntoon yleisavaimella", pets: true, phone: "040 123 4567"
    });
    assert.equal(created.status, 201);
    const { ticket, form: data } = await form(created.data.ticketId);
    assert.equal(ticket.type, "Huoltotyötilaus");
    assert.equal(ticket.subject, "Huoltotyötilaus: Oma asunto – Keittiö");
    assert.equal(ticket.resident_id, "resident-2");
    assert.equal(data.title, "Huoltotyötilaus");
    assert.deepEqual(data.fields.find(field => field.label === "Asuntoon pääsy")?.value, "Huolto saa mennä asuntoon yleisavaimella");
    assert.deepEqual(data.fields.find(field => field.label === "Asunnossa on lemmikki")?.value, "Kyllä");

    // Asukas näkee lomakkeen omissa tehtävissään.
    const own = (await call(server, resident, "GET", "/portal/tickets")).data as { id: string; type: string }[];
    assert.ok(own.some(item => item.id === created.data.ticketId && item.type === "Huoltotyötilaus"));
  });

  it("häiriöilmoitus, irtisanomisilmoitus ja asuntohakemus", async () => {
    const disturbance = await call(server, resident, "POST", "/portal/forms/disturbance", {
      category: "Melu", source: "Asunto B 36", date: "2026-10-15", time: "23–02", recurring: true,
      description: "Kova musiikki yöllä useana iltana.", discussed: false, nameAllowed: false
    });
    assert.equal(disturbance.status, 201);
    const disturbanceForm = await form(disturbance.data.ticketId);
    assert.equal(disturbanceForm.ticket.subject, "Häiriöilmoitus: Melu – Asunto B 36");
    assert.equal(disturbanceForm.form.fields.find(field => field.label === "Ajankohta")?.value, "15.10.2026 klo 23–02");

    // Liian aikainen päättymispäivä hyväksytään, mutta isännöitsijälle näytetään huomio.
    const termination = await call(server, resident, "POST", "/portal/forms/termination", {
      endDate: "2026-01-01", tenants: "Liisa Mallikas", newAddress: "Uusikatu 1, Tampere", confirm: true
    });
    assert.equal(termination.status, 201);
    const terminationForm = await form(termination.data.ticketId);
    assert.equal(terminationForm.ticket.type, "Irtisanomisilmoitus");
    assert.match(terminationForm.ticket.subject, /^Irtisanomisilmoitus: asunto .+, päättyy 1\.1\.2026$/);
    assert.ok(terminationForm.form.fields.some(field => field.label === "Huomio"));

    const application = await call(server, resident, "POST", "/portal/forms/application", {
      sizes: ["Kaksio", "Kolmio"], area: "Keskusta", maxRent: 900, moveDate: "", adults: 2, children: 1, pets: false, reason: "Perhe kasvaa."
    });
    assert.equal(application.status, 201);
    const applicationForm = await form(application.data.ticketId);
    assert.equal(applicationForm.ticket.subject, "Asuntohakemus: Kaksio, Kolmio");
    assert.equal(applicationForm.form.fields.find(field => field.label === "Vuokra enintään")?.value, "900 €/kk");
  });

  it("virheellinen lomake hylätään, eikä henkilökunta voi käyttää portaalin lomakkeita", async () => {
    assert.equal((await call(server, resident, "POST", "/portal/forms/termination", {
      endDate: "2027-01-31", tenants: "Liisa Mallikas", confirm: false
    })).status, 400);
    assert.equal((await call(server, resident, "POST", "/portal/forms/service", { target: "Kellari", description: "Vika" })).status, 400);
    assert.equal((await call(server, resident, "POST", "/portal/forms/tuntematon", {})).status, 404);
    assert.equal((await call(server, resident, "POST", "/portal/forms/__proto__", {})).status, 404);
    assert.equal((await call(server, manager, "POST", "/portal/forms/service", {
      target: "Oma asunto", description: "Hana vuotaa keittiössä."
    })).status, 403);
  });

  it("asukas voi jonottaa lämmityspaikkaa", async () => {
    const joined = await call(server, resident, "POST", "/portal/waitlist", { resource: "parking", parkingType: "Lämmityspaikka", note: "" });
    assert.equal(joined.status, 201);
    const prices = await call(server, admin, "PUT", "/companies/demo-company/parking-prices", { Autotalli: 60, Ulkopaikka: 20, Hallipaikka: 45 });
    assert.equal(prices.status, 200);
    assert.equal(prices.data["Lämmityspaikka"], 0);
  });
});
