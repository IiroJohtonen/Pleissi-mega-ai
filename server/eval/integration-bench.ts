import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------------------------
// ERP-integraation suorituskyky: mittaa jonon, julkaisun, haun, ensilatauksen ja vastaanoton ajat
// tilapäisessä tietokannassa keksityllä aineistolla. Ei käytä oikeaa tietokantaa eikä verkkoa.
//
//   npm run bench:integration                          oletuskoko (3 000 tehtävää, 100 taloyhtiötä)
//   npm run bench:integration -- --tickets 10000 --companies 300
//
// Ohjearvot (kehityskone, oletuskoko): tehtävän muutos jono päällä alle 2 ms, luonnoksen tallennus alle
// 0,1 ms, ensilatauksen päivitys alle 1 s, kutsu 1 000 odottavan sanoman aikana alle 1 ms. Selvästi
// suuremmat ajat kertovat yleensä puuttuvasta indeksistä tai kyselystä, joka käy läpi koko taulun.
// ---------------------------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    tickets: { type: "string", default: "3000" },
    messages: { type: "string", default: "10" },
    companies: { type: "string", default: "100" },
    apartments: { type: "string", default: "50" },
    residents: { type: "string", default: "100" },
    pending: { type: "string", default: "1000" }
  }
});
const size = {
  tickets: Number(args.tickets), messages: Number(args.messages), companies: Number(args.companies),
  apartments: Number(args.apartments), residents: Number(args.residents), pending: Number(args.pending)
};

Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "pleissi-bench-")),
  GMAIL_DISABLED: "1",
  INITIAL_PASSWORD: "bench-ei-kirjautumista",
  ANTHROPIC_API_KEY: "",
  INTEGRATION_ADAPTER: "",
  INTEGRATION_PULL: "",
  INTEGRATION_SEND_DELAY_MS: "0"
});

const { db } = await import("../src/db.js");
await import("../src/routes/tickets.js");
const { setPullSetting } = await import("../src/integration/outbox.js");
const inbox = await import("../src/integration/inbox.js");
const { publishOutbox, fetchEvents } = await import("../src/integration/pull.js");
const { createApiKey, authenticateApiKey } = await import("../src/integration/api-keys.js");

const results: { name: string; ms: number; per?: string }[] = [];
async function measure(name: string, count: number, work: () => unknown) {
  const started = performance.now();
  await work();
  const ms = performance.now() - started;
  results.push({ name, ms, per: count > 1 ? `${(ms / count).toFixed(3)} ms / kpl` : undefined });
}

// --- Pohja-aineisto: tehtävät ja viestit ilman jonoa ------------------------------------------
const COMPANY = "bench-company";
const created = new Date().toISOString();
db.prepare("INSERT INTO companies (id, name, email_address) VALUES (?, 'As Oy Mittaus', 'mittaus@example.com')").run(COMPANY);
db.transaction(() => {
  const ticket = db.prepare(`
    INSERT INTO tickets (id, company_id, type, priority, status, subject, summary, source_channel, ai_action, ai_reason, draft, created_at, updated_at)
    VALUES (?, ?, 'Vikailmoitus', 'normal', 'open', 'Hana vuotaa', 'Keittiön hana vuotaa.', 'email', 'pending_decision', '', '', ?, ?)
  `);
  const message = db.prepare(`
    INSERT INTO messages (id, ticket_id, direction, sender, subject, body, created_at, channel)
    VALUES (?, ?, 'inbound', 'Liisa Mattila', 'Hana', 'Hana vuotaa edelleen.', ?, 'email')
  `);
  for (let i = 0; i < size.tickets; i++) {
    ticket.run(`bench-t-${i}`, COMPANY, created, created);
    for (let j = 0; j < size.messages; j++) message.run(`bench-m-${i}-${j}`, `bench-t-${i}`, created);
  }
})();
const count = Math.min(1000, size.tickets);
const update = (sql: string, value: (i: number) => unknown[]) => () => {
  const statement = db.prepare(sql);
  for (let i = 0; i < count; i++) statement.run(...value(i));
};

// --- Lähtevä jono -----------------------------------------------------------------------------
await measure("Tehtävän muutos, jono pois", count, update("UPDATE tickets SET priority = ? WHERE id = ?", i => ["low", `bench-t-${i}`]));
setPullSetting(true);
await measure("Tehtävän ensimmäinen kirjaus jonoon (tehtävä + viestit)", count,
  update("UPDATE tickets SET priority = ?, updated_at = ? WHERE id = ?", i => ["urgent", new Date().toISOString(), `bench-t-${i}`]));
await measure("Tehtävän muutos, jono päällä", count,
  update("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?", i => ["waiting_manager", new Date().toISOString(), `bench-t-${i}`]));
await measure("Luonnoksen tallennus (ei ERP:lle), jono päällä", count, update("UPDATE tickets SET draft = ? WHERE id = ?", i => [`Luonnos ${i}`, `bench-t-${i}`]));
const queued = (db.prepare("SELECT COUNT(*) AS n FROM integration_outbox").get() as { n: number }).n;
await measure(`Julkaisu haettavaksi (${queued} riviä)`, 1, () => publishOutbox(Date.now() + 60_000));

const { apiKey, key } = createApiKey("Mittaus", ["events:read"], "mittaus");
await measure("API-avaimen tarkistus", 200, () => { for (let i = 0; i < 200; i++) authenticateApiKey(`Bearer ${key}`); });
await measure("Jonon haku, sivu 100 tapahtumaa", 20, () => {
  let after: number | null = null;
  for (let i = 0; i < 20; i++) {
    const page = fetchEvents(after, 100, apiKey.id);
    after = page.nextCursor ? Number(page.nextCursor.slice(2)) : after;
  }
});

// --- Ensilataus -------------------------------------------------------------------------------
const sync = inbox.SyncSchema.parse({
  housingCompanies: Array.from({ length: size.companies }, (_, c) => ({
    externalRefs: { erp: `HC-${c}` }, name: `As Oy ${c}`, email: `hc${c}@example.com`,
    apartments: Array.from({ length: size.apartments }, (_, a) => ({ externalRefs: { erp: `HC-${c}-A${a}` }, apartmentNumber: `A ${a}`, address: `Mittauskatu ${c}` })),
    residents: Array.from({ length: size.residents }, (_, r) => ({
      externalRefs: { erp: `R-${c}-${r}` }, apartmentRef: `HC-${c}-A${r % size.apartments}`, name: `Asukas ${c}-${r}`,
      email: `r${c}-${r}@example.com`, phone: "040 123 4567", roles: ["asukas"]
    }))
  }))
});
const residentTotal = size.companies * size.residents;
await measure(`Ensilataus: ${size.companies} taloyhtiötä, ${residentTotal} asukasta`, residentTotal, () => inbox.syncHousingCompanies(sync));
await measure("Ensilataus uudelleen (päivitys)", residentTotal, () => inbox.syncHousingCompanies(sync));

// --- Vastaanotto ja odotustila ------------------------------------------------------------------
const envelope = (eventType: string, data: unknown, eventId: string) =>
  ({ eventId, eventType, schemaVersion: "1.0", occurredAt: "2026-10-30T09:00:00+02:00", source: "erp", data });
await measure(`Vastaanotto: ${size.pending} odottamaan jäävää tapahtumaa`, size.pending, () => {
  for (let batch = 0; batch * 100 < size.pending; batch++) {
    inbox.receiveEvents(Array.from({ length: Math.min(100, size.pending - batch * 100) }, (_, i) => envelope("resident.upserted", {
      externalRefs: { erp: `P-${batch}-${i}` }, housingCompanyRef: "PUUTTUU", apartmentRef: "PUUTTUU-A1", name: "Odottava", phone: "0401111111", roles: ["asukas"]
    }, `bench-p-${batch}-${i}`)), null);
  }
});
await measure(`Kutsu, jossa yksi asukas, kun ${size.pending} odottaa`, 50, () => {
  for (let i = 0; i < 50; i++) {
    inbox.receiveEvents([envelope("resident.upserted", {
      externalRefs: { erp: `R-0-${i}` }, housingCompanyRef: "HC-0", apartmentRef: "HC-0-A1", name: `Päivitetty ${i}`, email: `r0-${i}@example.com`, roles: ["asukas"]
    }, `bench-u-${i}`)], null);
  }
});
await measure("Odottavien 24 tunnin tarkistus", 1, () => inbox.expirePendingInbox());
await measure("Vanhojen sanomien siivous", 1, () => inbox.purgeInboxPayloads(Date.now() + 40 * 24 * 60 * 60 * 1000));

console.log(`\nERP-integraation suorituskyky (${size.tickets} tehtävää × ${size.messages} viestiä, ${size.companies} taloyhtiötä)\n`);
const width = Math.max(...results.map(result => result.name.length));
for (const result of results) {
  console.log(`${result.name.padEnd(width)}  ${result.ms.toFixed(0).padStart(7)} ms${result.per ? `  (${result.per})` : ""}`);
}
fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
process.exit(0);
