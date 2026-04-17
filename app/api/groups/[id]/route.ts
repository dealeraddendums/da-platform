import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { GroupRow, GroupUpdate } from "@/lib/db";

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

  const admin = createAdminSupabaseClient();
  const { data, error: dbError } = await admin
    .from("groups")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();

  if (dbError || !data) {
    return NextResponse.json(
      { error: dbError?.message ?? "Group not found" },
      { status: dbError ? 500 : 404 }
    );
  }

  return NextResponse.json({ data: data as GroupRow });
}

/**
 * DELETE /api/groups/[id]
 * Permanently delete a group. super_admin only.
 * Dealers in this group will have their group_id set to null (ON DELETE SET NULL).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { error: dbError } = await admin
    .from("groups")
    .delete()
    .eq("id", params.id);

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
