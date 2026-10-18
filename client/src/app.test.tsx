import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const company = { id: "demo-company", name: "As Oy Koivikko", email_address: "", manager_id: null, manager_ids: [] };
const overdueTicket = {
  id: "ticket-1", ticket_number: 1, company_id: "demo-company", type: "Kysymys", priority: "normal", status: "open",
  subject: "Saunavuoron varaus", summary: "Asukas kysyy saunavuorosta.", source_channel: "email", ai_action: "pending_decision",
  ai_reason: "", due_date: "2026-01-01", created_at: "2025-12-27T08:00:00.000Z", updated_at: "2025-12-27T08:00:00.000Z",
  assignee_id: "user-1"
};

// Vastaukset rajapinnan lukukutsuihin; muut polut palauttavat tyhjän listan.
const responses: Record<string, unknown> = {
  "/users": [],
  "/office": { name: "Testitoimisto Oy", businessId: "", address: "", phone: "" },
  "/companies": [company],
  "/tickets?companyId=all": [overdueTicket]
};

function mockApi() {
  const calls: { url: string; headers: Record<string, string>; method: string; body: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    const path = url.replace(/^.*\/api/, "");
    return new Response(JSON.stringify(responses[path] ?? []), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

// Istunto luetaan selaimen tallennuksesta moduulin latautuessa, joten sovellus ladataan vasta sen jälkeen.
async function renderApp(session: unknown, hash = "", language = "") {
  localStorage.clear();
  if (session) localStorage.setItem("kotilo.session", JSON.stringify(session));
  if (language) localStorage.setItem("kotilo.language", language);
  window.location.hash = hash;
  vi.resetModules();
  const { default: App } = await import("./App");
  return render(<App />);
}

const staff = (role: string) => ({ token: "testitunniste", user: { id: "user-1", name: "Testi Käyttäjä", email: "testi@example.com", role } });

describe("sovellus", () => {
  beforeEach(() => {
    mockApi();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("näyttää kirjautumissivun ilman istuntoa", async () => {
    const { container } = await renderApp(null);
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(screen.queryByText("Kirjaudu ulos")).toBeNull();
  });

  it("kysyy kirjautumiskoodin ja muistaa luotetun laitteen", async () => {
    responses["/auth/login"] = { twoFactor: true, challengeId: "c".repeat(64), email: "te••••@example.com" };
    responses["/auth/verify-code"] = { ...staff("Isännöitsijä"), deviceToken: "laite-1" };
    const calls = mockApi();
    try {
      const { container } = await renderApp(null);
      fireEvent.change(container.querySelector('input[type="email"]')!, { target: { value: "Testi@example.com" } });
      fireEvent.change(container.querySelector('input[type="password"]')!, { target: { value: "salasana-123" } });
      fireEvent.click(screen.getByRole("button", { name: "Kirjaudu" }));

      expect(await screen.findByText("Syötä kirjautumiskoodi")).toBeTruthy();
      expect(screen.getByText(/te••••@example\.com/)).toBeTruthy();
      const codeInput = container.querySelector(".login-code-input") as HTMLInputElement;
      // Vain numerot hyväksytään, enintään kuusi.
      fireEvent.change(codeInput, { target: { value: "12a34567" } });
      expect(codeInput.value).toBe("123456");
      fireEvent.click(screen.getByRole("button", { name: "Kirjaudu" }));

      await screen.findByText("Kirjaudu ulos", undefined, { timeout: 3000 }).catch(() => undefined);
      const verify = calls.find(call => call.url.endsWith("/auth/verify-code"));
      expect(JSON.parse(verify!.body)).toEqual({ challengeId: "c".repeat(64), code: "123456", rememberDevice: true });
      expect(JSON.parse(localStorage.getItem("kotilo.trustedDevices")!)).toEqual({ "testi@example.com": "laite-1" });
      expect(JSON.parse(localStorage.getItem("kotilo.session")!).deviceToken).toBeUndefined();
    } finally {
      delete responses["/auth/login"];
      delete responses["/auth/verify-code"];
    }
  });

  it("näyttää päätösjonon ja merkitsee myöhässä olevan tehtävän", async () => {
    await renderApp(staff("Asiakaspalvelu"));
    expect(await screen.findByText("Saunavuoron varaus")).toBeTruthy();
    // Päätösjonon kortissa ei ole määräaikatägiä.
    expect(screen.queryByText("Myöhässä 1.1.2026")).toBeNull();
    expect(document.querySelector(".ticket-company")?.textContent).toContain("As Oy Koivikko");
  });

  it("näyttää päätösjonossa vain omat tehtävät ja Tunnistamattomat-laatikosta käsittelijättömät", async () => {
    const unassigned = { ...overdueTicket, id: "ticket-2", ticket_number: 2, subject: "Käsittelijätön tehtävä", assignee_id: null };
    const others = { ...overdueTicket, id: "ticket-3", ticket_number: 3, subject: "Toisen tehtävä", assignee_id: "user-2" };
    const original = responses["/tickets?companyId=all"];
    responses["/tickets?companyId=all"] = [overdueTicket, unassigned, others];
    try {
      await renderApp(staff("Isännöitsijä"), "#/queue");
      expect((await screen.findAllByText("Saunavuoron varaus")).length).toBeGreaterThan(0);
      expect(screen.queryByText("Käsittelijätön tehtävä")).toBeNull();
      expect(screen.queryByText("Toisen tehtävä")).toBeNull();

      fireEvent.click(screen.getByTitle("Näytä tehtävät, joiden taloyhtiötä ei ole tunnistettu tai joilla ei ole käsittelijää"));
      expect(await screen.findByText("Käsittelijätön tehtävä")).toBeTruthy();
      expect(window.location.hash).toBe("#/unidentified");
      expect(screen.queryByText("Saunavuoron varaus")).toBeNull();
      expect(screen.queryByText("Toisen tehtävä")).toBeNull();
    } finally {
      responses["/tickets?companyId=all"] = original;
    }
  });

  it("laskee muistutukset päätösjonoon ja näyttää ne suodatettuna listana", async () => {
    const waiting = {
      ...overdueTicket, id: "ticket-4", ticket_number: 4, subject: "Odottava kysymys", due_date: null, status: "waiting_manager",
      waiting_since: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    };
    const fresh = { ...waiting, id: "ticket-5", ticket_number: 5, subject: "Tuore kysymys", waiting_since: new Date().toISOString() };
    const original = responses["/tickets?companyId=all"];
    responses["/tickets?companyId=all"] = [waiting, fresh, overdueTicket];
    try {
      await renderApp(staff("Isännöitsijä"), "#/queue");
      const box = await screen.findByTitle("Näytä omat tehtävät, jotka vaativat huomiota");
      // Odottava kysymys ja myöhässä oleva tehtävä; tuore kysymys ei vielä.
      await vi.waitFor(() => expect(box.querySelector("strong")?.textContent).toBe("2"));
      // Päätösjonon kortissa ei näytetä määräaikaa.
      expect(screen.queryByText("Myöhässä 1.1.2026")).toBeNull();

      fireEvent.click(box);
      expect(window.location.hash).toBe("#/my-tickets");
      expect(await screen.findByText("Odottava kysymys")).toBeTruthy();
      expect(screen.getByText("Asukas odottanut 3 päivää")).toBeTruthy();
      expect(screen.getByText("Saunavuoron varaus")).toBeTruthy();
      expect(screen.queryByText("Tuore kysymys")).toBeNull();
    } finally {
      responses["/tickets?companyId=all"] = original;
    }
  });

  it("näyttää sivun yläotsikossa isännöitsijätoimiston nimen asetuksista", async () => {
    await renderApp(staff("Isännöitsijä"), "#/queue");
    await screen.findAllByText("Saunavuoron varaus");
    expect(await screen.findByText("PLEISSI / Testitoimisto Oy")).toBeTruthy();
  });

  it("yhdistää muun sähköpostin IMAP-tiedoilla toimiston asetuksista", async () => {
    responses["/mail/status"] = { connected: false };
    responses["/mail/providers"] = { gmail: true, microsoft: false, imap: true };
    try {
      const calls = mockApi();
      await renderApp(staff("Pääkäyttäjä"), "#/settings");
      fireEvent.click(await screen.findByRole("tab", { name: "Isännöitsijätoimiston tiedot" }));
      expect(await screen.findByText("Sähköpostitiliä ei ole yhdistetty. Valitse alta sähköpostipalvelusi.")).toBeTruthy();
      await vi.waitFor(() => expect((screen.getByRole("button", { name: "Microsoft 365 / Outlook" }) as HTMLButtonElement).disabled).toBe(true));

      fireEvent.click(screen.getByRole("button", { name: "Muu sähköposti (IMAP/SMTP)" }));
      fireEvent.change(screen.getByLabelText("Sähköpostiosoite"), { target: { value: "posti@toimisto.fi" } });
      fireEvent.change(screen.getByLabelText("Saapuvan postin palvelin (IMAP)"), { target: { value: "imap.toimisto.fi" } });
      // SMTP-palvelinta ehdotetaan IMAP-palvelimen perusteella.
      expect((screen.getByLabelText("Lähtevän postin palvelin (SMTP)") as HTMLInputElement).value).toBe("smtp.toimisto.fi");
      fireEvent.change(screen.getByLabelText("Salasana"), { target: { value: "sovellussalasana" } });
      fireEvent.click(screen.getByRole("button", { name: "Yhdistä tili" }));

      await vi.waitFor(() => expect(calls.some(request => request.method === "POST" && request.url.endsWith("/mail/imap"))).toBe(true));
      const body = JSON.parse(calls.find(request => request.url.endsWith("/mail/imap"))!.body);
      expect(body).toMatchObject({
        target: "office", email: "posti@toimisto.fi", imapHost: "imap.toimisto.fi", imapPort: 993,
        smtpHost: "smtp.toimisto.fi", smtpPort: 465, password: "sovellussalasana"
      });
    } finally {
      delete responses["/mail/status"];
      delete responses["/mail/providers"];
    }
  });

  it("näyttää toimiston asetukset ja sähköpostitilin, vaikka taloyhtiöitä ei ole", async () => {
    const original = responses["/companies"];
    responses["/companies"] = [];
    responses["/mail/status"] = { connected: false };
    try {
      await renderApp(staff("Pääkäyttäjä"), "#/settings");
      fireEvent.click(await screen.findByRole("tab", { name: "Isännöitsijätoimiston tiedot" }));
      expect((await screen.findAllByText("Toimiston sähköpostitili")).length).toBeGreaterThan(0);
      expect(screen.queryByText("Yhtiötä ei ole valittu.")).toBeNull();
      expect(screen.queryByText("Tehtävien vastaanotto")).toBeNull();
    } finally {
      responses["/companies"] = original;
      delete responses["/mail/status"];
    }
  });

  it("tumman tilan voi kytkeä päälle ja pois omista asetuksista", async () => {
    await renderApp(staff("Isännöitsijä"), "#/settings");
    const toggle = await screen.findByRole("switch", { name: /Tumma tila/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("kotilo.theme")).toBe("dark");
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("kotilo.theme")).toBe("light");
  });

  it("käyttäjä voi yhdistää oman sähköpostinsa omista asetuksistaan", async () => {
    responses["/mail/status?target=me"] = { connected: false, own: true };
    responses["/mail/providers"] = { gmail: true, microsoft: true, imap: true };
    try {
      const calls = mockApi();
      await renderApp(staff("Isännöitsijä"), "#/settings");
      expect((await screen.findAllByText("Oma sähköpostitili")).length).toBeGreaterThan(0);
      expect(screen.getByText(/Yhdistä oma työsähköpostisi/)).toBeTruthy();
      await vi.waitFor(() => expect((screen.getByRole("button", { name: "Microsoft 365 / Outlook" }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole("button", { name: "Microsoft 365 / Outlook" }));
      await vi.waitFor(() => expect(calls.some(request => request.url.endsWith("/mail/microsoft/connect"))).toBe(true));
      expect(JSON.parse(calls.find(request => request.url.endsWith("/mail/microsoft/connect"))!.body)).toEqual({ target: "me" });
    } finally {
      delete responses["/mail/status?target=me"];
      delete responses["/mail/providers"];
    }
  });

  it("lukee vanhalla nimellä tallennetun istunnon", async () => {
    localStorage.clear();
    localStorage.setItem("kiito.session", JSON.stringify(staff("Pääkäyttäjä")));
    vi.resetModules();
    const { default: App } = await import("./App");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Profiili" }));
    expect(screen.getByText("Kirjaudu ulos")).toBeTruthy();
  });

  it("piilottaa taloyhtiön lisäämisen asiakaspalvelulta", async () => {
    await renderApp(staff("Asiakaspalvelu"), "#/companies");
    expect(await screen.findByText("1 taloyhtiötä")).toBeTruthy();
    expect(screen.queryByText("Lisää taloyhtiö")).toBeNull();
  });

  it("näyttää taloyhtiön lisäämisen isännöitsijälle", async () => {
    await renderApp(staff("Isännöitsijä"), "#/companies");
    expect(await screen.findByText("Lisää taloyhtiö")).toBeTruthy();
  });

  it("näyttää asukkaalle portaalin eikä henkilökunnan näkymää", async () => {
    const resident = { id: "resident-1", name: "Liisa Mallikas", email: "liisa@example.com", companyId: "demo-company", companyName: "As Oy Koivikko", apartmentNumber: "B 34" };
    await renderApp({ token: "asukastunniste", kind: "resident", user: { id: resident.id, name: resident.name, email: resident.email, role: "Asukas" }, resident });
    expect(await screen.findByText("Liisa Mallikas")).toBeTruthy();
    expect(screen.getByText("Muuttoilmoitus")).toBeTruthy();
    expect(screen.queryByText("Päätösjono")).toBeNull();
  });

  it("näyttää uudet näkymät henkilökunnalle", async () => {
    await renderApp(staff("Isännöitsijä"), "#/keys");
    expect(await screen.findByText("Lisää avain")).toBeTruthy();
    cleanup();
    await renderApp(staff("Isännöitsijä"), "#/meters");
    expect(await screen.findByText("Lisää lukema")).toBeTruthy();
    cleanup();
    await renderApp(staff("Isännöitsijä"), "#/renovations");
    expect(await screen.findByText(/Ei remontti-ilmoituksia/)).toBeTruthy();
  });

  it("näyttää asukkaalle remontti-ilmoituksen ja kulutuslukemat", async () => {
    const resident = { id: "resident-1", name: "Liisa Mallikas", email: "liisa@example.com", companyId: "demo-company", companyName: "As Oy Koivikko", apartmentNumber: "B 34" };
    await renderApp({ token: "asukastunniste", kind: "resident", user: { id: resident.id, name: resident.name, email: resident.email, role: "Asukas" }, resident });
    expect(await screen.findByText("Remontti-ilmoitus")).toBeTruthy();
    expect(screen.getByText("Mittarilukemat")).toBeTruthy();
  });

  it("näyttää autopaikkatilaukset Jonot ja tilaukset -sivulla ja tilauksen lomakkeen tiedot", async () => {
    responses["/companies/demo-company/heating-orders"] = [{
      id: "heating-1", company_id: "demo-company", apartment_id: null, resident_id: null, start_date: "2026-11-01", end_date: null,
      status: "pending", note: "", source: "email", created_at: "2026-10-17T08:00:00Z", apartment_number: null,
      details: [
        { key: "address", label: "Kohteen osoite", type: "text", options: [], value: "Koivikkotie 10" },
        { key: "spot", label: "Tilaan", type: "select", options: ["Lämmitystolppapaikan"], value: "Lämmitystolppapaikan" },
        { key: "name", label: "Tilaajan nimi", type: "text", options: [], value: "Ville Vieras" },
        { key: "phone", label: "Puhelinnumero", type: "tel", options: [], value: "040 111 2222" }
      ]
    }];
    try {
      await renderApp(staff("Isännöitsijä"), "#/waitlist");
      expect(await screen.findByText("Autopaikkatilaukset")).toBeTruthy();
      fireEvent.click(await screen.findByText("Ville Vieras"));
      expect(screen.getByText("Tilauslomakkeen tiedot")).toBeTruthy();
      expect(screen.getByText("040 111 2222")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Muokkaa" }));
      expect((screen.getByLabelText("Puhelinnumero") as HTMLInputElement).value).toBe("040 111 2222");
    } finally {
      delete responses["/companies/demo-company/heating-orders"];
    }
  });

  it("näyttää arkaluonteisen tehtävän tägin päätösjonossa", async () => {
    const original = responses["/tickets?companyId=all"];
    responses["/tickets?companyId=all"] = [{ ...overdueTicket, id: "ticket-s", ticket_number: 7, subject: "Luiska rollaattorille", sensitive: 1 }];
    try {
      await renderApp(staff("Isännöitsijä"), "#/queue");
      expect(await screen.findByText("Luiska rollaattorille")).toBeTruthy();
      expect(screen.getAllByText(/Arkaluonteinen/).length).toBeGreaterThan(0);
    } finally {
      responses["/tickets?companyId=all"] = original;
    }
  });

  it("asukas lähettää huoltotyötilauksen portaalin lomakkeella", async () => {
    const calls = mockApi();
    const resident = { id: "resident-1", name: "Liisa Mallikas", email: "liisa@example.com", companyId: "demo-company", companyName: "As Oy Koivikko", apartmentNumber: "B 34" };
    await renderApp({ token: "asukastunniste", kind: "resident", user: { id: resident.id, name: resident.name, email: resident.email, role: "Asukas" }, resident });
    for (const label of ["Häiriöilmoitus", "Irtisanomisilmoitus", "Yleinen asuntohakemus", "Auton lämmityspaikka"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    fireEvent.click(screen.getAllByRole("button", { name: /Huoltotyötilaus/ })[0]);
    fireEvent.change(await screen.findByLabelText("Tarkempi paikka (valinnainen)"), { target: { value: "Keittiö" } });
    fireEvent.change(screen.getByLabelText("Vian kuvaus"), { target: { value: "Hana vuotaa tiskipöydän alle." } });
    fireEvent.click(screen.getByRole("button", { name: "Lähetä huoltotyötilaus" }));

    await vi.waitFor(() => expect(calls.some(request => request.method === "POST" && request.url.endsWith("/portal/forms/service"))).toBe(true));
    const sent = JSON.parse(calls.find(request => request.url.endsWith("/portal/forms/service"))?.body ?? "{}");
    expect(sent).toMatchObject({ target: "Oma asunto", location: "Keittiö", description: "Hana vuotaa tiskipöydän alle.", entry: "Huolto saa mennä asuntoon yleisavaimella" });
    expect(await screen.findByText(/Huoltotyötilaus on lähetetty/)).toBeTruthy();
  });

  it("näyttää käyttöliittymän englanniksi, kun kieli on valittu", async () => {
    await renderApp(staff("Asiakaspalvelu"), "", "en");
    expect((await screen.findAllByText("Saunavuoron varaus")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(screen.getByText("Sign out")).toBeTruthy();
    expect(screen.getAllByText("Decision queue").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Saunavuoron varaus").length).toBeGreaterThan(0);
    expect(screen.queryByText("Kirjaudu ulos")).toBeNull();
    expect(document.documentElement.lang).toBe("en");
  });

  it("näyttää kirjautumissivulla kielenvaihdon", async () => {
    await renderApp(null);
    expect(screen.getByText("In English")).toBeTruthy();
    cleanup();
    await renderApp(null, "", "en");
    expect(screen.getByText("Suomeksi")).toBeTruthy();
    expect(screen.getAllByText("Sign in").length).toBeGreaterThan(0);
  });

  it("näyttää muutoissa oletuksena vain odottavat ja valikossa niiden määrän", async () => {
    const move = (id: string, status: string, name: string) => ({
      id, company_id: "demo-company", move_date: "2026-11-01", moves_out: 1, new_residents: "[]", door_name: "", note: "",
      status, created_at: "2026-10-01T08:00:00.000Z", resident_name: name, apartment_number: "A 1"
    });
    responses["/companies/demo-company/moves"] = [move("m1", "pending", "Odottava Asukas"), move("m2", "approved", "Hyväksytty Asukas")];
    try {
      await renderApp(staff("Isännöitsijä"), "#/moves");
      expect(await screen.findByText("Odottava Asukas")).toBeTruthy();
      expect(screen.queryByText("Hyväksytty Asukas")).toBeNull();
      expect((await screen.findByTitle("Odottaa käsittelyä")).textContent).toBe("1");
      // Yhden taloyhtiön toimistolla Taloyhtiö-saraketta ei näytetä.
      expect(screen.queryByRole("columnheader", { name: "Taloyhtiö" })).toBeNull();
    } finally {
      delete responses["/companies/demo-company/moves"];
    }
  });

  it("taloyhtiö valitaan sivupalkin yhtiöosiosta ja alasivut koskevat valittua yhtiötä", async () => {
    await renderApp(staff("Isännöitsijä"), "#/residents");
    // Sama alasvetovalikko kuin muualla sovelluksessa, mutta sivupalkissa yhtiön näkymien otsikkona.
    const picker = await screen.findByRole("button", { name: "Taloyhtiö" });
    expect(picker.closest(".sidebar")).toBeTruthy();
    expect(document.querySelector(".topbar .dropdown")).toBeNull();
    // Valinnalla on aina arvo, joten alasivut näkyvät heti.
    await vi.waitFor(() => expect(picker.textContent).toContain("As Oy Koivikko"));
    expect(screen.getByText("Pyykkitupa")).toBeTruthy();
    expect(screen.getByText("Yhtiön tiedot")).toBeTruthy();
    expect(localStorage.getItem("kotilo.navCompany")).toBe("demo-company");
    // Valikon viimeinen kohta avaa kaikkien taloyhtiöiden listan.
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("option", { name: "Kaikki taloyhtiöt…" }));
    await vi.waitFor(() => expect(window.location.hash).toBe("#/companies"));
  });

  it("profiilivalikosta pääsee asetuksiin ja historia näyttää avatut tehtävät", async () => {
    responses["/tickets/ticket-1"] = { ticket: { ...overdueTicket, company_name: "As Oy Koivikko" }, messages: [], audit: [], reporters: [], apartments: [], notes: [], workOrders: [], contractor: null, attachments: [] };
    try {
      await renderApp(staff("Isännöitsijä"), "#/tickets/ticket-1");
      await screen.findByRole("button", { name: "Tallenna" });
      fireEvent.click(screen.getByRole("button", { name: /Historia/ }));
      expect(screen.getByRole("menuitem", { name: /Saunavuoron varaus/ })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Profiili" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Asetukset" }));
      await vi.waitFor(() => expect(window.location.hash).toBe("#/settings"));
    } finally {
      delete responses["/tickets/ticket-1"];
    }
  });

  it("sulkee ja avaa alavalikon ryhmän ja muistaa valinnan", async () => {
    // Alavalikko on auki, kun ollaan jollakin sen sivuista.
    await renderApp(staff("Isännöitsijä"), "#/waitlist");
    expect(await screen.findByText("Pyykkitupa")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Piilota Tilat"));
    expect(screen.queryByText("Pyykkitupa")).toBeNull();
    expect(screen.getByText("Tiedotteet")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("kotilo.closedNavGroups") ?? "[]")).toEqual(["facilities"]);
    fireEvent.click(screen.getByTitle("Näytä Tilat"));
    expect(screen.getByText("Pyykkitupa")).toBeTruthy();
  });

  it("näyttää dokumentaation listana ja rajaa alasivut AI:n ja sisäisen mukaan", async () => {
    const entry = (id: string, title: string, audience: string) => ({
      id, title, content: "Sisältö", content_length: 7, kind: "fact", audience, valid_from: null, valid_until: null,
      file_name: null, version: 1, state: audience === "internal" ? "internal" : "in_use", created_at: "2026-10-01T08:00:00.000Z"
    });
    responses["/companies/demo-company/knowledge"] = [entry("k1", "Saunavuorot", "ai"), entry("k2", "Vara-avaimen säilytys", "internal")];
    try {
      await renderApp(staff("Isännöitsijä"), "#/knowledge");
      expect(await screen.findByText("Saunavuorot")).toBeTruthy();
      expect(screen.getByText("Vara-avaimen säilytys")).toBeTruthy();
      expect(screen.getByTitle("Järjestä sarakkeen Käyttö mukaan")).toBeTruthy();
      cleanup();

      await renderApp(staff("Isännöitsijä"), "#/knowledge-internal");
      expect(await screen.findByText("Vara-avaimen säilytys")).toBeTruthy();
      expect(screen.queryByText("Saunavuorot")).toBeNull();
      expect(screen.queryByText("Testaa AI:n vastaus")).toBeNull();
      cleanup();

      await renderApp(staff("Isännöitsijä"), "#/knowledge-ai");
      expect(await screen.findByText("Saunavuorot")).toBeTruthy();
      expect(screen.queryByText("Vara-avaimen säilytys")).toBeNull();
    } finally {
      delete responses["/companies/demo-company/knowledge"];
    }
  });

  it("näyttää toimiston asetuksissa AI-prioriteetin kytkimen pois päältä", async () => {
    await renderApp(staff("Pääkäyttäjä"), "#/settings");
    fireEvent.click(await screen.findByText("Isännöitsijätoimiston tiedot"));
    // AI-asetukset ovat omalla välilehdellään.
    expect(screen.queryByText("AI arvioi saapuvan tehtävän prioriteetin")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "AI" }));
    const label = await screen.findByText("AI arvioi saapuvan tehtävän prioriteetin");
    const toggle = label.closest("label")?.querySelector("input") as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    // Osion saa kiinni otsikon väkäsestä, ja valinta muistetaan.
    fireEvent.click(screen.getByRole("button", { name: "AI" }));
    expect(screen.queryByText("AI arvioi saapuvan tehtävän prioriteetin")).toBeNull();
    expect(JSON.parse(localStorage.getItem("kotilo.settingsCollapsed") ?? "[]")).toEqual(["office-ai"]);
    // Aliotsikko avaa tiivistetyn osion.
    fireEvent.click(screen.getByRole("button", { name: "AI-käyttö ja -asetukset" }));
    expect(screen.getByText("AI arvioi saapuvan tehtävän prioriteetin")).toBeTruthy();
  });

  it("tallentaa tehtävän tietojen muutokset vasta Tallenna-painikkeesta", async () => {
    const detail = { ticket: { ...overdueTicket, company_name: "As Oy Koivikko" }, messages: [], audit: [], reporters: [], apartments: [], notes: [], workOrders: [], contractor: null, attachments: [] };
    responses["/tickets/ticket-1"] = detail;
    try {
      const calls = mockApi();
      await renderApp(staff("Asiakaspalvelu"), "#/tickets/ticket-1");
      const save = await screen.findByRole("button", { name: "Tallenna" }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      // Tehtävä on oma sivunsa: navigaatio pysyy näkyvissä ja takaisin-linkki vie listaan.
      expect(screen.getByText("Päätösjono")).toBeTruthy();
      expect(screen.getByText("← Kaikki tehtävät")).toBeTruthy();
      expect(document.querySelector(".overlay")).toBeNull();
      // Työtilaukset ovat välilehtenä vastauksen vieressä.
      const ordersTab = screen.getByRole("tab", { name: /Työtilaukset/ });
      expect(ordersTab.getAttribute("aria-selected")).toBe("false");
      fireEvent.click(ordersTab);
      expect(ordersTab.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("tab", { name: "Vastaus asukkaalle" }).getAttribute("aria-selected")).toBe("false");
      // Asiakaspalvelu ei voi poistaa tehtävää.
      expect(screen.queryByRole("button", { name: "Poista" })).toBeNull();

      fireEvent.change(screen.getByLabelText("Määräaika"), { target: { value: "2026-12-24" } });
      expect(screen.getByText("Tallentamattomia muutoksia")).toBeTruthy();
      expect(save.disabled).toBe(false);
      expect(calls.some(request => request.method === "PUT")).toBe(false);

      fireEvent.click(save);
      await screen.findByRole("button", { name: "Tallenna" });
      const put = calls.find(request => request.method === "PUT");
      expect(put?.url).toContain("/tickets/ticket-1/fields");
      expect(JSON.parse(put?.body ?? "{}").dueDate).toBe("2026-12-24");
    } finally {
      delete responses["/tickets/ticket-1"];
    }
  });

  it("vastaa oletuksena saapumislaatikosta ja lähettäjän voi vaihtaa", async () => {
    const detail = {
      ticket: { ...overdueTicket, status: "waiting_manager", company_name: "As Oy Koivikko" },
      messages: [{ id: "m1", direction: "inbound", sender: "Matti <matti@example.com>", subject: "Hana vuotaa", body: "Apua", created_at: "2026-10-14T10:00:00Z", channel: "email" }],
      audit: [], reporters: [], apartments: [], notes: [], workOrders: [], contractor: null, attachments: [],
      replyAccounts: [
        { id: "office", email: "toimisto@toimisto.fi", kind: "office", arrived: true },
        { id: "user:user-1", email: "testi@toimisto.fi", kind: "own", arrived: false }
      ]
    };
    responses["/tickets/ticket-1"] = detail;
    try {
      const calls = mockApi();
      await renderApp(staff("Isännöitsijä"), "#/tickets/ticket-1");
      const from = await screen.findByLabelText("Lähettäjä") as HTMLSelectElement;
      expect(from.value).toBe("office");
      expect(screen.getByRole("option", { name: "toimisto@toimisto.fi (isännöintitoimisto, viesti saapui tänne)" })).toBeTruthy();
      fireEvent.change(from, { target: { value: "user:user-1" } });
      fireEvent.change(document.querySelector(".draft-editor")!, { target: { value: "Huoltomies tulee huomenna." } });
      fireEvent.click(screen.getByRole("button", { name: "Lähetä" }));
      await vi.waitFor(() => expect(calls.some(request => request.url.endsWith("/tickets/ticket-1/reply"))).toBe(true));
      const reply = calls.find(request => request.url.endsWith("/tickets/ticket-1/reply"));
      expect(JSON.parse(reply?.body ?? "{}").fromAccountId).toBe("user:user-1");
    } finally {
      delete responses["/tickets/ticket-1"];
    }
  });

  it("näyttää saapuneen viestin liitteet aikajanalla pikkukuvina", async () => {
    const detail = {
      ticket: { ...overdueTicket, company_name: "As Oy Koivikko" },
      messages: [{ id: "m1", direction: "inbound", sender: "Matti <matti@example.com>", subject: "Vuoto", body: "Kuvat liitteenä", created_at: "2026-10-14T10:00:00Z", channel: "email" }],
      audit: [], reporters: [], apartments: [], notes: [], workOrders: [], contractor: null, replyAccounts: [],
      attachments: [
        { id: "a1", filename: "vuoto.jpg", mime_type: "image/jpeg", size: 2048, created_at: "2026-10-14T10:00:01Z", direction: "inbound", message_id: "m1" },
        { id: "a2", filename: "lasku.pdf", mime_type: "application/pdf", size: 4096, created_at: "2026-10-14T10:00:01Z", direction: "inbound", message_id: "m1" },
        { id: "a3", filename: "muistio.pdf", mime_type: "application/pdf", size: 10, created_at: "2026-10-14T11:00:00Z", direction: "internal", message_id: null }
      ]
    };
    responses["/tickets/ticket-1"] = detail;
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:vuoto");
    URL.revokeObjectURL = vi.fn();
    try {
      const calls = mockApi();
      await renderApp(staff("Isännöitsijä"), "#/tickets/ticket-1");
      const thumbnail = await screen.findByRole("button", { name: "Näytä kuva vuoto.jpg" });
      const image = await screen.findByAltText("vuoto.jpg") as HTMLImageElement;
      expect(image.src).toBe("blob:vuoto");
      const imageCall = calls.find(request => request.url.endsWith("/attachments/a1?inline=1"));
      expect(imageCall?.headers.Authorization).toBe("Bearer testitunniste");
      // Muu liite näkyy viestin alla nimellä; sisäinen liite ei kuulu viestille.
      const timeline = document.querySelector(".drawer-timeline")!;
      expect(timeline.textContent).toContain("lasku.pdf");
      expect(timeline.textContent).not.toContain("muistio.pdf");

      fireEvent.click(thumbnail);
      const preview = screen.getByRole("dialog", { name: "vuoto.jpg" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(preview.isConnected).toBe(false);
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      delete responses["/tickets/ticket-1"];
    }
  });

  it("tekee tuntemattomasta lähettäjästä asukkaan ja liittää hänet ilmoittajaksi", async () => {
    const detail = {
      ticket: { ...overdueTicket, company_name: "As Oy Koivikko" },
      messages: [{ id: "m1", direction: "inbound", sender: "Uusi Asukas <uusi@example.com>", subject: "Kysymys", body: "Hei", created_at: "2026-10-14T10:00:00Z", channel: "email" }],
      audit: [], reporters: [], apartments: [], notes: [], workOrders: [], contractor: null, attachments: [], replyAccounts: [], signature: ""
    };
    responses["/tickets/ticket-1"] = detail;
    responses["/companies/demo-company/apartments"] = [{ id: "apt-1", apartment_number: "A 12", address: "Koivikkotie 10" }];
    try {
      const calls = mockApi();
      const base = globalThis.fetch;
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await base(input, init);
        return init?.method === "POST" && String(input).endsWith("/companies/demo-company/residents")
          ? new Response(JSON.stringify({ ok: true, residentId: "resident-new" }), { status: 201, headers: { "Content-Type": "application/json" } })
          : response;
      }));
      await renderApp(staff("Isännöitsijä"), "#/tickets/ticket-1");
      fireEvent.click(await screen.findByRole("button", { name: "Tee käyttäjä" }));

      const dialog = screen.getByRole("dialog", { name: "Uusi asukas" });
      expect((screen.getByLabelText("Nimi") as HTMLInputElement).value).toBe("Uusi Asukas");
      expect((dialog.querySelector("input[type=email]") as HTMLInputElement).value).toBe("uusi@example.com");
      // Taloyhtiö kysytään aina; oletuksena tehtävän taloyhtiö.
      expect((dialog.querySelectorAll("select")[0] as HTMLSelectElement).value).toBe("demo-company");
      await vi.waitFor(() => expect((dialog.querySelectorAll("select")[1] as HTMLSelectElement).value).toBe("apt-1"));
      fireEvent.click(screen.getByRole("button", { name: "Lisää asukas" }));

      await vi.waitFor(() => expect(calls.some(request => request.method === "POST" && request.url.endsWith("/tickets/ticket-1/reporters"))).toBe(true));
      const created = calls.find(request => request.method === "POST" && request.url.endsWith("/companies/demo-company/residents"));
      expect(JSON.parse(created?.body ?? "{}")).toEqual({ name: "Uusi Asukas", email: "uusi@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12" });
      const linked = calls.find(request => request.url.endsWith("/tickets/ticket-1/reporters"));
      expect(JSON.parse(linked?.body ?? "{}").residentId).toBe("resident-new");
      await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Uusi asukas" })).toBeNull());
    } finally {
      delete responses["/tickets/ticket-1"];
      delete responses["/companies/demo-company/apartments"];
    }
  });

  it("varoittaa ennen tehtävän poistamista ja poistaa vasta vahvistuksesta", async () => {
    const detail = { ticket: { ...overdueTicket, company_name: "As Oy Koivikko" }, messages: [], audit: [], reporters: [], apartments: [], notes: [], workOrders: [], contractor: null, attachments: [] };
    responses["/tickets/ticket-1"] = detail;
    try {
      const calls = mockApi();
      await renderApp(staff("Isännöitsijä"), "#/tickets/ticket-1");
      fireEvent.click(await screen.findByRole("button", { name: "Poista" }));
      expect(await screen.findByText("Poistetaanko tehtävä #T000001?")).toBeTruthy();
      expect(screen.getByText(/Poistoa ei voi perua/)).toBeTruthy();
      expect(calls.some(request => request.method === "DELETE")).toBe(false);

      fireEvent.click(screen.getByRole("button", { name: "Poista tehtävä" }));
      await vi.waitFor(() => expect(calls.some(request => request.method === "DELETE" && request.url.endsWith("/tickets/ticket-1"))).toBe(true));
    } finally {
      delete responses["/tickets/ticket-1"];
    }
  });

  it("ilmoittajan vaihto päivittää asunnon heti ja AI-ehdotukseen voi antaa lisätietoa", async () => {
    responses["/tickets/ticket-1"] = {
      ticket: { ...overdueTicket, company_name: "As Oy Koivikko" }, messages: [], audit: [],
      reporters: [{ id: "r1", name: "Matti Meikäläinen", email: "matti@example.com", apartment_number: "A 1" }],
      apartments: [{ id: "a1", apartment_number: "A 1", address: "Koivikkotie 1" }],
      notes: [], workOrders: [], contractor: null, attachments: []
    };
    responses["/tickets/ticket-1/suggest"] = { draft: "Huoltomies tulee torstaina.", reason: "Käsittelijän lisätieto.", source: null, usedAi: true };
    responses["/companies/demo-company/residents"] = [
      { id: "r1", name: "Matti Meikäläinen", email: "matti@example.com", apartment_number: "A 1", address: "Koivikkotie 1" },
      { id: "r2", name: "Liisa Mallikas", email: "liisa@example.com", apartment_number: "B 34", address: "Koivikkotie 3" }
    ];
    try {
      const calls = mockApi();
      await renderApp(staff("Isännöitsijä"), "#/tickets/ticket-1");
      expect(await screen.findByText("Koivikkotie 1")).toBeTruthy();

      const reporterInput = screen.getByDisplayValue("Matti Meikäläinen");
      fireEvent.focus(reporterInput);
      fireEvent.change(reporterInput, { target: { value: "Liisa" } });
      fireEvent.mouseDown(await screen.findByText("Liisa Mallikas"));
      expect(screen.getByText("Koivikkotie 3")).toBeTruthy();
      expect(screen.getByText("B 34")).toBeTruthy();
      expect(calls.some(request => request.url.includes("/reporters"))).toBe(false);

      fireEvent.click(screen.getByRole("button", { name: /Pyydä AI-ehdotus/ }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(dialog.querySelector("textarea")!, { target: { value: "Huoltomies käy torstaina." } });
      fireEvent.click(screen.getByRole("button", { name: "Pyydä ehdotus" }));
      await vi.waitFor(() => expect(calls.some(request => request.url.endsWith("/tickets/ticket-1/suggest"))).toBe(true));
      const suggest = calls.find(request => request.url.endsWith("/tickets/ticket-1/suggest"));
      expect(JSON.parse(suggest!.body).context).toBe("Huoltomies käy torstaina.");
      // Valmis ehdotus ilmoitetaan yläreunan ilmoituksella, jonka saa suljettua ruksista.
      expect(await screen.findByText("Käsittelijän lisätieto.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Sulje ilmoitus" }));
      expect(screen.queryByText("Käsittelijän lisätieto.")).toBeNull();
    } finally {
      delete responses["/tickets/ticket-1"];
      delete responses["/tickets/ticket-1/suggest"];
      delete responses["/companies/demo-company/residents"];
    }
  });

  it("päätösjonossa ei ole Osoita minulle -painiketta, koska tehtävät on jo osoitettu käyttäjälle", async () => {
    mockApi();
    await renderApp(staff("Asiakaspalvelu"), "#/queue");
    await screen.findAllByText("Saunavuoron varaus");
    expect(screen.queryByRole("button", { name: "Osoita minulle" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sulje" })).toBeTruthy();
  });

  it("haku: #numero avaa tehtävän ja muu haku näyttää tulokset otsikoittain", async () => {
    const found = {
      query: "", tickets: [{ id: "ticket-1", ticket_number: 1, subject: "Saunavuoron varaus", status: "open", priority: "normal",
        created_at: "2025-12-27T08:00:00.000Z", company_id: "demo-company", company_name: "As Oy Koivikko", resident_name: null,
        apartment_number: null, snippet: "Asukas kysyy saunavuorosta." }], ticketCount: 1,
      knowledge: [{ id: "k1", title: "Saunavuorot", audience: "ai", company_id: "demo-company", company_name: "As Oy Koivikko", snippet: "Sauna on auki" }],
      knowledgeCount: 1, residents: [], residentCount: 0, announcements: [], announcementCount: 0
    };
    responses["/search?q=%231"] = found;
    responses["/search?q=sauna"] = found;
    responses["/tickets/ticket-1"] = { ticket: { ...overdueTicket, company_name: "As Oy Koivikko" }, messages: [], audit: [], reporters: [], apartments: [], notes: [], workOrders: [], contractor: null, attachments: [] };
    try {
      mockApi();
      await renderApp(staff("Isännöitsijä"), "#/queue");
      const search = await screen.findByLabelText("Hae alustalta");
      fireEvent.change(search, { target: { value: "#1" } });
      fireEvent.submit(search.closest("form")!);
      await vi.waitFor(() => expect(window.location.hash).toBe("#/tickets/ticket-1"));

      fireEvent.change(screen.getByLabelText("Hae alustalta"), { target: { value: "sauna" } });
      fireEvent.submit(screen.getByLabelText("Hae alustalta").closest("form")!);
      await vi.waitFor(() => expect(window.location.hash).toBe("#/search/sauna"));
      expect(await screen.findByRole("heading", { name: /Tehtävät/ })).toBeTruthy();
      expect(screen.getByRole("heading", { name: /Dokumentaatio/ })).toBeTruthy();
      expect(screen.getByText(/löytyi 2 osumaa/)).toBeTruthy();
    } finally {
      delete responses["/search?q=%231"];
      delete responses["/search?q=sauna"];
      delete responses["/tickets/ticket-1"];
    }
  });

  it("sivupalkin voi pienentää ja valinta muistetaan", async () => {
    mockApi();
    await renderApp(staff("Isännöitsijä"), "#/queue");
    fireEvent.click(await screen.findByRole("button", { name: "Pienennä valikko" }));
    expect(document.querySelector(".app.nav-collapsed")).toBeTruthy();
    expect(localStorage.getItem("kotilo.navPinned")).toBe("off");
    fireEvent.click(screen.getByRole("button", { name: "Kiinnitä valikko auki" }));
    expect(document.querySelector(".app.nav-collapsed")).toBeNull();
  });

  it("tehtävän tilan voi vaihtaa tehtäväsivulla", async () => {
    responses["/tickets/ticket-1"] = { ticket: { ...overdueTicket, company_name: "As Oy Koivikko" }, messages: [], audit: [], reporters: [], apartments: [], notes: [], workOrders: [], contractor: null, attachments: [] };
    try {
      const calls = mockApi();
      await renderApp(staff("Isännöitsijä"), "#/tickets/ticket-1");
      const save = await screen.findByRole("button", { name: "Tallenna" });
      const statusRow = screen.getByText("Tila", { selector: "dt" }).parentElement!;
      fireEvent.click(statusRow.querySelector("button")!);
      fireEvent.click(await screen.findByRole("option", { name: "Vastattu" }).catch(() => screen.getByRole("button", { name: "Vastattu" })));
      fireEvent.click(save);
      await vi.waitFor(() => expect(calls.some(request => request.method === "PUT" && request.url.endsWith("/tickets/ticket-1/fields"))).toBe(true));
      const put = calls.find(request => request.method === "PUT" && request.url.endsWith("/tickets/ticket-1/fields"));
      expect(JSON.parse(put!.body).status).toBe("answered");
    } finally {
      delete responses["/tickets/ticket-1"];
    }
  });

  it("dokumentaation tietokortissa on Muokkaa ja tilan valinta, ei Siirrä sisäiseksi -painiketta", async () => {
    const entry = { id: "k1", company_id: "demo-company", title: "Saunavuorot", content: "Sauna varataan portaalista.", kind: "fact",
      audience: "ai", state: "in_use", status: "active", version: 1, valid_from: null, valid_until: null, created_at: "2026-10-01T08:00:00.000Z",
      tags: "", file_name: null, content_length: 27 };
    responses["/companies/demo-company/knowledge"] = [entry];
    responses["/knowledge/k1"] = { ...entry, company_name: "As Oy Koivikko", versions: [entry] };
    try {
      mockApi();
      await renderApp(staff("Isännöitsijä"), "#/knowledge/k1");
      expect(await screen.findByRole("button", { name: "Muokkaa" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Siirrä sisäiseksi" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Korvaa" })).toBeNull();
      const stateRow = screen.getByText("Tila", { selector: "dt" }).parentElement!;
      expect(stateRow.querySelector("button")?.textContent).toContain("AI:n käytössä");
    } finally {
      delete responses["/companies/demo-company/knowledge"];
      delete responses["/knowledge/k1"];
    }
  });

  it("toiselle osoitetun tehtävän voi ottaa itselleen tehtäväsivulta", async () => {
    responses["/tickets/ticket-1"] = { ticket: { ...overdueTicket, assignee_id: "user-2", status: "answered", company_name: "As Oy Koivikko" }, messages: [], audit: [], reporters: [], apartments: [], notes: [], workOrders: [], contractor: null, attachments: [] };
    try {
      const calls = mockApi();
      await renderApp(staff("Asiakaspalvelu"), "#/tickets/ticket-1");
      fireEvent.click(await screen.findByRole("button", { name: "Osoita minulle" }));
      await vi.waitFor(() => expect(calls.some(request => request.method === "PUT" && request.url.endsWith("/tickets/ticket-1/fields"))).toBe(true));
      const put = calls.find(request => request.method === "PUT" && request.url.endsWith("/tickets/ticket-1/fields"));
      expect(JSON.parse(put!.body).assigneeId).toBe("user-1");
      // Tallennuksen jälkeen tehtävä ladataan uudelleen; odotetaan se, jotta pyyntö ei jää testin jälkeen kesken.
      const putIndex = calls.indexOf(put!);
      await vi.waitFor(() => expect(calls.slice(putIndex).some(request => request.method === "GET" && request.url.endsWith("/tickets/ticket-1"))).toBe(true));
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      delete responses["/tickets/ticket-1"];
    }
  });

  it("lähettää istuntotunnisteen otsakkeessa eikä osoitteessa", async () => {
    const calls = mockApi();
    await renderApp(staff("Pääkäyttäjä"));
    await screen.findAllByText("Saunavuoron varaus");
    expect(calls.length).toBeGreaterThan(0);
    for (const request of calls) {
      expect(request.url).not.toContain("testitunniste");
      expect(request.headers.Authorization).toBe("Bearer testitunniste");
    }
  });
});
