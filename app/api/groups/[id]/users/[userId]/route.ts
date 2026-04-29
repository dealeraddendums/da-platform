import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole, ProfileRow } from "@/lib/db";

type Params = { params: { id: string; userId: string } };

const GROUP_ROLES = new Set<UserRole>(["group_admin", "group_user"]);

/**
 * PATCH /api/groups/[id]/users/[userId]
 * Update a group user's name, role, or active status.
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
  if (claims.role === "group_admin" && params.id !== claims.group_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { full_name?: string; role?: string; active?: boolean };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Partial<Pick<ProfileRow, "full_name" | "active" | "role" | "updated_at">> = { updated_at: new Date().toISOString() };
  if (body.full_name !== undefined) patch.full_name = body.full_name?.trim() || null;
  if (body.active !== undefined) patch.active = body.active;
  if (body.role !== undefined) {
    if (!GROUP_ROLES.has(body.role as UserRole)) {
      return NextResponse.json({ error: "Role must be group_admin or group_user" }, { status: 400 });
    }
    patch.role = body.role as UserRole;
  }

  const admin = createAdminSupabaseClient();

  // Verify user belongs to this group
  const { data: profile } = await admin
    .from("profiles")
    .select("id, group_id, role")
    .eq("id", params.userId)
    .maybeSingle<{ id: string; group_id: string | null; role: string }>();

  if (!profile || profile.group_id !== params.id) {
    return NextResponse.json({ error: "User not found in this group" }, { status: 404 });
  }

  const { data, error: dbError } = await admin
    .from("profiles")
    .update(patch)
    .eq("id", params.userId)
    .select("id, email, full_name, role, active, last_login, created_at")
    .single();

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

/**
 * DELETE /api/groups/[id]/users/[userId]
 * Deactivate (soft-delete) a group user. Cannot delete yourself.
 */
export async function DELETE(
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
  if (claims.sub === params.userId) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Verify user belongs to this group
  const { data: profile } = await admin
    .from("profiles")
    .select("id, group_id")
    .eq("id", params.userId)
    .maybeSingle<{ id: string; group_id: string | null }>();

  if (!profile || profile.group_id !== params.id) {
    return NextResponse.json({ error: "User not found in this group" }, { status: 404 });
  }

  // Hard delete auth user (cascades to profile via trigger)
  const { error: authErr } = await admin.auth.admin.deleteUser(params.userId);
  if (authErr) {
    return NextResponse.json({ error: authErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
