import express, { type Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { sendEmail } from "../mail.js";
import { VALID_EMAIL } from "../util.js";

export const contactRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Kotisivun yhteydenottolomake ei kuulu Pleissin toimintaan: pyyntöä ei tallenneta eikä näytetä
// alustalla, vaan se välitetään sähköpostina. Vastaanottaja on ympäristömuuttujassa CONTACT_FORWARD_EMAIL
// tai, jos sitä ei ole asetettu, aiemmin tallennettu osoite. Lähetystä rajoitetaan osoitekohtaisesti
// tiedostossa index.ts.
// ---------------------------------------------------------------------------------------------
const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().max(200).regex(VALID_EMAIL),
  phone: z.string().trim().max(40).default(""),
  company: z.string().trim().max(160).default(""),
  message: z.string().trim().max(2000).default(""),
  // Piilotettu kenttä, jonka vain automaattinen lähettäjä täyttää.
  website: z.string().max(200).default("")
});

function forwardAddress(): string {
  const configured = process.env.CONTACT_FORWARD_EMAIL?.trim();
  if (configured) return configured;
  const row = db.prepare("SELECT contact_email FROM office_settings WHERE id = 1").get() as { contact_email: string } | undefined;
  return row?.contact_email ?? "";
}

// Välittää pyynnön sähköpostina. Vastaus viestiin menee suoraan yhteydenottajalle. Epäonnistunut lähetys
// kirjataan lokiin.
async function forwardContact(request: { name: string; email: string; phone: string; company: string; message: string }) {
  const to = forwardAddress();
  if (!to) {
    console.error("Yhteydenottopyyntöä ei välitetty: vastaanottajaa (CONTACT_FORWARD_EMAIL) ei ole asetettu.");
    return;
  }
  try {
    await sendEmail({
      to,
      replyTo: request.email,
      notification: true,
      subject: `Uusi yhteydenottopyyntö: ${request.name}${request.company ? `, ${request.company}` : ""}`,
      body: [
        "Kotisivun lomakkeelta on tullut uusi yhteydenottopyyntö.",
        "",
        `Nimi: ${request.name}`,
        `Sähköposti: ${request.email}`,
        ...(request.phone ? [`Puhelin: ${request.phone}`] : []),
        ...(request.company ? [`Yritys: ${request.company}`] : []),
        ...(request.message ? ["", "Viesti:", request.message] : []),
        "",
        "Voit vastata suoraan tähän viestiin, niin vastaus menee yhteydenottajalle."
      ].join("\n")
    });
  } catch (error) {
    console.error("Yhteydenottopyynnön välitys epäonnistui:", error instanceof Error ? error.message : error);
  }
}

contactRouter.post("/contact", (req, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista nimi ja sähköpostiosoite." });
  const { name, email, phone, company, message, website } = parsed.data;
  // Automaattiselle lähettäjälle vastataan kuten onnistuneeseen lähetykseen, mutta mitään ei välitetä.
  if (!website) void forwardContact({ name, email, phone, company, message });
  res.status(201).json({ ok: true });
});
