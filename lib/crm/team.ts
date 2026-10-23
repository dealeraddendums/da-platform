// DA-CRM team members (crm_staff_profiles). Two teams; Management's
// specialities are capability tags.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { sanitizeTemplateHtml } from "./email-html";
import { normalizePhone } from "./phone";

export const TEAMS = { customer_support: "Customer Support", management: "Management" } as const;
export const CAPABILITIES = { tier1: "Tier 1", tier2: "Tier 2", feed_support: "Feed support", ar_ap: "AR/AP", label_shipping: "Label shipping" } as const;
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Email signatures: the same strict email allowlist as templates (lib/crm/email-html.ts). */
export function sanitizeSignature(html: string): string {
  return sanitizeTemplateHtml(html);
}

export function parseWorkHours(v: unknown): Record<string, { start: string; end: string }> | null {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, { start: string; end: string }> = {};
  for (const [day, h] of Object.entries(v as Record<string, any>)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) return null;
    if (h == null) continue;
    if (!HHMM.test(h?.start ?? "") || !HHMM.test(h?.end ?? "") || h.start >= h.end) return null;
    out[day] = { start: h.start, end: h.end };
  }
  return out;
}

const ADMIN_FIELDS = ["team", "capabilities", "dialpad_user_id", "dialpad_number", "active"] as const;

/**
 * Validated patch from a request body. Non-admins may only set the personal
 * fields (name, hours, time zone, cell, signature); ADMIN_FIELDS need crm_admin.
 */
export function staffPatch(b: any, isAdmin: boolean): { patch: Record<string, unknown> } | { error: string; forbidden?: boolean } {
  const patch: Record<string, unknown> = {};
  const keys = Object.keys(b ?? {});
  const forbidden = keys.filter((k) => (ADMIN_FIELDS as readonly string[]).includes(k) && !isAdmin);
  if (forbidden.length) return { error: `Only a DA-CRM admin can change ${forbidden.join(", ")}`, forbidden: true };

  if ("full_name" in b) patch.full_name = typeof b.full_name === "string" && b.full_name.trim() ? b.full_name.trim() : null;
  if ("work_hours" in b) {
    const wh = parseWorkHours(b.work_hours);
    if (!wh) return { error: "work_hours must be {mon:{start:'08:00',end:'17:00'}, …}" };
    patch.work_hours = wh;
  }
  if ("time_zone" in b) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: b.time_zone }); } catch { return { error: "Unknown time zone" }; }
    patch.time_zone = b.time_zone;
  }
  for (const k of ["cell_phone", "dialpad_number"] as const) {
    if (k in b) {
      const p = b[k] ? normalizePhone(b[k]) : null;
      if (b[k] && !p) return { error: `${k} isn't a valid phone number` };
      patch[k] = p;
    }
  }
  if ("email_signature_html" in b) patch.email_signature_html = typeof b.email_signature_html === "string" && b.email_signature_html.trim()
    ? sanitizeSignature(b.email_signature_html).slice(0, 20_000) : null;
  if ("team" in b) {
    if (!(b.team in TEAMS)) return { error: "Unknown team" };
    patch.team = b.team;
  }
  if ("capabilities" in b) {
    if (!Array.isArray(b.capabilities) || b.capabilities.some((c: unknown) => typeof c !== "string" || !(c in CAPABILITIES))) return { error: "Unknown capability" };
    patch.capabilities = Array.from(new Set(b.capabilities));
  }
  if ("dialpad_user_id" in b) {
    const id = b.dialpad_user_id == null || b.dialpad_user_id === "" ? null : String(b.dialpad_user_id).trim();
    if (id && !/^\d+$/.test(id)) return { error: "Dialpad user id is a number" };
    patch.dialpad_user_id = id;
  }
  if ("active" in b) patch.active = !!b.active;
  return { patch };
}
