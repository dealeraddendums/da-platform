import { z } from "zod";

// ── Primitives ────────────────────────────────────────────────────────────────

export const uuidSchema = z.string().uuid("Invalid UUID format");

export const emailSchema = z
  .string()
  .email("Invalid email address")
  .max(255, "Email too long")
  .toLowerCase()
  .trim();

export const nameSchema = z
  .string()
  .min(1, "Name is required")
  .max(255, "Name too long")
  .trim();

export const phoneSchema = z
  .string()
  .regex(/^[\d\s\-+().]+$/, "Invalid phone number format")
  .max(30, "Phone number too long")
  .optional()
  .or(z.literal(""));

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password too long");

export const urlSchema = z
  .string()
  .url("Invalid URL")
  .max(2048, "URL too long")
  .optional()
  .or(z.literal(""));

export const shortTextSchema = z
  .string()
  .max(255, "Text too long")
  .trim()
  .optional()
  .or(z.literal(""));

export const longTextSchema = z
  .string()
  .max(10_000, "Text too long")
  .trim()
  .optional()
  .or(z.literal(""));

export const positiveIntSchema = z
  .number()
  .int("Must be a whole number")
  .positive("Must be positive");

export const booleanSchema = z.boolean();

// ── Domain schemas ────────────────────────────────────────────────────────────

export const userRoleSchema = z.enum([
  "super_admin",
  "group_admin",
  "dealer_admin",
  "dealer_user",
  "dealer_restricted",
]);

export const vehicleConditionSchema = z.enum(["new", "used", "cpo"]);

export const documentTypeSchema = z.enum(["addendum", "infosheet", "buyers_guide"]);

export const timezoneSchema = z
  .string()
  .max(100)
  .regex(/^[A-Za-z_/]+$/, "Invalid timezone format")
  .optional();

export const timeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}(:\d{2})?$/, "Invalid time format (HH:MM)")
  .optional();

export const weekdaySchema = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

// ── Composite schemas ─────────────────────────────────────────────────────────

export const createUserSchema = z.object({
  full_name: nameSchema,
  email: emailSchema,
  role: userRoleSchema,
  password: passwordSchema,
  dealer_id: z.string().max(100).optional().nullable(),
  group_id: uuidSchema.optional().nullable(),
});

export const updateUserSchema = z.object({
  full_name: nameSchema.optional(),
  email: emailSchema.optional(),
  role: userRoleSchema.optional(),
  active: booleanSchema.optional(),
  password: passwordSchema.optional(),
  dealer_id: z.string().max(100).optional().nullable(),
  group_id: uuidSchema.optional().nullable(),
});

export const createDealerSchema = z.object({
  name: nameSchema,
  dealer_id: z.string().min(1).max(50).trim(),
  active: booleanSchema.optional(),
  group_id: uuidSchema.optional().nullable(),
  phone: phoneSchema,
  address: shortTextSchema,
  city: shortTextSchema,
  state: z.string().max(50).optional().or(z.literal("")),
  zip: z
    .string()
    .max(20)
    .regex(/^[\d\-\s]+$/, "Invalid ZIP code")
    .optional()
    .or(z.literal("")),
  country: z.string().max(50).optional().or(z.literal("")),
  primary_contact: shortTextSchema,
  primary_contact_email: emailSchema.optional().or(z.literal("")),
});

export const updateDealerSchema = createDealerSchema.partial();

export const staffProfileSchema = z.object({
  full_name: nameSchema.optional(),
  title: shortTextSchema,
  phone: phoneSchema,
  mobile: phoneSchema,
  sms_enabled: booleanSchema.optional(),
  avatar_url: urlSchema,
  timezone: timezoneSchema,
  on_call: booleanSchema.optional(),
  on_call_start: timeSchema,
  on_call_end: timeSchema,
  on_call_days: z.array(weekdaySchema).max(7).optional().nullable(),
  notification_email: emailSchema.optional().or(z.literal("")),
  notification_sms: phoneSchema,
  notes: longTextSchema,
});

export const inviteSchema = z.object({
  firstName: z.string().min(1).max(100).trim(),
  lastName: z.string().min(1).max(100).trim(),
  email: emailSchema,
  role: z.enum(["dealer_admin", "dealer_user", "dealer_restricted"]).optional(),
  dealer_id: z.string().max(100).optional().nullable(),
  group_id: uuidSchema.optional().nullable(),
});

export const templateSchema = z.object({
  name: nameSchema,
  document_type: documentTypeSchema,
  vehicle_types: z.array(vehicleConditionSchema).optional(),
  template_json: z.record(z.unknown()).optional(),
  is_active: booleanSchema.optional(),
});

// ── Parse helper ──────────────────────────────────────────────────────────────

/** Parse and return `{ data, error }` — never throws. */
export function safeParseBody<T>(
  schema: z.ZodSchema<T>,
  body: unknown
): { data: T; error: null } | { data: null; error: string } {
  const result = schema.safeParse(body);
  if (result.success) return { data: result.data, error: null };
  const message = result.error.errors
    .map((e) => `${e.path.join(".")}: ${e.message}`)
    .join("; ");
  return { data: null, error: message };
}
