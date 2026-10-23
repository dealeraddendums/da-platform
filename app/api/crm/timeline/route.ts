import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { staffNames } from "@/lib/crm/queries";
import { FILTER_TYPES, buildRow, type TimelineFilter } from "@/lib/crm/timeline-rows";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/crm/timeline?company_id= | contact_id= &filter=all|email|calls|chat|notes|work|feeds|system
 *   &before=<iso>&before_id=<uuid> &limit=25
 * One compact row per activity, one per email thread (crm_timeline_rows, migration 192), newest first.
 * → { rows: TimelineRow[], next: { before, before_id } | null }
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const sp = req.nextUrl.searchParams;
  const companyId = sp.get("company_id"), contactId = sp.get("contact_id");
  if (!(companyId && UUID.test(companyId)) && !(contactId && UUID.test(contactId))) return NextResponse.json({ error: "company_id or contact_id required" }, { status: 400 });
  const filter = (sp.get("filter") ?? "all") as TimelineFilter;
  if (!(filter in FILTER_TYPES)) return NextResponse.json({ error: "Bad filter" }, { status: 400 });
  const before = sp.get("before"), beforeId = sp.get("before_id");
  const limit = Math.min(50, Math.max(1, Number(sp.get("limit")) || 25));

  const admin = createAdminSupabaseClient() as any;
  const { data: rows, error: rpcErr } = await admin.rpc("crm_timeline_rows", {
    p_company: companyId && UUID.test(companyId) ? companyId : null,
    p_contact: !companyId && contactId && UUID.test(contactId) ? contactId : null,
    p_types: FILTER_TYPES[filter], p_before: before && !Number.isNaN(Date.parse(before)) ? before : null,
    p_before_id: beforeId && UUID.test(beforeId) ? beforeId : null, p_limit: limit + 1,
  });
  if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 });
  const list: any[] = (rows ?? []).slice(0, limit);
  const more = (rows ?? []).length > limit;

  const ids = list.map((r) => r.activity_id);
  const [{ data: acts }, staff] = await Promise.all([
    ids.length ? admin.from("crm_activities").select("id, type, direction, subject, body, metadata, occurred_at, actor_staff_id, contact_id").in("id", ids) : { data: [] },
    staffNames(admin),
  ]);
  const byId = new Map<string, any>((acts ?? []).map((a: any) => [a.id, a]));
  const contactIds = Array.from(new Set((acts ?? []).map((a: any) => a.contact_id).filter(Boolean)));
  const { data: contacts } = contactIds.length ? await admin.from("crm_contacts").select("id, first_name, last_name, email").in("id", contactIds) : { data: [] };
  const cName = Object.fromEntries((contacts ?? []).map((c: any) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email]));

  const out = list.map((r) => {
    const a = byId.get(r.activity_id);
    return a ? buildRow(a, staff, cName, r.thread_id ? { id: r.thread_id, count: r.message_count, activityIds: r.activity_ids ?? [a.id] } : null) : null;
  }).filter(Boolean);
  const last = list[list.length - 1];
  return NextResponse.json({ rows: out, next: more && last ? { before: last.occurred_at, before_id: last.activity_id } : null });
}
