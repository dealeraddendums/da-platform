import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { vehicleId: string; optionId: string } };

/**
 * PATCH /api/options/[vehicleId]/[optionId]
 * Updates a single option (name, price, active).
 *
 * DELETE /api/options/[vehicleId]/[optionId]
 * Removes a single option.
 */

export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  // Fetch row to verify dealer scope
  const { data: row } = await admin
    .from("vehicle_options")
    .select("dealer_id")
    .eq("id", params.optionId)
    .single();

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (
    (claims.role === "dealer_admin" || claims.role === "dealer_user") &&
    claims.dealer_id !== row.dealer_id
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { option_name?: string; option_price?: string; active?: boolean };
  const update: { option_name?: string; option_price?: string; active?: boolean } = {};
  if (body.option_name !== undefined) update.option_name = body.option_name.trim();
  if (body.option_price !== undefined) update.option_price = body.option_price.trim();
  if (body.active !== undefined) update.active = body.active;

  const { data, error: err } = await admin
    .from("vehicle_options")
    .update(update)
    .eq("id", params.optionId)
    .select("*")
    .single();

  if (err) return NextResponse.json({ error: err.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function DELETE(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { data: row } = await admin
    .from("vehicle_options")
    .select("dealer_id")
    .eq("id", params.optionId)
    .single();

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (
    (claims.role === "dealer_admin" || claims.role === "dealer_user") &&
    claims.dealer_id !== row.dealer_id
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { error: err } = await admin
    .from("vehicle_options")
    .delete()
    .eq("id", params.optionId);

  if (err) return NextResponse.json({ error: err.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
