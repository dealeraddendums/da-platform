import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { GroupRow, GroupUpdate } from "@/lib/db";

type SortableCol = "name" | "active" | "account_type" | "dealer_count" | "created_at" | "billing_contact";
const DB_SORT_COLS = new Set<SortableCol>(["name", "active", "account_type", "billing_contact", "created_at"]);
const DB_SORT_COL_MAP: Partial<Record<SortableCol, string>> = { created_at: "legacy_id" };

/**
 * GET /api/groups
 * Paginated group list. super_admin only.
 * Query params: q, page, per_page, sort, sort_dir, legacy_id_gte
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { searchParams } = req.nextUrl;
  const q = searchParams.get("q") ?? "";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get("per_page") ?? "25", 10)));
  const from = (page - 1) * perPage;
  const sortCol = (searchParams.get("sort") ?? "created_at") as SortableCol;
  const sortDir = searchParams.get("sort_dir") === "asc" ? true : false;
  const legacyIdGte = searchParams.get("legacy_id_gte");

  let query = admin.from("groups").select("*", { count: "exact" });
  if (q) query = query.or(`name.ilike.%${q}%,billing_contact.ilike.%${q}%,primary_contact.ilike.%${q}%`);
  if (legacyIdGte) query = query.gte("legacy_id", parseInt(legacyIdGte, 10));

  const dbSortCol = DB_SORT_COLS.has(sortCol)
    ? (DB_SORT_COL_MAP[sortCol] ?? sortCol)
    : "legacy_id";
  query = query.order(dbSortCol, { ascending: sortDir, nullsFirst: false }).range(from, from + perPage - 1);

  const { data, error: dbError, count } = await query;
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });

  // Count dealers per group
  const groupIds = (data ?? []).map((g: Record<string, unknown>) => g.id as string);
  const dealerCounts: Record<string, number> = {};
  if (groupIds.length > 0) {
    const { data: dealerRows } = await admin
      .from("dealers")
      .select("group_id")
      .in("group_id", groupIds);
    for (const r of dealerRows ?? []) {
      if (r.group_id) dealerCounts[r.group_id] = (dealerCounts[r.group_id] ?? 0) + 1;
    }
  }

  let enriched = (data ?? []).map((g: Record<string, unknown>) => ({
    ...g,
    dealer_count: dealerCounts[g.id as string] ?? 0,
  }));

  if (sortCol === "dealer_count") {
    enriched = enriched.sort((a, b) =>
      sortDir ? a.dealer_count - b.dealer_count : b.dealer_count - a.dealer_count
    );
  }

  return NextResponse.json({ data: enriched, total: count ?? 0, page, per_page: perPage });
}

/**
 * POST /api/groups
 * Create a new group. super_admin only.
 * Optional: username + password to create a group_admin auth user.
 * Optional: sendNotify=true for placeholder welcome email.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: {
    name?: string;
    internal_id?: string;
    username?: string;
    password?: string;
    sendNotify?: boolean;
  } & GroupUpdate;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { name, internal_id, username, password, sendNotify, ...rest } = body;
  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const groupInternalId = internal_id?.trim() || Date.now().toString();

  const admin = createAdminSupabaseClient();
  const insertPayload = { name: name.trim(), internal_id: groupInternalId, ...rest };
  let { data, error: dbError } = await admin.from("groups").insert(insertPayload).select().single();

  // If new columns don't exist yet (migration pending), retry with only base columns
  if (dbError && (dbError.message.includes("account_type") || dbError.message.includes("billing_contact") || dbError.message.includes("billing_email") || dbError.message.includes("billing_phone"))) {
    const { account_type: _a, billing_contact: _b, billing_email: _c, billing_phone: _d, ...basePayload } = insertPayload as typeof insertPayload & { account_type?: string; billing_contact?: string; billing_email?: string; billing_phone?: string };
    ({ data, error: dbError } = await admin.from("groups").insert(basePayload).select().single());
  }

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  const group = data as GroupRow;

  // Optionally create a group_admin auth user
  if (username?.trim() && password?.trim()) {
    const rawUsername = username.trim();
    const authEmail = rawUsername.includes("@") ? rawUsername : `${rawUsername}@dealeraddendums.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email: authEmail,
      password: password.trim(),
      email_confirm: true,
      user_metadata: { full_name: (rest.primary_contact as string | undefined) ?? "" },
      app_metadata: { role: "group_admin" },
    });

    if (authError) {
      return NextResponse.json(
        { data: group, warning: `Group created but user account failed: ${authError.message}` },
        { status: 201 }
      );
    }

    await admin.from("profiles").upsert({
      id: authUser.user.id,
      email: authEmail,
      full_name: (rest.primary_contact as string | undefined) ?? null,
      role: "group_admin" as const,
      group_id: group.id,
    });
  }

  return NextResponse.json(
    { data: group, emailSent: sendNotify ? true : false },
    { status: 201 }
  );
}
