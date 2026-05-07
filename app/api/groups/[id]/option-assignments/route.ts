import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerOptionAssignmentRow, GroupOptionRow } from "@/lib/db";

type Params = { params: { id: string } };

/**
 * GET /api/groups/[id]/option-assignments
 * List all option assignments for this group.
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
    .from("dealer_option_assignments")
    .select("*")
    .eq("group_id", params.id)
    .order("assigned_at", { ascending: false });

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ data: (data as DealerOptionAssignmentRow[]) ?? [] });
}

/**
 * POST /api/groups/[id]/option-assignments
 * Assign a suggested group option to one or more dealers.
 * Body: { option_id: string, dealer_ids: string[], dealer_editable: boolean }
 *
 * If dealer_editable=true: copies to dealer's addendum library (can edit/remove).
 * If dealer_editable=false: locked — treated like a corporate option for that dealer.
 */
export async function POST(
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

  let body: { option_id?: string; dealer_ids?: string[]; dealer_editable?: boolean };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { option_id, dealer_ids, dealer_editable = true } = body;
  if (!option_id) return NextResponse.json({ error: "option_id required" }, { status: 400 });
  if (!dealer_ids?.length) return NextResponse.json({ error: "dealer_ids required" }, { status: 400 });

  const admin = createAdminSupabaseClient();

  // Verify option belongs to this group and is suggested
  const { data: opt } = await admin
    .from("group_options")
    .select("*")
    .eq("id", option_id)
    .eq("group_id", params.id)
    .eq("is_suggested", true)
    .maybeSingle<GroupOptionRow>();

  if (!opt) {
    return NextResponse.json({ error: "Suggested option not found in this group" }, { status: 404 });
  }

  const rows = dealer_ids.map((dealer_id) => ({
    dealer_id,
    option_id,
    group_id: params.id,
    dealer_editable,
    assigned_by: claims.sub,
  }));

  const { error: upsertErr } = await admin
    .from("dealer_option_assignments")
    .upsert(rows, { onConflict: "dealer_id,option_id" });

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  // If dealer_editable=true, copy to dealer's addendum library
  if (dealer_editable) {
    const copies = dealer_ids.map((dealer_id) => ({
      dealer_id,
      option_name: opt.option_name,
      item_price: opt.option_price,
      description: "",
      ad_type: "Both",
      ad_types: null,
      makes: "",
      makes_not: false,
      models: "",
      models_not: false,
      trims: "",
      trims_not: false,
      body_styles: "",
      year_condition: 0,
      year_value: null,
      miles_condition: 0,
      miles_value: null,
      msrp_condition: 0,
      msrp1: null,
      msrp2: null,
      applies_to: "all" as const,
      sort_order: 9999,
      active: true,
      required: true,
      show_models_only: false,
      separator_above: false,
      separator_below: false,
      spaces: 0,
    }));

    await admin.from("addendum_library").insert(copies);
  }

  return NextResponse.json({ ok: true, assigned: dealer_ids.length });
}

/**
 * DELETE /api/groups/[id]/option-assignments
 * Remove an option assignment.
 * Body: { option_id: string, dealer_id: string }
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

  let body: { option_id?: string; dealer_id?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.option_id || !body.dealer_id) {
    return NextResponse.json({ error: "option_id and dealer_id required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { error: dbError } = await admin
    .from("dealer_option_assignments")
    .delete()
    .eq("option_id", body.option_id)
    .eq("dealer_id", body.dealer_id)
    .eq("group_id", params.id);

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
