import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { call, login, MANAGER_EMAIL, SERVICE_EMAIL, startServer, type TestServer } from "./helpers.js";

// Viedyn CSV:n rivit tuonnin muotoon: sama sarakejärjestys kuin viennissä (asunto, avainnumero,
// tyyppi, huomio, tila). Testiaineistossa ei ole puolipisteitä eikä lainausmerkkejä.
function csvToRows(csv: string) {
  const [header, ...lines] = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  assert.deepEqual(header.split(";"), ["asunto", "avainnumero", "tyyppi", "huomio", "tila", "lainassa"]);
  return lines.map((line, index) => {
    const [apartment, code, type, note, state] = line.split(";");
    return { line: index + 2, apartment, code, type, note, state };
  });
}

describe("avainten tuonti ja vienti", () => {
  let server: TestServer;
  let manager: string;
  let service: string;

  before(async () => {
    server = await startServer();
    manager = await login(server, MANAGER_EMAIL);
    service = await login(server, SERVICE_EMAIL);
  });

  after(() => server.stop());

  const keys = async () => (await call(server, service, "GET", "/companies/demo-company/keys")).data as any[];
  const importKeys = (rows: unknown[], commit: boolean) =>
    call(server, service, "POST", "/companies/demo-company/keys/import", { rows, commit });

  it("esikatselu erottelee uudet, olemassa olevat ja virheelliset rivit tallentamatta mitään", async () => {
    assert.equal((await call(server, service, "POST", "/companies/demo-company/keys", { code: "A12-1", type: "Asunto" })).status, 201);
    const rows = [
      { line: 2, apartment: "A 12", code: "A12-1", type: "Asunto", note: "" },
      { line: 3, apartment: "a12", code: "A12-2", type: "", note: "Varavain" },
      { line: 4, apartment: "Z 99", code: "Z99-1", type: "Asunto" },
      { line: 5, apartment: "", code: "Y-1", type: "yleisavain", state: "kadonnut" },
      { line: 6, apartment: "B 34", code: "", type: "Asunto" },
      { line: 7, apartment: "B 34", code: "B34-1", type: "Lukko" },
      // Saman tiedoston toinen rivi samalla numerolla ohitetaan.
      { line: 8, apartment: "B 34", code: "a12-2", type: "Asunto" }
    ];
    const preview = await importKeys(rows, false);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.data.created.map((row: any) => row.code), ["A12-2", "Y-1"]);
    assert.deepEqual(preview.data.existing.map((row: any) => row.line), [2, 8]);
    assert.deepEqual(preview.data.invalid.map((row: any) => row.line), [4, 6, 7]);
    assert.match(preview.data.invalid[0].reason, /Z 99/);
    assert.equal(preview.data.added, 0);
    assert.equal((await keys()).length, 1);

    const saved = await importKeys(rows, true);
    assert.equal(saved.data.added, 2);
    const all = await keys();
    assert.equal(all.length, 3);
    const spare = all.find(key => key.code === "A12-2");
    assert.equal(spare.apartment_number, "A 12");
    assert.equal(spare.type, "Asunto");
    assert.equal(all.find(key => key.code === "Y-1").status, "lost");

    // Uusi tuonti samalla tiedostolla ei luo kaksoiskappaleita.
    assert.equal((await importKeys(rows, true)).data.added, 0);
    assert.equal((await keys()).length, 3);
  });

  it("viety tiedosto kelpaa tuontiin, ja vienti → tuonti tuottaa saman rekisterin", async () => {
    const [first] = await keys();
    assert.equal((await call(server, service, "POST", `/keys/${first.id}/hand-over`, { holderName: "Putki Oy" })).status, 201);

    const exported = await call(server, service, "GET", "/companies/demo-company/keys/export");
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type") ?? "", /text\/csv/);
    const csv = exported.data as string;
    assert.match(csv, /Putki Oy/);
    const rows = csvToRows(csv);
    assert.equal(rows.length, 3);

    for (const key of await keys()) assert.equal((await call(server, manager, "DELETE", `/keys/${key.id}`)).status, 200);
    assert.equal((await importKeys(rows, true)).data.added, 3);

    // Lainassa-sarake on vain tiedoksi, joten muut sarakkeet vertaillaan.
    const again = csvToRows((await call(server, service, "GET", "/companies/demo-company/keys/export")).data as string);
    assert.deepEqual(again, rows);
  });
});
