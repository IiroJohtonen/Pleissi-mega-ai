import express, { type Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth.js";
import { db } from "../db.js";
import { id, now, VALID_EMAIL } from "../util.js";

export const contactRouter: Router = express.Router();

// ---------------------------------------------------------------------------------------------
// Kotisivun yhteydenottolomake: kävijä jättää yhteystietonsa kirjautumatta, ja pääkäyttäjä näkee
// pyynnöt asetuksista. Lomakkeen lähetystä rajoitetaan osoitekohtaisesti tiedostossa index.ts.
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
  }
  res.status(201).json({ ok: true });
});

contactRouter.get("/contact-requests", requireAdmin, (_req, res) => {
  res.json(db.prepare("SELECT * FROM contact_requests ORDER BY created_at DESC, rowid DESC").all());
});

contactRouter.delete("/contact-requests/:id", requireAdmin, (req, res) => {
  const result = db.prepare("DELETE FROM contact_requests WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Yhteydenottopyyntöä ei löytynyt." });
  res.json({ ok: true });
});
