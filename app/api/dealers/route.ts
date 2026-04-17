import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerRow, DealerUpdate } from "@/lib/db";

/**
 * GET /api/dealers
 * Paginated dealer list. super_admin only.
 * Query params: q, active (true|false), page, per_page
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { searchParams } = req.nextUrl;
  const q = searchParams.get("q") ?? "";
  const active = searchParams.get("active");
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get("per_page") ?? "25", 10)));
  const from = (page - 1) * perPage;

  let query = admin.from("dealers").select("*", { count: "exact" });

  if (q) {
    query = query.or(
      `name.ilike.%${q}%,dealer_id.ilike.%${q}%,city.ilike.%${q}%,primary_contact.ilike.%${q}%`
    );
  }
  if (active === "true") query = query.eq("active", true);
  else if (active === "false") query = query.eq("active", false);

  const { data, error: dbError, count } = await query
    .order("name", { ascending: true })
    .range(from, from + perPage - 1);

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({
    data: (data as DealerRow[]) ?? [],
    total: count ?? 0,
    page,
    per_page: perPage,
  });
}

/**
 * POST /api/dealers
 * Create a new dealer. super_admin only.
 * Optional: username + password to create a dealer_admin auth user.
 * Optional: sendNotify=true for placeholder welcome email.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: {
    dealer_id?: string;
    name?: string;
    username?: string;
    password?: string;
    sendNotify?: boolean;
  } & DealerUpdate;

  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { dealer_id, name, username, password, sendNotify, ...rest } = body;
  if (!dealer_id || !name) {
    return NextResponse.json(
      { error: "dealer_id and name are required" },
      { status: 400 }
    );
  }

  // internal_id = never-changing billing ID, set once at creation
  // inventory_dealer_id = supplier-assigned ID, starts equal to dealer_id then replaced when feed goes live
  const internalId = Date.now().toString();

  const admin = createAdminSupabaseClient();
  const { data, error: dbError } = await admin
    .from("dealers")
    .insert({
      dealer_id,
      name,
      internal_id: internalId,
      inventory_dealer_id: dealer_id,
      ...rest,
    })
    .select()
    .single();

  if (dbError) {
    if (dbError.code === "23505") {
      return NextResponse.json({ error: "Dealer ID already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  // Optionally create a dealer_admin auth user
  if (username?.trim() && password?.trim()) {
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email: username.trim(),
      password: password.trim(),
      email_confirm: true,
      user_metadata: { full_name: (rest.primary_contact as string | undefined) ?? "" },
      app_metadata: { role: "dealer_admin" },
    });

    if (authError) {
      // Dealer was created — return it with a warning about user creation failure
      return NextResponse.json(
        { data, warning: `Dealer created but user account failed: ${authError.message}` },
        { status: 201 }
      );
    }

    await admin.from("profiles").upsert({
      id: authUser.user.id,
      email: username.trim(),
      full_name: (rest.primary_contact as string | undefined) ?? null,
      role: "dealer_admin" as const,
      dealer_id,
    });
  }

  return NextResponse.json(
    { data, emailSent: sendNotify ? true : false },
    { status: 201 }
  );
}
