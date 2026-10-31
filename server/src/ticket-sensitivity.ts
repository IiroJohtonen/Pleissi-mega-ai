import { db } from "./db.js";
import { deleteEmbedding } from "./embedding.js";
import { sensitiveMatches } from "./privacy-filter.js";
import { id, now } from "./util.js";

// ---------------------------------------------------------------------------------------------
// Arkaluonteinen tehtävä (terveys ja muut erityiset tietoryhmät, GDPR 9 art.) ei mene AI:lle: saapuvan
// viestin arviointi tehdään avainsanoilla, vastausehdotus tehdään ilman AI:ta ja tehtävä jätetään pois
// toistuvien aiheiden raportista. Merkintä tulee perustietojen sanalistasta tai käsittelijältä.
// sensitive_source: 'keywords' | 'manual' | 'cleared' (käsittelijä poisti merkinnän; sanalista ei merkitse uudelleen).
// ---------------------------------------------------------------------------------------------

function audit(ticketId: string, actor: string, action: string, details: Record<string, unknown>) {
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), ticketId, actor, action, JSON.stringify(details), now());
}

// Merkitsee tehtävän arkaluonteiseksi, jos teksti osuu sanalistaan eikä käsittelijä ole poistanut
// merkintää. Palauttaa, onko tehtävä arkaluonteinen.
export function detectSensitivity(ticketId: string, text: string): boolean {
  const ticket = db.prepare("SELECT sensitive, sensitive_source FROM tickets WHERE id = ?").get(ticketId) as
    { sensitive: number; sensitive_source: string | null } | undefined;
  if (!ticket) return false;
  if (ticket.sensitive || ticket.sensitive_source === "cleared") return Boolean(ticket.sensitive);
  const words = sensitiveMatches(text);
  if (!words.length) return false;
  db.transaction(() => {
    db.prepare("UPDATE tickets SET sensitive = 1, sensitive_source = 'keywords' WHERE id = ?").run(ticketId);
    // Arkaluonteisen tehtävän vektori poistetaan heti; sitä ei käytetä esimerkkinä.
    deleteEmbedding("ticket", ticketId);
  })();
  audit(ticketId, "system", "sensitive_marked", { by: "keywords", words });
  return true;
}

export function setSensitivity(ticketId: string, sensitive: boolean, actor: string) {
  db.transaction(() => {
    db.prepare("UPDATE tickets SET sensitive = ?, sensitive_source = ? WHERE id = ?")
      .run(sensitive ? 1 : 0, sensitive ? "manual" : "cleared", ticketId);
    if (sensitive) deleteEmbedding("ticket", ticketId);
  })();
  audit(ticketId, actor, sensitive ? "sensitive_marked" : "sensitive_cleared", { by: "manual" });
}
