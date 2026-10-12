import fs from "node:fs/promises";
import path from "node:path";
import { attachmentsDir, db, knowledgeFilesDir } from "./db.js";

const BACKUP_PREFIX = "kotilo-";

function stamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Varmuuskopio: tietokannasta otetaan eheä kopio käytön aikana, ja liitteet ja tietopankin tiedostot
// kopioidaan sen viereen. Jokainen kopio on oma kansionsa; vanhimmat poistetaan, kun niitä on yli keep.
export async function createBackup(targetDir: string, keep = Number(process.env.BACKUP_KEEP) || 14): Promise<string> {
  const name = `${BACKUP_PREFIX}${stamp(new Date())}`;
  const backupDir = path.join(path.resolve(targetDir), name);
  // Kopio kootaan väliaikaiseen kansioon ja nimetään lopuksi, jotta keskeneräinen kopio ei näytä valmiilta.
  const workDir = path.join(path.resolve(targetDir), `.kesken-${name}`);
  await fs.mkdir(workDir, { recursive: true });
  await db.backup(path.join(workDir, "kotilo.sqlite"));
  await fs.cp(attachmentsDir, path.join(workDir, "attachments"), { recursive: true });
  await fs.cp(knowledgeFilesDir, path.join(workDir, "knowledge-files"), { recursive: true });
  await fs.rename(workDir, backupDir);

  const backups = (await fs.readdir(path.resolve(targetDir), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith(BACKUP_PREFIX))
    .map(entry => entry.name)
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    await fs.rm(path.join(path.resolve(targetDir), old), { recursive: true, force: true });
  }
  return backupDir;
}

// Tosi, kun kansiossa on jo tämän päivän varmuuskopio.
export async function hasBackupToday(targetDir: string): Promise<boolean> {
  const today = stamp(new Date()).slice(0, 10);
  try {
    return (await fs.readdir(path.resolve(targetDir))).some(name => name.startsWith(`${BACKUP_PREFIX}${today}`));
  } catch {
    return false;
  }
}
