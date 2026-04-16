import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole, Database } from "@/lib/db";

type Params = { params: { id: string } };
type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];

/**
 * GET /api/admin/users/[id]
 * Fetch a single user profile by id (super_admin only).
 */
export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { data, error: dbError } = await admin
    .from("profiles")
    .select("id, dealer_id, role, email, full_name, created_at")
    .eq("id", params.id)
    .single();

  if (dbError || !data) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({ user: data });
}

/**
 * PATCH /api/admin/users/[id]
 * Edit any user on the platform (super_admin only).
 */
export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: {
    full_name?: string;
    email?: string;
    role?: UserRole;
    dealer_id?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const profileUpdate: ProfileUpdate = {};
  if (body.full_name) profileUpdate.full_name = body.full_name;
  if (body.email) profileUpdate.email = body.email;
  if (body.role) profileUpdate.role = body.role;
  if (body.dealer_id) profileUpdate.dealer_id = body.dealer_id;

  if (Object.keys(profileUpdate).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  const { data: updated, error: updateError } = await admin
    .from("profiles")
    .update(profileUpdate)
    .eq("id", params.id)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Sync to auth.users
  const authUpdate: {
    email?: string;
    app_metadata?: Record<string, string>;
  } = {};
  if (body.email) authUpdate.email = body.email;
  if (body.role || body.dealer_id) {
    authUpdate.app_metadata = {
      ...(body.role ? { role: body.role } : {}),
      ...(body.dealer_id ? { dealer_id: body.dealer_id } : {}),
    };
  }

  if (Object.keys(authUpdate).length > 0) {
    await admin.auth.admin.updateUserById(params.id, authUpdate);
  }

  return NextResponse.json({ user: updated });
}
