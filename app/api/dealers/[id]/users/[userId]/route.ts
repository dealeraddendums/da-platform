import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole, ProfileRow } from "@/lib/db";

type Params = { params: { id: string; userId: string } };

const DEALER_ROLES = new Set<UserRole>(["dealer_admin", "dealer_user", "dealer_restricted"]);

/**
 * PATCH /api/dealers/[id]/users/[userId]
 * Update a dealer-side user's name, role, or active flag.
 *
 * Auth:
 *   - super_admin: any dealer
 *   - dealer_admin: their own dealer only, cannot promote anyone to
 *     dealer_admin (mirrors the invite restriction)
 *   - everyone else: 403 (group_admin is view-only on this list)
 */
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin" && claims.role !== "dealer_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { full_name?: string; role?: string; active?: boolean };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const patch: Partial<Pick<ProfileRow, "full_name" | "active" | "role" | "updated_at">> = {
    updated_at: new Date().toISOString(),
  };
  if (body.full_name !== undefined) patch.full_name = body.full_name?.trim() || null;
  if (body.active !== undefined) patch.active = body.active;
  if (body.role !== undefined) {
    if (!DEALER_ROLES.has(body.role as UserRole)) {
      return NextResponse.json({ error: "Role must be dealer_admin, dealer_user, or dealer_restricted" }, { status: 400 });
    }
    if (claims.role === "dealer_admin" && body.role === "dealer_admin") {
      return NextResponse.json({ error: "Only super_admin can promote to dealer_admin" }, { status: 403 });
    }
    patch.role = body.role as UserRole;
  }

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id")
    .eq("id", params.id)
    .maybeSingle<{ id: string; dealer_id: string }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  if (claims.role === "dealer_admin" && dealer.dealer_id !== claims.dealer_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("id, dealer_id")
    .eq("id", params.userId)
    .maybeSingle<{ id: string; dealer_id: string | null }>();
  if (!profile || profile.dealer_id !== dealer.dealer_id) {
    return NextResponse.json({ error: "User not found on this dealer" }, { status: 404 });
  }

  const { data, error: dbError } = await admin
    .from("profiles")
    .update(patch)
    .eq("id", params.userId)
    .select("id, email, full_name, role, active, last_login, created_at")
    .single();
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });

  return NextResponse.json({ data });
}

/**
 * DELETE /api/dealers/[id]/users/[userId]
 * Hard-delete a dealer-side user. Super admin only — matches the
 * spec ("Edit / Impersonate / Delete actions super_admin only").
 */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (claims.sub === params.userId) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id")
    .eq("id", params.id)
    .maybeSingle<{ id: string; dealer_id: string }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  const { data: profile } = await admin
    .from("profiles")
    .select("id, dealer_id")
    .eq("id", params.userId)
    .maybeSingle<{ id: string; dealer_id: string | null }>();
  if (!profile || profile.dealer_id !== dealer.dealer_id) {
    return NextResponse.json({ error: "User not found on this dealer" }, { status: 404 });
  }

  const { error: authErr } = await admin.auth.admin.deleteUser(params.userId);
  if (authErr) return NextResponse.json({ error: authErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
