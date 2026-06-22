import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { GroupRow, GroupUpdate } from "@/lib/db";
import { billingConfigured, updateCustomer } from "@/lib/billing";
import { fireAndForget } from "@/lib/billing-sync";
import { invalidateBrandCache } from "@/lib/brand";

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
  // DA Legacy ETL config-lock (migration 094) — super_admin only; cascades to
  // all member dealers. group_admin can edit name/contact, never this: a forged
  // etl_locked from group_admin is simply not copied into the patch.
  if (body.etl_locked !== undefined && claims.role === "super_admin") {
    patch.etl_locked = body.etl_locked;
    patch.etl_locked_at = body.etl_locked ? new Date().toISOString() : null;
    patch.etl_locked_by = body.etl_locked ? claims.sub : null;
    patch.etl_locked_reason = body.etl_locked ? (body.etl_locked_reason ?? null) : null;
  }

  // White-label (Phase 12a, migration 110) — super_admin only (operator-
  // provisioned). A group_admin can never set their own domain/branding; a
  // forged value is simply not copied into the patch.
  let brandingTouched = false;
  if (claims.role === "super_admin") {
    if (body.custom_domain !== undefined) {
      const d = (body.custom_domain ?? "").trim().toLowerCase();
      patch.custom_domain = d || null;
      brandingTouched = true;
    }
    if (body.branding !== undefined) {
      patch.branding = body.branding ?? null;
      brandingTouched = true;
    }
    if (body.custom_domain_status !== undefined) {
      patch.custom_domain_status = body.custom_domain_status === "active" ? "active" : "pending";
      brandingTouched = true;
    }
  }

  const admin = createAdminSupabaseClient();

  // Snapshot the prior name so we can detect a real rename for the da-billing
  // company sync below (only when name is actually being patched).
  let prevName: string | null = null;
  if (patch.name !== undefined) {
    const { data: snap } = await admin
      .from("groups")
      .select("name")
      .eq("id", params.id)
      .maybeSingle<{ name: string | null }>();
    prevName = snap?.name ?? null;
  }

  const { data, error: dbError } = await admin
    .from("groups")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();

  if (dbError || !data) {
    // Unique violation on custom_domain → friendly 409 (another group owns it).
    if (dbError && (dbError.code === "23505" || /custom_domain/i.test(dbError.message))) {
      return NextResponse.json({ error: "That custom domain is already assigned to another group." }, { status: 409 });
    }
    return NextResponse.json(
      { error: dbError?.message ?? "Group not found" },
      { status: dbError ? 500 : 404 }
    );
  }

  const updatedGroup = data as GroupRow;

  // White-label changes affect host→brand resolution — drop the cached map so
  // the next request on the (old or new) domain re-resolves immediately.
  if (brandingTouched) invalidateBrandCache();

  // Group rename → propagate the new name to the group's da-billing customer
  // (company field). NAME/COMPANY ONLY — pricing lives in template:{uuid} and is
  // never touched here. updateCustomer is a partial PUT (lib/billing.ts), so
  // sending just { company } can't blank other fields — no read-merge needed.
  // Only the group's own customer; member dealers' customers are unaffected.
  // Fire-and-forget: a billing hiccup logs to billing_sync_errors, never blocks
  // or rolls back the rename.
  if (
    patch.name !== undefined
    && prevName !== null
    && (patch.name ?? "").trim() !== prevName
    && updatedGroup.billing_customer_id
    && billingConfigured()
  ) {
    const newName = (patch.name as string).trim();
    const customerId = updatedGroup.billing_customer_id;
    fireAndForget(
      () => updateCustomer(customerId, { company: newName }),
      { event: "billing.group.rename", groupId: updatedGroup.id, payload: { customerId, newName } },
    );
  }

  return NextResponse.json({ data: updatedGroup });
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
