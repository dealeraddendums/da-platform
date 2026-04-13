import { NextRequest, NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole, Database } from "@/lib/db";

type Params = { params: { id: string } };
type UserUpdate = Database["public"]["Tables"]["users"]["Update"];

/**
 * GET /api/admin/users/[id]
 * Fetch a single user by id (root_admin only).
 */
export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { error } = await requireRootAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { data, error: dbError } = await admin
    .from("users")
    .select("id, dealer_id, user_type, email, name, created_at")
    .eq("id", params.id)
    .single();

  if (dbError || !data) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({ user: data });
}

/**
 * PATCH /api/admin/users/[id]
 * Edit any user on the platform (root_admin only).
 */
export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { error } = await requireRootAdmin();
  if (error) return error;

  let body: {
    name?: string;
    email?: string;
    user_type?: UserRole;
    dealer_id?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const profileUpdate: UserUpdate = {};
  if (body.name) profileUpdate.name = body.name;
  if (body.email) profileUpdate.email = body.email;
  if (body.user_type) profileUpdate.user_type = body.user_type;
  if (body.dealer_id) profileUpdate.dealer_id = body.dealer_id;

  if (Object.keys(profileUpdate).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  const { data: updated, error: updateError } = await admin
    .from("users")
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
  if (body.user_type || body.dealer_id) {
    authUpdate.app_metadata = {
      ...(body.user_type ? { user_type: body.user_type } : {}),
      ...(body.dealer_id ? { dealer_id: body.dealer_id } : {}),
    };
  }

  if (Object.keys(authUpdate).length > 0) {
    await admin.auth.admin.updateUserById(params.id, authUpdate);
  }

  return NextResponse.json({ user: updated });
}
