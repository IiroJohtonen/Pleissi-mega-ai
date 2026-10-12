import net from "node:net";
import path from "node:path";

// Liite, jota ei tallenneta: ajettava tiedosto tai virustarkistuksen hylkäämä. Viesti on käyttäjälle näytettävä.
export class UnsafeFileError extends Error {}

// Tiedostotyypit, jotka voivat suorittaa koodia avattaessa. Niitä ei oteta vastaan missään muodossa.
const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".dll", ".com", ".scr", ".pif", ".msi", ".msp", ".bat", ".cmd", ".ps1", ".vbs", ".vbe",
  ".js", ".jse", ".wsf", ".wsh", ".hta", ".jar", ".lnk", ".reg", ".cpl", ".apk", ".app", ".sh"
]);

// Ajettavien tiedostojen tunnisteet tiedoston alussa: Windows (MZ), Linux (ELF), macOS (Mach-O) ja komentosarja (#!).
const EXECUTABLE_SIGNATURES = ["4d5a", "7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "2321"];

function startsWithHex(content: Buffer, hex: string, offset = 0) {
  return content.subarray(offset, offset + hex.length / 2).toString("hex") === hex;
}

// Tosi, kun sisältö on oikeasti kuva (PNG, JPEG, GIF, WebP, HEIC) tai PDF; selaimen ilmoittamaan tyyppiin ei luoteta.
export function isImageOrPdf(content: Buffer): boolean {
  return startsWithHex(content, "89504e47")
    || startsWithHex(content, "ffd8ff")
    || startsWithHex(content, "47494638")
    || startsWithHex(content, "25504446")
    || (startsWithHex(content, "52494646") && startsWithHex(content, "57454250", 8))
    || startsWithHex(content, "66747970", 4);
}

const CLAMAV_TIMEOUT_MS = 30_000;
const CLAMAV_CHUNK_BYTES = 64 * 1024;

// Lähettää sisällön ClamAV-palvelulle (clamd, INSTREAM) ja palauttaa löydetyn haittaohjelman nimen tai null.
function clamavScan(content: Buffer, host: string, port: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let reply = "";
    socket.setTimeout(CLAMAV_TIMEOUT_MS, () => socket.destroy(new Error("aikakatkaisu")));
    socket.on("error", reject);
    socket.on("data", chunk => { reply += chunk.toString("utf8"); });
    socket.on("close", () => {
      const result = reply.replace(/\0/g, "").trim();
      if (result.endsWith("OK")) resolve(null);
      else if (result.endsWith("FOUND")) resolve(result.replace(/^stream:\s*/, "").replace(/\s*FOUND$/, ""));
      else reject(new Error(result || "tyhjä vastaus"));
    });
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < content.length; offset += CLAMAV_CHUNK_BYTES) {
        const chunk = content.subarray(offset, offset + CLAMAV_CHUNK_BYTES);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

// Tarkistaa vastaanotettavan tiedoston ennen tallennusta ja heittää UnsafeFileError-virheen, jos sitä ei
// oteta vastaan. Ajettavat tiedostot hylätään aina. Kun CLAMAV_HOST on asetettu, sisältö tarkistetaan
// lisäksi ClamAV:lla; jos tarkistus ei ole silloin käytettävissä, tiedosto hylätään.
export async function assertSafeFile(content: Buffer, filename: string): Promise<void> {
  if (BLOCKED_EXTENSIONS.has(path.extname(filename).toLowerCase())
    || EXECUTABLE_SIGNATURES.some(signature => startsWithHex(content, signature))) {
    throw new UnsafeFileError(`Tiedostoa "${filename}" ei oteta vastaan: ajettavat tiedostot ja komentosarjat on estetty.`);
  }

  const host = process.env.CLAMAV_HOST;
  if (!host) return;

  let virus: string | null;
  try {
    virus = await clamavScan(content, host, Number(process.env.CLAMAV_PORT || 3310));
  } catch (error) {
    console.error("Virustarkistus epäonnistui:", error instanceof Error ? error.message : error);
    throw new UnsafeFileError(`Tiedostoa "${filename}" ei voitu tarkistaa virusten varalta. Yritä hetken kuluttua uudelleen.`);
  }
  if (virus) {
    console.warn(`Virustarkistus hylkäsi tiedoston "${filename}": ${virus}`);
    throw new UnsafeFileError(`Tiedostoa "${filename}" ei oteta vastaan: virustarkistus löysi haittaohjelman.`);
  }
}
