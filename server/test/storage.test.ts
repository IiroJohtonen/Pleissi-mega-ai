import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { ADMIN_EMAIL, call, login, startServer, tempDir } from "./helpers.js";

describe("tallennus", () => {
  it("varmuuskopio otetaan käynnistyksessä, kun BACKUP_DIR on asetettu", async () => {
    const backupDir = await tempDir("kotilo-backup-");
    const server = await startServer({ env: { BACKUP_DIR: backupDir } });
    try {
      const admin = await login(server, ADMIN_EMAIL);
      const ticket = await call(server, admin, "POST", "/tickets", { companyId: "demo-company", subject: "Ennen kopiota", summary: "Testi" });
      assert.equal(ticket.status, 201);

      let backups: string[] = [];
      for (let attempt = 0; attempt < 50; attempt++) {
        // Keskeneräinen kopio on .kesken-alkuisessa kansiossa; valmis kopio alkaa nimellä kotilo-.
        backups = fs.readdirSync(backupDir).filter(name => name.startsWith("kotilo-"));
        if (backups.length > 0) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(backups.length, 1, server.output());
      assert.match(backups[0], /^kotilo-\d{4}-\d{2}-\d{2}_\d{6}$/);
      assert.ok(fs.existsSync(path.join(backupDir, backups[0], "attachments")));

      // Kopio on avattavissa oleva tietokanta, jossa käyttäjät ovat tallessa.
      const copy = new Database(path.join(backupDir, backups[0], "kotilo.sqlite"), { readonly: true });
      assert.equal((copy.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count, 4);
      copy.close();
    } finally {
      await server.stop();
    }
  });

  it("tuotantotilassa palvelin tarjoaa käyttöliittymän samasta osoitteesta", async () => {
    const clientDist = await tempDir("kotilo-client-");
    fs.writeFileSync(path.join(clientDist, "index.html"), "<!doctype html><title>Kotilo</title>");
    fs.writeFileSync(path.join(clientDist, "app.js"), "console.log('kotilo')");
    const server = await startServer({ env: { NODE_ENV: "production", CLIENT_DIST: clientDist } });
    try {
      const page = await fetch(`${server.url}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>Kotilo<\/title>/);
      assert.equal(await (await fetch(`${server.url}/app.js`)).text(), "console.log('kotilo')");
      // Selaimen sisäiset osoitteet palauttavat saman sivun; rajapinnan tuntematon polku ei.
      assert.match(await (await fetch(`${server.url}/asetukset/loki`)).text(), /<title>Kotilo<\/title>/);
      const api = await fetch(`${server.url}/api/ei-ole`);
      assert.equal(api.status, 401);
      assert.equal((await fetch(`${server.url}/api/health`)).status, 200);
    } finally {
      await server.stop();
    }
  });

  it("vanha kiito.sqlite nimetään uudelleen ja tiedot säilyvät", async () => {
    const dataDir = await tempDir();
    let server = await startServer({ dataDir });
    let admin = await login(server, ADMIN_EMAIL);
    const ticket = await call(server, admin, "POST", "/tickets", { companyId: "demo-company", subject: "Säilyy nimenvaihdossa", summary: "Testi" });
    await server.stop();

    // Palautetaan tilanne, jossa tietokanta on vanhalla nimellä ja osa muutoksista on vielä WAL-tiedostossa.
    for (const suffix of ["", "-wal", "-shm"]) {
      const current = path.join(dataDir, `kotilo.sqlite${suffix}`);
      if (fs.existsSync(current)) fs.renameSync(current, path.join(dataDir, `kiito.sqlite${suffix}`));
    }

    server = await startServer({ dataDir });
    try {
      assert.ok(fs.existsSync(path.join(dataDir, "kotilo.sqlite")));
      assert.equal(fs.existsSync(path.join(dataDir, "kiito.sqlite")), false);
      admin = await login(server, ADMIN_EMAIL);
      assert.equal((await call(server, admin, "GET", `/tickets/${ticket.data.ticketId}`)).data.ticket.subject, "Säilyy nimenvaihdossa");
    } finally {
      await server.stop();
    }
  });
});
