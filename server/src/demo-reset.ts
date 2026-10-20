import { createBackup } from "./backup.js";
import { MIN_PASSWORD_LENGTH } from "./auth.js";
import { resetDemoData } from "./demo-data.js";

// Tyhjentää alustan ja luo esittelyaineiston. Ennen tyhjennystä otetaan varmuuskopio.
// Käyttö: node dist/demo-reset.js --vahvista --salasana=<salasana> [--sahkoposti=<pääkäyttäjän sähköposti>]
// Palvelin käynnistetään uudelleen ajon jälkeen (deploy/server/demo-reset.ps1 tekee sen).
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=") || "true"];
}));

if (args.vahvista !== "true" || !args.salasana) {
  console.error("Tämä poistaa KAIKKI alustan tiedot (tehtävät, taloyhtiöt, asukkaat, käyttäjät, dokumentit ym.) ja luo esittelyaineiston.");
  console.error("Aja uudelleen: node dist/demo-reset.js --vahvista --salasana=<esittelytunnusten salasana> [--sahkoposti=<pääkäyttäjän sähköposti>]");
  process.exit(1);
}
if (args.salasana.length < MIN_PASSWORD_LENGTH) {
  console.error(`Salasanassa pitää olla vähintään ${MIN_PASSWORD_LENGTH} merkkiä.`);
  process.exit(1);
}

const backup = await createBackup(process.env.BACKUP_DIR || "backups");
console.log(`Varmuuskopio otettu: ${backup}`);
const summary = resetDemoData({ password: args.salasana, adminEmail: args.sahkoposti === "true" ? undefined : args.sahkoposti });
console.log(`Esittelyaineisto luotu: ${summary.companies} taloyhtiötä, ${summary.apartments} asuntoa, ${summary.residents} asukasta, ${summary.tickets} tehtävää.`);
console.log(`Pääkäyttäjä: ${args.sahkoposti && args.sahkoposti !== "true" ? args.sahkoposti : "demo@pohjantahti-isannointi.fi"}. Asukasportaali: ${summary.portalLogins.join(", ")}.`);
console.log("Kaikilla esittelytunnuksilla on annettu salasana.");
process.exit(0);
