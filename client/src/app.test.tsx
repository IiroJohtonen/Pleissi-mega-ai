import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

  it("näyttää sivupalkissa vain roolin taulut ja ohjaa muualle roolin ulkopuolisesta näkymästä", async () => {
    await renderApp({ ...staff("Kiinteistösihteeri"), user: { ...staff("Kiinteistösihteeri").user, tables: ["tickets", "residents"] } }, "#/queue");
    await vi.waitFor(() => expect(window.location.hash).toBe("#/tickets"));
    const nav = document.querySelector(".sidebar nav") as HTMLElement;
    expect(within(nav).getByRole("button", { name: "Kaikki tehtävät" })).toBeTruthy();
    expect(within(nav).queryByRole("button", { name: /Päätösjono/ })).toBeNull();
    expect(within(nav).queryByRole("button", { name: "Raportit" })).toBeNull();
    expect(within(nav).queryByRole("button", { name: "Yhtiön tiedot" })).toBeNull();
    expect(await within(nav).findByRole("button", { name: "Asukkaat" })).toBeTruthy();
    expect(within(nav).queryByRole("button", { name: "Asunnot" })).toBeNull();
    expect(within(nav).queryByRole("button", { name: /Tilat/ })).toBeNull();
  });

  it("pääkäyttäjä luo roolin ja valitsee sille taulut asetusten Roolit-välilehdellä", async () => {
    responses["/roles"] = [{ id: "role-service", name: "Asiakaspalvelu", base: "Asiakaspalvelu", tables: null, userCount: 1 }];
    try {
      const calls = mockApi();
      await renderApp(staff("Pääkäyttäjä"), "#/settings");
      fireEvent.click(await screen.findByRole("tab", { name: "Isännöitsijätoimiston tiedot" }));
      fireEvent.click(screen.getByRole("tab", { name: "Roolit" }));
      expect(await screen.findByText("Kaikki taulut aina")).toBeTruthy();
      expect(await screen.findByText("Kaikki taulut")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Lisää rooli" }));
      fireEvent.change(screen.getByLabelText("Roolin nimi"), { target: { value: "Kiinteistösihteeri" } });
      fireEvent.click(screen.getByRole("checkbox", { name: "Kaikki tehtävät" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Perustiedot" }));
      expect((screen.getByRole("checkbox", { name: "Asunnot" }) as HTMLInputElement).checked).toBe(true);
      fireEvent.click(screen.getByRole("checkbox", { name: "Avaimet" }));
      fireEvent.click(within(document.querySelector(".form-drawer form") as HTMLElement).getByRole("button", { name: "Lisää rooli" }));

      await vi.waitFor(() => expect(calls.some(request => request.method === "POST" && request.url.endsWith("/roles"))).toBe(true));
      expect(JSON.parse(calls.find(request => request.method === "POST" && request.url.endsWith("/roles"))!.body)).toEqual({
        name: "Kiinteistösihteeri", base: "Asiakaspalvelu", tables: ["tickets", "residents", "apartments", "waitlist"]
      });
    } finally {
      delete responses["/roles"];
    }
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

  it("uuden tehtävän asukkaaksi voi valita taloyhtiön asukkaan tai Muu-valinnalla kirjoittaa uuden", async () => {
    responses["/companies/demo-company/residents"] = [
      { id: "r1", name: "Matti Meikäläinen", email: "matti@example.com", apartment_number: "A 1", address: "Koivikkotie 1" }
    ];
    try {
      const calls = mockApi();
      await renderApp(staff("Isännöitsijä"), "#/tickets");
      fireEvent.click(await screen.findByRole("button", { name: "+ Luo tehtävä" }));
      fireEvent.change(screen.getByPlaceholderText("Esim. Käytävävalot"), { target: { value: "Ovikello" } });
      fireEvent.change(screen.getByPlaceholderText("Kerro tehtävän sisältö..."), { target: { value: "Ovikello ei soi." } });

      const residentInput = screen.getByLabelText("Asukas");
      await vi.waitFor(() => expect(calls.some(request => request.url.endsWith("/companies/demo-company/residents"))).toBe(true));
      fireEvent.focus(residentInput);
      fireEvent.mouseDown(await screen.findByText("Matti Meikäläinen"));
      expect(screen.getByText("A 1 · Koivikkotie 1 · matti@example.com")).toBeTruthy();

      // Muu avaa kentät nimelle, osoitteelle ja asunnolle; luonti odottaa, että ne on täytetty.
      fireEvent.focus(residentInput);
      fireEvent.mouseDown(screen.getByText("Muu"));
      const submit = screen.getByRole("button", { name: "Luo tehtävä" }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("Asukkaan nimi"), { target: { value: "Olli Ohikulkija" } });
      fireEvent.change(screen.getByLabelText("Osoite"), { target: { value: "Uusitie 5" } });
      fireEvent.change(screen.getByLabelText("Asunto"), { target: { value: "C 7" } });
      expect(submit.disabled).toBe(false);
      fireEvent.click(submit);

      await vi.waitFor(() => expect(calls.some(request => request.method === "POST" && request.url.endsWith("/tickets"))).toBe(true));
      const body = JSON.parse(calls.find(request => request.method === "POST" && request.url.endsWith("/tickets"))!.body);
      expect(body.residentId).toBeUndefined();
      expect(body.newResident).toEqual({ name: "Olli Ohikulkija", address: "Uusitie 5", apartmentNumber: "C 7" });
    } finally {
      delete responses["/companies/demo-company/residents"];
    }
  });

  it("näyttää päätösjonon yläosassa mahdollisen yhteisen vian ja avaa sen toimenpiteineen", async () => {
    const incident = {
      id: "incident-1", companyId: "demo-company", companyName: "As Oy Koivikko", topic: "heating", stairwell: "B", status: "open",
      firstReportAt: "2026-10-24T06:00:00.000Z", lastReportAt: "2026-10-24T08:00:00.000Z", createdAt: "2026-10-24T08:00:00.000Z",
      summary: "3 asuntoa B-portaasta (B 1, B 2, B 3) on ilmoittanut aiheesta lämmitys.",
      ai: null, aiAt: null, autoReply: false, replyMessage: "", announcedAt: null, orderedAt: null, handledBy: null, handledAt: null,
      drafts: { workOrder: "Pyydämme tarkistamaan lämmityksen (B-portaan osalta).", announcementTitle: "Lämmitys: vika selvityksessä",
        announcementBody: "Vika on tiedossa.", reply: "Kiitos ilmoituksestasi. Vika on tiedossa." },
      reporters: 3,
      tickets: [{ id: "ticket-1", ticketNumber: 1, subject: "Kylmä asunto", status: "open", createdAt: "2026-10-24T06:00:00.000Z",
        apartmentNumber: "B 1", stairwell: "B", residentName: "Asukas B 1" }]
    };
    responses["/incidents"] = [incident];
    responses["/incidents/incident-1"] = incident;
    try {
      await renderApp(staff("Isännöitsijä"), "#/queue");
      expect(await screen.findByRole("heading", { name: /Mahdolliset yhteiset viat/ })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Lämmitys, B-porras/ }));
      expect(await screen.findByRole("heading", { name: "Mahdollinen yhteinen vika: Lämmitys" })).toBeTruthy();
      expect(screen.getByText(incident.summary)).toBeTruthy();
      expect((screen.getByDisplayValue(incident.drafts.workOrder) as HTMLTextAreaElement).tagName).toBe("TEXTAREA");
      expect(screen.getByRole("button", { name: "Pyydä AI-tulkinta" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Merkitse korjatuksi ja sulje ilmoitukset" })).toBeTruthy();
    } finally {
      delete responses["/incidents"];
      delete responses["/incidents/incident-1"];
    }
  });

  it("sulkeminen kysyy, mikä ratkaisi asian, ja lähettää ratkaisun", async () => {
    const calls = mockApi();
    await renderApp(staff("Isännöitsijä"), "#/queue");
    fireEvent.click((await screen.findAllByRole("button", { name: "Sulje" }))[0]);
    fireEvent.click(await screen.findByText("Jo hoidettu"));
    fireEvent.change(screen.getByLabelText("Mikä ratkaisi asian? (valinnainen)"), { target: { value: "Termostaatti avattiin." } });
    fireEvent.click(screen.getByRole("button", { name: "Sulje tehtävä" }));
    await vi.waitFor(() => expect(calls.some(request => request.url.endsWith("/decision"))).toBe(true));
    const body = JSON.parse(calls.find(request => request.url.endsWith("/decision"))!.body);
    expect(body).toMatchObject({ decision: "skip", reason: "already_handled", resolution: "Termostaatti avattiin." });
  });

  it("näyttää trendit ja taloyhtiön muistin raporttien alla", async () => {
    responses["/reports/trends?companyId=demo-company&months=12"] = {
      months: ["2026-09", "2026-10"], topics: [{ topic: "heating", series: [0, 4], total: 4, lastMonth: 4, average: 0 }],
      repeats: [{ kind: "stairwell", companyName: "As Oy Koivikko", place: "B", topic: "heating", count: 4, firstAt: "2026-10-01T08:00:00.000Z", lastAt: "2026-10-20T08:00:00.000Z" }],
      resolution: [], contractors: [], incidents: []
    };
    responses["/companies/demo-company/memory"] = {
      notes: [{ id: "memory-1", companyId: "demo-company", topic: "heating", stairwell: "B", text: "B-portaan pumppu vaihdettiin.", sources: [],
        status: "proposed", validUntil: null, origin: "ai", createdAt: "2026-10-20T08:00:00.000Z", decidedBy: null, decidedAt: null, updatedAt: "2026-10-20T08:00:00.000Z" }],
      scannedAt: null, newCases: 2
    };
    try {
      await renderApp(staff("Isännöitsijä"), "#/reports/trends");
      expect(await screen.findByRole("heading", { name: "Aiheet kuukausittain" })).toBeTruthy();
      expect(screen.getByText("Lämmitys, B-porras")).toBeTruthy();
      window.location.hash = "#/reports/memory";
      expect(await screen.findByRole("heading", { name: "Hyväksyttävänä (1)" })).toBeTruthy();
      expect(screen.getByDisplayValue("B-portaan pumppu vaihdettiin.")).toBeTruthy();
      expect(screen.getByText("2 uutta ratkaisua edellisen haun jälkeen.")).toBeTruthy();
    } finally {
      delete responses["/reports/trends?companyId=demo-company&months=12"];
      delete responses["/companies/demo-company/memory"];
    }
  });

  it("näyttää päätösjonon alla omat käsittelyssä olevat tehtävät", async () => {
    const inProgress = { ...overdueTicket, id: "ticket-6", ticket_number: 6, subject: "Oma käsittelyssä", status: "waiting_manager" };
    const othersInProgress = { ...inProgress, id: "ticket-7", ticket_number: 7, subject: "Toisen käsittelyssä", assignee_id: "user-2" };
    const answered = { ...inProgress, id: "ticket-8", ticket_number: 8, subject: "Oma vastattu", status: "answered" };
    const original = responses["/tickets?companyId=all"];
    responses["/tickets?companyId=all"] = [overdueTicket, inProgress, othersInProgress, answered];
    try {
      await renderApp(staff("Isännöitsijä"), "#/queue");
      const heading = await screen.findByRole("heading", { name: /Käsittelyssä olevat tehtäväsi/ });
      expect(heading.querySelector("b")?.textContent).toBe("1");
      expect(screen.getByText("Oma käsittelyssä")).toBeTruthy();
      // Ylempi lista sisältää edelleen vain uudet ja avoimet tehtävät.
      expect(screen.getByRole("heading", { name: /Avoimet tehtäväsi/ }).querySelector("b")?.textContent).toBe("1");
      expect(screen.queryByText("Toisen käsittelyssä")).toBeNull();
      expect(screen.queryByText("Oma vastattu")).toBeNull();
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

  it("näyttää isännöitsijätoimiston nimen asetuksista yläpalkissa eikä toista sitä sivun otsikon yllä", async () => {
    await renderApp(staff("Isännöitsijä"), "#/queue");
    await screen.findAllByText("Saunavuoron varaus");
    await vi.waitFor(() => expect(document.querySelector(".topbar-office")?.textContent).toBe("Testitoimisto Oy"));
    expect(screen.queryByText(/PLEISSI \//)).toBeNull();
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
    for (const label of ["Häiriöilmoitus", "Yleinen asuntohakemus", "Muuttoilmoitus"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // Auton lämmityspaikka ja irtisanomisilmoitus eivät ole asukasportaalissa.
    expect(screen.queryByText("Auton lämmityspaikka")).toBeNull();
    expect(screen.queryByText("Irtisanomisilmoitus")).toBeNull();
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
    const section = within(picker.closest(".nav-company-section") as HTMLElement);
    expect(section.getByText("Pyykkitupa")).toBeTruthy();
    expect(section.getByText("Yhtiön tiedot")).toBeTruthy();
    expect(localStorage.getItem("kotilo.navCompany")).toBe("demo-company");
    // Valikossa ovat vain taloyhtiöt; kaikkien taloyhtiöiden lista on Data-osiossa.
    fireEvent.click(picker);
    expect(screen.queryByRole("option", { name: "Kaikki taloyhtiöt…" })).toBeNull();
  });

  it("Data-osiossa ovat kaikki taloyhtiöt ja taloyhtiöosion taulut kaikista taloyhtiöistä", async () => {
    responses["/data/residents"] = [
      { id: "r1", company_id: "demo-company", company_name: "As Oy Koivikko", name: "Kalle Koivikko", apartment_number: "A 1", moved_out_at: null },
      { id: "r2", company_id: "other-company", company_name: "As Oy Toinen", name: "Tiina Toinen", apartment_number: "B 2", moved_out_at: "2026-01-31" }
    ];
    try {
      await renderApp(staff("Isännöitsijä"), "#/residents");
      const dataSection = (await screen.findByRole("button", { name: "Data" })).closest(".nav-data-section") as HTMLElement;
      const data = within(dataSection);
      // Data on taloyhtiöosion yläpuolella, ja siinä ovat samat ryhmät ja alasivut.
      expect(dataSection.compareDocumentPosition(screen.getByRole("button", { name: "Taloyhtiö" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      for (const label of ["Dokumentaatio", "Perustiedot", "Tilat", "Ilmoitukset"]) expect(data.getByTitle(`Piilota ${label}`)).toBeTruthy();
      for (const label of ["Kaikki dokumentit", "Asukkaat", "Asunnot", "Jonot", "Avaimet", "Sauna", "Pyykkitupa", "Autopaikat", "Tiedotteet", "Muutot", "Remontit", "Lukemat"]) {
        expect(data.getByText(label)).toBeTruthy();
      }
      fireEvent.click(data.getByText("Kaikki taloyhtiöt"));
      await vi.waitFor(() => expect(window.location.hash).toBe("#/companies"));

      fireEvent.click(data.getByText("Asukkaat"));
      await vi.waitFor(() => expect(window.location.hash).toBe("#/data/residents"));
      // Myös toisen taloyhtiön ja poismuuttaneet asukkaat näkyvät.
      expect(await screen.findByText("Tiina Toinen")).toBeTruthy();
      expect(screen.getByText("Kalle Koivikko")).toBeTruthy();
      expect(screen.getByRole("columnheader", { name: /Taloyhtiö/ })).toBeTruthy();
      expect(screen.getByText("2 riviä · 2 taloyhtiötä")).toBeTruthy();
    } finally {
      delete responses["/data/residents"];
    }
  });

  it("Perustiedot-ryhmässä ovat asukkaat, asunnot, jonot ja avaimet; muutot ovat ilmoituksissa", async () => {
    await renderApp(staff("Isännöitsijä"), "#/residents");
    const section = within((await screen.findByRole("button", { name: "Taloyhtiö" })).closest(".nav-company-section") as HTMLElement);
    const group = await section.findByRole("button", { name: /Perustiedot/ });
    const items = (heading: Element) => {
      const labels: string[] = [];
      for (let next = heading.nextElementSibling; next && !next.classList.contains("nav-label"); next = next.nextElementSibling) {
        labels.push(next.textContent?.replace(/\d+$/, "").trim() ?? "");
      }
      return labels;
    };
    expect(items(group)).toEqual(["Asukkaat", "Asunnot", "Jonot", "Avaimet"]);
    expect(items(section.getByRole("button", { name: /Ilmoitukset/ }))).toEqual(["Tiedotteet", "Muutot", "Remontit", "Lukemat"]);
    expect(items(section.getByRole("button", { name: /^Tilat/ }))).toEqual(["Sauna", "Pyykkitupa", "Autopaikat"]);
  });

  it("asunnon tietueella ovat henkilöt rooleineen, avaimet ja väliotsikot", async () => {
    responses["/apartments/apt-1"] = {
      id: "apt-1", company_id: "demo-company", company_name: "As Oy Koivikko", apartment_number: "A 12", staircase: "A", address: "Koivikkotie 10",
      residents: [{ id: "r1", name: "Matti Meikäläinen", email: "matti@example.com", roles: "osakas,asukas" }],
      keys: [{ id: "k1", code: "A-12-1", type: "Asunto", status: "active", holder_name: null }],
      parking: [{ id: "p1", label: "P 4", type: "Lämmitetty", resident_name: "Matti Meikäläinen" }],
      bookings: [], renovations: [{ id: "n1", work_type: "Keittiö", start_date: "2026-11-01", end_date: "2026-11-20", status: "approved", resident_name: "Matti Meikäläinen" }]
    };
    try {
      await renderApp(staff("Isännöitsijä"), "#/apartments/apt-1");
      expect(await screen.findByRole("heading", { name: "Asunto A 12" })).toBeTruthy();
      expect((screen.getByDisplayValue("As Oy Koivikko") as HTMLInputElement).readOnly).toBe(true);
      expect(screen.getByText("Osakas")).toBeTruthy();
      expect(screen.getByText("A-12-1")).toBeTruthy();
      expect(screen.getByText("P 4")).toBeTruthy();
      fireEvent.click(screen.getByRole("tab", { name: /Remontit/ }));
      expect(screen.getByText("Keittiö")).toBeTruthy();
    } finally {
      delete responses["/apartments/apt-1"];
    }
  });

  it("asukkaan asunnon voi hakea listasta ja rooleiksi voi valita osakkaan ja asukkaan", async () => {
    responses["/companies/demo-company/apartments"] = [
      { id: "apt-1", apartment_number: "A 12", staircase: "A", address: "Koivikkotie 10", resident_count: 1 },
      { id: "apt-2", apartment_number: "B 34", staircase: "B", address: "Koivikkotie 10", resident_count: 0 }
    ];
    const calls = mockApi();
    try {
      await renderApp(staff("Isännöitsijä"), "#/residents");
      fireEvent.click(await screen.findByRole("button", { name: "Lisää asukas" }));
      fireEvent.change(screen.getByPlaceholderText("Esim. Matti Meikäläinen"), { target: { value: "Olli Osakas" } });
      fireEvent.click(screen.getByRole("checkbox", { name: "Osakas" }));
      const picker = screen.getByRole("combobox", { name: "Asunto" });
      fireEvent.focus(picker);
      fireEvent.change(picker, { target: { value: "rappu b" } });
      const list = await screen.findByRole("listbox", { name: "Asunnot" });
      await vi.waitFor(() => expect(within(list).getAllByRole("option").map(option => option.textContent)).toEqual(["B 34rappu B · Koivikkotie 10"]));
      fireEvent.click(within(list).getByRole("option"));
      const submit = screen.getAllByRole("button", { name: "Lisää asukas" }).find(button => button.getAttribute("type") === "submit")!;
      expect((submit as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(submit);
      await vi.waitFor(() => expect(calls.some(call => call.method === "POST" && call.url.endsWith("/companies/demo-company/residents"))).toBe(true));
      const body = JSON.parse(calls.find(call => call.method === "POST" && call.url.endsWith("/residents"))!.body);
      expect(body).toMatchObject({ name: "Olli Osakas", apartmentId: "apt-2", roles: ["asukas", "osakas"] });
    } finally {
      delete responses["/companies/demo-company/apartments"];
    }
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
    const section = within((await screen.findByRole("button", { name: "Taloyhtiö" })).closest(".nav-company-section") as HTMLElement);
    expect(await section.findByText("Pyykkitupa")).toBeTruthy();
    fireEvent.click(section.getByTitle("Piilota Tilat"));
    expect(section.queryByText("Pyykkitupa")).toBeNull();
    expect(section.getByText("Tiedotteet")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("kotilo.closedNavGroups") ?? "[]")).toEqual(["facilities"]);
    fireEvent.click(section.getByTitle("Näytä Tilat"));
    expect(section.getByText("Pyykkitupa")).toBeTruthy();
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

  it("valikon tehtävälista avautuu ilman Muistutukset-laatikon suodatinta", async () => {
    await renderApp(staff("Isännöitsijä"), "#/queue");
    fireEvent.click(await screen.findByRole("button", { name: /Muistutukset/ }, { timeout: 5000 }));
    expect(await screen.findByRole("button", { name: "Poista suodatin Määräaika" })).toBeTruthy();

    // Sama valikkokohta uudelleen nollaa suodattimet.
    fireEvent.click(screen.getByRole("button", { name: /^Omat tehtävät/ }));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Poista suodatin Määräaika" })).toBeNull());
    expect(window.location.hash).toBe("#/my-tickets");
  });

  it("asetusten haku avaa osion oikealta välilehdeltä", async () => {
    responses["/master-data"] = {
      values: { emergencyKeywords: [], sensitiveKeywords: ["sairau"], masking: { phone: true, email: true, personalId: true, iban: true },
        priorityDays: { emergency: 0, urgent: 1, normal: 7, low: 30 }, aiModels: { reply: "", assess: "", fast: "", reports: "" } },
      defaults: { emergencyKeywords: [], sensitiveKeywords: [], masking: { phone: true, email: true, personalId: true, iban: true },
        priorityDays: { emergency: 0, urgent: 1, normal: 7, low: 30 }, aiModels: { reply: "", assess: "", fast: "", reports: "" } },
      modelChoices: []
    };
    try {
      await renderApp(staff("Pääkäyttäjä"), "#/settings");
      const search = await screen.findByRole("searchbox", { name: "Hae asetuksista" });
      fireEvent.change(search, { target: { value: "henkilötunnus" } });
      fireEvent.click(screen.getByRole("option", { name: /Maskaus ennen AI:ta/ }));
      // Toimiston Tietoturva-välilehti avautuu, ja siellä ovat arkaluonteiset tiedot ja maskaus.
      expect((await screen.findByRole("tab", { name: "Tietoturva" })).getAttribute("aria-selected")).toBe("true");
      expect(await screen.findByText("Henkilötunnukset")).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Arkaluonteiset tiedot" })).toHaveLength(2);

      // AI-ehdotusten lisätietoikkuna on toimiston AI-asetuksissa, ei käyttäjän asetuksissa.
      fireEvent.change(search, { target: { value: "AI-ehdotukset" } });
      const options = within(screen.getByRole("listbox", { name: "Hakutulokset" })).getAllByRole("option");
      expect(options.map(option => option.textContent)).toEqual(["AI-ehdotuksetIsännöitsijätoimiston tiedot › AI"]);
      fireEvent.click(options[0]);
      expect(await screen.findByText("Kysy lisätietoa ennen AI-ehdotusta")).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "AI-mallit" })).toHaveLength(2);
    } finally {
      delete responses["/master-data"];
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

  it("vastaukseen voi liittää tehtävän liitteen ja dokumentaation tiedoston", async () => {
    const detail = {
      ticket: { ...overdueTicket, status: "waiting_manager", company_name: "As Oy Koivikko" },
      messages: [{ id: "m1", direction: "inbound", sender: "Matti <matti@example.com>", subject: "Häiriö", body: "Naapuri metelöi", created_at: "2026-10-14T10:00:00Z", channel: "email" }],
      audit: [], reporters: [], apartments: [], notes: [], workOrders: [], contractor: null, replyAccounts: [],
      attachments: [{ id: "a1", filename: "valokuva.jpg", mime_type: "image/jpeg", size: 2048, created_at: "2026-10-14T10:00:01Z", direction: "inbound", message_id: "m1" }]
    };
    responses["/tickets/ticket-1"] = detail;
    responses["/companies/demo-company/knowledge"] = [
      { id: "k1", title: "Järjestyssäännöt", kind: "document", file_name: "jarjestyssaannot.pdf", audience: "ai" },
      { id: "k2", title: "Sisäinen ohje", kind: "document", file_name: "sisainen.pdf", audience: "internal" },
      { id: "k3", title: "Saunavuorot", kind: "fact", file_name: null, audience: "ai" }
    ];
    try {
      const calls = mockApi();
      await renderApp(staff("Isännöitsijä"), "#/tickets/ticket-1");
      fireEvent.click(await screen.findByRole("button", { name: "Liitä tehtävän liite" }));
      fireEvent.click(screen.getByRole("option", { name: "valokuva.jpg (2 kt)" }));
      fireEvent.click(await screen.findByRole("button", { name: "Liitä dokumentti dokumentaatiosta" }));
      // Vain taloyhtiön käytössä olevat tiedostot tarjotaan, ei sisäisiä ohjeita eikä vakiotietoja.
      expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["Järjestyssäännöt (jarjestyssaannot.pdf)"]);
      fireEvent.click(screen.getByRole("option", { name: "Järjestyssäännöt (jarjestyssaannot.pdf)" }));
      expect(screen.getByRole("button", { name: "Poista liite jarjestyssaannot.pdf" })).toBeTruthy();

      fireEvent.change(document.querySelector(".draft-editor")!, { target: { value: "Liitteenä järjestyssäännöt." } });
      fireEvent.click(screen.getByRole("button", { name: "Lähetä" }));
      await vi.waitFor(() => expect(calls.some(request => request.url.endsWith("/tickets/ticket-1/reply"))).toBe(true));
      const reply = JSON.parse(calls.find(request => request.url.endsWith("/tickets/ticket-1/reply"))?.body ?? "{}");
      expect(reply.ticketAttachmentIds).toEqual(["a1"]);
      expect(reply.knowledgeIds).toEqual(["k1"]);
    } finally {
      delete responses["/tickets/ticket-1"];
      delete responses["/companies/demo-company/knowledge"];
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
      // Tehtävän sivu latautuu hitaalla CI-koneella yli sekunnin, joten odotetaan oletusta pidempään.
      await screen.findByRole("button", { name: "Poista" }, { timeout: 5000 });
      // Poista-painike on hetken pois käytöstä, kun tehtävän tietoja päivitetään latauksen jälkeen: klikataan
      // ajantasaista painiketta, kunnes vahvistus aukeaa.
      await vi.waitFor(() => {
        fireEvent.click(screen.getByRole("button", { name: "Poista" }));
        expect(screen.getByText("Poistetaanko tehtävä #T000001?")).toBeTruthy();
      }, { timeout: 5000 });
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

      // Ehdotuksen voi pyytää uudelleen; jatkovastauksessa AI on lukenut myös sähköpostiketjun.
      responses["/tickets/ticket-1/suggest"] = { draft: "Huoltomies kävi jo.", reason: "Aiempi vastaus.", source: null, usedAi: true, followUp: true };
      const again = screen.getByRole("button", { name: /Pyydä uusi AI-ehdotus/ }) as HTMLButtonElement;
      expect(again.disabled).toBe(false);
      // Edellinen ehdotus on luonnoksessa, joten korvaaminen varmistetaan.
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      fireEvent.click(again);
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Pyydä ehdotus" }));
      expect(await screen.findByText(/ottaa huomioon tehtävän sähköpostit/)).toBeTruthy();
      expect(calls.filter(request => request.url.endsWith("/tickets/ticket-1/suggest"))).toHaveLength(2);
      confirm.mockRestore();
    } finally {
      delete responses["/tickets/ticket-1"];
      delete responses["/tickets/ticket-1/suggest"];
      delete responses["/companies/demo-company/residents"];
    }
  });

  it("AI-agentti käsittelee tehtävän vasta painikkeesta ja kertoo tuloksen", async () => {
    const office = responses["/office"];
    responses["/tickets/ticket-1"] = {
      ticket: { ...overdueTicket, company_name: "As Oy Koivikko" }, messages: [], audit: [], reporters: [], apartments: [],
      notes: [], workOrders: [], contractor: null, attachments: []
    };
    responses["/tickets/ticket-1/agent"] = { outcome: "replied", reason: "", resolved: false, booked: false };
    try {
      // Ilman toimiston asetusta painiketta ei ole.
      await renderApp(staff("Isännöitsijä"), "#/tickets/ticket-1");
      expect(await screen.findByRole("button", { name: /Pyydä AI-ehdotus/ }, { timeout: 5000 })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Anna AI-agentin hoitaa/ })).toBeNull();
      cleanup();

      responses["/office"] = { ...(office as object), aiAgent: 1, aiAvailable: true };
      const calls = mockApi();
      await renderApp(staff("Isännöitsijä"), "#/tickets/ticket-1");
      const button = await screen.findByRole("button", { name: /Anna AI-agentin hoitaa/ }, { timeout: 5000 });
      // Tehtävän avaaminen ei kutsu agenttia.
      expect(calls.some(request => request.url.endsWith("/agent"))).toBe(false);
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      fireEvent.click(button);
      await vi.waitFor(() => expect(calls.some(request => request.method === "POST" && request.url.endsWith("/tickets/ticket-1/agent"))).toBe(true));
      expect(await screen.findByText("AI-agentti vastasi asukkaalle ja odottaa hänen vastaustaan.")).toBeTruthy();
      confirm.mockRestore();
    } finally {
      responses["/office"] = office;
      delete responses["/tickets/ticket-1"];
      delete responses["/tickets/ticket-1/agent"];
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
