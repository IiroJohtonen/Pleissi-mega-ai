import express, { type Router } from "express";
import { z } from "zod";
import { consumePasswordReset, createPasswordResets } from "../auth.js";
import { db } from "../db.js";
import { sendEmail } from "../mail.js";

export const passwordResetRouter: Router = express.Router();

// Salasanan palautus kirjautumissivulta. Vastaus on aina sama, jotta siitä ei voi päätellä,
// onko osoitteella tunnusta. Pyyntöjä rajoitetaan osoitetta kohden.
const resetRequests = new Map<string, { count: number; firstAt: number }>();

passwordResetRouter.post("/auth/forgot", async (req, res) => {
  const parsed = z.object({ email: z.email() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Anna sähköpostiosoite." });

  const key = parsed.data.email.toLowerCase();
  const recent = resetRequests.get(key);
  if (recent && Date.now() - recent.firstAt > 15 * 60 * 1000) resetRequests.delete(key);
  const attempts = resetRequests.get(key) ?? { count: 0, firstAt: Date.now() };
  if (attempts.count >= 3) return res.status(429).json({ error: "Liian monta pyyntöä. Yritä uudelleen 15 minuutin kuluttua." });
  resetRequests.set(key, { count: attempts.count + 1, firstAt: attempts.firstAt });

  const resets = createPasswordResets(parsed.data.email);
  if (resets.length > 0) {
    // Linkki osoittaa siihen osoitteeseen, josta pyyntö tuli (selain lähettää Origin-otsakkeen).
    const origin = typeof req.headers.origin === "string" && /^https?:\/\/[^\s/]+$/.test(req.headers.origin)
      ? req.headers.origin
      : process.env.APP_URL || "http://localhost:5173";
    const office = db.prepare("SELECT name FROM office_settings WHERE id = 1").get() as { name: string };
    const body = [
      "Hei,",
      "",
      "saimme pyynnön vaihtaa Kotilo-tunnuksesi salasana. Aseta uusi salasana alla olevasta linkistä.",
      "Linkki on voimassa tunnin ja toimii vain kerran.",
      "",
      ...resets.flatMap(reset => [`${reset.label} (${reset.name}):`, `${origin}/#/reset/${reset.token}`, ""]),
      "Jos et pyytänyt salasanan vaihtoa, voit jättää tämän viestin huomiotta.",
      "",
      office.name
    ].join("\n");
    try {
      await sendEmail({ to: parsed.data.email, subject: "Kotilo: salasanan vaihto", body });
    } catch (error: any) {
      console.error("Palautuslinkin lähetys epäonnistui:", error?.message ?? error);
      return res.status(502).json({ error: "Palautuslinkin lähetys epäonnistui. Yritä uudelleen tai pyydä pääkäyttäjää vaihtamaan salasana." });
    }
  }
  res.json({ ok: true });
});

passwordResetRouter.post("/auth/reset", (req, res) => {
  const parsed = z.object({ token: z.string().min(20).max(200), password: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Palautuslinkki on virheellinen." });
  const error = consumePasswordReset(parsed.data.token, parsed.data.password);
  if (error) return res.status(400).json({ error });
  res.json({ ok: true });
});
