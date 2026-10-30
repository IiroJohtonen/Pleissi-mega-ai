import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { db } from "../db.js";
import { id, now } from "../util.js";
import { tenantId } from "./outbox.js";

// ---------------------------------------------------------------------------------------------
// ERP:n API-avaimet (docs/integraatiospec.md, Tietoturva). Avain on muotoa plk_live_<satunnainen>, ja
// siitä tallennetaan vain SHA-256-tiiviste: avain näytetään pääkäyttäjälle vain luontihetkellä. Avain
// kuuluu toimistolle (tenant_id), ja sillä on oikeudet (scopes). Mitätöity avain ei enää kelpaa.
// Haun seuranta: viimeisin haettu kursori ja aika per avain.
// ---------------------------------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS integration_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  -- Avaimen alku (plk_live_ab12…) tunnistamista varten; ei riitä kirjautumiseen.
  key_prefix TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  -- JSON-lista: events:write, events:read, sync:write.
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  last_cursor TEXT,
  last_fetched_at TEXT
);
`);

export const API_SCOPES = ["events:write", "events:read", "sync:write"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export type ApiKey = {
  id: string; name: string; key_prefix: string; tenant_id: string; scopes: ApiScope[]; created_at: string; created_by: string;
  last_used_at: string | null; revoked_at: string | null; revoked_by: string | null; last_cursor: string | null; last_fetched_at: string | null;
};

const KEY_PREFIX = "plk_live_";
const hash = (key: string) => crypto.createHash("sha256").update(key).digest("hex");
const COLUMNS = "id, name, key_prefix, tenant_id, scopes, created_at, created_by, last_used_at, revoked_at, revoked_by, last_cursor, last_fetched_at";
const parse = (row: Omit<ApiKey, "scopes"> & { scopes: string }): ApiKey => ({ ...row, scopes: JSON.parse(row.scopes) as ApiScope[] });

// Luo avaimen. Palauttaa avaimen selväkielisenä vain tässä.
export function createApiKey(name: string, scopes: ApiScope[], createdBy: string) {
  const key = `${KEY_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
  const keyId = id("apikey");
  db.prepare(`
    INSERT INTO integration_api_keys (id, name, key_hash, key_prefix, tenant_id, scopes, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(keyId, name, hash(key), `${key.slice(0, KEY_PREFIX.length + 4)}…`, tenantId(), JSON.stringify([...new Set(scopes)]), now(), createdBy);
  return { key, apiKey: getApiKey(keyId)! };
}

export function getApiKey(keyId: string) {
  const row = db.prepare(`SELECT ${COLUMNS} FROM integration_api_keys WHERE id = ?`).get(keyId) as (Omit<ApiKey, "scopes"> & { scopes: string }) | undefined;
  return row ? parse(row) : null;
}

export function listApiKeys() {
  return (db.prepare(`SELECT ${COLUMNS} FROM integration_api_keys ORDER BY revoked_at IS NOT NULL, created_at DESC`).all() as
    (Omit<ApiKey, "scopes"> & { scopes: string })[]).map(parse);
}

export function revokeApiKey(keyId: string, revokedBy: string) {
  return db.prepare("UPDATE integration_api_keys SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL")
    .run(now(), revokedBy, keyId).changes > 0;
}

// Voimassa oleva avain Authorization-otsakkeesta (Bearer plk_live_…), muuten null.
export function authenticateApiKey(header: string | undefined): ApiKey | null {
  const match = /^Bearer\s+(plk_live_[A-Za-z0-9_-]{10,200})\s*$/.exec(header ?? "");
  if (!match) return null;
  const row = db.prepare(`SELECT ${COLUMNS} FROM integration_api_keys WHERE key_hash = ? AND revoked_at IS NULL`)
    .get(hash(match[1])) as (Omit<ApiKey, "scopes"> & { scopes: string }) | undefined;
  if (!row || row.tenant_id !== tenantId()) return null;
  db.prepare("UPDATE integration_api_keys SET last_used_at = ? WHERE id = ?").run(now(), row.id);
  return parse(row);
}

// Rajapinnan /api/v1 tunnistus: 401, jos avain puuttuu tai ei kelpaa. Avain on res.locals.apiKey.
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = authenticateApiKey(req.headers.authorization);
  if (!apiKey) return res.status(401).json({ error: "invalid_api_key", message: "API-avain puuttuu, on virheellinen tai mitätöity." });
  res.locals.apiKey = apiKey;
  next();
}

// 403, jos avaimelta puuttuu oikeus.
export function requireScope(scope: ApiScope) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const apiKey = res.locals.apiKey as ApiKey | undefined;
    if (!apiKey?.scopes.includes(scope)) {
      return res.status(403).json({ error: "missing_scope", message: `API-avaimelta puuttuu oikeus ${scope}.` });
    }
    next();
  };
}
