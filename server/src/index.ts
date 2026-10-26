import "dotenv/config";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import helmet from "helmet";
// Käynnistyksen tietokantakorjaukset ajetaan ennen kuin mikään muu moduuli lukee tietokantaa.
import "./startup.js";
// ERP-integraation jono ja sen triggerit ennen kuin mikään reitti tallentaa tehtäviä.
import "./integration/outbox.js";
import { requestUser } from "./access.js";
import { raiseAlert } from "./alerts.js";
import { authRouter, INTERNAL_TOKEN, requireAuth, type User } from "./auth.js";
import { db } from "./db.js";
import { loginCodesRouter } from "./login-codes.js";
import { signatureRouter } from "./signature.js";
import { searchRouter } from "./routes/search.js";
import { startMailPolling } from "./mail.js";
import { startMaintenanceJobs } from "./jobs.js";
import { announcementsRouter } from "./routes/announcements.js";
import { billingRouter } from "./routes/billing.js";
import { boardRouter } from "./routes/board.js";
import { bookingQueueRouter } from "./routes/booking-queue.js";
import { bookingsRouter } from "./routes/bookings.js";
import { companiesRouter } from "./routes/companies.js";
import { contactRouter } from "./routes/contact.js";
import { dataRouter } from "./routes/data.js";
import { gmailRouter } from "./routes/gmail.js";
import { inboundRouter } from "./routes/inbound.js";
import { incidentsRouter } from "./routes/incidents.js";
import { integrationRouter } from "./routes/integration.js";
import { memoryRouter } from "./routes/memory.js";
import { keysRouter } from "./routes/keys.js";
import { knowledgeRouter } from "./routes/knowledge.js";
import { metersRouter } from "./routes/meters.js";
import { apartmentsRouter } from "./routes/apartments.js";
import { movesRouter } from "./routes/moves.js";
import { officeRouter } from "./routes/office.js";
import { rolesRouter } from "./routes/roles.js";
import { parkingRouter } from "./routes/parking.js";
import { passwordResetRouter } from "./routes/password-reset.js";
import { portalRouter } from "./routes/portal.js";
import { portalFormsRouter } from "./routes/portal-forms.js";
import { heatingRouter } from "./routes/heating.js";
import { renovationsRouter } from "./routes/renovations.js";
import { reportersRouter } from "./routes/reporters.js";
import { reportsRouter } from "./routes/reports.js";
import { residentsRouter } from "./routes/residents.js";
import { ticketActionsRouter } from "./routes/ticket-actions.js";
import { ticketsRouter } from "./routes/tickets.js";
import { waitlistRouter } from "./routes/waitlist.js";
import { workOrdersRouter } from "./routes/work-orders.js";

const app = express();

// Välityspalvelimen takana asiakkaan osoite luetaan X-Forwarded-For-otsakkeesta. Arvo on luotettavien
// välityspalvelimien määrä (yleensä 1); ilman asetusta otsakkeeseen ei luoteta.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

// Liitteiden pikkukuvat haetaan kirjautumistunnisteen kanssa ja näytetään selaimen muistista (blob:).
app.use(helmet({
  contentSecurityPolicy: {
    directives: { "img-src": ["'self'", "data:", "blob:"] }
  }
}));

// Selainkutsut sallitaan vain sovelluksen omista osoitteista. CORS_ORIGINS on pilkuilla erotettu lista.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || process.env.APP_URL || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map(origin => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
app.use(cors({ origin: CORS_ORIGINS }));

// Pyyntöjen rajoitus: kirjautunut käyttäjä tunnistetaan istunnostaan, muut osoitteestaan. Raja on väljä,
// koska käyttöliittymä hakee tehtävät taustalla; tiukempi raja koskee kirjautumista ja salasanan palautusta.
const tooManyRequests = { error: "Liian monta pyyntöä. Yritä hetken kuluttua uudelleen." };
const requestKey = (req: express.Request) => {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ")
    ? crypto.createHash("sha256").update(header).digest("hex")
    : ipKeyGenerator(req.ip ?? "");
};
app.use("/api", rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.RATE_LIMIT_PER_MINUTE) || 1000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: requestKey,
  // Palvelimen oma Gmail-tuonti ei kulu rajaan.
  skip: req => req.headers["x-internal-token"] === INTERNAL_TOKEN,
  message: tooManyRequests
}));
app.use(["/api/auth/login", "/api/auth/forgot", "/api/auth/reset", "/api/auth/verify-code", "/api/auth/resend-code"], rateLimit({
  windowMs: 15 * 60_000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: tooManyRequests
}));

// Kotisivun yhteydenottolomake on avoin kaikille, joten sen lähetyksiä rajoitetaan tiukasti osoitekohtaisesti.
app.post("/api/contact", rateLimit({
  windowMs: 60 * 60_000,
  limit: Number(process.env.CONTACT_RATE_LIMIT) || 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: tooManyRequests
}));

// Raja kattaa vastauksen liitteet, jotka kulkevat pyynnössä base64-muodossa.
app.use(express.json({ limit: "30mb" }));
app.use("/api", requireAuth);
app.use("/api", (_req, res, next) => requestUser.run(res.locals.user as User | undefined, next));

// Tilatarkistus valvontaa varten: vastaa vain, jos tietokantaan saadaan yhteys.
app.get("/api/health", (_req, res) => {
  db.prepare("SELECT 1").get();
  res.json({ ok: true, service: "kotilo-api", uptimeSeconds: Math.round(process.uptime()) });
});

// Rajapinnan reitit aihealueittain; jokainen on omassa tiedostossaan kansiossa routes.
for (const router of [
  authRouter, loginCodesRouter, passwordResetRouter, officeRouter, rolesRouter, signatureRouter, companiesRouter, gmailRouter, knowledgeRouter, residentsRouter,
  parkingRouter, bookingsRouter, bookingQueueRouter, billingRouter, portalRouter, portalFormsRouter, heatingRouter, ticketsRouter, ticketActionsRouter, inboundRouter,
  workOrdersRouter, announcementsRouter, movesRouter, waitlistRouter, reportsRouter, renovationsRouter, keysRouter,
  metersRouter, apartmentsRouter, contactRouter, searchRouter, boardRouter, reportersRouter, dataRouter, incidentsRouter, memoryRouter,
  integrationRouter
]) {
  app.use("/api", router);
}

const PORT = Number(process.env.PORT || 4000);

// Tuotannossa sama palvelin tarjoaa myös käännetyn käyttöliittymän, jolloin selain ja rajapinta ovat
// samassa osoitteessa. CLIENT_DIST osoittaa käännökseen (oletus ../client/dist).
const CLIENT_DIST = path.resolve(process.env.CLIENT_DIST || path.join(process.cwd(), "../client/dist"));
if (process.env.NODE_ENV === "production" && existsSync(path.join(CLIENT_DIST, "index.html"))) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
}

// Odottamaton virhe kirjataan lokiin; käyttäjälle ei näytetä palvelimen sisäisiä tietoja.
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error);
  const status = Number(error?.status ?? error?.statusCode) || 500;
  if (status >= 500) {
    console.error(`${req.method} ${req.path} epäonnistui:`, error);
    raiseAlert("server-error", "Palvelimella tapahtui virhe", `${req.method} ${req.path}\n\n${error?.stack ?? error}`);
  }
  res.status(status).json({
    error: status === 413 ? "Pyyntö on liian suuri."
      : status < 500 ? "Virheellinen pyyntö."
      : "Palvelimella tapahtui virhe. Yritä uudelleen."
  });
});

// Käsittelemätön virhe taustatyössä ei kaada palvelinta, mutta siitä tulee hälytys.
process.on("unhandledRejection", reason => {
  console.error("Käsittelemätön virhe:", reason);
  raiseAlert("server-error", "Palvelimen taustatyössä tapahtui virhe", String((reason as Error)?.stack ?? reason));
});

app.listen(PORT, (error?: Error) => {
  if (error) {
    console.error(`Kotilo API ei käynnistynyt: portti ${PORT} on jo käytössä. Sulje vanha palvelin ja yritä uudelleen.`);
    console.error(error.message);
    process.exit(1);
  }
  console.log(`Kotilo API running at http://localhost:${PORT}`);
  startMailPolling();
  startMaintenanceJobs();
});
