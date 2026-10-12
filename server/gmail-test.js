
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testGmail() {
  console.log("Yhdistetään Gmailiin...");

  const auth = await authenticate({
    keyfilePath: path.join(__dirname, "credentials.json"),
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  });

  const tokenResponse = await auth.getAccessToken();

  console.log("Käyttöoikeustunniste saatu:", Boolean(tokenResponse?.token));

  // Tarkistetaan tunnisteen kelvollisuus Googlen kautta.
  const tokenInfo = await google.oauth2("v2").tokeninfo({
    access_token: tokenResponse.token,
  });

  console.log("Tunnisteen tiedot:", {
    audienceTunnistettu: Boolean(tokenInfo.data.audience),
    scopeSisaltaaGmail: tokenInfo.data.scope?.includes(
      "https://www.googleapis.com/auth/gmail.readonly"
    ),
  });

 
const response = await auth.request({
  url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
});

console.log("Gmail API -yhteys onnistui!");
console.log("Sähköpostiosoite:", response.data.emailAddress);
console.log("Viestien määrä:", response.data.messagesTotal);

}

testGmail().catch((error) => {
  console.error("Gmail-yhteys epäonnistui:");
  console.error("Virhe:", error.message);
  console.error("HTTP-status:", error.response?.status ?? "ei saatavilla");
  console.error(
    "Google-virheen syy:",
    error.response?.data?.error?.message ?? "ei lisätietoja"
  );
});
