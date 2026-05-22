import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerRow, DealerUpdate } from "@/lib/db";
import { archiveCustomer, unarchiveCustomer, billingConfigured } from "@/lib/billing";
import { fireAndForget } from "@/lib/billing-sync";
import { fireGroupDiscountSync } from "@/lib/sync-group-discount";
import { fireSuperAdminGroupAssignCascade } from "@/lib/group-billing-cascade";

type Params = { params: { id: string } };

/**
 * GET /api/dealers/[id]
 * Returns dealer profile.
 * super_admin: any dealer. Others: only their own dealer (matched by dealer_id claim).
 */
export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { data, error: dbError } = await admin
    .from("dealers")
    .select("*")
    .eq("id", params.id)
    .single();

  if (dbError || !data) {
    return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  }

  const dealer = data as DealerRow;

  // Non-admins may only read their own dealer
  if (
    claims.role !== "super_admin" &&
    dealer.dealer_id !== claims.dealer_id
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ data: dealer });
}

/**
 * PATCH /api/dealers/[id]
 * Update dealer.
 * super_admin: any. dealer_admin: own dealer only. dealer_user/group_admin: 403.
 */
export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: DealerUpdate;
  try {
    body = (await req.json()) as DealerUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // group_admin gets a narrow whitelist — inventory_provider /
  // inventory_provider_is_dms / inventory_dealer_id only, and only on
  // dealers in their group. Reject anything outside that whitelist up
  // front so the 403 reason is explicit (the whitelist below would
  // silently drop unknown fields otherwise).
  if (claims.role === "group_admin") {
    const allowed = new Set(["inventory_provider", "inventory_provider_is_dms", "inventory_dealer_id"]);
    const submitted = Object.keys(body).filter(k => (body as Record<string, unknown>)[k] !== undefined);
    const extras = submitted.filter(k => !allowed.has(k));
    if (extras.length > 0) {
      return NextResponse.json({ error: `group_admin cannot edit: ${extras.join(", ")}` }, { status: 403 });
    }
    const { data: existing } = await admin
      .from("dealers")
      .select("group_id")
      .eq("id", params.id)
      .single();
    const row = existing as { group_id: string | null } | null;
    if (!row || row.group_id !== claims.group_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // For dealer_admin, verify they own this dealer before patching
  if (claims.role === "dealer_admin") {
    const { data: existing } = await admin
      .from("dealers")
      .select("dealer_id")
      .eq("id", params.id)
      .single();
    const row = existing as { dealer_id: string } | null;
    if (!row || row.dealer_id !== claims.dealer_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Whitelist updatable fields
  const patch: DealerUpdate = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.active !== undefined && claims.role === "super_admin") patch.active = body.active;
  if (body.is_test !== undefined && claims.role === "super_admin") patch.is_test = body.is_test;
  if (body.group_id !== undefined && claims.role === "super_admin") patch.group_id = body.group_id;
  // subscription_billed_to / labels_billed_to — super_admin only, used
  // by the group-assign cascade below to route billing.
  if (body.subscription_billed_to !== undefined && claims.role === "super_admin") {
    patch.subscription_billed_to = body.subscription_billed_to;
  }
  if (body.labels_billed_to !== undefined && claims.role === "super_admin") {
    patch.labels_billed_to = body.labels_billed_to;
  }
  if (body.primary_contact !== undefined) patch.primary_contact = body.primary_contact;
  if (body.primary_contact_email !== undefined) patch.primary_contact_email = body.primary_contact_email;
  if (body.phone !== undefined) patch.phone = body.phone;
  if (body.address !== undefined) patch.address = body.address;
  if (body.city !== undefined) patch.city = body.city;
  if (body.state !== undefined) patch.state = body.state;
  if (body.zip !== undefined) patch.zip = body.zip;
  if (body.country !== undefined) patch.country = body.country;
  if (body.makes !== undefined) patch.makes = body.makes;
  if (body.logo_url !== undefined) patch.logo_url = body.logo_url;
  // shipping address fields — dealer_admin and super_admin
  if (body.shipping_name !== undefined) patch.shipping_name = body.shipping_name;
  if (body.shipping_attention !== undefined) patch.shipping_attention = body.shipping_attention;
  if (body.shipping_address !== undefined) patch.shipping_address = body.shipping_address;
  if (body.shipping_address2 !== undefined) patch.shipping_address2 = body.shipping_address2;
  if (body.shipping_city !== undefined) patch.shipping_city = body.shipping_city;
  if (body.shipping_state !== undefined) patch.shipping_state = body.shipping_state;
  if (body.shipping_zip !== undefined) patch.shipping_zip = body.shipping_zip;
  if (body.shipping_country !== undefined) patch.shipping_country = body.shipping_country;
  if (body.shipping_phone !== undefined) patch.shipping_phone = body.shipping_phone;
  // inventory_dealer_id / inventory_provider / inventory_provider_is_dms:
  // super_admin can edit anywhere; group_admin gated above to own group.
  // internal_id is never updated.
  if (body.inventory_dealer_id !== undefined && (claims.role === "super_admin" || claims.role === "group_admin")) {
    patch.inventory_dealer_id = body.inventory_dealer_id;
  }
  if (body.inventory_provider !== undefined && (claims.role === "super_admin" || claims.role === "group_admin")) {
    patch.inventory_provider = body.inventory_provider;
  }
  if (body.inventory_provider_is_dms !== undefined && (claims.role === "super_admin" || claims.role === "group_admin")) {
    patch.inventory_provider_is_dms = body.inventory_provider_is_dms;
  }
  // Snapshot the active flag + billing customer id + group_id before
  // update so we can detect transitions (true→false, false→true) for
  // Event 5 / discount sync, and null→UUID on group_id for the
  // super-admin group-assign cascade.
  let prevActive: boolean | null = null;
  let billingCustomerId: string | null = null;
  let legacyBillingId: string | null = null;
  let dealerGroupId: string | null = null;
  let prevGroupId: string | null = null;
  // Snapshot runs whenever active OR group_id is being touched.
  if (typeof patch.active === "boolean" || patch.group_id !== undefined) {
    const { data: snap } = await admin
      .from("dealers")
      .select("active, billing_customer_id, internal_id, group_id")
      .eq("id", params.id)
      .maybeSingle<{ active: boolean; billing_customer_id: string | null; internal_id: string | null; group_id: string | null }>();
    prevActive = snap?.active ?? null;
    billingCustomerId = snap?.billing_customer_id ?? null;
    legacyBillingId = snap?.internal_id ?? null;
    dealerGroupId = snap?.group_id ?? null;
    prevGroupId = snap?.group_id ?? null;
  }

  const { data, error: dbError } = await admin
    .from("dealers")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();

  if (dbError || !data) {
    return NextResponse.json(
      { error: dbError?.message ?? "Dealer not found" },
      { status: dbError ? 500 : 404 }
    );
  }

  // Event 5: archive/unarchive in da-billing on active flag transition.
  // Prefer billing_customer_id (new platform dealers); fall back to
  // internal_id (legacy migrated dealers). Skip if both are null.
  if (
    typeof patch.active === "boolean"
    && prevActive !== null
    && patch.active !== prevActive
    && billingConfigured()
  ) {
    const customerKey = billingCustomerId ?? legacyBillingId;
    if (customerKey) {
      if (patch.active === false) {
        fireAndForget(
          () => archiveCustomer(customerKey),
          { event: "billing.customer.archive", dealerId: params.id, payload: { customerKey } },
        );
      } else {
        fireAndForget(
          () => unarchiveCustomer(customerKey),
          { event: "billing.customer.unarchive", dealerId: params.id, payload: { customerKey } },
        );
      }
    }
  }

  // Group discount sync: when a dealer is deactivated AND was in a
  // group, the group's active-dealer count just dropped, which may
  // bump the auto-discount tier down. Fire-and-forget. (We don't sync
  // on activate because re-activating an already-grouped dealer hits
  // the same tier — but to keep symmetry the helper is cheap to call,
  // so we fire on any active flip while in a group.)
  if (
    typeof patch.active === "boolean"
    && prevActive !== null
    && patch.active !== prevActive
    && dealerGroupId
  ) {
    fireGroupDiscountSync(dealerGroupId);
  }

  // Super-admin group assignment: when group_id transitions from null
  // to a non-null UUID, fire the cascade. The cascade also fires its
  // own fireGroupDiscountSync at the end so we don't double-sync here.
  // Re-assignment (UUID → different UUID) and removal are out of scope
  // per spec, so we only act on the null → UUID edge.
  if (
    patch.group_id !== undefined
    && patch.group_id !== null
    && prevGroupId === null
    && claims.role === "super_admin"
  ) {
    fireSuperAdminGroupAssignCascade(params.id, patch.group_id);
  }

  return NextResponse.json({ data: data as DealerRow });
}

/**
 * DELETE /api/dealers/[id]
 * Permanently hard-deletes a dealer. super_admin only AND only when
 * dealers.is_test = true. The is_test gate is the safety rail: real
 * dealerships are protected from this endpoint regardless of caller.
 *
 * Order of deletion:
 *   1. Count children for the audit record
 *   2. Delete auth.users for dealer-scoped profiles (cascades profiles)
 *   3. Delete dealer_vehicles by text dealer_id (no FK cascade exists)
 *   4. Delete the dealers row (FK cascade handles addendum_data,
 *      vehicle_options, vehicle_addendum_items, dealer_admins,
 *      dealer_invites, group_*_assignments, dealer_settings,
 *      addendum_library, addendum_history, print_history, templates)
 *   5. Log to admin_audit
 *
 * Returns the counts so the UI can show what was removed.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  // Load the dealer first so we can verify is_test and grab the text dealer_id
  // (needed for the non-FK-cascading dealer_vehicles delete). billing_customer_id
  // + internal_id are read so we can archive the da-billing customer after the
  // delete completes.
  const { data: dealer, error: loadErr } = await admin
    .from("dealers")
    .select("id, dealer_id, name, is_test, billing_customer_id, internal_id")
    .eq("id", params.id)
    .maybeSingle<{ id: string; dealer_id: string; name: string; is_test: boolean; billing_customer_id: string | null; internal_id: string | null }>();

  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  if (!dealer.is_test) {
    return NextResponse.json(
      { error: "Refusing to delete: dealer is not flagged as a test account. Toggle is_test first." },
      { status: 403 },
    );
  }

  // ── Counts (run in parallel; failures here aren't fatal, just log) ───────
  const [vehiclesC, addendumC, printC, optionsC, usersRes] = await Promise.all([
    admin.from("dealer_vehicles").select("id", { count: "exact", head: true }).eq("dealer_id", dealer.dealer_id),
    admin.from("addendum_data").select("id", { count: "exact", head: true }).eq("dealer_id", dealer.id),
    admin.from("print_history").select("id", { count: "exact", head: true }).eq("dealer_id", dealer.dealer_id),
    admin.from("vehicle_options").select("id", { count: "exact", head: true }).eq("dealer_id", dealer.dealer_id),
    admin.from("profiles").select("id").eq("dealer_id", dealer.dealer_id),
  ]);
  const counts = {
    vehicles: vehiclesC.count ?? 0,
    addendum_line_items: addendumC.count ?? 0,
    print_records: printC.count ?? 0,
    options: optionsC.count ?? 0,
    users: usersRes.data?.length ?? 0,
  };
  const userIds = (usersRes.data ?? []).map(r => r.id as string);

  // ── Delete dealer-scoped auth users (profiles cascade via auth FK) ───────
  // Use Supabase admin auth API rather than DELETE from profiles directly so
  // the auth.users row goes away too (otherwise the user could still log in).
  let usersDeleted = 0;
  for (const uid of userIds) {
    const { error: authErr } = await admin.auth.admin.deleteUser(uid);
    if (authErr) {
      console.error(`[dealer DELETE] auth.deleteUser failed for ${uid}: ${authErr.message}`);
    } else {
      usersDeleted++;
    }
  }

  // ── Delete dealer_vehicles (no FK cascade — must be explicit) ────────────
  const { error: dvErr } = await admin
    .from("dealer_vehicles")
    .delete()
    .eq("dealer_id", dealer.dealer_id);
  if (dvErr) {
    console.error(`[dealer DELETE] dealer_vehicles delete failed: ${dvErr.message}`);
    return NextResponse.json({ error: `dealer_vehicles delete failed: ${dvErr.message}` }, { status: 500 });
  }

  // ── Delete label_orders (FK to dealers(id) without ON DELETE CASCADE) ────
  const { error: loErr } = await admin
    .from("label_orders")
    .delete()
    .eq("dealer_id", dealer.id);
  if (loErr) {
    console.error(`[dealer DELETE] label_orders delete failed: ${loErr.message}`);
    return NextResponse.json({ error: `label_orders delete failed: ${loErr.message}` }, { status: 500 });
  }

  // ── Finally, delete the dealer row (cascade picks up the rest) ───────────
  const { error: dbError } = await admin
    .from("dealers")
    .delete()
    .eq("id", dealer.id);
  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  // ── Archive in da-billing so the customer + invoice history are preserved ─
  // Hard-delete in the platform → soft-archive in da-billing. Prefer
  // billing_customer_id (platform-created dealers); fall back to internal_id
  // (legacy migrated dealers). Fire-and-forget — never fail the dealer
  // delete if archive call fails; the error lands in billing_sync_errors.
  if (billingConfigured()) {
    const customerKey = dealer.billing_customer_id ?? dealer.internal_id;
    if (customerKey) {
      fireAndForget(
        () => archiveCustomer(customerKey),
        { event: "billing.customer.archive", dealerId: dealer.id, payload: { customerKey, reason: "dealer_deleted" } },
      );
    }
  }

  // ── Audit log (best-effort — don't fail the response if it errors) ───────
  try {
    await admin.from("admin_audit").insert({
      admin_user_id: claims.sub,
      action: "dealer_deleted",
      target_dealer_id: dealer.dealer_id,
      metadata: {
        dealer_name: dealer.name,
        dealer_uuid: dealer.id,
        counts: { ...counts, users_deleted: usersDeleted },
      },
    });
  } catch (auditErr) {
    console.error("[dealer DELETE] admin_audit insert failed:", auditErr);
  }

  return NextResponse.json({
    success: true,
    deleted: {
      dealer_name: dealer.name,
      dealer_id: dealer.dealer_id,
      ...counts,
      users_deleted: usersDeleted,
    },
  });
}
