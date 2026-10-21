// Server-side reads shared by the /crm pages (service-role client; callers
// have already passed requireCrmPage).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAdminSupabaseClient } from "@/lib/db";
import { crmEnv } from "./env";

export type TimelineItem = {
  id: string;
  type: string;
  direction: string;
  subject: string | null;
  body: string | null;
  metadata: Record<string, any>;
  occurred_at: string;
  actor_staff_id: string | null;
  contact_id: string | null;
  company_id: string | null;
};

export type CallListRow = {
  id: string;
  company_id: string | null;
  contact_id: string | null;
  staff_id: string | null;
  direction: "inbound" | "outbound";
  from_number: string | null;
  to_number: string | null;
  started_at: string | null;
  duration_sec: number | null;
  state: string;
  has_recording: boolean;
  transcript: string | null;
  summary: string | null;
  company_name: string | null;
  contact_name: string | null;
  staff_name: string | null;
};

export function crmAdmin(): any {
  return createAdminSupabaseClient();
}

/** profiles.id → display name for everyone holding a DA-CRM permission. */
export async function staffNames(admin: any = crmAdmin()): Promise<Record<string, string>> {
  const { data: perms } = await admin.from("staff_permissions").select("user_id").in("permission", ["crm", "crm_admin"]);
  const ids = Array.from(new Set((perms ?? []).map((p: any) => p.user_id)));
  if (!ids.length) return {};
  const [{ data }, { data: team }] = await Promise.all([
    admin.from("profiles").select("id, full_name, email").in("id", ids),
    admin.from("crm_staff_profiles").select("staff_id, full_name").in("staff_id", ids),
  ]);
  const teamName = Object.fromEntries((team ?? []).map((t: any) => [t.staff_id, t.full_name]));
  return Object.fromEntries((data ?? []).map((p: any) => [p.id, teamName[p.id] || p.full_name || p.email]));
}

/** Can this staff member click-to-call through Dialpad (mapped + configured)? */
export async function canDial(userId: string, admin: any = crmAdmin()): Promise<boolean> {
  if (!crmEnv("DIALPAD_API_KEY")) return false;
  const { data } = await admin.from("crm_staff_profiles").select("dialpad_user_id").eq("staff_id", userId).maybeSingle();
  return !!data?.dialpad_user_id;
}

export async function timeline(filter: { company_id?: string; contact_id?: string; types?: string[] }, limit = 100, admin: any = crmAdmin()): Promise<TimelineItem[]> {
  let q = admin.from("crm_activities")
    .select("id, type, direction, subject, body, metadata, occurred_at, actor_staff_id, contact_id, company_id")
    .order("occurred_at", { ascending: false }).limit(limit);
  if (filter.company_id) q = q.eq("company_id", filter.company_id);
  if (filter.types?.length) q = q.in("type", filter.types);
  if (filter.contact_id) q = q.eq("contact_id", filter.contact_id);
  const { data } = await q;
  return (data ?? []) as TimelineItem[];
}

/** company id → resolved name (dealer / group / partner). */
export async function companyNames(ids: string[], admin: any = crmAdmin()): Promise<Record<string, string>> {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (!uniq.length) return {};
  const { data } = await admin.from("crm_company_directory").select("id, name").in("id", uniq);
  return Object.fromEntries((data ?? []).map((c: any) => [c.id, c.name]));
}

/** Calls with company / contact / staff names resolved for the tables. */
export async function decorateCalls(rows: any[], admin: any = crmAdmin()): Promise<CallListRow[]> {
  const contactIds = Array.from(new Set(rows.map((r) => r.contact_id).filter(Boolean)));
  const [dName, contacts, staff] = await Promise.all([
    companyNames(rows.map((r) => r.company_id), admin),
    contactIds.length ? admin.from("crm_contacts").select("id, first_name, last_name, email").in("id", contactIds).then((r: any) => r.data ?? []) : [],
    staffNames(admin),
  ]);
  const cName = Object.fromEntries(contacts.map((c: any) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email]));
  return rows.map((r) => ({
    id: r.id,
    company_id: r.company_id,
    contact_id: r.contact_id,
    staff_id: r.staff_id,
    direction: r.direction,
    from_number: r.from_number,
    to_number: r.to_number,
    started_at: r.started_at,
    duration_sec: r.duration_sec,
    state: r.state,
    has_recording: !!(r.recording_s3_key || r.recording_url || r.voicemail_url),
    transcript: r.transcript,
    summary: r.summary,
    company_name: r.company_id ? dName[r.company_id] ?? null : null,
    contact_name: r.contact_id ? cName[r.contact_id] ?? null : null,
    staff_name: r.staff_id ? (staff as Record<string, string>)[r.staff_id] ?? null : null,
  }));
}

export const CALL_COLUMNS = "id, company_id, contact_id, staff_id, direction, from_number, to_number, started_at, duration_sec, state, recording_s3_key, recording_url, voicemail_url, transcript, summary";
