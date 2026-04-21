import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createServerSupabaseClient, createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";

/**
 * GET /api/users
 * super_admin: all users with pagination/search/role filter.
 * dealer_admin: own dealer's users only.
 * Params: page, limit, search, role
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));
  const search = searchParams.get("search")?.trim() ?? "";
  const roleFilter = searchParams.get("role")?.trim() ?? "";

  const admin = createAdminSupabaseClient();
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = admin
    .from("profiles")
    .select(
      "id, email, full_name, role, dealer_id, phone, active, force_password_reset, last_login, created_at",
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(from, to);

  // Scope by dealer for non-super_admin
  if (claims.role !== "super_admin") {
    if (!claims.dealer_id) return NextResponse.json({ users: [], total: 0, role: claims.role });
    query = query.eq("dealer_id", claims.dealer_id);
  }

  if (search) {
    query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
  }

  if (roleFilter) {
    query = query.eq("role", roleFilter as UserRole);
  }

  const { data, error: dbError, count } = await query;

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ users: data ?? [], total: count ?? 0, role: claims.role });
}

/**
 * POST /api/users
 * Create a sub-user for the authenticated dealer.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: { email?: string; full_name?: string; role?: UserRole };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { email, full_name, role } = body;
  if (!email || !full_name) {
    return NextResponse.json(
      { error: "email and full_name are required" },
      { status: 400 }
    );
  }

  const dealerId = claims.dealer_id;

  const admin = createAdminSupabaseClient();

  const { data: authData, error: authError } = await admin.auth.admin.createUser(
    {
      email,
      email_confirm: true,
      app_metadata: {
        role: role ?? "dealer_user",
        dealer_id: dealerId,
      },
    }
  );

  if (authError) {
    return NextResponse.json({ error: authError.message }, { status: 400 });
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .insert({
      id: authData.user.id,
      dealer_id: dealerId,
      role: role ?? "dealer_user",
      email,
      full_name,
    })
    .select()
    .single();

  if (profileError) {
    await admin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({ user: profile }, { status: 201 });
}
