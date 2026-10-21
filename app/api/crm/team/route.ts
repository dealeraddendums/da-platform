import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { staffPatch } from "@/lib/crm/team";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/team (crm_admin) — add a team member: { staff_id, admin?,
 * team?, capabilities?, …profile fields }. The person must be an active
 * super_admin login; they get the 'crm' permission (+ 'crm_admin' if admin).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff({ admin: true });
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const staffId = typeof b?.staff_id === "string" ? b.staff_id : null;
  if (!staffId) return NextResponse.json({ error: "staff_id required" }, { status: 400 });
  const { staff_id: _s, admin: makeAdmin, ...rest } = b; // eslint-disable-line @typescript-eslint/no-unused-vars
  const parsed = staffPatch(rest, true);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const admin = createAdminSupabaseClient() as any;
  const { data: p } = await admin.from("profiles").select("id, role, active, full_name").eq("id", staffId).maybeSingle();
  if (!p || p.role !== "super_admin" || p.active === false) {
    return NextResponse.json({ error: "Team members must be active DA staff (super_admin) logins" }, { status: 400 });
  }
  const perms = [{ user_id: staffId, permission: "crm", granted_by: claims.sub }];
  if (makeAdmin) perms.push({ user_id: staffId, permission: "crm_admin", granted_by: claims.sub });
  const { error: pErr } = await admin.from("staff_permissions").upsert(perms, { onConflict: "user_id,permission", ignoreDuplicates: true });
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });
  const { error: sErr } = await admin.from("crm_staff_profiles")
    .upsert({ staff_id: staffId, full_name: p.full_name, ...parsed.patch, active: true }, { onConflict: "staff_id" });
  if (sErr) return NextResponse.json({ error: sErr.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
