import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, login, MANAGER_EMAIL, PASSWORD, startServer, type TestServer } from "./helpers.js";

describe("varaustoiveet", () => {
  let server: TestServer;
  let manager: string;
  let matti: string;
  let liisa: string;

  before(async () => {
    server = await startServer();
    const admin = await login(server, ADMIN_EMAIL);
    manager = await login(server, MANAGER_EMAIL);
    await call(server, admin, "PUT", "/residents/resident-1", {
      name: "Matti Meikäläinen", email: "matti@example.com", address: "Koivikkotie 10", apartmentNumber: "A 12", password: PASSWORD
    });
    await call(server, admin, "PUT", "/residents/resident-2", {
      name: "Liisa Mallikas", email: "liisa@example.com", address: "Koivikkotie 10", apartmentNumber: "B 34", password: PASSWORD
    });
    matti = await login(server, "matti@example.com");
    liisa = await login(server, "liisa@example.com");
  });

  after(() => server.stop());

  // Vuoro kahden päivän päästä annettuun tasatuntiin.
  function slot(hour: number) {
    const start = new Date(Date.now() + 2 * 86_400_000);
    start.setUTCHours(hour, 0, 0, 0);
    return { resource: "sauna", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString() };
  }

  async function sauna(token: string, path: string, time: ReturnType<typeof slot>) {
    const query = `resource=sauna&from=${encodeURIComponent(time.startsAt)}&to=${encodeURIComponent(time.endsAt)}`;
    return (await call(server, token, "GET", `${path}?${query}`)).data as any[];
  }

  it("toive hyväksytään: vuoro siirtyy toivojalle ja aiempi varaus poistuu", async () => {
    const time = slot(15);
    assert.equal((await call(server, liisa, "POST", "/portal/booking-requests", { ...time, note: "Vieraita tulossa" })).status, 409);
    assert.equal((await call(server, matti, "POST", "/portal/bookings", time)).status, 201);
    assert.equal((await call(server, matti, "POST", "/portal/booking-requests", time)).status, 409);

    const created = await call(server, liisa, "POST", "/portal/booking-requests", { ...time, note: "Vieraita tulossa" });
    assert.equal(created.status, 201);
    assert.equal((await call(server, liisa, "POST", "/portal/booking-requests", time)).status, 409);
    const mine = (await call(server, liisa, "GET", "/portal/booking-requests?resource=sauna")).data;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, "pending");

    const pending = (await call(server, manager, "GET", "/companies/demo-company/booking-requests")).data;
    const request = pending.find((item: any) => item.id === created.data.requestId);
    assert.equal(request.resident_name, "Liisa Mallikas");
    assert.equal(request.note, "Vieraita tulossa");
    assert.match(request.current_holder, /Matti Meikäläinen/);

    // Asukas ei pääse henkilökunnan reitteihin.
    assert.equal((await call(server, liisa, "POST", `/booking-requests/${request.id}/approve`)).status, 403);

    assert.equal((await call(server, manager, "POST", `/booking-requests/${request.id}/approve`)).status, 200);
    assert.equal((await call(server, manager, "POST", `/booking-requests/${request.id}/approve`)).status, 409);

    const bookings = await sauna(manager, "/companies/demo-company/bookings", time);
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].resident_id, "resident-2");
    assert.equal((await sauna(liisa, "/portal/bookings", time))[0].mine, true);
    assert.equal((await sauna(matti, "/portal/bookings", time))[0].mine, false);
    assert.equal((await call(server, liisa, "GET", "/portal/booking-requests")).data[0].status, "approved");
  });

  it("toive hylätään perustelulla, ja asukas voi perua odottavan toiveen", async () => {
    const time = slot(17);
    assert.equal((await call(server, matti, "POST", "/portal/bookings", time)).status, 201);

    const first = await call(server, liisa, "POST", "/portal/booking-requests", time);
    assert.equal((await call(server, manager, "POST", `/booking-requests/${first.data.requestId}/reject`, { note: "Vuoro on vakiovuoro." })).status, 200);
    const rejected = (await call(server, liisa, "GET", "/portal/booking-requests")).data
      .find((item: any) => item.id === first.data.requestId);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.decision_note, "Vuoro on vakiovuoro.");
    assert.equal((await sauna(manager, "/companies/demo-company/bookings", time))[0].resident_id, "resident-1");

    const second = await call(server, liisa, "POST", "/portal/booking-requests", time);
    assert.equal(second.status, 201);
    assert.equal((await call(server, matti, "DELETE", `/portal/booking-requests/${second.data.requestId}`)).status, 404);
    assert.equal((await call(server, liisa, "DELETE", `/portal/booking-requests/${second.data.requestId}`)).status, 200);
    const pending = (await call(server, manager, "GET", "/companies/demo-company/booking-requests")).data;
    assert.ok(!pending.some((item: any) => item.id === second.data.requestId));
    assert.equal((await call(server, manager, "POST", `/booking-requests/${second.data.requestId}/approve`)).status, 409);
  });
});
