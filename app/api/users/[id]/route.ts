import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole, Database } from "@/lib/db";

type Params = { params: { id: string } };
type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];

/**
 * PATCH /api/users/[id]
 * Edit a sub-user's profile. Only the owning dealer can edit their users.
 */
export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const dealerId = claims.dealer_id;
  const admin = createAdminSupabaseClient();

  const { data: existing, error: fetchError } = await admin
    .from("profiles")
    .select("id, dealer_id")
    .eq("id", params.id)
    .eq("dealer_id", dealerId ?? "")
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  let body: { full_name?: string; email?: string; role?: UserRole };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const profileUpdate: ProfileUpdate = {};
  if (body.full_name) profileUpdate.full_name = body.full_name;
  if (body.email) profileUpdate.email = body.email;
  if (body.role) profileUpdate.role = body.role;

  if (Object.keys(profileUpdate).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const { data: updated, error: updateError } = await admin
    .from("profiles")
    .update(profileUpdate)
    .eq("id", params.id)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const authUpdate: { email?: string; app_metadata?: Record<string, string> } = {};
  if (body.email) authUpdate.email = body.email;
  if (body.role) {
    authUpdate.app_metadata = {
      role: body.role,
      ...(dealerId ? { dealer_id: dealerId } : {}),
    };
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

  const dealerId = claims.dealer_id;
  const admin = createAdminSupabaseClient();

  const { data: existing, error: fetchError } = await admin
    .from("profiles")
    .select("id, dealer_id")
    .eq("id", params.id)
    .eq("dealer_id", dealerId ?? "")
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { error: deleteError } = await admin
    .from("profiles")
    .delete()
    .eq("id", params.id);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  await admin.auth.admin.deleteUser(params.id);

  return NextResponse.json({ success: true });
}
