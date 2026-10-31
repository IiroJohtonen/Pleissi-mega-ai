import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Pleissin kanoninen sanomamalli (docs/integraatiospec.md). Pleissi puhuu ERP:n kanssa vain tätä
// muotoa; järjestelmäkohtainen käännös tehdään adapterissa. Yhteiset säännöt: kenttänimet camelCasena,
// ajat ISO 8601 offsetin kanssa, puhelin E.164, sähköposti pienillä kirjaimilla ja puuttuva arvo null.
// Kenttiä voi lisätä ilman versionnostoa; poisto tai merkityksen muutos nostaa pääversiota.
// ---------------------------------------------------------------------------------------------

export const SCHEMA_VERSION = "1.0";

// Aika offsetin kanssa, esim. 2026-10-24T20:00:00+03:00 (myös Z hyväksytään).
const dateTime = z.iso.datetime({ offset: true });
const date = z.iso.date();

export const ExternalRefsSchema = z.object({ erp: z.string().nullable() });

export const EVENT_TYPES = [
  "housingCompany.upserted", "housingCompany.deleted",
  "resident.upserted", "resident.moved_out",
  "booking.created", "booking.cancelled", "booking.updated",
  "task.created", "task.updated",
  "task.comment.added"
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EnvelopeSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.enum(EVENT_TYPES),
  schemaVersion: z.string(),
  occurredAt: dateTime,
  // Kuka muutoksen teki; estää synkkasilmukat.
  source: z.enum(["pleissi", "erp"]),
  // Vain Pleissin julkaisemissa; ERP:n lähettämissä asiakas päätellään API-avaimesta.
  tenantId: z.string().min(1).optional(),
  // Juokseva numero per olio: vanhempi sanoma ei koskaan ylikirjoita uudempaa.
  sequence: z.number().int().positive().optional(),
  // task.updated: mitkä kentät muuttuivat edellisestä lähetetystä tilasta.
  changedFields: z.array(z.string()).optional(),
  // Vain jonosta haetuissa: tapahtuman paikka jonossa (c_000042).
  cursor: z.string().optional(),
  data: z.unknown()
});
export type Envelope<T = unknown> = Omit<z.infer<typeof EnvelopeSchema>, "data"> & { data: T };

// --- Taloyhtiöt (ERP → Pleissi) ---------------------------------------------------------------
// ERP lähettää omat tunnisteensa (externalRefs.erp, pakollinen); Pleissin id saa puuttua.

const erpRefs = z.object({ erp: z.string().trim().min(1).max(100) });
// Puuttuva arvo on null; tyhjä merkkijono hyväksytään samana.
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const ErpApartmentSchema = z.object({
  externalRefs: erpRefs,
  apartmentNumber: z.string().trim().min(1).max(40),
  staircase: optionalText(20),
  address: z.string().trim().min(1).max(200)
});

export const HousingCompanySchema = z.object({
  externalRefs: erpRefs,
  name: z.string().trim().min(1).max(200),
  businessId: optionalText(30),
  // Yhtiön sähköposti, jolla Pleissi tunnistaa yhtiölle tulevat viestit.
  email: z.string().trim().toLowerCase().pipe(z.email()),
  phone: optionalText(40),
  // Kohdistetaan Pleissin käyttäjään sähköpostilla.
  propertyManager: z.object({ email: z.string().trim().toLowerCase().pipe(z.email()).nullable().optional() }).nullable().optional(),
  maintenance: z.object({
    name: optionalText(200), phone: optionalText(40), email: z.string().trim().toLowerCase().pipe(z.union([z.literal(""), z.email()])).nullable().optional(),
    emergencyPhone: optionalText(40)
  }).nullable().optional(),
  apartments: z.array(ErpApartmentSchema).max(5000).default([])
});
export type HousingCompany = z.infer<typeof HousingCompanySchema>;

// --- Asukkaat (ERP → Pleissi) -----------------------------------------------------------------

export const RESIDENT_ROLE_VALUES = ["asukas", "osakas"] as const;

const residentFields = {
  externalRefs: erpRefs,
  apartmentRef: z.string().trim().min(1).max(100),
  // Yksi nimikenttä, kuten Pleississä.
  name: z.string().trim().min(1).max(200),
  // Tyhjä merkkijono tulkitaan puuttuvaksi.
  email: z.string().trim().toLowerCase().pipe(z.union([z.literal(""), z.email()])).nullable().optional(),
  // E.164; Pleissi normalisoi myös suomalaisen muodon (040 …).
  phone: z.string().trim().max(40).nullable().optional(),
  roles: z.array(z.enum(RESIDENT_ROLE_VALUES)).min(1).max(2),
  movedInAt: date.nullable().optional(),
  movedOutAt: date.nullable().optional()
};
const contactRequired = (resident: { email?: string | null; phone?: string | null }) => Boolean(resident.email || resident.phone);
const CONTACT_MESSAGE = "Vähintään sähköposti tai puhelin";

export const ResidentSchema = z.object({ ...residentFields, housingCompanyRef: z.string().trim().min(1).max(100) })
  .refine(contactRequired, CONTACT_MESSAGE);
export type Resident = z.infer<typeof ResidentSchema>;

// Ensilatauksessa asukkaat ovat taloyhtiön sisällä, joten taloyhtiön viittausta ei tarvita.
export const SyncResidentSchema = z.object(residentFields).refine(contactRequired, CONTACT_MESSAGE);
export type SyncResident = z.infer<typeof SyncResidentSchema>;

export const ResidentMovedOutSchema = z.object({
  externalRefs: erpRefs,
  // Puuttuessa tänään.
  movedOutAt: date.nullable().optional()
});

// --- Varaukset (molemmat suunnat; lähetys toteutetaan myöhemmin) ------------------------------

const bookingBase = {
  id: z.string(),
  externalRefs: ExternalRefsSchema,
  taskId: z.string().nullable(),
  resourceId: z.string(),
  residentId: z.string(),
  apartmentId: z.string(),
  channel: z.enum(["email", "phone", "erp_app", "web_form", "manual"]),
  status: z.enum(["requested", "confirmed", "cancelled"])
};

export const BookingSchema = z.discriminatedUnion("type", [
  z.object({ ...bookingBase, type: z.literal("single"), start: dateTime, end: dateTime }),
  z.object({
    ...bookingBase,
    type: z.literal("recurring"),
    // Toistuvat ajat paikallisena kellonaikana, koska kesäaika muuttaa offsetin.
    recurrence: z.object({
      frequency: z.literal("weekly"),
      dayOfWeek: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]),
      startTime: z.string().regex(/^\d{2}:\d{2}$/),
      endTime: z.string().regex(/^\d{2}:\d{2}$/),
      timeZone: z.string()
    }),
    validFrom: date,
    validUntil: date.nullable()
  })
]);
export type Booking = z.infer<typeof BookingSchema>;

// --- Tehtävät ----------------------------------------------------------------------------------

export const TASK_CATEGORIES = ["maintenance", "booking", "question", "complaint", "other"] as const;
// critical = Pleissin hätätapaus (emergency).
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent", "critical"] as const;
export const TASK_STATUSES = ["open", "in_progress", "waiting_resident", "waiting_contractor", "resolved", "closed"] as const;
// manual = toimiston käsin kirjaama tehtävä (esim. puhelu tai käynti).
export const TASK_CHANNELS = ["email", "phone", "erp_app", "web_form", "manual"] as const;

export const AssigneeSchema = z.object({
  type: z.enum(["ai", "propertyManager", "maintenance"]),
  name: z.string()
});

export const AttachmentSchema = z.object({
  fileName: z.string(),
  // Null, kunnes liitteille on julkiset allekirjoitetut linkit.
  url: z.string().url().nullable(),
  contentType: z.string()
});

// Tehtävän tunnisteet ja tila; arkaluonteisesta tehtävästä lähetetään vain nämä.
const taskIdentity = {
  id: z.string(),
  externalRefs: ExternalRefsSchema,
  // Juokseva numero taloyhtiöittäin; näkyy asukkaalle viesteissä.
  ticketNumber: z.number().int().nullable(),
  title: z.string(),
  status: z.enum(TASK_STATUSES)
};

export const TaskSchema = z.discriminatedUnion("sensitive", [
  z.object({
    ...taskIdentity,
    sensitive: z.literal(false),
    description: z.string().nullable(),
    category: z.enum(TASK_CATEGORIES),
    priority: z.enum(TASK_PRIORITIES),
    channel: z.enum(TASK_CHANNELS),
    housingCompanyId: z.string(),
    apartmentId: z.string().nullable(),
    residentId: z.string().nullable(),
    assignee: AssigneeSchema.nullable(),
    relatedBookingId: z.string().nullable(),
    attachments: z.array(AttachmentSchema),
    commentCount: z.number().int().nonnegative(),
    createdAt: dateTime,
    updatedAt: dateTime
  }),
  // Arkaluonteinen: ei kuvausta, käsittelijää, liitteitä eikä kommentteja.
  z.object({ ...taskIdentity, sensitive: z.literal(true) })
]);
export type Task = z.infer<typeof TaskSchema>;
export type FullTask = Extract<Task, { sensitive: false }>;

// --- Kommentit ---------------------------------------------------------------------------------

export const CommentSchema = z.object({
  id: z.string(),
  externalRefs: ExternalRefsSchema,
  taskId: z.string(),
  // AI:n kommentit aina type "ai", jotta niitä ei tulkita isännöitsijän omiksi.
  author: z.object({ type: z.enum(["ai", "propertyManager", "resident"]), name: z.string() }),
  // public näkyy asukkaalle. Sisäisiä muistiinpanoja ei julkaista, joten Pleissin sanomissa arvo on aina public.
  visibility: z.enum(["public", "internal"]),
  text: z.string(),
  createdAt: dateTime
});
export type Comment = z.infer<typeof CommentSchema>;
