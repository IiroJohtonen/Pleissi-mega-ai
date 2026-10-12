import { cleanup, render, screen } from "@testing-library/react";
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
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const path = url.replace(/^.*\/api/, "");
    return new Response(JSON.stringify(responses[path] ?? []), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

// Istunto luetaan selaimen tallennuksesta moduulin latautuessa, joten sovellus ladataan vasta sen jälkeen.
async function renderApp(session: unknown, hash = "") {
  localStorage.clear();
  if (session) localStorage.setItem("kotilo.session", JSON.stringify(session));
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
