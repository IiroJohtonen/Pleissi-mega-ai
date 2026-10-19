import { db } from "./db.js";

// Pääkäyttäjä on kiinteä rooli: se hallitsee asetuksia ja käyttäjiä ja näkee aina kaikki taulut.
export const ADMIN_ROLE = "Pääkäyttäjä";
// Toimiston omien roolien oikeustasot. Isännöitsijän tasoinen rooli saa muokata taloyhtiöiden tietoja ja
// näkee vain omat yhtiönsä; asiakaspalvelun tasoinen näkee kaikki yhtiöt mutta muokkaa vähemmän.
export const ROLE_BASES = ["Isännöitsijä", "Asiakaspalvelu"] as const;
export type RoleBase = typeof ROLE_BASES[number];

export type RoleRow = { id: string; name: string; base: RoleBase; tables: string[] | null };

function parseTables(value: string | null): string[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function listRoles(): RoleRow[] {
  return (db.prepare("SELECT id, name, base, tables FROM roles ORDER BY created_at, name COLLATE NOCASE").all() as
    { id: string; name: string; base: RoleBase; tables: string | null }[])
    .map(row => ({ ...row, tables: parseTables(row.tables) }));
}

export function findRole(name: string): RoleRow | null {
  const row = db.prepare("SELECT id, name, base, tables FROM roles WHERE name = ?").get(name) as
    { id: string; name: string; base: RoleBase; tables: string | null } | undefined;
  return row ? { ...row, tables: parseTables(row.tables) } : null;
}

export function roleExists(name: string) {
  return name === ADMIN_ROLE || Boolean(findRole(name));
}

// Roolin oikeustaso. Tuntematon rooli saa suppeimmat oikeudet.
export function roleBase(role: string): typeof ADMIN_ROLE | RoleBase {
  if (role === ADMIN_ROLE) return ADMIN_ROLE;
  return findRole(role)?.base ?? "Asiakaspalvelu";
}

// Saako rooli isännöitsijän toiminnot (taloyhtiöiden tiedot, tiedotteet, muutot ym.).
export function isManagerRole(role: string) {
  return roleBase(role) !== "Asiakaspalvelu";
}

// Taulut, jotka rooli näkee; null = kaikki. Pääkäyttäjä näkee aina kaikki.
export function roleTables(role: string): string[] | null {
  if (role === ADMIN_ROLE) return null;
  const found = findRole(role);
  return found ? found.tables : [];
}
