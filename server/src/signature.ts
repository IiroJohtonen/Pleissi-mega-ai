import express, { type Router } from "express";
import { z } from "zod";
import type { User } from "./auth.js";
import { db } from "./db.js";

// Sähköpostin allekirjoitus lisätään käyttäjän lähettämien vastausten loppuun. Pohjan paikkamerkit
// korvataan käyttäjän ja toimiston tiedoilla; rivi, jonka paikkamerkit jäävät tyhjiksi, jätetään pois.
export const DEFAULT_SIGNATURE = "Ystävällisin terveisin\n\n{nimi}\n{titteli}\n{toimisto}\n{puhelin}\n{sähköposti}";

export const SIGNATURE_FIELDS = ["nimi", "titteli", "puhelin", "sähköposti", "toimisto"] as const;

type SignatureRow = { title: string; phone: string; template: string | null };

export function signatureSettings(userId: string): { title: string; phone: string; template: string } {
  const row = db.prepare("SELECT title, phone, template FROM user_signatures WHERE user_id = ?").get(userId) as SignatureRow | undefined;
  return { title: row?.title ?? "", phone: row?.phone ?? "", template: row?.template ?? DEFAULT_SIGNATURE };
}

export function fillSignature(template: string, values: Record<(typeof SIGNATURE_FIELDS)[number], string>): string {
  const lines = template.replace(/\r\n/g, "\n").split("\n").flatMap(line => {
    const hasField = /\{[^{}]+\}/.test(line);
    const filled = line.replace(/\{([^{}]+)\}/g, (match, key: string) => {
      const field = key.trim().toLowerCase() as (typeof SIGNATURE_FIELDS)[number];
      return field in values ? values[field] : match;
    });
    return hasField && !filled.trim() ? [] : [filled.trimEnd()];
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Valmis allekirjoitus käyttäjälle; tyhjä, jos käyttäjä on poistanut allekirjoituksen.
export function renderSignature(userId: string | undefined): string {
  if (!userId) return "";
  const user = db.prepare("SELECT name, email FROM users WHERE id = ?").get(userId) as { name: string; email: string } | undefined;
  if (!user) return "";
  const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string } | undefined;
  const settings = signatureSettings(userId);
  return fillSignature(settings.template, {
    nimi: user.name,
    titteli: settings.title,
    puhelin: settings.phone,
    "sähköposti": user.email,
    toimisto: office?.name ?? ""
  });
}

export function withSignature(body: string, signature: string): string {
  return signature ? `${body.trimEnd()}\n\n${signature}` : body;
}

export const signatureRouter: Router = express.Router();

signatureRouter.get("/me/signature", (_req, res) => {
  const userId = (res.locals.user as User).id;
  res.json({ ...signatureSettings(userId), defaultTemplate: DEFAULT_SIGNATURE, preview: renderSignature(userId) });
});

signatureRouter.put("/me/signature", (req, res) => {
  const parsed = z.object({
    title: z.string().trim().max(100).default(""),
    phone: z.string().trim().max(40).default(""),
    template: z.string().max(2000)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Allekirjoitus saa olla enintään 2000 merkkiä." });
  const userId = (res.locals.user as User).id;
  const { title, phone, template } = parsed.data;
  db.prepare(`
    INSERT INTO user_signatures (user_id, title, phone, template) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET title = excluded.title, phone = excluded.phone, template = excluded.template
  `).run(userId, title, phone, template.trim() === DEFAULT_SIGNATURE ? null : template.trim());
  res.json({ ...signatureSettings(userId), defaultTemplate: DEFAULT_SIGNATURE, preview: renderSignature(userId) });
});
