import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const company = { id: "demo-company", name: "As Oy Koivikko", email_address: "", manager_id: null, manager_ids: [] };
const overdueTicket = {
  id: "ticket-1", ticket_number: 1, company_id: "demo-company", type: "Kysymys", priority: "normal", status: "open",
  subject: "Saunavuoron varaus", summary: "Asukas kysyy saunavuorosta.", source_channel: "email", ai_action: "pending_decision",
  ai_reason: "", due_date: "2026-01-01", created_at: "2025-12-27T08:00:00.000Z", updated_at: "2025-12-27T08:00:00.000Z"
};

// Vastaukset rajapinnan lukukutsuihin; muut polut palauttavat tyhjän listan.
const responses: Record<string, unknown> = {
  "/users": [],
  "/office": { name: "Testitoimisto Oy", businessId: "", address: "", phone: "" },
  "/companies": [company],
  "/tickets?companyId=demo-company": [overdueTicket],
  "/my-tickets?companyId=demo-company": []
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

  it("näyttää päätösjonon ja merkitsee myöhässä olevan tehtävän", async () => {
    await renderApp(staff("Asiakaspalvelu"));
    expect(await screen.findByText("Saunavuoron varaus")).toBeTruthy();
    expect(screen.getByText("Myöhässä 1.1.2026")).toBeTruthy();
    expect(screen.getByText("As Oy Koivikko")).toBeTruthy();
  });

  it("lukee vanhalla nimellä tallennetun istunnon", async () => {
    localStorage.clear();
    localStorage.setItem("kiito.session", JSON.stringify(staff("Pääkäyttäjä")));
    vi.resetModules();
    const { default: App } = await import("./App");
    render(<App />);
    expect(await screen.findByText("Kirjaudu ulos")).toBeTruthy();
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
    expect(screen.getByText("Kulutuslukemat")).toBeTruthy();
  });

  it("näyttää käyttöliittymän englanniksi, kun kieli on valittu", async () => {
    await renderApp(staff("Asiakaspalvelu"), "", "en");
    expect(await screen.findByText("Saunavuoron varaus")).toBeTruthy();
    expect(screen.getByText("Sign out")).toBeTruthy();
    expect(screen.getAllByText("Decision queue").length).toBeGreaterThan(0);
    expect(screen.getByText("Overdue 1/1/2026")).toBeTruthy();
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
      expect(screen.getByTitle("Odottaa käsittelyä").textContent).toBe("1");
      // Yhden taloyhtiön toimistolla Taloyhtiö-saraketta ei näytetä.
      expect(screen.queryByRole("columnheader", { name: "Taloyhtiö" })).toBeNull();
    } finally {
      delete responses["/companies/demo-company/moves"];
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
    const label = await screen.findByText("AI arvioi saapuvan tehtävän prioriteetin");
    const toggle = label.closest("label")?.querySelector("input") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("tallentaa tehtävän tietojen muutokset vasta Tallenna-painikkeesta", async () => {
    const detail = { ticket: { ...overdueTicket, company_name: "As Oy Koivikko" }, messages: [], audit: [], reporters: [], apartments: [], notes: [], workOrders: [], contractor: null, attachments: [] };
    responses["/tickets/ticket-1"] = detail;
    try {
      const calls = mockApi();
      await renderApp(staff("Asiakaspalvelu"), "#/tickets/ticket-1");
      const save = await screen.findByRole("button", { name: "Tallenna" }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
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

  it("varoittaa ennen tehtävän poistamista ja poistaa vasta vahvistuksesta", async () => {
    const detail = { ticket: { ...overdueTicket, company_name: "As Oy Koivikko" }, messages: [], audit: [], reporters: [], apartments: [], notes: [], workOrders: [], contractor: null, attachments: [] };
    responses["/tickets/ticket-1"] = detail;
    try {
      const calls = mockApi();
      await renderApp(staff("Isännöitsijä"), "#/tickets/ticket-1");
      fireEvent.click(await screen.findByRole("button", { name: "Poista" }));
      expect(screen.getByText("Poistetaanko tehtävä #0001?")).toBeTruthy();
      expect(screen.getByText(/Poistoa ei voi perua/)).toBeTruthy();
      expect(calls.some(request => request.method === "DELETE")).toBe(false);

      fireEvent.click(screen.getByRole("button", { name: "Poista tehtävä" }));
      await vi.waitFor(() => expect(calls.some(request => request.method === "DELETE" && request.url.endsWith("/tickets/ticket-1"))).toBe(true));
    } finally {
      delete responses["/tickets/ticket-1"];
    }
  });

  it("lähettää istuntotunnisteen otsakkeessa eikä osoitteessa", async () => {
    const calls = mockApi();
    await renderApp(staff("Pääkäyttäjä"));
    await screen.findByText("Saunavuoron varaus");
    expect(calls.length).toBeGreaterThan(0);
    for (const request of calls) {
      expect(request.url).not.toContain("testitunniste");
      expect(request.headers.Authorization).toBe("Bearer testitunniste");
    }
  });
});
