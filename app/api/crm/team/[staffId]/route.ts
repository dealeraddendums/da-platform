import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { staffPatch } from "@/lib/crm/team";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * PATCH /api/crm/team/[staffId] — edit a team member. Anyone may edit their
 * own name, hours, time zone, cell and signature; team, capabilities, Dialpad
 * mapping, active and { admin: bool } (crm_admin grant) need crm_admin.
 */
export async function PATCH(req: NextRequest, { params }: { params: { staffId: string } }): Promise<NextResponse> {
  const { claims, perms, error } = await requireCrmStaff();
  if (error) return error;
  const self = claims.sub === params.staffId;
  if (!self && !perms.crmAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const { admin: grantAdmin, ...rest } = b ?? {};
  const parsed = staffPatch(rest, perms.crmAdmin);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: parsed.forbidden ? 403 : 400 });

  const admin = createAdminSupabaseClient() as any;
  const { data: existing } = await admin.from("crm_staff_profiles").select("staff_id").eq("staff_id", params.staffId).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Not a team member" }, { status: 404 });

  if (typeof grantAdmin === "boolean") {
    if (!perms.crmAdmin) return NextResponse.json({ error: "Only a DA-CRM admin can change admin access" }, { status: 403 });
    if (!grantAdmin && self) return NextResponse.json({ error: "You can't remove your own admin access" }, { status: 400 });
    if (grantAdmin) await admin.from("staff_permissions").upsert({ user_id: params.staffId, permission: "crm_admin", granted_by: claims.sub }, { onConflict: "user_id,permission", ignoreDuplicates: true });
    else await admin.from("staff_permissions").delete().eq("user_id", params.staffId).eq("permission", "crm_admin");
  }
  if (Object.keys(parsed.patch).length) {
    const { error: upErr } = await admin.from("crm_staff_profiles").update(parsed.patch).eq("staff_id", params.staffId);
    if (upErr) {
      const dup = upErr.code === "23505";
      return NextResponse.json({ error: dup ? "That Dialpad user is already mapped to someone else" : upErr.message }, { status: dup ? 409 : 500 });
    }
  }
  // Deactivating someone also removes their DA-CRM access.
  if (parsed.patch.active === false && !self) {
    await admin.from("staff_permissions").delete().eq("user_id", params.staffId).in("permission", ["crm", "crm_admin"]);
  } else if (parsed.patch.active === true) {
    await admin.from("staff_permissions").upsert({ user_id: params.staffId, permission: "crm", granted_by: claims.sub }, { onConflict: "user_id,permission", ignoreDuplicates: true });
  }
  return NextResponse.json({ ok: true });
}
