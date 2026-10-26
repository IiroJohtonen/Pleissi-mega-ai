import type { Comment, Envelope, Task } from "./canonical.js";

// ---------------------------------------------------------------------------------------------
// ERP-adapterin rajapinta. Adapteri kääntää kanonisen sanoman ERP:n muotoon ja kutsuu ERP:n API:a.
// Jokaista ERP:tä varten tehdään oma adapteri; Pleissin ydin ei tunne ERP:n kenttiä.
// Kirjoitukset kohdistetaan ERP:n tunnisteella (externalRefs.erp), jonka dispatcher antaa kutsulle.
// ---------------------------------------------------------------------------------------------

// ok: ERP kuittasi kirjoituksen; externalId on uuden olion ERP-tunniste (luonnissa).
// Virhe: status on ERP:n HTTP-vastauskoodi tai null, kun yhteys ei onnistunut tai aikakatkaistiin.
export type AdapterResult =
  | { ok: true; status: number; externalId?: string | null }
  | { ok: false; status: number | null; error: string };

export interface ErpAdapter {
  readonly name: string;
  createTask(envelope: Envelope<Task>): Promise<AdapterResult>;
  updateTask(erpTaskId: string, envelope: Envelope<Task>): Promise<AdapterResult>;
  addComment(erpTaskId: string, envelope: Envelope<Comment>): Promise<AdapterResult>;
}
