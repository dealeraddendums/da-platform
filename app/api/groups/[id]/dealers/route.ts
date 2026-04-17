import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerRow } from "@/lib/db";

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
  const { data, error: dbError } = await admin
    .from("dealers")
    .update({ group_id: params.id })
    .eq("id", body.dealer_id)
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
 * DELETE /api/groups/[id]/dealers
 * Remove a dealer from this group (set group_id = null). super_admin only.
 * Body: { dealer_id: string }  (the dealers.id UUID)
 */
export async function DELETE(
  req: NextRequest,
  { params: _ }: Params
): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

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
  const { data, error: dbError } = await admin
    .from("dealers")
    .update({ group_id: null })
    .eq("id", body.dealer_id)
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
