import express, { type Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { db } from "../db.js";
import { type ApiKey, requireApiKey, requireScope } from "../integration/api-keys.js";
import { MAX_EVENTS, receiveEvents, SyncSchema, syncHousingCompanies } from "../integration/inbox.js";
import { pullEnabled } from "../integration/outbox.js";
import { fetchEvents, parseCursor } from "../integration/pull.js";
import { id, now } from "../util.js";

// ---------------------------------------------------------------------------------------------
// Pleissin integraatiorajapinta ERP:lle (docs/integraatiospec.md, Pleissin integraatiorajapinta).
// Muu /api vaatii kirjautumisen; /api/v1 tunnistetaan API-avaimella (Authorization: Bearer plk_live_…),
// ja jokaisella avaimella on oma pyyntöraja (oletus 120 minuutissa, 429 + Retry-After).
//   POST /api/v1/events                    events:write  ERP:n tapahtumat (1–100)
//   GET  /api/v1/events?after=&limit=      events:read   Pleissin tapahtumat jonosta kursorin jälkeen
//   POST /api/v1/sync/housing-companies    sync:write    ensilataus ja täysi täsmäytys
// Vastauksissa error on koneluettava koodi ja message selite.
// ---------------------------------------------------------------------------------------------

export const apiV1Router: Router = express.Router();

apiV1Router.use(requireApiKey);
apiV1Router.use(rateLimit({
  windowMs: 60_000,
  limit: () => Number(process.env.API_V1_RATE_LIMIT_PER_MINUTE) || 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (_req, res) => (res.locals.apiKey as ApiKey).id,
  message: { error: "rate_limited", message: "Liian monta pyyntöä. Odota Retry-After-otsakkeen kertoma aika." }
}));

const apiKeyOf = (res: express.Response) => res.locals.apiKey as ApiKey;

apiV1Router.post("/events", requireScope("events:write"), (req, res) => {
  const events = (req.body as { events?: unknown } | undefined)?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: "invalid_request", message: "Pyynnössä pitää olla events-lista, jossa on 1–100 tapahtumaa." });
  }
  if (events.length > MAX_EVENTS) {
    return res.status(413).json({ error: "too_many_events", message: `Yhdessä kutsussa voi olla enintään ${MAX_EVENTS} tapahtumaa.` });
  }
  res.status(202).json({ results: receiveEvents(events, apiKeyOf(res).id) });
});

apiV1Router.get("/events", requireScope("events:read"), (req, res) => {
  const parsed = z.object({
    after: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100)
  }).safeParse(req.query);
  const after = parsed.success && parsed.data.after !== undefined ? parseCursor(parsed.data.after) : null;
  if (!parsed.success || (parsed.data.after !== undefined && after === null)) {
    return res.status(400).json({ error: "invalid_request", message: "after on muotoa c_000042 ja limit 1–100." });
  }
  if (!pullEnabled()) {
    return res.status(409).json({ error: "pull_disabled", message: "Jonon haku ei ole käytössä. Pääkäyttäjä kytkee sen Pleissin asetuksista." });
  }
  res.json(fetchEvents(after, parsed.data.limit, apiKeyOf(res).id));
});

apiV1Router.post("/sync/housing-companies", requireScope("sync:write"), async (req, res) => {
  const parsed = SyncSchema.safeParse(req.body);
  if (!parsed.success) {
    const fields = parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    return res.status(400).json({ error: "validation_error", message: fields });
  }
  const result = await syncHousingCompanies(parsed.data);
  // Toimintalokiin vain määrät, ei henkilötietoja.
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(
    id("audit"), null, `API-avain ${apiKeyOf(res).name}`, "integration_sync",
    JSON.stringify({ companies: result.companies.length, added: result.added, updated: result.updated, movedOut: result.movedOut, rejected: result.rejected.length }),
    now()
  );
  res.status(202).json(result);
});

apiV1Router.use((_req, res) => {
  res.status(404).json({ error: "not_found", message: "Tuntematon rajapinnan osoite." });
});
