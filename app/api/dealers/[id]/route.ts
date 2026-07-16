import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import type { DealerRow, DealerUpdate } from "@/lib/db";
import { archiveCustomer, unarchiveCustomer, billingConfigured, updateCustomer, getTemplate, putTemplate } from "@/lib/billing";
import { fireAndForget } from "@/lib/billing-sync";
import { fireDealerSync, fireDealerReliable } from "@/lib/sync-hubspot";
import { fireConversionWebhook } from "@/lib/marketing-webhook";
import { normalizeSubscriptionType, isPayingAccount } from "@/lib/hubspot";
import { fireGroupDiscountSync } from "@/lib/sync-group-discount";
import { fireSuperAdminGroupAssignCascade } from "@/lib/group-billing-cascade";
import { applyDealerSubscriptionChange, type SubscriptionBillingResult } from "@/lib/billing-subscription";
import { applyInventoryDealerIdChange, DealerIdSyncError } from "@/lib/dealer-id-sync";

type Params = { params: { id: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // Resolve params.id to the dealer row. Callers pass either the
  // dealers.id UUID (super_admin paths from /dealers/[id]) or the text
  // dealers.dealer_id (dealer_admin paths from Print Settings, which
  // pass profile.dealer_id verbatim through DealerLogoUploader). Every
  // downstream .eq("id", …) needs the UUID — without this resolution
  // the dealer_admin scope check below would never find a row when the
  // route was hit with a text id and would 403 "Forbidden" on every
  // logo save (which is exactly the Print Settings bug).
  const { data: resolved } = await admin
    .from("dealers")
    .select("id, dealer_id, group_id")
    .eq(UUID_RE.test(params.id) ? "id" : "dealer_id", params.id)
    .maybeSingle<{ id: string; dealer_id: string; group_id: string | null }>();
  if (!resolved) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  const dealerUuid = resolved.id;

  // group_admin / group_user get a narrow whitelist — the inventory trio
  // plus logo_url (group admins operate member dealers with dealer_admin
  // parity, and the Dealer Logo card saves via this PATCH). Reject anything
  // outside the whitelist up front so the 403 reason is explicit (the
  // whitelist below would silently drop unknown fields otherwise). Scope via
  // authorizeDealerAction: group_admin → in-group; group_user (regional
  // manager) → in-group AND tag-scoped. (group_user previously fell through
  // this gate entirely — no branch — and could PATCH any dealer.)
  if (claims.role === "group_admin" || claims.role === "group_user") {
    const allowed = new Set(["inventory_provider", "inventory_provider_is_dms", "inventory_dealer_id", "logo_url"]);
    const submitted = Object.keys(body).filter(k => (body as Record<string, unknown>)[k] !== undefined);
    const extras = submitted.filter(k => !allowed.has(k));
    if (extras.length > 0) {
      return NextResponse.json({ error: `${claims.role} cannot edit: ${extras.join(", ")}` }, { status: 403 });
    }
    const authz = await authorizeDealerAction(claims, resolved.dealer_id);
    if (!authz.ok) return authz.response;
  }

  // dealer_restricted also had no branch — lock it out like dealer_user.
  if (claims.role === "dealer_restricted") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // For dealer_admin, verify they own this dealer before patching
  if (claims.role === "dealer_admin") {
    if (resolved.dealer_id !== claims.dealer_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Whitelist updatable fields
  const patch: DealerUpdate = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.active !== undefined && claims.role === "super_admin") patch.active = body.active;
  // Account-purpose classifier (migration 096) — super_admin only. Purpose is
  // authoritative and recomputes is_test = (account_purpose <> 'real'). If only
  // the raw is_test toggle is sent (back-compat), keep honoring it AND sync
  // account_purpose so the invariant holds: on→'test', off→'real' (use the
  // Purpose selector to set 'sales_demo').
  if (body.account_purpose !== undefined && claims.role === "super_admin") {
    const valid = new Set(["real", "test", "sales_demo"]);
    if (!valid.has(body.account_purpose)) {
      return NextResponse.json({ error: "Invalid account_purpose" }, { status: 400 });
    }
    patch.account_purpose = body.account_purpose;
    patch.is_test = body.account_purpose !== "real";
  } else if (body.is_test !== undefined && claims.role === "super_admin") {
    patch.is_test = body.is_test;
    patch.account_purpose = body.is_test ? "test" : "real";
  }
  // DA Legacy ETL config-lock (migration 094) — super_admin only. A forged
  // etl_locked from dealer_admin/group_admin never reaches here (group_admin is
  // whitelist-rejected above; dealer_admin's value is simply not copied).
  if (body.etl_locked !== undefined && claims.role === "super_admin") {
    patch.etl_locked = body.etl_locked;
    patch.etl_locked_at = body.etl_locked ? new Date().toISOString() : null;
    patch.etl_locked_by = body.etl_locked ? claims.sub : null;
    patch.etl_locked_reason = body.etl_locked ? (body.etl_locked_reason ?? null) : null;
  }
  if (body.group_id !== undefined && claims.role === "super_admin") {
    patch.group_id = body.group_id;
    // Removing a dealer from its group must clear group-derived state, or the
    // dealer keeps a stale "🔒 Group" lock and a group-billed billing route that
    // points at a now-missing group (orphaning the past-due/billing lookup).
    // An explicit value for any of these in the same request still wins (the
    // dedicated blocks below run after this and only set when body provides it).
    if (body.group_id === null) {
      if (body.group_controls_templates === undefined) patch.group_controls_templates = false;
      if (body.subscription_billed_to === undefined) patch.subscription_billed_to = "dealer";
      if (body.labels_billed_to === undefined) patch.labels_billed_to = "dealer";
    }
  }
  // account_type drives the HubSpot subscription_type + lifecyclestage —
  // super_admin only. Free downgrades and Manual/Auto-Web/Auto-DMS upgrades
  // both flow through here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (body.account_type !== undefined && claims.role === "super_admin") (patch as any).account_type = body.account_type;
  // subscription_billed_to / labels_billed_to / group_controls_templates —
  // super_admin only. The first two route billing for the cascade below;
  // group_controls_templates flags whether the group owns this dealer's
  // template configuration. Defaults to true on group assignment.
  if (body.subscription_billed_to !== undefined && claims.role === "super_admin") {
    patch.subscription_billed_to = body.subscription_billed_to;
  }
  if (body.labels_billed_to !== undefined && claims.role === "super_admin") {
    patch.labels_billed_to = body.labels_billed_to;
  }
  if (body.group_controls_templates !== undefined && claims.role === "super_admin") {
    patch.group_controls_templates = body.group_controls_templates;
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
  // Snapshot the active flag + billing customer id + group_id + name +
  // account_type before update so we can detect transitions for
  // (a) Event 5 / discount sync (true→false, false→true),
  // (b) null→UUID on group_id for the super-admin group-assign cascade,
  // (c) a name change pushed to da-billing's lineItemDescriptions, and
  // (d) Phase 14 follow-up: paying→Free sets downgraded_at,
  //     Free/Trial→paying clears it, and any account_type change routes
  //     through the reliable HubSpot path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patchAny = patch as any;
  let prevActive: boolean | null = null;
  let billingCustomerId: string | null = null;
  let legacyBillingId: string | null = null;
  let dealerGroupId: string | null = null;
  let prevGroupId: string | null = null;
  let prevName: string | null = null;
  let prevAccountType: string | null = null;
  // Snapshot runs whenever active, group_id, name, OR account_type is being touched.
  if (typeof patch.active === "boolean" || patch.group_id !== undefined || typeof patch.name === "string" || patchAny.account_type !== undefined) {
    const { data: snap } = await admin
      .from("dealers")
      .select("active, billing_customer_id, internal_id, group_id, name, account_type")
      .eq("id", dealerUuid)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .maybeSingle<any>();
    prevActive = snap?.active ?? null;
    billingCustomerId = snap?.billing_customer_id ?? null;
    legacyBillingId = snap?.internal_id ?? null;
    dealerGroupId = snap?.group_id ?? null;
    prevGroupId = snap?.group_id ?? null;
    prevName = snap?.name ?? null;
    prevAccountType = snap?.account_type ?? null;
  }

  // inventory_dealer_id change must keep dealer_id in sync. Route it through the
  // shared cascade helper (atomic dealer_id rename when the two were in sync;
  // inventory-only update otherwise), then drop it from the combined patch so
  // the bulk update below doesn't re-write it / bypass the cascade.
  if (patch.inventory_dealer_id !== undefined) {
    const { data: invDealer } = await admin
      .from("dealers")
      .select("id, dealer_id, inventory_dealer_id, name")
      .eq("id", dealerUuid)
      .maybeSingle<{ id: string; dealer_id: string; inventory_dealer_id: string | null; name: string | null }>();
    if (invDealer) {
      try {
        await applyInventoryDealerIdChange(admin, invDealer, String(patch.inventory_dealer_id));
      } catch (e) {
        if (e instanceof DealerIdSyncError) {
          return NextResponse.json({ error: e.message }, { status: e.needsMigration ? 409 : 500 });
        }
        return NextResponse.json({ error: e instanceof Error ? e.message : "Update failed" }, { status: 500 });
      }
    }
    delete patch.inventory_dealer_id;
  }

  // Apply the remaining fields. When inventory_dealer_id was the only change the
  // helper already wrote it, so skip an empty update and just re-read the row —
  // downstream side-effects are gated on active/group_id/name/account_type, none
  // of which are touched here.
  const hasOtherFields = Object.keys(patch).length > 0;
  const { data, error: dbError } = hasOtherFields
    ? await admin.from("dealers").update(patch).eq("id", dealerUuid).select().single()
    : await admin.from("dealers").select().eq("id", dealerUuid).single();

  if (dbError || !data) {
    return NextResponse.json(
      { error: dbError?.message ?? "Dealer not found" },
      { status: dbError ? 500 : 404 }
    );
  }

  // ── Phase 14 follow-up Part B: downgraded_at transition ──────────────────
  //
  // Detect plan-tier transitions and stamp the lifecycle timestamp:
  //   paying → Free       → set downgraded_at = now()  (drives ACCOUNT_DOWNGRADED stage)
  //   Free/Trial → paying → clear downgraded_at        (back to Customer)
  // Other shapes (Free → Trial, Trial → Free, etc.) leave downgraded_at as-is.
  //
  // The follow-up only fires when account_type actually changed AND the
  // pre/post normalized tiers cross the paying/non-paying line. The
  // resulting subscription_type + lifecyclestage push rides the reliable
  // HubSpot path below.
  let accountTypeChanged = false;
  let lifecycleTransition: "downgrade" | "upgrade" | null = null;
  if (patchAny.account_type !== undefined && prevAccountType !== patchAny.account_type) {
    accountTypeChanged = true;
    const prevPaying = isPayingAccount(prevAccountType);
    const newNormalized = normalizeSubscriptionType(patchAny.account_type);
    const newPaying = isPayingAccount(patchAny.account_type);
    if (prevPaying && newNormalized === "Free") {
      lifecycleTransition = "downgrade";
      await admin
        .from("dealers")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ downgraded_at: new Date().toISOString() } as any)
        .eq("id", dealerUuid);
      // Gap C: write an account_closures row so the BI "cancellation reasons"
      // table isn't blank for admin-initiated churn (the dealer self-close flow
      // writes its own row; this covers the super_admin downgrade path). The
      // reason/detail come from the PATCH body when supplied, else "Not
      // specified." Non-blocking — a failure here never rolls back the downgrade.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const closureRes = await (admin as any).from("account_closures").insert({
        dealer_id: dealerUuid,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reason: (body as any).closure_reason?.trim?.() || "Admin downgrade",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        detail: (body as any).closure_detail?.trim?.() || null,
        closed_by: claims.sub,
      });
      if (closureRes.error) {
        console.error("[dealer PATCH] account_closures insert failed:", closureRes.error.message);
      }
    } else if (!prevPaying && newPaying) {
      lifecycleTransition = "upgrade";
      // Trial/Free → paying: clear downgraded_at and stamp converted_at so the
      // BI conversion funnel counts this dealer (migration 095). A re-conversion
      // within the grace window correctly re-stamps the funnel date.
      await admin
        .from("dealers")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ downgraded_at: null, converted_at: new Date().toISOString() } as any)
        .eq("id", dealerUuid);
    }
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
          { event: "billing.customer.archive", dealerId: dealerUuid, payload: { customerKey } },
        );
      } else {
        fireAndForget(
          () => unarchiveCustomer(customerKey),
          { event: "billing.customer.unarchive", dealerId: dealerUuid, payload: { customerKey } },
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
    fireSuperAdminGroupAssignCascade(dealerUuid, patch.group_id);
  }

  // Dealer name change → propagate to da-billing.
  // Dealer-name lives in two places on the billing side: the customer's
  // `company` field (used by the billing UI's dealer list) and the
  // second `::`-separated segment of every product's lineItemDescription
  // (used on the printed invoice). Subscriptions live on the dealer's
  // own template when they're standalone or on the group's template when
  // the group pays; labels follow labels_billed_to the same way. Cover
  // both: the dealer's own customer/template if any, and rewrite this
  // dealer's matching line items inside the group's template if any.
  // All non-blocking — billing failures must not roll back the rename.
  if (
    typeof patch.name === "string"
    && prevName !== null
    && patch.name.trim() !== prevName
    && billingConfigured()
  ) {
    const newName = patch.name.trim();
    const internalId = legacyBillingId;
    const ownCustomerId = billingCustomerId;
    const groupIdForBilling = dealerGroupId;

    if (ownCustomerId) {
      fireAndForget(async () => {
        await updateCustomer(ownCustomerId, { company: newName });
        const tmpl = await getTemplate(ownCustomerId);
        if (!tmpl) return;
        const rewritten = tmpl.products.map(p => {
          // Strip any stored price so the rename re-save never re-persists a
          // stale value — da-billing is the sole price authority and
          // re-canonicalizes (docs/billing-price-integrity.md).
          const { price: _drop, ...rest } = p;
          const next = rewriteLineItemDealerName(p.lineItemDescription, null, newName);
          return next == null ? rest : { ...rest, lineItemDescription: next };
        });
        await putTemplate(ownCustomerId, rewritten);
      }, { event: "billing.dealer.rename", dealerId: dealerUuid, payload: { customerId: ownCustomerId, newName } });
    }

    if (groupIdForBilling && internalId) {
      fireAndForget(async () => {
        const { data: group } = await admin
          .from("groups")
          .select("billing_customer_id")
          .eq("id", groupIdForBilling)
          .maybeSingle<{ billing_customer_id: string | null }>();
        const groupCustomerId = group?.billing_customer_id ?? null;
        if (!groupCustomerId) return;
        const tmpl = await getTemplate(groupCustomerId);
        if (!tmpl) return;
        let mutated = false;
        const rewritten = tmpl.products.map(p => {
          const { price: _drop, ...rest } = p; // strip stale price; da-billing re-canonicalizes
          const next = rewriteLineItemDealerName(p.lineItemDescription, internalId, newName);
          if (next == null) return rest;
          mutated = true;
          return { ...rest, lineItemDescription: next };
        });
        if (mutated) await putTemplate(groupCustomerId, rewritten);
      }, { event: "billing.dealer.rename.group_template", dealerId: dealerUuid, payload: { groupId: groupIdForBilling, internalId, newName } });
    }
  }

  // Phase 14 sync — push the post-edit dealer state to HubSpot Company.
  //   - Lifecycle-affecting edits (account_type change, paying↔Free
  //     transition, lifecyclestage move) go through the RELIABLE path:
  //     3× retry, Mandrill alert on terminal failure. These fields fire
  //     Alex's HubSpot workflows; a silent miss is unacceptable.
  //   - Non-lifecycle edits (address, phone, logo, etc.) stay on plain
  //     fire-and-forget — failures still land in hubspot_sync_errors
  //     for super_admin review.
  // da-billing propagation — synchronous so the operator sees the result. Only
  // on a super_admin account_type change (the single choke point both the
  // profile Subscription editor and any other account_type PATCH flow through).
  // Mutates the dealer's own template, or the group's template when group-billed;
  // Free/Trial cancels the recurring line. Never rolls back the platform change —
  // a failure/block is returned in `billing` for the UI + logged.
  let billing: SubscriptionBillingResult | undefined;
  if (accountTypeChanged && claims.role === "super_admin") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    billing = await applyDealerSubscriptionChange(dealerUuid, patchAny.account_type ?? null);
  }

  if (accountTypeChanged) {
    const ctx = lifecycleTransition === "downgrade"
      ? "dealer update (paying → Free downgrade — Downgraded workflow)"
      : lifecycleTransition === "upgrade"
        ? "dealer update (upgrade to paying plan — Customer workflow)"
        : "dealer update (plan tier change)";
    fireDealerReliable(dealerUuid, ctx);
    // Operator upgrade → notify Marketing OS so its funnel Converted stage
    // updates. resolved.dealer_id (ss_*) is the marketing_leads.da_dealer_id
    // join key. Only on the upgrade transition; fire-and-forget.
    if (lifecycleTransition === "upgrade") {
      fireConversionWebhook({
        dealerId: resolved.dealer_id,
        convertedAt: new Date().toISOString(),
        plan: typeof body.account_type === "string" ? body.account_type : undefined,
      });
    }
  } else {
    fireDealerSync(dealerUuid);
  }

  return NextResponse.json({ data: data as DealerRow, billing });
}

/**
 * Rewrite the dealer-name segment of a da-billing lineItemDescription.
 *
 * Format is `{internal_id}::{DEALER_NAME}` for subscriptions and
 * `{internal_id}::{DEALER_NAME}::{sku}` for labels. We replace the second
 * segment only, preserving the rest verbatim.
 *
 * - `expectedInternalId == null` → rewrite every well-formed entry (used
 *   for the dealer's own template, where every line belongs to them).
 * - `expectedInternalId != null` → only rewrite lines whose first segment
 *   matches (used for the group's template, which carries lines for many
 *   member dealers).
 *
 * Returns the new description, or null if the entry should be left alone
 * (malformed, doesn't match the expected internal id, or already equal).
 */
function rewriteLineItemDealerName(
  desc: string | undefined,
  expectedInternalId: string | null,
  newName: string,
): string | null {
  if (!desc) return null;
  const parts = desc.split("::");
  if (parts.length < 2) return null;
  if (expectedInternalId !== null && parts[0] !== expectedInternalId) return null;
  if (parts[1] === newName) return null;
  parts[1] = newName;
  return parts.join("::");
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
