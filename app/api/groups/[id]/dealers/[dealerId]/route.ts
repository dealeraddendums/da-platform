import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerRow } from "@/lib/db";
import { fireGroupAssignCascade, fireGroupUnassignCascade } from "@/lib/group-billing-cascade";

type Params = { params: { id: string; dealerId: string } };

/**
 * PATCH /api/groups/[id]/dealers/[dealerId]
 * Body: {
 *   group_controls_templates?: boolean;
 *   subscription_billed_to?: "dealer" | "group";
 *   labels_billed_to?: "dealer" | "group";
 * }
 *
 * Per-dealer flag toggles. `dealerId` is the dealers.id UUID. The dealer
 * must already belong to this group (params.id) — we don't accept
 * group-reassignment through this route. super_admin can touch any
 * group; group_admin only their own. Flipping subscription_billed_to
 * fires the Event 3/4 billing cascade.
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
  if (claims.role === "group_admin" && params.id !== claims.group_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    group_controls_templates?: boolean;
    subscription_billed_to?: "dealer" | "group";
    labels_billed_to?: "dealer" | "group";
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: Partial<Pick<DealerRow, "group_controls_templates" | "subscription_billed_to" | "labels_billed_to">> = {};
  if (typeof body.group_controls_templates === "boolean") {
    patch.group_controls_templates = body.group_controls_templates;
  }
  if (body.subscription_billed_to === "dealer" || body.subscription_billed_to === "group") {
    patch.subscription_billed_to = body.subscription_billed_to;
  }
  if (body.labels_billed_to === "dealer" || body.labels_billed_to === "group") {
    patch.labels_billed_to = body.labels_billed_to;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No patchable fields supplied" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Verify dealer belongs to this group and snapshot prior flags for
  // cascade detection.
  const { data: check } = await admin
    .from("dealers")
    .select("id, group_id, subscription_billed_to")
    .eq("id", params.dealerId)
    .maybeSingle<{ id: string; group_id: string | null; subscription_billed_to: "dealer" | "group" }>();
  if (!check || check.group_id !== params.id) {
    return NextResponse.json({ error: "Dealer not in this group" }, { status: 404 });
  }
  const prevSubBilledTo = check.subscription_billed_to;

  const { data, error: dbError } = await admin
    .from("dealers")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update(patch as any)
    .eq("id", params.dealerId)
    .select()
    .single();

  if (dbError || !data) {
    return NextResponse.json(
      { error: dbError?.message ?? "Update failed" },
      { status: dbError ? 500 : 404 }
    );
  }

  // Cascade subscription billing on transitions. Going dealer→group adds a
  // line to the group's template and zeros the dealer's. group→dealer
  // removes the cascadeFromDealer line from the group's template.
  if (patch.subscription_billed_to && patch.subscription_billed_to !== prevSubBilledTo) {
    if (patch.subscription_billed_to === "group") {
      fireGroupAssignCascade(params.dealerId, params.id);
    } else {
      fireGroupUnassignCascade(params.dealerId, params.id);
    }
  }

  return NextResponse.json({ data: data as DealerRow });
}
