import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole, Database } from "@/lib/db";

type Params = { params: { id: string } };
type UserUpdate = Database["public"]["Tables"]["users"]["Update"];

/**
 * PATCH /api/users/[id]
 * Edit a user's name, email, or user_type.
 * Only the owning dealer can edit their own sub-users.
 */
export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
  const admin = createAdminSupabaseClient();

  // Verify the target user belongs to this dealer
  const { data: existing, error: fetchError } = await admin
    .from("users")
    .select("id, dealer_id")
    .eq("id", params.id)
    .eq("dealer_id", dealerId)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  let body: { name?: string; email?: string; user_type?: UserRole };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const profileUpdate: UserUpdate = {};
  if (body.name) profileUpdate.name = body.name;
  if (body.email) profileUpdate.email = body.email;
  if (body.user_type) profileUpdate.user_type = body.user_type;

  if (Object.keys(profileUpdate).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const { data: updated, error: updateError } = await admin
    .from("users")
    .update(profileUpdate)
    .eq("id", params.id)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Sync email/app_metadata changes to auth.users
  const authUpdate: { email?: string; app_metadata?: Record<string, string> } = {};
  if (body.email) authUpdate.email = body.email;
  if (body.user_type) {
    authUpdate.app_metadata = { user_type: body.user_type, dealer_id: dealerId };
  }

  if (Object.keys(authUpdate).length > 0) {
    await admin.auth.admin.updateUserById(params.id, authUpdate);
  }

  return NextResponse.json({ user: updated });
}

/**
 * DELETE /api/users/[id]
 * Delete a sub-user (own dealer only).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
  const admin = createAdminSupabaseClient();

  const { data: existing, error: fetchError } = await admin
    .from("users")
    .select("id, dealer_id")
    .eq("id", params.id)
    .eq("dealer_id", dealerId)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { error: deleteError } = await admin
    .from("users")
    .delete()
    .eq("id", params.id);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  await admin.auth.admin.deleteUser(params.id);

  return NextResponse.json({ success: true });
}
