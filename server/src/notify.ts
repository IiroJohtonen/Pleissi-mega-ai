import { db } from "./db.js";
import { sendGmailReply } from "./gmail.js";

// Ilmoitus asukkaalle sähköpostilla. Lähetys tehdään taustalla: epäonnistuminen kirjataan lokiin,
// mutta ei kaada varsinaista toimintoa. Asukkaalle ilman kelvollista osoitetta ei lähetetä mitään.
export async function notifyResident(residentId: string, subject: string, lines: string[]) {
  const resident = db.prepare(`
    SELECT r.name, r.email, r.company_id, c.name AS company FROM residents r JOIN companies c ON c.id = r.company_id WHERE r.id = ?
  `).get(residentId) as { name: string; email: string | null; company: string; company_id: string } | undefined;
  const email = (resident?.email ?? "").trim();
  if (!resident || !/^[^\s<>,;@]+@[^\s<>,;@]+$/.test(email)) return;
  const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string };
  try {
    await sendGmailReply({
      to: email,
      companyId: resident.company_id,
      subject: `${subject} (${resident.company})`,
      body: [`Hei ${resident.name},`, "", ...lines, "", "Ystävällisin terveisin", office.name].join("\n")
    });
  } catch (error: any) {
    console.error("Ilmoituksen lähetys asukkaalle epäonnistui:", error?.message ?? error);
  }
}
