import { getMasterData } from "./master-data.js";

// ---------------------------------------------------------------------------------------------
// Tietojen minimointi ennen AI:ta. Asukkaan kirjoittamasta tekstistä korvataan yhteystiedot ja
// tunnisteet merkinnöillä, ja arkaluonteiset viestit tunnistetaan, jotta niitä ei lähetetä AI:lle.
// Pleissin omaan tietokantaan tallennetaan aina alkuperäinen teksti.
// ---------------------------------------------------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Suomalainen henkilötunnus: ppkkvv, välimerkki (+, -, A–F, U–Y), yksilönumero ja tarkiste.
const PERSONAL_ID = /\b\d{6}[-+A-FU-Y]\d{3}[0-9A-FHJ-NPR-Y]\b/gi;
// IBAN-tilinumero, myös neljän merkin ryhmiin jaettuna.
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/g;
// Puhelinnumero: +358 tai 0 ja vähintään kuusi numeroa, välissä välilyöntejä tai viivoja.
const PHONE = /(?:\+\s?358|\b0)(?:[\s-]?\d){6,11}\b/g;

export function maskPersonalData(text: string): string {
  const { masking } = getMasterData();
  let result = text;
  if (masking.email) result = result.replace(EMAIL, "[sähköposti]");
  if (masking.personalId) result = result.replace(PERSONAL_ID, "[henkilötunnus]");
  if (masking.iban) result = result.replace(IBAN, "[tilinumero]");
  if (masking.phone) result = result.replace(PHONE, "[puhelin]");
  return result;
}

// Lähettäjästä AI saa vain sähköpostin verkkotunnuksen, joka riittää mainosten ja huijausten tunnistamiseen.
export function senderForAi(sender: string): string {
  const domain = sender.match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/)?.[1];
  return domain ? `@${domain.toLowerCase()}` : "(unknown)";
}

// Arkaluonteisuuden tunnistus: sana alkaa listan sanalla, tai monisanainen ilmaus löytyy tekstistä.
// Palauttaa osuneet listan sanat.
export function sensitiveMatches(text: string): string[] {
  const { sensitiveKeywords } = getMasterData();
  const lower = text.toLowerCase();
  const words = lower.match(/[a-zåäö0-9]+/g) ?? [];
  return sensitiveKeywords.filter(keyword => keyword.includes(" ")
    ? lower.includes(keyword)
    : words.some(word => word.startsWith(keyword)));
}

export function emergencyKeywordHit(text: string): boolean {
  const lower = text.toLowerCase();
  return getMasterData().emergencyKeywords.some(keyword => lower.includes(keyword));
}
