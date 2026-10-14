import express, { type Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth.js";
import { db } from "../db.js";
import { sendEmail } from "../mail.js";
import { id, now, VALID_EMAIL } from "../util.js";

export const contactRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Kotisivun yhteydenottolomake: kävijä jättää yhteystietonsa kirjautumatta, ja pääkäyttäjä näkee
// pyynnöt asetuksista. Jos pääkäyttäjä on asettanut vastaanottajan, pyyntö lähetetään myös
// sähköpostina. Lomakkeen lähetystä rajoitetaan osoitekohtaisesti tiedostossa index.ts.
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

function contactEmail(): string {
  const row = db.prepare("SELECT contact_email FROM office_settings WHERE id = 1").get() as { contact_email: string } | undefined;
  return row?.contact_email ?? "";
}

// Ilmoitus uudesta pyynnöstä. Vastaus viestiin menee suoraan yhteydenottajalle. Lähetys ei saa estää
// tallennusta, joten virhe vain kirjataan lokiin.
async function notifyContact(request: { name: string; email: string; phone: string; company: string; message: string }) {
  const to = contactEmail();
  if (!to) return;
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
    console.error("Yhteydenottopyynnön sähköposti-ilmoitus epäonnistui:", error instanceof Error ? error.message : error);
  }
}

contactRouter.post("/contact", (req, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista nimi ja sähköpostiosoite." });
  const { name, email, phone, company, message, website } = parsed.data;
  // Automaattiselle lähettäjälle vastataan kuten onnistuneeseen lähetykseen, mutta mitään ei tallenneta.
  if (!website) {
    db.prepare(`
      INSERT INTO contact_requests (id, name, email, phone, company, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id("contact"), name, email, phone, company, message, now());
    void notifyContact({ name, email, phone, company, message });
  }
  res.status(201).json({ ok: true });
});

// Osoite, johon uudet pyynnöt lähetetään sähköpostina. Tyhjä = ei lähetetä.
contactRouter.get("/contact-settings", requireAdmin, (_req, res) => {
  res.json({ email: contactEmail() });
});

contactRouter.put("/contact-settings", requireAdmin, (req, res) => {
  const parsed = z.object({
    email: z.string().trim().max(200).refine(value => value === "" || VALID_EMAIL.test(value))
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Tarkista sähköpostiosoite." });
  db.prepare("UPDATE office_settings SET contact_email = ? WHERE id = 1").run(parsed.data.email);
  res.json({ email: parsed.data.email });
});

contactRouter.get("/contact-requests", requireAdmin, (_req, res) => {
  res.json(db.prepare("SELECT * FROM contact_requests ORDER BY created_at DESC, rowid DESC").all());
});

contactRouter.delete("/contact-requests/:id", requireAdmin, (req, res) => {
  const result = db.prepare("DELETE FROM contact_requests WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Yhteydenottopyyntöä ei löytynyt." });
  res.json({ ok: true });
});
