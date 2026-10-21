// DA-CRM access: staff only. A user may use DA-CRM when they are an ACTIVE
// super_admin AND hold the 'crm' row in staff_permissions (migration 179);
// 'crm_admin' additionally manages the team, settings, webhook subscribers and
// company ownership. Same rule as public.has_staff_permission() in RLS. Never
// dealer-facing: dealer / group roles fail the role check before any lookup.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { getJwtClaims, type JwtClaims } from "@/lib/auth";

export type CrmPerms = { crm: boolean; crmAdmin: boolean };

/** This user's CRM permissions (role checked separately). Fails closed. */
export async function crmPermissions(userId: string, admin: any = createAdminSupabaseClient()): Promise<CrmPerms> {
  const { data, error } = await admin
    .from("staff_permissions")
    .select("permission")
    .eq("user_id", userId)
    .in("permission", ["crm", "crm_admin"]);
  if (error) {
    // Table missing (migration 179 not applied yet) or a blip → closed.
    console.error("[crm] staff_permissions lookup:", error.message);
    return { crm: false, crmAdmin: false };
  }
  const set = new Set((data ?? []).map((r: any) => r.permission));
  // crm_admin implies crm.
  return { crm: set.has("crm") || set.has("crm_admin"), crmAdmin: set.has("crm_admin") };
}

/**
 * API guard: 401 without a session, 403 unless super_admin + crm
 * (or crm_admin when `opts.admin`).
 */
export async function requireCrmStaff(opts: { admin?: boolean } = {}): Promise<
  { claims: JwtClaims; perms: CrmPerms; error: null } | { claims: null; perms: null; error: NextResponse }
> {
  const claims = await getJwtClaims();
  if (!claims) return { claims: null, perms: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const perms = claims.role === "super_admin" ? await crmPermissions(claims.sub) : { crm: false, crmAdmin: false };
  if (!perms.crm || (opts.admin && !perms.crmAdmin)) {
    return { claims: null, perms: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { claims, perms, error: null };
}
