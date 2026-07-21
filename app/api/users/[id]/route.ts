import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import type { UserRole, ProfileRow } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import type { JwtClaims } from "@/lib/auth";

type ProfilePatch = Partial<Pick<ProfileRow, "full_name" | "email" | "role" | "dealer_id" | "group_id" | "active">>;

type Params = { params: { id: string } };

const DEALER_ROLES: UserRole[] = ["dealer_admin", "dealer_user", "dealer_restricted"];

type TargetUser = { dealer_id: string | null; group_id: string | null; role: string; email: string };

/**
 * Authorize a write against a target user, by the SAME canonical rule the rest
 * of the platform uses (docs/group-admin-dealer-parity.md):
 *   - super_admin                → any user
 *   - dealer_admin               → users on their own dealer
 *   - group_admin                → users on an in-group dealer, OR a group-level
 *                                  user (no dealer_id) of their own group
 *   - group_user (regional mgr)  → users on an in-group dealer within tag scope
 *
 * Previously PATCH/DELETE only branched super_admin/dealer_admin, so ANY
 * group-context operator managing a member dealer's users 403'd — the same
 * authorization hole fixed for addendum-library writes (2277b77). (This is how a
 * super_admin reaching a member-dealer Users tab through the group flow hit the
 * "Forbidden" on delete.)
 */
async function authorizeUserTarget(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  claims: JwtClaims,
  targetId: string,
): Promise<{ ok: true; target: TargetUser } | { ok: false; response: NextResponse }> {
  const { data: target } = await admin
    .from("profiles")
    .select("dealer_id, group_id, role, email")
    .eq("id", targetId)
    .maybeSingle<TargetUser>();
  if (!target) return { ok: false, response: NextResponse.json({ error: "User not found" }, { status: 404 }) };

  if (claims.role === "super_admin") return { ok: true, target };

  // Dealer-level target → canonical dealer authorization (own / in-group / tag).
  if (target.dealer_id) {
    const authz = await authorizeDealerAction(claims, target.dealer_id);
    if (!authz.ok) return { ok: false, response: authz.response };
    return { ok: true, target };
  }

  // Group-level target (no dealer_id): only a group_admin of the SAME group may
  // manage them (group_user has dealer-parity only, not group management).
  if (target.group_id && claims.role === "group_admin" && claims.group_id === target.group_id) {
    return { ok: true, target };
  }

  return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
}

/**
 * PATCH /api/users/[id]
 * super_admin: update any field on any user.
 * dealer_admin / group_user: users in scope; role stays dealer-only; no dealer/group move.
 * group_admin: users in their group; may set any non-super_admin role.
 */
export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { id } = params;

  const authz = await authorizeUserTarget(admin, claims, id);
  if (!authz.ok) return authz.response;

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

  if (body.password !== undefined && (typeof body.password !== "string" || body.password.length < 8)) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }

  // Role/scope restrictions for non-super_admin callers.
  const role = claims.role;
  if (role !== "super_admin") {
    // No one below super_admin can mint a super_admin.
    if (body.role === "super_admin") {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    if (role === "dealer_admin" || role === "group_user") {
      // Dealer-parity callers: cannot move a user between dealers/groups, and
      // may only assign dealer-level roles.
      delete body.dealer_id;
      delete body.group_id;
      if (body.role !== undefined && !DEALER_ROLES.includes(body.role)) {
        return NextResponse.json({ error: "Invalid role" }, { status: 400 });
      }
    }
    // group_admin: may set any non-super_admin role and move users within their
    // own group; authorizeUserTarget already confirmed the target is in-group.
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
 * super_admin: any user; dealer_admin/group_user: in scope; group_admin: in group.
 * Deletes the auth user (profile cascades via FK) and revokes any pending
 * invitations for that email so it can be re-used immediately.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { id } = params;
  if (claims.sub === id) {
    return NextResponse.json({ error: "You cannot delete your own account." }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  const authz = await authorizeUserTarget(admin, claims, id);
  if (!authz.ok) return authz.response;
  const targetEmail = authz.target.email;

  // Delete the auth user — profiles.id REFERENCES auth.users(id) ON DELETE
  // CASCADE, so the profile row goes with it. If the auth user is somehow
  // missing (shouldn't happen given the FK), fall back to deleting the profile.
  const { error: deleteErr } = await admin.auth.admin.deleteUser(id);
  if (deleteErr) {
    const { error: profileDelErr } = await admin.from("profiles").delete().eq("id", id);
    if (profileDelErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 });
  }

  // Revoke any pending invitations for this email so the address frees up
  // immediately (legacy 4.0 allowed the same email at many dealers; a stale
  // invite would otherwise block re-inviting the address).
  if (targetEmail) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: invErr } = await (admin as any).from("invitations").delete().eq("email", targetEmail);
    if (invErr) console.error("[users.delete] invitation cleanup failed:", invErr.message);
  }

  fireWrite(admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "delete_user",
    target_dealer_id: authz.target.dealer_id,
    metadata: { deleted_user_id: id, email: targetEmail, role: authz.target.role, by_role: claims.role },
  }), "admin_audit");

  return NextResponse.json({ success: true });
}
