import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
// requireSuperAdmin is used only for POST (assign dealer)
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerRow } from "@/lib/db";
import { fireGroupAssignCascade, fireGroupUnassignCascade } from "@/lib/group-billing-cascade";
import { fireGroupDiscountSync } from "@/lib/sync-group-discount";

type Params = { params: { id: string } };

/**
 * GET /api/groups/[id]/dealers
 * Returns all dealers belonging to this group.
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

  if (claims.role === "group_admin" && params.id !== claims.group_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbError } = await admin
    .from("dealers")
    .select("*")
    .eq("group_id", params.id)
    .order("name");

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ data: (data as DealerRow[]) ?? [] });
}

/**
 * POST /api/groups/[id]/dealers
 * Assign a dealer to this group by dealer UUID. super_admin only.
 * Body: { dealer_id: string }  (the dealers.id UUID, not the text dealer_id)
 */
export async function POST(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: {
    dealer_id?: string;
    subscription_billed_to?: "dealer" | "group";
    labels_billed_to?: "dealer" | "group";
    group_controls_templates?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.dealer_id) {
    return NextResponse.json({ error: "dealer_id is required" }, { status: 400 });
  }

  // Defaults when a dealer is added to a group via the "+ Add Dealer"
  // flow on the group detail page or the DA Group dropdown on the
  // dealer profile page. Both default to group-billed + group-controls-
  // templates ON; the caller can override via the request body.
  const subscription_billed_to: "dealer" | "group" = body.subscription_billed_to ?? "group";
  const labels_billed_to:       "dealer" | "group" = body.labels_billed_to       ?? "group";
  const group_controls_templates: boolean          = body.group_controls_templates ?? true;

  const admin = createAdminSupabaseClient();
  const { data, error: dbError } = await admin
    .from("dealers")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({
      group_id: params.id,
      subscription_billed_to,
      labels_billed_to,
      group_controls_templates,
    } as any)
    .eq("id", body.dealer_id)
    .select()
    .single();

  if (dbError || !data) {
    return NextResponse.json(
      { error: dbError?.message ?? "Dealer not found" },
      { status: dbError ? 500 : 404 }
    );
  }

  // Event 3: cascade billing config to the group if the dealer is flagged
  // subscription_billed_to='group'. Fire-and-forget; failures land in
  // billing_sync_errors for super_admin review.
  fireGroupAssignCascade(body.dealer_id, params.id);

  // Group active-dealer count just changed — recompute the
  // subscriptionDiscount tier (0 / 10 / 20 / 30%) and PUT to da-billing
  // unless the customer is discountLocked. Fire-and-forget.
  fireGroupDiscountSync(params.id);

  return NextResponse.json({ data: data as DealerRow });
}

/**
 * DELETE /api/groups/[id]/dealers
 * Remove a dealer from this group (set group_id = null).
 * super_admin: any group. group_admin: own group only.
 * Body: { dealer_id: string }  (the dealers.id UUID)
 */
export async function DELETE(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (claims.role === "group_admin" && params.id !== claims.group_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { dealer_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.dealer_id) {
    return NextResponse.json({ error: "dealer_id is required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Verify dealer belongs to this group before removing
  const { data: check } = await admin
    .from("dealers")
    .select("id, group_id")
    .eq("id", body.dealer_id)
    .maybeSingle<{ id: string; group_id: string | null }>();

  if (!check || check.group_id !== params.id) {
    return NextResponse.json({ error: "Dealer not found in this group" }, { status: 404 });
  }

  const { data, error: dbError } = await admin
    .from("dealers")
    // Reset group-derived flags to defaults on the way out so the dealer
    // doesn't keep a stale "🔒 Group" lock (group_controls_templates is only
    // meaningful with a group_id) or a group-billed route pointing at a group
    // it no longer belongs to. Re-assigning to a different group starts clean.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ group_id: null, subscription_billed_to: "dealer", labels_billed_to: "dealer", group_controls_templates: false } as any)
    .eq("id", body.dealer_id)
    .select()
    .single();

  if (dbError || !data) {
    return NextResponse.json(
      { error: dbError?.message ?? "Dealer not found" },
      { status: dbError ? 500 : 404 }
    );
  }

  // Event 4: remove any cascadeFromDealer:<uuid> line items from the
  // group's template. Fire-and-forget.
  fireGroupUnassignCascade(body.dealer_id, params.id);

  // Active member-dealer count shrank — sync subscriptionDiscount tier.
  fireGroupDiscountSync(params.id);

  return NextResponse.json({ data: data as DealerRow });
}
