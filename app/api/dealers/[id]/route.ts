import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerRow, DealerUpdate } from "@/lib/db";

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

  if (claims.role === "dealer_user" || claims.role === "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: DealerUpdate;
  try {
    body = (await req.json()) as DealerUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

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
  if (body.group_id !== undefined && claims.role === "super_admin") patch.group_id = body.group_id;
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
  // inventory_dealer_id: super_admin only (updated when feed goes live). internal_id is never updated.
  if (body.inventory_dealer_id !== undefined && claims.role === "super_admin") {
    patch.inventory_dealer_id = body.inventory_dealer_id;
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

  return NextResponse.json({ data: data as DealerRow });
}

/**
 * DELETE /api/dealers/[id]
 * Permanently delete a dealer. super_admin only.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { error: dbError } = await admin
    .from("dealers")
    .delete()
    .eq("id", params.id);

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
