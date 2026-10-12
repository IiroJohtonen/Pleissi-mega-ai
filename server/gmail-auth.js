
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { authenticate } from "@google-cloud/local-auth";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function saveGmailAuth() {
  console.log("Kirjaudutaan Gmailiin...");

  const auth = await authenticate({
    keyfilePath: path.join(__dirname, "credentials.json"),
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ],
  });

  const credentials = auth.credentials;

  if (!credentials.refresh_token) {
    console.error(
      "Kirjautuminen onnistui, mutta pitkäaikainen refresh token puuttuu."
    );
    console.error(
      "Tokenia ei tallennettu. Tarvitsemme uuden OAuth-suostumuksen."
    );
    process.exitCode = 1;
    return;
  }

  const tokenPath = path.join(__dirname, "token.json");

  await fs.writeFile(
    tokenPath,
    JSON.stringify(credentials, null, 2),
    { mode: 0o600 }
  );

  console.log("Gmail-kirjautuminen tallennettu onnistuneesti.");
  console.log("Token-tiedosto luotu: server/token.json");
  console.log("Älä jaa tätä tiedostoa tai julkaise sitä GitHubissa.");
}

saveGmailAuth().catch((error) => {
  console.error("Gmail-kirjautumisen tallennus epäonnistui:");
  console.error(error.message);
  process.exitCode = 1;
});
