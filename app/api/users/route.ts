import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";

/**
 * GET /api/users — super_admin only.
 * Returns paginated profiles with dealer_name + group_name resolved.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const { searchParams } = new URL(req.url);
  const page  = Math.max(1, parseInt(searchParams.get("page")  ?? "1",  10));
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));
  const search     = searchParams.get("search")?.trim() ?? "";
  const roleFilter = searchParams.get("role")?.trim()   ?? "";

  const admin = createAdminSupabaseClient();
  const from = (page - 1) * limit;
  const to   = from + limit - 1;

  let q = admin
    .from("profiles")
    .select(
      "id, email, full_name, role, dealer_id, group_id, active, force_password_reset, last_login, created_at",
      { count: "exact" }
    )
    .order("full_name", { ascending: true, nullsFirst: false })
    .range(from, to);

  if (search)     q = q.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
  if (roleFilter) q = q.eq("role", roleFilter as UserRole);

  const { data: profiles, count, error: dbErr } = await q;
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  const rows = profiles ?? [];

  const dealerIds = Array.from(new Set(rows.filter(p => p.dealer_id).map(p => p.dealer_id as string)));
  const groupIds  = Array.from(new Set(rows.filter(p => p.group_id).map(p => p.group_id  as string)));

  const [dealerRes, groupRes] = await Promise.all([
    dealerIds.length > 0
      ? admin.from("dealers").select("dealer_id, name").in("dealer_id", dealerIds)
      : Promise.resolve({ data: [] as { dealer_id: string; name: string }[] }),
    groupIds.length > 0
      ? admin.from("groups").select("id, name").in("id", groupIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);

  const dealerMap = new Map((dealerRes.data ?? []).map(d => [d.dealer_id, d.name]));
  const groupMap  = new Map((groupRes.data  ?? []).map(g => [g.id,        g.name]));

  const users = rows.map(p => ({
    ...p,
    dealer_name: p.dealer_id ? (dealerMap.get(p.dealer_id) ?? null) : null,
    group_name:  p.group_id  ? (groupMap.get(p.group_id)   ?? null) : null,
  }));

  return NextResponse.json({ users, total: count ?? 0 });
}

/**
 * POST /api/users — super_admin only.
 * Creates a new auth user + profile.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: {
    email?: string;
    full_name?: string;
    role?: UserRole;
    dealer_id?: string | null;
    group_id?: string | null;
    password?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { email, full_name, role, dealer_id, group_id, password } = body;
  if (!email?.trim())    return NextResponse.json({ error: "Email is required"     }, { status: 400 });
  if (!full_name?.trim()) return NextResponse.json({ error: "Full name is required" }, { status: 400 });
  if (!password)         return NextResponse.json({ error: "Password is required"  }, { status: 400 });

  const admin = createAdminSupabaseClient();

  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email: email.trim(),
    password,
    email_confirm: true,
    user_metadata:  { full_name: full_name.trim() },
    app_metadata:   { role: role ?? "dealer_admin" },
  });

  if (authErr) return NextResponse.json({ error: authErr.message }, { status: 400 });

  // Upsert so this works whether the DB trigger fired first or not
  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .upsert({
      id:        authData.user.id,
      email:     email.trim(),
      full_name: full_name.trim(),
      role:      role ?? "dealer_admin",
      dealer_id: dealer_id ?? null,
      group_id:  group_id  ?? null,
    }, { onConflict: "id" })
    .select()
    .single();

  if (profileErr) {
    void admin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: profileErr.message }, { status: 500 });
  }

  return NextResponse.json({ user: profile }, { status: 201 });
}
