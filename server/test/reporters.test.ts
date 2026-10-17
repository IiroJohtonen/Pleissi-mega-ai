import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, PASSWORD, startServer, type TestServer } from "./helpers.js";

describe("ilmoittajan vaihto tietueilla ja dokumentin tietojen tarkistus", () => {
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

  async function otherResident() {
    const residents = (await call(server, manager, "GET", "/companies/demo-company/residents")).data as { id: string; name: string; apartment_id?: string }[];
    const other = residents.find(item => item.id !== "resident-2");
    assert.ok(other, "demossa pitää olla toinen asukas");
    return other;
  }

  it("remontti-ilmoituksen ilmoittajan vaihto päivittää myös remonttitehtävän", async () => {
    const created = await call(server, resident, "POST", "/portal/renovations", {
      workType: "Keittiö", description: "Keittiön kaapistot ja työtaso uusitaan.",
      startDate: "2027-04-01", endDate: "2027-04-10", contractor: ""
    });
    assert.equal(created.status, 201);
    const other = await otherResident();

    assert.equal((await call(server, manager, "PUT", `/renovations/${created.data.renovationId}/reporter`, { residentId: other.id })).status, 200);
    const notice = ((await call(server, manager, "GET", "/companies/demo-company/renovations")).data as any[])
      .find(item => item.id === created.data.renovationId);
    assert.equal(notice.resident_id, other.id);
    assert.equal(notice.resident_name, other.name);

    const ticket = (await call(server, manager, "GET", `/tickets/${notice.ticket_id}`)).data;
    assert.equal(ticket.ticket.resident_id, other.id);
    assert.ok(ticket.audit.some((row: any) => row.action === "reporter_changed"));

    // Tehtävän ilmoittajan vaihto vaihtaa myös remontti-ilmoituksen ilmoittajan.
    assert.equal((await call(server, manager, "POST", `/tickets/${notice.ticket_id}/reporters`, { residentId: "resident-2" })).status, 201);
    const back = ((await call(server, manager, "GET", "/companies/demo-company/renovations")).data as any[])
      .find(item => item.id === created.data.renovationId);
    assert.equal(back.resident_id, "resident-2");
  });

  it("jonon ja lukeman ilmoittajan voi vaihtaa vain saman taloyhtiön asukkaaseen", async () => {
    const joined = await call(server, resident, "POST", "/portal/waitlist", { resource: "parking", parkingType: "", note: "" });
    assert.equal(joined.status, 201);
    const other = await otherResident();

    assert.equal((await call(server, manager, "PUT", `/waitlist/${joined.data.waitlistId}/reporter`, { residentId: "olematon" })).status, 404);
    assert.equal((await call(server, manager, "PUT", `/waitlist/${joined.data.waitlistId}/reporter`, { residentId: "" })).status, 400);
    assert.equal((await call(server, manager, "PUT", `/waitlist/${joined.data.waitlistId}/reporter`, { residentId: other.id })).status, 200);
    const entry = ((await call(server, manager, "GET", "/companies/demo-company/waitlist")).data as any[])
      .find(item => item.id === joined.data.waitlistId);
    assert.equal(entry.resident_name, other.name);

    const reading = await call(server, resident, "POST", "/portal/meter-readings", { meterType: "electricity", value: 1500 });
    assert.equal(reading.status, 201);
    const listed = ((await call(server, manager, "GET", "/companies/demo-company/meter-readings")).data as any[])
      .find(item => item.meter_type === "electricity");
    assert.equal(listed.resident_name, "Liisa Mallikas");
    assert.equal((await call(server, manager, "PUT", `/meter-readings/${listed.id}/reporter`, { residentId: other.id })).status, 200);
    const changed = ((await call(server, manager, "GET", "/companies/demo-company/meter-readings")).data as any[])
      .find(item => item.id === listed.id);
    assert.equal(changed.resident_name, other.name);
    // Lukeman asunto ei muutu ilmoittajan mukana.
    assert.equal(changed.apartment_id, listed.apartment_id);

    assert.equal((await call(server, manager, "PUT", `/tuntematon/${listed.id}/reporter`, { residentId: other.id })).status, 404);
    assert.equal((await call(server, resident, "PUT", `/waitlist/${joined.data.waitlistId}/reporter`, { residentId: other.id })).status, 403);
  });

  it("dokumentista poimitun tiedon voi merkitä tarkistetuksi muuttamatta sisältöä", async () => {
    const response = await fetch(
      `${server.url}/api/companies/demo-company/knowledge/documents?fileName=ohje.txt&mimeType=text%2Fplain&title=Ohje&audience=ai`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${manager}`, "Content-Type": "application/octet-stream" },
        body: "Pihasäännöt\n\n1. Grillaus\nGrillaus on sallittu pihan grillipaikalla.\n\n2. Pyörät\nPolkupyörät säilytetään pyörävarastossa."
      }
    );
    assert.equal(response.status, 201);
    const { knowledgeId } = await response.json() as { knowledgeId: string };
    const chunks = (await call(server, manager, "GET", `/knowledge/${knowledgeId}/chunks`)).data as any[];
    const target = chunks.find(chunk => !chunk.verified);
    assert.ok(target, "dokumentissa pitää olla tarkistamaton tieto");

    assert.equal((await call(server, manager, "POST", `/knowledge-chunks/${target.id}/verify`)).status, 200);
    const after = ((await call(server, manager, "GET", `/knowledge/${knowledgeId}/chunks`)).data as any[]).find(chunk => chunk.id === target.id);
    assert.ok(after.verified);
    assert.ok(!after.needs_review);
    assert.equal(after.content, target.content);
    assert.equal(after.title, target.title);
    assert.equal((await call(server, manager, "POST", "/knowledge-chunks/olematon/verify")).status, 404);
  });
});
