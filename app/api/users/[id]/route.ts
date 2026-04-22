import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole, ProfileRow } from "@/lib/db";

type ProfilePatch = Partial<Pick<ProfileRow, "full_name" | "email" | "role" | "dealer_id" | "group_id" | "active">>;

type Params = { params: { id: string } };

/**
 * PATCH /api/users/[id] — super_admin only.
 * Updates profile fields; optionally resets password.
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
    dealer_id?: string | null;
    group_id?: string | null;
    active?: boolean;
    password?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { id } = params;

  // Build profile patch — only include keys that were explicitly sent
  const profilePatch: ProfilePatch = {};
  if (body.full_name !== undefined) profilePatch.full_name = body.full_name;
  if (body.email     !== undefined) profilePatch.email     = body.email;
  if (body.role      !== undefined) profilePatch.role      = body.role;
  if (body.dealer_id !== undefined) profilePatch.dealer_id = body.dealer_id;
  if (body.group_id  !== undefined) profilePatch.group_id  = body.group_id;
  if (body.active    !== undefined) profilePatch.active    = body.active;

  if (Object.keys(profilePatch).length > 0) {
    const { error: updateErr } = await admin
      .from("profiles")
      .update(profilePatch)
      .eq("id", id);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Sync to auth.users if needed
  const authPatch: Record<string, unknown> = {};
  if (body.email)    authPatch.email    = body.email;
  if (body.password) authPatch.password = body.password;
  if (body.role)     authPatch.app_metadata = { role: body.role };

  if (Object.keys(authPatch).length > 0) {
    const { error: authErr } = await admin.auth.admin.updateUserById(id, authPatch);
    if (authErr) return NextResponse.json({ error: authErr.message }, { status: 500 });
  }

  const { data: updated } = await admin.from("profiles").select("*").eq("id", id).single();
  return NextResponse.json({ user: updated });
}

/**
 * DELETE /api/users/[id] — super_admin only. Cannot self-delete.
 * Deleting the auth user cascades to the profile row.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  const { id } = params;

  if (claims.sub === id) {
    return NextResponse.json(
      { error: "You cannot delete your own account." },
      { status: 400 }
    );
  }

  const admin = createAdminSupabaseClient();
  const { error: deleteErr } = await admin.auth.admin.deleteUser(id);
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
