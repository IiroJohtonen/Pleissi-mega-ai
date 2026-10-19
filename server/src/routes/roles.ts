import express, { type Router } from "express";
import { z } from "zod";
import { requireAdmin, type User } from "../auth.js";
import { db } from "../db.js";
import { ADMIN_ROLE, listRoles, ROLE_BASES } from "../roles.js";
import { id, now } from "../util.js";

export const rolesRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Roolit: toimiston omat käyttäjäroolit. Roolilla on nimi, oikeustaso (isännöitsijä tai asiakaspalvelu)
// ja taulut, jotka sen käyttäjät näkevät. Pääkäyttäjä on kiinteä rooli, joka näkee aina kaiken.
// Lukea saa jokainen käyttäjä, muuttaa vain pääkäyttäjä.
// ---------------------------------------------------------------------------------------------

rolesRouter.get("/roles", (_req, res) => {
  const counts = new Map((db.prepare("SELECT role, COUNT(*) AS count FROM users GROUP BY role").all() as
    { role: string; count: number }[]).map(row => [row.role, row.count]));
  res.json(listRoles().map(role => ({ ...role, userCount: counts.get(role.name) ?? 0 })));
});

// tables: null = kaikki taulut, myös myöhemmin lisättävät; muuten valitut taulut.
const roleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  base: z.enum(ROLE_BASES),
  tables: z.array(z.string().regex(/^[a-z][a-z-]{0,39}$/)).max(100).nullable()
});

function parseRole(body: unknown, exceptId = "") {
  const parsed = roleSchema.safeParse(body);
  if (!parsed.success) return { error: "Kirjoita roolin nimi ja valitse oikeustaso." };
  if (parsed.data.name.toLowerCase() === ADMIN_ROLE.toLowerCase()) return { error: "Pääkäyttäjä-rooli on jo olemassa." };
  if (db.prepare("SELECT 1 FROM roles WHERE name = ? AND id != ?").get(parsed.data.name, exceptId)) {
    return { error: "Samanniminen rooli on jo olemassa." };
  }
  return { data: { ...parsed.data, tables: parsed.data.tables === null ? null : [...new Set(parsed.data.tables)] } };
}

function audit(actor: string, action: string, details: Record<string, unknown>) {
  db.prepare("INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)").run(id("audit"), null, actor, action, JSON.stringify(details), now());
}

rolesRouter.post("/roles", requireAdmin, (req, res) => {
  const parsed = parseRole(req.body);
  if (!parsed.data) return res.status(400).json({ error: parsed.error });
  const roleId = id("role");
  db.prepare("INSERT INTO roles (id, name, base, tables, created_at) VALUES (?, ?, ?, ?, ?)").run(
    roleId, parsed.data.name, parsed.data.base, parsed.data.tables === null ? null : JSON.stringify(parsed.data.tables), now()
  );
  audit((res.locals.user as User).name, "role_created", { name: parsed.data.name });
  res.status(201).json({ ok: true, roleId });
});

// Nimen vaihto siirtyy roolin käyttäjille ja Taloyhtiö tunnistamatta -jonon asetukseen.
rolesRouter.put("/roles/:id", requireAdmin, (req, res) => {
  const role = db.prepare("SELECT id, name FROM roles WHERE id = ?").get(req.params.id) as { id: string; name: string } | undefined;
  if (!role) return res.status(404).json({ error: "Roolia ei löytynyt." });
  const parsed = parseRole(req.body, role.id);
  if (!parsed.data) return res.status(400).json({ error: parsed.error });
  const { name, base, tables } = parsed.data;
  db.transaction(() => {
    db.prepare("UPDATE roles SET name = ?, base = ?, tables = ? WHERE id = ?")
      .run(name, base, tables === null ? null : JSON.stringify(tables), role.id);
    if (name !== role.name) {
      db.prepare("UPDATE users SET role = ? WHERE role = ?").run(name, role.name);
      renameQueueRole(role.name, name);
    }
  })();
  audit((res.locals.user as User).name, "role_updated", { name });
  res.json({ ok: true });
});

// Roolin voi poistaa vain, kun kenelläkään käyttäjällä ei ole sitä.
rolesRouter.delete("/roles/:id", requireAdmin, (req, res) => {
  const role = db.prepare("SELECT id, name FROM roles WHERE id = ?").get(req.params.id) as { id: string; name: string } | undefined;
  if (!role) return res.status(404).json({ error: "Roolia ei löytynyt." });
  if (db.prepare("SELECT 1 FROM users WHERE role = ?").get(role.name)) {
    return res.status(409).json({ error: "Roolilla on käyttäjiä. Vaihda heille ensin toinen rooli." });
  }
  db.transaction(() => {
    db.prepare("DELETE FROM roles WHERE id = ?").run(role.id);
    renameQueueRole(role.name, null);
  })();
  audit((res.locals.user as User).name, "role_deleted", { name: role.name });
  res.json({ ok: true });
});

function renameQueueRole(from: string, to: string | null) {
  const row = db.prepare("SELECT unidentified_queue_roles AS roles FROM office_settings WHERE id = 1").get() as { roles: string } | undefined;
  let roles: string[] = [];
  try {
    roles = JSON.parse(row?.roles ?? "[]");
  } catch {
    return;
  }
  if (!Array.isArray(roles) || !roles.includes(from)) return;
  const next = roles.flatMap(item => item === from ? (to ? [to] : []) : [item]);
  db.prepare("UPDATE office_settings SET unidentified_queue_roles = ? WHERE id = 1").run(JSON.stringify(next));
}
