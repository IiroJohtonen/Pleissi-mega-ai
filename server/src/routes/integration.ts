import { Router } from "express";
import { z } from "zod";
import { requireAdmin, type User } from "../auth.js";
import { db } from "../db.js";
import { API_SCOPES, createApiKey, listApiKeys, revokeApiKey } from "../integration/api-keys.js";
import { buildEnvelope } from "../integration/dispatcher.js";
import { integrationAdapterName, type OutboxRow, pullEnabled, pullForcedByEnv, pullSetting, setPullSetting } from "../integration/outbox.js";
import { id, now } from "../util.js";

// ---------------------------------------------------------------------------------------------
// Integraatioloki: ERP:hen lähteneet ja lähtevät sanomat tiloineen (docs/integraatiospec.md, Pääsy
// lokiin). Sanomissa on henkilötietoja, joten loki on vain pääkäyttäjälle, ja sanoman avaus kirjataan
// toimintalokiin. Lista ei sisällä sanomien sisältöä; sanoma haetaan vasta avattaessa.
// ---------------------------------------------------------------------------------------------

export const integrationRouter = Router();

const LIST_LIMIT = 500;
const STATUSES = ["pending", "sent", "failed", "superseded"] as const;

integrationRouter.get("/integration/messages", requireAdmin, (req, res) => {
  const parsed = z.object({ status: z.enum(STATUSES).optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Tuntematon tila." });
  const status = parsed.data.status;
  const messages = db.prepare(`
    SELECT o.event_id, o.event_type, o.entity_type, o.task_id, o.sequence, o.status, o.attempts, o.next_attempt_at,
           o.last_status_code, o.last_error, o.superseded_by, o.created_at, o.sent_at,
           t.ticket_number, t.sensitive, t.subject AS ticket_subject, c.name AS company_name
    FROM integration_outbox o
    LEFT JOIN tickets t ON t.id = o.task_id
    LEFT JOIN companies c ON c.id = t.company_id
    ${status ? "WHERE o.status = ?" : ""}
    ORDER BY o.rowid DESC
    LIMIT ${LIST_LIMIT}
  `).all(...(status ? [status] : [])) as ({ sensitive: number | null; ticket_subject: string | null } & Record<string, unknown>)[];
  const counts = Object.fromEntries(STATUSES.map(key => [key, 0]));
  for (const row of db.prepare("SELECT status, COUNT(*) AS count FROM integration_outbox GROUP BY status").all() as { status: string; count: number }[]) {
    counts[row.status] = row.count;
  }
  res.json({
    adapter: integrationAdapterName() || null,
    pull: pullEnabled(),
    limit: LIST_LIMIT,
    counts,
    // Arkaluonteisen tehtävän otsikkoa ei näytetä listassa, kuten ei sanomassakaan.
    messages: messages.map(({ sensitive, ticket_subject, ...row }) => ({ ...row, ticket_subject: sensitive ? "Arkaluonteinen tehtävä" : ticket_subject }))
  });
});

// Yksi sanoma siinä muodossa, jossa se lähetetään tai lähetettiin ERP:hen.
integrationRouter.get("/integration/messages/:eventId", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT * FROM integration_outbox WHERE event_id = ?").get(req.params.eventId) as OutboxRow | undefined;
  if (!row) return res.status(404).json({ error: "Sanomaa ei löytynyt." });
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), row.task_id, (res.locals.user as User | undefined)?.name ?? "Tuntematon", "integration_message_viewed",
    JSON.stringify({ eventId: row.event_id, eventType: row.event_type }), now()
  );
  res.json({ envelope: buildEnvelope(row) });
});

// --- ERP-rajapinnan asetukset: hakutila ja API-avaimet (vain pääkäyttäjä) -------------------------

const actorName = (res: { locals: Record<string, unknown> }) => (res.locals.user as User | undefined)?.name ?? "Tuntematon";
const audit = (actor: string, action: string, details: unknown) =>
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), null, actor, action, JSON.stringify(details), now());

function apiSettings() {
  return {
    adapter: integrationAdapterName() || null,
    // pull = haku käytössä; pullSetting = asetuksen arvo; pullForced = ympäristömuuttuja pakottaa päälle.
    pull: pullEnabled(),
    pullSetting: pullSetting(),
    pullForced: pullForcedByEnv(),
    scopes: API_SCOPES,
    keys: listApiKeys()
  };
}

integrationRouter.get("/integration/api", requireAdmin, (_req, res) => {
  res.json(apiSettings());
});

integrationRouter.put("/integration/api/pull", requireAdmin, (req, res) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Valitse, onko haku käytössä." });
  setPullSetting(parsed.data.enabled);
  audit(actorName(res), "integration_pull_updated", { enabled: parsed.data.enabled });
  res.json(apiSettings());
});

integrationRouter.post("/integration/api-keys", requireAdmin, (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(API_SCOPES)).min(1)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Anna avaimelle nimi ja valitse vähintään yksi oikeus." });
  const { key, apiKey } = createApiKey(parsed.data.name, parsed.data.scopes, actorName(res));
  audit(actorName(res), "integration_api_key_created", { id: apiKey.id, name: apiKey.name, scopes: apiKey.scopes });
  // Avain näytetään vain tässä vastauksessa; tietokantaan jää vain tiiviste.
  res.status(201).json({ key, apiKey });
});

integrationRouter.delete("/integration/api-keys/:keyId", requireAdmin, (req, res) => {
  if (!revokeApiKey(String(req.params.keyId), actorName(res))) return res.status(404).json({ error: "Avainta ei löytynyt tai se on jo mitätöity." });
  audit(actorName(res), "integration_api_key_revoked", { id: req.params.keyId });
  res.json({ ok: true });
});
