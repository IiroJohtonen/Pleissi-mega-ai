import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ADMIN_EMAIL, call, MANAGER_EMAIL, PASSWORD, startServer, type TestServer } from "./helpers.js";

describe("kirjautumiskoodi sähköpostiin", () => {
  let server: TestServer;
  let admin: string;

  // Testeissä koodia ei lähetetä postina; palvelin tulostaa sen lokiin.
  function latestCode(email: string) {
    const matches = [...server.output().matchAll(new RegExp(`Kirjautumiskoodi ${email.replace(/\./g, "\\.")}: (\\d{6})`, "g"))];
    assert.ok(matches.length > 0, "koodia ei löytynyt palvelimen lokista");
    return matches[matches.length - 1][1];
  }

  async function passwordStep(email: string, deviceToken?: string) {
    return call(server, null, "POST", "/auth/login", { email, password: PASSWORD, ...(deviceToken ? { deviceToken } : {}) });
  }

  before(async () => {
    server = await startServer();
    admin = (await passwordStep(ADMIN_EMAIL)).data.token;
    const office = (await call(server, admin, "GET", "/office")).data;
    assert.equal(office.twoFactor, 0);
    const saved = await call(server, admin, "PUT", "/office", { name: office.name, twoFactor: true });
    assert.equal(saved.data.twoFactor, 1);
  });

  after(() => server.stop());

  it("salasanan jälkeen kysytään koodi, ja vain oikea koodi kirjaa sisään", async () => {
    const first = await passwordStep(MANAGER_EMAIL);
    assert.equal(first.status, 200);
    assert.equal(first.data.twoFactor, true);
    assert.equal(first.data.token, undefined);
    assert.match(first.data.email, /^ha•+@pohjantahti-isannointi\.fi$/);
    const code = latestCode(MANAGER_EMAIL);
    const wrong = code === "000000" ? "111111" : "000000";

    const rejected = await call(server, null, "POST", "/auth/verify-code", { challengeId: first.data.challengeId, code: wrong });
    assert.equal(rejected.status, 401);
    assert.match(rejected.data.error, /Yrityksiä jäljellä 4/);
    assert.equal((await call(server, null, "POST", "/auth/verify-code", { challengeId: "x".repeat(64), code })).status, 401);

    const accepted = await call(server, null, "POST", "/auth/verify-code", { challengeId: first.data.challengeId, code });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.user.email, MANAGER_EMAIL);
    assert.equal(accepted.data.deviceToken, undefined);
    assert.equal((await call(server, accepted.data.token, "GET", "/auth/me")).status, 200);

    // Koodi on kertakäyttöinen.
    assert.equal((await call(server, null, "POST", "/auth/verify-code", { challengeId: first.data.challengeId, code })).status, 401);
  });

  it("viides väärä koodi mitätöi kirjautumisen, ja uutta koodia ei voi pyytää heti", async () => {
    const step = await passwordStep(MANAGER_EMAIL);
    assert.equal((await call(server, null, "POST", "/auth/resend-code", { challengeId: step.data.challengeId })).status, 429);
    const code = latestCode(MANAGER_EMAIL);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 1; attempt <= 5; attempt++) {
      assert.equal((await call(server, null, "POST", "/auth/verify-code", { challengeId: step.data.challengeId, code: wrong })).status, 401);
    }
    const locked = await call(server, null, "POST", "/auth/verify-code", { challengeId: step.data.challengeId, code });
    assert.equal(locked.status, 401);
    assert.match(locked.data.error, /Kirjaudu uudelleen/);
  });

  it("luotettu laite ohittaa koodin, kunnes salasana vaihdetaan", async () => {
    const step = await passwordStep(MANAGER_EMAIL);
    const verified = await call(server, null, "POST", "/auth/verify-code", {
      challengeId: step.data.challengeId, code: latestCode(MANAGER_EMAIL), rememberDevice: true
    });
    assert.equal(verified.status, 200);
    const deviceToken = verified.data.deviceToken as string;
    assert.ok(deviceToken);

    const again = await passwordStep(MANAGER_EMAIL, deviceToken);
    assert.ok(again.data.token, "luotetulla laitteella kirjautuminen onnistuu ilman koodia");
    // Toisen käyttäjän laitetunnisteella koodi kysytään silti.
    assert.equal((await passwordStep(ADMIN_EMAIL, deviceToken)).data.twoFactor, true);
    // Väärä salasana ei kelpaa luotetullakaan laitteella.
    assert.equal((await call(server, null, "POST", "/auth/login", { email: MANAGER_EMAIL, password: "väärä-salasana", deviceToken })).status, 401);

    const me = (await call(server, again.data.token, "GET", "/auth/me")).data;
    assert.equal((await call(server, again.data.token, "PUT", `/users/${me.id}`, { name: me.name, email: me.email, password: PASSWORD, currentPassword: PASSWORD })).status, 200);
    assert.equal((await passwordStep(MANAGER_EMAIL, deviceToken)).data.twoFactor, true);
  });

  it("asetuksen voi kytkeä pois, jolloin koodia ei kysytä", async () => {
    const step = await passwordStep(ADMIN_EMAIL);
    const verified = await call(server, null, "POST", "/auth/verify-code", { challengeId: step.data.challengeId, code: latestCode(ADMIN_EMAIL) });
    const office = (await call(server, verified.data.token, "GET", "/office")).data;
    await call(server, verified.data.token, "PUT", "/office", { name: office.name, twoFactor: false });
    assert.ok((await passwordStep(MANAGER_EMAIL)).data.token);
  });
});

describe("kirjautumiskoodin yritysraja", () => {
  it("samalle käyttäjälle aloitetaan enintään viisi kirjautumista vartissa", async () => {
    const server = await startServer();
    try {
      const admin = (await call(server, null, "POST", "/auth/login", { email: ADMIN_EMAIL, password: PASSWORD })).data.token;
      const office = (await call(server, admin, "GET", "/office")).data;
      await call(server, admin, "PUT", "/office", { name: office.name, twoFactor: true });
      for (let attempt = 1; attempt <= 5; attempt++) {
        assert.equal((await call(server, null, "POST", "/auth/login", { email: MANAGER_EMAIL, password: PASSWORD })).data.twoFactor, true);
      }
      assert.equal((await call(server, null, "POST", "/auth/login", { email: MANAGER_EMAIL, password: PASSWORD })).status, 429);
    } finally {
      await server.stop();
    }
  });
});

describe("kirjautumiskoodin hätäkatkaisin", () => {
  it("TWO_FACTOR_DISABLED ohittaa asetuksen", async () => {
    const server = await startServer({ env: { TWO_FACTOR_DISABLED: "1" } });
    try {
      const admin = (await call(server, null, "POST", "/auth/login", { email: ADMIN_EMAIL, password: PASSWORD })).data.token;
      const office = (await call(server, admin, "GET", "/office")).data;
      const saved = await call(server, admin, "PUT", "/office", { name: office.name, twoFactor: true });
      assert.equal(saved.data.twoFactorOverridden, true);
      const login = await call(server, null, "POST", "/auth/login", { email: MANAGER_EMAIL, password: PASSWORD });
      assert.ok(login.data.token);
    } finally {
      await server.stop();
    }
  });
});
