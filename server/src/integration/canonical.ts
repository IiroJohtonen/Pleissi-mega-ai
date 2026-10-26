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
const email = z.string().email().refine(value => value === value.toLowerCase(), "Sähköposti pienillä kirjaimilla");
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, "Puhelinnumero E.164-muodossa");

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
  tenantId: z.string().min(1),
  // Juokseva numero per olio: vanhempi sanoma ei koskaan ylikirjoita uudempaa.
  sequence: z.number().int().positive().optional(),
  // task.updated: mitkä kentät muuttuivat edellisestä lähetetystä tilasta.
  changedFields: z.array(z.string()).optional(),
  data: z.unknown()
});
export type Envelope<T = unknown> = Omit<z.infer<typeof EnvelopeSchema>, "data"> & { data: T };

// --- Taloyhtiöt (ERP → Pleissi) ---------------------------------------------------------------

export const ApartmentSchema = z.object({
  id: z.string(),
  externalRefs: ExternalRefsSchema,
  label: z.string(),
  staircase: z.string().nullable(),
  number: z.string()
});

export const BookableResourceSchema = z.object({
  id: z.string(),
  externalRefs: ExternalRefsSchema,
  type: z.enum(["sauna", "laundry", "other"]),
  name: z.string()
});

export const HousingCompanySchema = z.object({
  id: z.string(),
  externalRefs: ExternalRefsSchema,
  name: z.string().min(1),
  businessId: z.string().nullable().optional(),
  address: z.object({ street: z.string(), postalCode: z.string(), city: z.string() }).nullable().optional(),
  apartments: z.array(ApartmentSchema),
  bookableResources: z.array(BookableResourceSchema).nullable().optional(),
  propertyManager: z.object({ name: z.string(), email: email.nullable() }).nullable().optional()
});
export type HousingCompany = z.infer<typeof HousingCompanySchema>;

// --- Asukkaat (ERP → Pleissi) -----------------------------------------------------------------

export const ResidentSchema = z.object({
  id: z.string(),
  externalRefs: ExternalRefsSchema,
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: email.nullable(),
  phone: phone.nullable(),
  housingCompanyId: z.string(),
  apartmentId: z.string(),
  role: z.enum(["owner", "tenant", "other"]),
  validFrom: date,
  validUntil: date.nullable(),
  language: z.string().nullable().optional()
}).refine(resident => resident.email !== null || resident.phone !== null, "Vähintään sähköposti tai puhelin");
export type Resident = z.infer<typeof ResidentSchema>;

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

export const TaskSchema = z.object({
  id: z.string(),
  externalRefs: ExternalRefsSchema,
  title: z.string(),
  description: z.string().nullable(),
  category: z.enum(TASK_CATEGORIES),
  priority: z.enum(TASK_PRIORITIES),
  status: z.enum(TASK_STATUSES),
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
});
export type Task = z.infer<typeof TaskSchema>;

// --- Kommentit ---------------------------------------------------------------------------------

export const CommentSchema = z.object({
  id: z.string(),
  externalRefs: ExternalRefsSchema,
  taskId: z.string(),
  // AI:n kommentit aina type "ai", jotta niitä ei tulkita isännöitsijän omiksi.
  author: z.object({ type: z.enum(["ai", "propertyManager", "resident"]), name: z.string() }),
  // public näkyy asukkaalle, internal vain toimistolle.
  visibility: z.enum(["public", "internal"]),
  text: z.string(),
  createdAt: dateTime
});
export type Comment = z.infer<typeof CommentSchema>;
