import type { ErpAdapter, AdapterResult } from "./adapter.js";
import type { Comment, Envelope, Task } from "./canonical.js";

// ---------------------------------------------------------------------------------------------
// ERP:tä simuloiva adapteri kehitykseen ja testeihin, kunnes oikea ERP on käytettävissä. Pitää tehtävät
// ja kommentit muistissa, antaa niille ERP-tunnisteet ja kääntää tilat ERP:n karkeampiin tiloihin, kuten
// oikea adapteri tekisi. Virheitä voi simuloida: failures on jono vastauskoodeja, jotka palautetaan
// seuraaville kutsuille ennen onnistumista (0 = yhteysvirhe). Palvelimessa jono luetaan muuttujasta
// INTEGRATION_MOCK_FAILURES, esim. "503,503".
// ---------------------------------------------------------------------------------------------

// Esimerkki ERP:stä, jossa on vähemmän tiloja kuin Pleississä; tarkka tila säilyy Pleississä.
const ERP_STATUS: Record<Task["status"], string> = {
  open: "Uusi", in_progress: "Kesken", waiting_resident: "Kesken", waiting_contractor: "Kesken", resolved: "Valmis", closed: "Valmis"
};

export type MockErpTask = { erpId: string; status: string; title: string; lastEventId: string; lastSequence: number };
export type MockErpComment = { erpId: string; erpTaskId: string; text: string; internal: boolean };

export class MockErpAdapter implements ErpAdapter {
  readonly name = "mock";
  readonly tasks = new Map<string, MockErpTask>();
  readonly comments: MockErpComment[] = [];
  // Kaikki kutsut järjestyksessä: testit tarkistavat, mitä ERP:hen lähti.
  readonly calls: { method: string; eventId: string; erpId: string | null }[] = [];
  private nextId = 1;

  constructor(private readonly failures: number[] = []) {}

  static fromEnv() {
    const failures = (process.env.INTEGRATION_MOCK_FAILURES ?? "").split(",").map(value => value.trim()).filter(Boolean).map(Number);
    return new MockErpAdapter(failures.filter(Number.isInteger));
  }

  fail(...statuses: number[]) {
    this.failures.push(...statuses);
  }

  private failure(): AdapterResult | null {
    const status = this.failures.shift();
    if (status === undefined) return null;
    return status === 0 ? { ok: false, status: null, error: "Yhteys ERP:hen ei onnistunut" } : { ok: false, status, error: `ERP vastasi ${status}` };
  }

  async createTask(envelope: Envelope<Task>): Promise<AdapterResult> {
    this.calls.push({ method: "createTask", eventId: envelope.eventId, erpId: null });
    const failed = this.failure();
    if (failed) return failed;
    const erpId = `ERP-T-${this.nextId++}`;
    this.tasks.set(erpId, {
      erpId, status: ERP_STATUS[envelope.data.status], title: envelope.data.title, lastEventId: envelope.eventId, lastSequence: envelope.sequence ?? 0
    });
    return { ok: true, status: 201, externalId: erpId };
  }

  async updateTask(erpTaskId: string, envelope: Envelope<Task>): Promise<AdapterResult> {
    this.calls.push({ method: "updateTask", eventId: envelope.eventId, erpId: erpTaskId });
    const failed = this.failure();
    if (failed) return failed;
    const task = this.tasks.get(erpTaskId);
    if (!task) return { ok: false, status: 404, error: "Tehtävää ei löydy ERP:stä" };
    // Vanhempi sanoma ei koskaan ylikirjoita uudempaa.
    if ((envelope.sequence ?? 0) > task.lastSequence) {
      Object.assign(task, { status: ERP_STATUS[envelope.data.status], title: envelope.data.title, lastEventId: envelope.eventId, lastSequence: envelope.sequence });
    }
    return { ok: true, status: 200 };
  }

  async addComment(erpTaskId: string, envelope: Envelope<Comment>): Promise<AdapterResult> {
    this.calls.push({ method: "addComment", eventId: envelope.eventId, erpId: erpTaskId });
    const failed = this.failure();
    if (failed) return failed;
    if (!this.tasks.has(erpTaskId)) return { ok: false, status: 404, error: "Tehtävää ei löydy ERP:stä" };
    const erpId = `ERP-C-${this.nextId++}`;
    this.comments.push({ erpId, erpTaskId, text: envelope.data.text, internal: envelope.data.visibility === "internal" });
    return { ok: true, status: 201, externalId: erpId };
  }
}
