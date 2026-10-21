// Validation for contact create / edit bodies (POST + PATCH /api/crm/contacts).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { normalizePhone } from "./phone";
import { ROLE_TAGS } from "./companies";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Only keys present in `b` are returned, so PATCH leaves the rest alone. */
export function contactFields(b: any, opts: { requireFirstName: boolean }): { fields: Record<string, string | null> } | { error: string } {
  const fields: Record<string, string | null> = {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  for (const k of ["first_name", "last_name", "title"] as const) if (k in (b ?? {})) fields[k] = str(b[k]);
  if (opts.requireFirstName && !fields.first_name) return { error: "first_name required" };
  if ("first_name" in fields && !fields.first_name) return { error: "first_name can't be blank" };
  if ("email" in (b ?? {})) {
    const email = str(b.email)?.toLowerCase() ?? null;
    if (email && !EMAIL.test(email)) return { error: "Email isn't valid" };
    fields.email = email;
  }
  if ("phone" in (b ?? {})) {
    const raw = str(b.phone);
    const phone = raw ? normalizePhone(raw) : null;
    if (raw && !phone) return { error: "Phone number isn't valid" };
    fields.phone = phone;
  }
  if ("role_tag" in (b ?? {})) {
    if (b.role_tag && !(ROLE_TAGS as readonly string[]).includes(b.role_tag)) return { error: "Unknown role" };
    fields.role_tag = b.role_tag || null;
  }
  return { fields };
}

/** The platform user behind this email at this company's dealer (or group), if any. */
export async function linkPlatformUser(admin: any, companyId: string, email: string): Promise<string | null> {
  const { data: c } = await admin.from("crm_companies").select("kind, group_id, dealer:dealers(dealer_id)").eq("id", companyId).maybeSingle();
  if (!c || (c.kind !== "dealer" && c.kind !== "group")) return null;
  let q = admin.from("profiles").select("id").ilike("email", email.replace(/[\\%_]/g, "\\$&"));
  q = c.kind === "dealer" ? q.eq("dealer_id", c.dealer?.dealer_id ?? "__none__") : q.eq("group_id", c.group_id);
  const { data } = await q.limit(1).maybeSingle();
  return data?.id ?? null;
}
