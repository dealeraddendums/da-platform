import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { GroupRow, GroupUpdate } from "@/lib/db";

type Params = { params: { id: string } };

/**
 * GET /api/groups/[id]
 * super_admin: any group. group_admin: own group only.
 */
export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbError } = await admin
    .from("groups")
    .select("*")
    .eq("id", params.id)
    .single();

  if (dbError || !data) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const group = data as GroupRow;

  // group_admin may only see their own group
  if (claims.role === "group_admin" && group.id !== claims.group_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ data: group });
}

/**
 * PATCH /api/groups/[id]
 * super_admin: any. group_admin: own group only (name/contact, not active).
 */
export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // group_admin may only patch their own group
  if (claims.role === "group_admin" && params.id !== claims.group_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: GroupUpdate;
  try {
    body = (await req.json()) as GroupUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Whitelist updatable fields; group_admin cannot toggle active
  const patch: GroupUpdate = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.primary_contact !== undefined) patch.primary_contact = body.primary_contact;
  if (body.primary_contact_email !== undefined) patch.primary_contact_email = body.primary_contact_email;
  if (body.phone !== undefined) patch.phone = body.phone;
  if (body.address !== undefined) patch.address = body.address;
  if (body.city !== undefined) patch.city = body.city;
  if (body.state !== undefined) patch.state = body.state;
  if (body.zip !== undefined) patch.zip = body.zip;
  if (body.country !== undefined) patch.country = body.country;
  if (body.active !== undefined && claims.role === "super_admin") patch.active = body.active;
  if (body.is_test !== undefined && claims.role === "super_admin") patch.is_test = body.is_test;

  const admin = createAdminSupabaseClient();
  const { data, error: dbError } = await admin
    .from("groups")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();

  if (dbError || !data) {
    return NextResponse.json(
      { error: dbError?.message ?? "Group not found" },
      { status: dbError ? 500 : 404 }
    );
  }

  return NextResponse.json({ data: data as GroupRow });
}

/**
 * DELETE /api/groups/[id]
 *
 * Hard-deletes a group. super_admin only AND only when groups.is_test = true.
 * Member dealers are dissociated (dealers.group_id → null via the existing
 * ON DELETE SET NULL FK in migration 004) — the dealer rows themselves stay.
 *
 * Group-scoped tables that cascade automatically on DELETE:
 *   - group_options          (ON DELETE CASCADE, migration 015)
 *   - group_templates        (ON DELETE CASCADE, migration 015)
 *   - dealer_option_assignments  (group_id, CASCADE — migration 041)
 *   - dealer_template_assignments (group_id, CASCADE — migration 041)
 *   - dealer_admins          (group_id, CASCADE — migration 041)
 *   - profiles.group_id      (CASCADE — clears group_admin profile rows,
 *                             but the auth.users row stays so we delete
 *                             those explicitly first)
 *
 * Steps:
 *   1. Counts for the audit record + UI
 *   2. Delete auth.users for group_admin / group-scoped profiles (cascade
 *      deletes their profile rows too)
 *   3. Delete the groups row — FK cascade handles everything else
 *   4. Log to admin_audit
 */
export async function DELETE(
  _req: NextRequest,
  { params }: Params,
): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { data: group, error: loadErr } = await admin
    .from("groups")
    .select("id, name, is_test")
    .eq("id", params.id)
    .maybeSingle<{ id: string; name: string; is_test: boolean }>();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
  if (!group.is_test) {
    return NextResponse.json(
      { error: "Refusing to delete: group is not flagged as a test account. Toggle is_test first." },
      { status: 403 },
    );
  }

  // ── Counts (parallel; failures here aren't fatal) ──────────────────────────
  const [dealersC, templatesC, optionsC, usersRes] = await Promise.all([
    admin.from("dealers").select("id", { count: "exact", head: true }).eq("group_id", group.id),
    admin.from("group_templates").select("id", { count: "exact", head: true }).eq("group_id", group.id),
    admin.from("group_options").select("id", { count: "exact", head: true }).eq("group_id", group.id),
    admin.from("profiles").select("id").eq("group_id", group.id),
  ]);
  const counts = {
    member_dealers: dealersC.count ?? 0,
    group_templates: templatesC.count ?? 0,
    group_options: optionsC.count ?? 0,
    users: usersRes.data?.length ?? 0,
  };
  const userIds = (usersRes.data ?? []).map(r => r.id as string);

  // ── Delete group-scoped auth users (profiles cascade via auth FK) ──────────
  let usersDeleted = 0;
  for (const uid of userIds) {
    const { error: authErr } = await admin.auth.admin.deleteUser(uid);
    if (authErr) {
      console.error(`[group DELETE] auth.deleteUser failed for ${uid}: ${authErr.message}`);
    } else {
      usersDeleted++;
    }
  }

  // ── Delete the group row — FK cascade handles the rest ────────────────────
  const { error: dbError } = await admin
    .from("groups")
    .delete()
    .eq("id", group.id);
  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  // ── Audit log (best-effort) ───────────────────────────────────────────────
  try {
    await admin.from("admin_audit").insert({
      admin_user_id: claims.sub,
      action: "group_deleted",
      target_dealer_id: null,
      metadata: {
        group_name: group.name,
        group_uuid: group.id,
        counts: { ...counts, users_deleted: usersDeleted },
      },
    });
  } catch (auditErr) {
    console.error("[group DELETE] admin_audit insert failed:", auditErr);
  }

  return NextResponse.json({
    success: true,
    deleted: {
      group_name: group.name,
      group_id: group.id,
      ...counts,
      users_deleted: usersDeleted,
    },
  });
}
