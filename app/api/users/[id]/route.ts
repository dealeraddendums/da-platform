import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole, ProfileRow } from "@/lib/db";

type ProfilePatch = Partial<Pick<ProfileRow, "full_name" | "email" | "role" | "dealer_id" | "group_id" | "active">>;

type Params = { params: { id: string } };

const DEALER_ROLES: UserRole[] = ["dealer_admin", "dealer_user", "dealer_restricted"];

/**
 * PATCH /api/users/[id]
 * super_admin: update any field on any user.
 * dealer_admin: update users within their own dealer; cannot change dealer_id/group_id; role must be dealer-only.
 */
export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { role, dealer_id: callerDealerId } = claims;
  if (role !== "super_admin" && role !== "dealer_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  // dealer_admin: verify target user is in their dealer
  if (role === "dealer_admin") {
    if (!callerDealerId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { data: target } = await admin
      .from("profiles")
      .select("dealer_id, role")
      .eq("id", id)
      .single<{ dealer_id: string | null; role: string }>();

    if (!target || target.dealer_id !== callerDealerId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Cannot change dealer_id or group_id
    delete body.dealer_id;
    delete body.group_id;

    // Role must stay within dealer roles
    if (body.role !== undefined && !DEALER_ROLES.includes(body.role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
  }

  const profilePatch: ProfilePatch = {};
  if (body.full_name  !== undefined) profilePatch.full_name  = body.full_name;
  if (body.email      !== undefined) profilePatch.email      = body.email;
  if (body.role       !== undefined) profilePatch.role       = body.role;
  if (body.dealer_id  !== undefined) profilePatch.dealer_id  = body.dealer_id;
  if (body.group_id   !== undefined) profilePatch.group_id   = body.group_id;
  if (body.active     !== undefined) profilePatch.active     = body.active;

  if (Object.keys(profilePatch).length > 0) {
    const { error: updateErr } = await admin
      .from("profiles")
      .update(profilePatch)
      .eq("id", id);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  const authPatch: Record<string, unknown> = {};
  if (body.email)    authPatch.email        = body.email;
  if (body.password) authPatch.password     = body.password;
  if (body.role)     authPatch.app_metadata = { role: body.role };

  if (Object.keys(authPatch).length > 0) {
    const { error: authErr } = await admin.auth.admin.updateUserById(id, authPatch);
    if (authErr) return NextResponse.json({ error: authErr.message }, { status: 500 });
  }

  const { data: updated } = await admin.from("profiles").select("*").eq("id", id).single();
  return NextResponse.json({ user: updated });
}

/**
 * DELETE /api/users/[id]
 * super_admin: delete any user (except self).
 * dealer_admin: delete users within their own dealer (except self).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { role, dealer_id: callerDealerId, sub } = claims;
  if (role !== "super_admin" && role !== "dealer_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = params;

  if (sub === id) {
    return NextResponse.json({ error: "You cannot delete your own account." }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  if (role === "dealer_admin") {
    if (!callerDealerId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { data: target } = await admin
      .from("profiles")
      .select("dealer_id")
      .eq("id", id)
      .single<{ dealer_id: string | null }>();

    if (!target || target.dealer_id !== callerDealerId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const { error: deleteErr } = await admin.auth.admin.deleteUser(id);
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
