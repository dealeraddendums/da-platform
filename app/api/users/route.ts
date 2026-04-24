import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

const DEALER_ROLES: UserRole[] = ["dealer_admin", "dealer_user", "dealer_restricted"];

/**
 * GET /api/users
 * super_admin: all users, paginated, with HubSpot enrichment.
 * dealer_admin: only users belonging to their own dealer_id.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { role, dealer_id } = claims;
  if (role !== "super_admin" && role !== "dealer_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const page       = Math.max(1, parseInt(searchParams.get("page")  ?? "1",  10));
  const limit      = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));
  const search     = searchParams.get("search")?.trim() ?? "";
  const roleFilter = searchParams.get("role")?.trim()   ?? "";
  const from       = (page - 1) * limit;
  const to         = from + limit - 1;

  const admin = createAdminSupabaseClient();

  // ── dealer_admin: scoped query ───────────────────────────────────────────────
  if (role === "dealer_admin") {
    if (!dealer_id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    let q = admin
      .from("profiles")
      .select("id, email, full_name, role, dealer_id, active, force_password_reset, last_login, created_at", { count: "exact" })
      .eq("dealer_id", dealer_id)
      .in("role", DEALER_ROLES)
      .order("full_name", { ascending: true, nullsFirst: false })
      .range(from, to);

    if (search)     q = q.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
    if (roleFilter && DEALER_ROLES.includes(roleFilter as UserRole)) {
      q = q.eq("role", roleFilter as UserRole);
    }

    const { data: profiles, count, error: dbErr } = await q;
    if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

    const rows = profiles ?? [];
    const userIds = rows.map(r => r.id);

    type AuthUserRow = { id: string; last_sign_in_at: string | null };
    const authUsersRes = userIds.length > 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? await ((admin as any).schema("auth").from("users").select("id, last_sign_in_at").in("id", userIds) as Promise<{ data: AuthUserRow[] | null }>)
      : { data: [] as AuthUserRow[] };

    const lastSignInMap = new Map((authUsersRes.data ?? []).map(u => [u.id, u.last_sign_in_at]));

    const users = rows.map(p => ({
      ...p,
      group_id:           null,
      dealer_name:        null,
      group_name:         null,
      last_sign_in_at:    lastSignInMap.get(p.id) ?? null,
      hubspot_contact_id: null,
    }));

    return NextResponse.json({ users, total: count ?? 0 });
  }

  // ── super_admin: full query ──────────────────────────────────────────────────
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

  const userIds   = rows.map(r => r.id);
  const dealerIds = Array.from(new Set(rows.filter(p => p.dealer_id).map(p => p.dealer_id as string)));
  const groupIds  = Array.from(new Set(rows.filter(p => p.group_id).map(p => p.group_id  as string)));

  type AuthUserRow = { id: string; last_sign_in_at: string | null };
  const authUsersQuery = userIds.length > 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (admin as any).schema("auth").from("users").select("id, last_sign_in_at").in("id", userIds) as Promise<{ data: AuthUserRow[] | null }>
    : Promise.resolve({ data: [] as AuthUserRow[] });

  const emails = rows.map(p => p.email).filter((e): e is string => !!e);
  async function getHubspotContactIds(): Promise<Map<string, number>> {
    if (emails.length === 0) return new Map();
    try {
      const placeholders = emails.map(() => "?").join(",");
      const [hsRows] = await getPool().execute<RowDataPacket[]>(
        `SELECT EMAIL, HUBSPOT_CONTACT_ID FROM users WHERE EMAIL IN (${placeholders}) AND HUBSPOT_CONTACT_ID IS NOT NULL`,
        emails
      );
      return new Map(
        (hsRows as RowDataPacket[])
          .filter(r => r.EMAIL && r.HUBSPOT_CONTACT_ID)
          .map(r => [String(r.EMAIL).toLowerCase(), r.HUBSPOT_CONTACT_ID as number])
      );
    } catch {
      return new Map();
    }
  }

  const [dealerRes, groupRes, authUsersRes, hubspotContactMap] = await Promise.all([
    dealerIds.length > 0
      ? admin.from("dealers").select("dealer_id, name").in("dealer_id", dealerIds)
      : Promise.resolve({ data: [] as { dealer_id: string; name: string }[] }),
    groupIds.length > 0
      ? admin.from("groups").select("id, name").in("id", groupIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    authUsersQuery,
    getHubspotContactIds(),
  ]);

  const dealerMap     = new Map((dealerRes.data     ?? []).map(d => [d.dealer_id, d.name]));
  const groupMap      = new Map((groupRes.data      ?? []).map(g => [g.id,        g.name]));
  const lastSignInMap = new Map((authUsersRes.data   ?? []).map(u => [u.id,        u.last_sign_in_at]));

  const users = rows.map(p => ({
    ...p,
    dealer_name:        p.dealer_id ? (dealerMap.get(p.dealer_id) ?? null) : null,
    group_name:         p.group_id  ? (groupMap.get(p.group_id)   ?? null) : null,
    last_sign_in_at:    lastSignInMap.get(p.id) ?? null,
    hubspot_contact_id: hubspotContactMap.get(p.email?.toLowerCase() ?? "") ?? null,
  }));

  return NextResponse.json({ users, total: count ?? 0 });
}

/**
 * POST /api/users
 * super_admin: create any user with any role/dealer/group.
 * dealer_admin: create dealer_admin/dealer_user/dealer_restricted for their own dealer only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { role, dealer_id: callerDealerId } = claims;
  if (role !== "super_admin" && role !== "dealer_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  const { email, full_name, password } = body;
  if (!email?.trim())     return NextResponse.json({ error: "Email is required"     }, { status: 400 });
  if (!full_name?.trim()) return NextResponse.json({ error: "Full name is required" }, { status: 400 });
  if (!password)          return NextResponse.json({ error: "Password is required"  }, { status: 400 });

  let targetRole: UserRole;
  let targetDealerId: string | null;
  let targetGroupId: string | null;

  if (role === "dealer_admin") {
    if (!callerDealerId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (!body.role || !DEALER_ROLES.includes(body.role)) {
      return NextResponse.json({ error: "Invalid role for dealer admin" }, { status: 400 });
    }
    targetRole     = body.role;
    targetDealerId = callerDealerId;
    targetGroupId  = null;
  } else {
    targetRole     = body.role ?? "dealer_admin";
    targetDealerId = body.dealer_id ?? null;
    targetGroupId  = body.group_id  ?? null;
  }

  const admin = createAdminSupabaseClient();

  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email: email.trim(),
    password,
    email_confirm: true,
    user_metadata: { full_name: full_name.trim() },
    app_metadata:  { role: targetRole },
  });

  if (authErr) return NextResponse.json({ error: authErr.message }, { status: 400 });

  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .upsert({
      id:        authData.user.id,
      email:     email.trim(),
      full_name: full_name.trim(),
      role:      targetRole,
      dealer_id: targetDealerId,
      group_id:  targetGroupId,
    }, { onConflict: "id" })
    .select()
    .single();

  if (profileErr) {
    void admin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: profileErr.message }, { status: 500 });
  }

  return NextResponse.json({ user: profile }, { status: 201 });
}
