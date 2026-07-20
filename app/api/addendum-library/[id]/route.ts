import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { AddendumLibraryRow } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";

type Params = { params: { id: string } };

/**
 * PATCH /api/addendum-library/[id]
 * Updates an option in the library.
 */
export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: Partial<AddendumLibraryRow>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Verify ownership
  const { data: existing } = await admin
    .from("addendum_library")
    .select("dealer_id")
    .eq("id", params.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Authorize against the row's OWN dealer (not the caller's claims.dealer_id):
  // dealer roles → own dealer; group_admin → any in-group dealer; group_user →
  // in-group + tag scope; super_admin → any. This is what lets a group_admin
  // operating a member dealer edit its products (parity model), which the old
  // string-equality-to-claims.dealer_id check blocked when the active-dealer
  // context wasn't reflected in claims.dealer_id.
  const authz = await authorizeDealerAction(claims, existing.dealer_id);
  if (!authz.ok) return authz.response;

  // Whitelist updatable fields
  type LibraryPatch = Omit<Partial<AddendumLibraryRow>, 'id' | 'dealer_id' | 'created_at' | 'updated_at'>;
  const patch: LibraryPatch = {};
  if (body.option_name !== undefined) patch.option_name = body.option_name;
  if (body.item_price !== undefined) patch.item_price = body.item_price;
  if (body.description !== undefined) patch.description = body.description;
  if (body.ad_type !== undefined) patch.ad_type = body.ad_type;
  if (body.ad_types !== undefined) patch.ad_types = body.ad_types;
  if (body.makes !== undefined) patch.makes = body.makes;
  if (body.makes_not !== undefined) patch.makes_not = body.makes_not;
  if (body.models !== undefined) patch.models = body.models;
  if (body.models_not !== undefined) patch.models_not = body.models_not;
  if (body.trims !== undefined) patch.trims = body.trims;
  if (body.trims_not !== undefined) patch.trims_not = body.trims_not;
  if (body.body_styles !== undefined) patch.body_styles = body.body_styles;
  if (body.fuel !== undefined) patch.fuel = body.fuel;
  if (body.fuel_not !== undefined) patch.fuel_not = body.fuel_not;
  if (body.year_condition !== undefined) patch.year_condition = body.year_condition;
  if (body.year_value !== undefined) patch.year_value = body.year_value;
  if (body.miles_condition !== undefined) patch.miles_condition = body.miles_condition;
  if (body.miles_value !== undefined) patch.miles_value = body.miles_value;
  if (body.msrp_condition !== undefined) patch.msrp_condition = body.msrp_condition;
  if (body.msrp1 !== undefined) patch.msrp1 = body.msrp1;
  if (body.msrp2 !== undefined) patch.msrp2 = body.msrp2;
  if (body.sort_order !== undefined) patch.sort_order = body.sort_order;
  if (body.active !== undefined) patch.active = body.active;
  if (body.show_models_only !== undefined) patch.show_models_only = body.show_models_only;
  if (body.separator_above !== undefined) patch.separator_above = body.separator_above;
  if (body.separator_below !== undefined) patch.separator_below = body.separator_below;
  if (body.spaces !== undefined) patch.spaces = body.spaces;
  if (body.applies_to !== undefined) patch.applies_to = body.applies_to;
  if (body.required !== undefined) patch.required = body.required;

  const { data, error: dbError } = await admin
    .from("addendum_library")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();

  if (dbError || !data) {
    return NextResponse.json(
      { error: dbError?.message ?? "Update failed" },
      { status: dbError ? 500 : 404 }
    );
  }

  return NextResponse.json({ data: data as AddendumLibraryRow });
}

/**
 * DELETE /api/addendum-library/[id]
 */
export async function DELETE(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { data: existing } = await admin
    .from("addendum_library")
    .select("dealer_id")
    .eq("id", params.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Authorize against the row's own dealer (see PATCH above).
  const authz = await authorizeDealerAction(claims, existing.dealer_id);
  if (!authz.ok) return authz.response;

  const { error: dbError } = await admin
    .from("addendum_library")
    .delete()
    .eq("id", params.id);

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
