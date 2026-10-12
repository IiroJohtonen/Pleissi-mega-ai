import "dotenv/config";
import { createBackup } from "./backup.js";

// Käyttö: npm run backup -- <kansio>. Ilman kansiota käytetään BACKUP_DIR-muuttujaa tai kansiota backups.
const targetDir = process.argv[2] || process.env.BACKUP_DIR || "backups";

createBackup(targetDir)
  .then(backupDir => console.log(`Varmuuskopio valmis: ${backupDir}`))
  .catch(error => {
    console.error("Varmuuskopiointi epäonnistui:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
