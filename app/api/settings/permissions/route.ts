import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * GET /api/settings/permissions
 * Returns permissions for the calling role (dealer_admin: own role + dealer_user).
 * super_admin gets all 5 roles.
 */
export async function GET(): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  let rolesFilter: string[];
  if (claims.role === "super_admin") {
    rolesFilter = ["super_admin", "group_admin", "group_user", "dealer_admin", "dealer_user"];
  } else if (claims.role === "dealer_admin") {
    rolesFilter = ["dealer_admin", "dealer_user"];
  } else {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error: dbErr } = await admin
    .from("user_permissions")
    .select("*")
    .in("role", rolesFilter)
    .order("role");

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  return NextResponse.json({ permissions: data ?? [], role: claims.role });
}

/**
 * PATCH /api/settings/permissions
 * Updates permissions for a role. dealer_admin can only modify dealer_admin/dealer_user.
 * super_admin can modify any role except super_admin (to prevent lockout).
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const body = await req.json() as { role: string; permissions: Record<string, boolean> };
  const { role: targetRole, permissions } = body;

  if (!targetRole || typeof permissions !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Access control
  if (claims.role === "dealer_admin") {
    if (targetRole !== "dealer_admin" && targetRole !== "dealer_user") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Strip non-boolean or metadata fields
  const allowed = new Set([
    "can_view_inventory", "can_add_vehicles", "can_edit_vehicles", "can_delete_vehicles",
    "can_print_addendums", "can_print_infosheets", "can_use_builder",
    "can_view_options_library", "can_edit_options_library",
    "can_view_templates", "can_edit_templates",
    "can_view_reports", "can_export_data",
    "can_view_settings", "can_edit_settings",
    "can_manage_users",
    "can_view_dealers", "can_edit_dealers", "can_view_groups", "can_edit_groups",
    "can_impersonate_dealers",
    "can_view_billing",
    "can_use_ai_content", "can_manage_api_keys",
  ]);

  const update: Record<string, boolean | string> = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(permissions)) {
    if (allowed.has(k) && typeof v === "boolean") update[k] = v;
  }

  const admin = createAdminSupabaseClient();
  const { error: dbErr } = await admin
    .from("user_permissions")
    .update(update as never)
    .eq("role", targetRole);

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
