import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { call, login, startServer, tempDir, type TestServer } from "./helpers.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_PASSWORD = "Esittely-salasana-1";

function runReset(dataDir: string, backupDir: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/demo-reset.ts", ...args], {
    cwd: serverRoot,
    env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backupDir, GMAIL_DISABLED: "1", ANTHROPIC_API_KEY: "", INITIAL_PASSWORD: "Testi-salasana1" },
    encoding: "utf8"
  });
}

describe("esittelyaineisto", () => {
  let server: TestServer;
  let backupDir: string;
  let resetOutput: string;

  before(async () => {
    // Ensin tavallinen alusta, jonka esittelyaineisto korvaa.
    const first = await startServer();
    await first.stop();
    backupDir = await tempDir("kotilo-demo-backup-");
    assert.equal(runReset(first.dataDir, backupDir, ["--salasana=" + DEMO_PASSWORD]).status, 1, "ilman vahvistusta ei poisteta mitään");
    const reset = runReset(first.dataDir, backupDir, ["--vahvista", "--salasana=" + DEMO_PASSWORD, "--sahkoposti=esittelija@example.com"]);
    resetOutput = reset.stdout + reset.stderr;
    assert.equal(reset.status, 0, resetOutput);
    server = await startServer({ dataDir: first.dataDir });
  });

  after(() => server.stop());

  it("ottaa varmuuskopion ja korvaa vanhat käyttäjät esittelytunnuksilla", async () => {
    assert.match(resetOutput, /Varmuuskopio otettu/);
    await assert.rejects(login(server, "demo@pohjantahti-isannointi.fi"));
    const admin = await login(server, "esittelija@example.com", DEMO_PASSWORD);
    const users = (await call(server, admin, "GET", "/users")).data as any[];
    assert.equal(users.length, 5);
    assert.ok(users.some(user => user.role === "Pääkäyttäjä" && user.email === "esittelija@example.com"));
  });

  it("luo taloyhtiöt, tehtävät ja kaikkien taulujen tiedot", async () => {
    const admin = await login(server, "esittelija@example.com", DEMO_PASSWORD);
    const companies = (await call(server, admin, "GET", "/companies")).data as any[];
    assert.equal(companies.length, 4);
    const tickets = (await call(server, admin, "GET", "/tickets?companyId=all")).data as any[];
    assert.ok(tickets.length >= 60, `tehtäviä ${tickets.length}`);
    // Vanhan testiaineiston kiireellisiä esimerkkejä ei lisätä uudelleenkäynnistyksessä.
    assert.equal(tickets.some(ticket => ticket.id.startsWith("ticket-urgent")), false);
    for (const [resource, minimum] of [["apartments", 12], ["residents", 15], ["keys", 25], ["knowledge", 7], ["moves", 2],
      ["renovations", 2], ["parking", 8], ["meter-readings", 20], ["announcements", 1], ["waitlist", 3]] as const) {
      const result = await call(server, admin, "GET", `/companies/demo-company/${resource}`);
      assert.equal(result.status, 200, resource);
      assert.ok((result.data as any[]).length >= minimum, `${resource}: ${(result.data as any[]).length}`);
    }
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const to = new Date(Date.now() + 14 * 86_400_000).toISOString();
    for (const resource of ["sauna", "laundry"]) {
      const bookings = (await call(server, admin, "GET", `/companies/demo-company/bookings?resource=${resource}&from=${from}&to=${to}`)).data as any[];
      assert.ok(bookings.length >= 10, `${resource}: ${bookings.length}`);
    }
  });

  it("asukas- ja hallitustunnukset toimivat esittelysalasanalla", async () => {
    const resident = await call(server, null, "POST", "/auth/login", { email: "liisa@example.com", password: DEMO_PASSWORD });
    assert.equal(resident.data.kind, "resident");
    const board = await call(server, null, "POST", "/auth/login", { email: "hallitus.koivikko@example.com", password: DEMO_PASSWORD });
    assert.equal(board.data.kind, "board");
  });
});
