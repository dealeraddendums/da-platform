import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerUpdate } from "@/lib/db";

// Strip HTML tags from dealer names imported from Aurora
function sanitizeName(name: string | null | undefined): string {
  if (!name) return "";
  return name.replace(/<[^>]*>/g, "").trim();
}

async function getPrintCounts(admin: ReturnType<typeof createAdminSupabaseClient>, dealerIds: string[]) {
  if (dealerIds.length === 0) return { lifetime: {} as Record<string, number>, recent: {} as Record<string, number> };
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [lifetimeRes, recentRes] = await Promise.all([
    admin.from("print_history").select("dealer_id").in("dealer_id", dealerIds).limit(50000),
    admin.from("print_history").select("dealer_id").in("dealer_id", dealerIds).gte("created_at", thirtyDaysAgo).limit(10000),
  ]);
  const lifetime: Record<string, number> = {};
  const recent: Record<string, number> = {};
  for (const r of lifetimeRes.data ?? []) lifetime[r.dealer_id] = (lifetime[r.dealer_id] ?? 0) + 1;
  for (const r of recentRes.data ?? []) recent[r.dealer_id] = (recent[r.dealer_id] ?? 0) + 1;
  return { lifetime, recent };
}

type SortableCol = "name" | "active" | "account_type" | "created_at" | "lifetime_prints" | "last_30_prints" | "group_name";
// Use legacy_id for "created" sort — it's the Aurora _ID (sequential int) and more reliable than created_at
const DB_SORT_COLS = new Set<SortableCol>(["name", "active", "account_type", "created_at"]);
const DB_SORT_COL_MAP: Partial<Record<SortableCol, string>> = { created_at: "legacy_id" };

/**
 * GET /api/dealers
 * Paginated dealer list. super_admin only.
 * Query params: q, active (true|false), at_risk (true), page, per_page, sort, sort_dir
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { searchParams } = req.nextUrl;
  const q = searchParams.get("q") ?? "";
  const active = searchParams.get("active");
  const atRisk = searchParams.get("at_risk") === "true";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get("per_page") ?? "25", 10)));
  const from = (page - 1) * perPage;

  const sortCol = (searchParams.get("sort") ?? "created_at") as SortableCol;
  const sortDir = searchParams.get("sort_dir") === "asc" ? true : false; // ascending = true
  const legacyIdGte = searchParams.get("legacy_id_gte");

  if (atRisk) {
    let allQuery = admin.from("dealers").select("*, groups(name)").eq("active", true).limit(2500);
    if (q) allQuery = allQuery.or(`name.ilike.%${q}%,dealer_id.ilike.%${q}%`);
    if (legacyIdGte) allQuery = allQuery.gte("legacy_id", parseInt(legacyIdGte, 10));
    const { data: allDealers, error: allErr } = await allQuery;
    if (allErr) return NextResponse.json({ error: allErr.message }, { status: 500 });

    const dealerIds = (allDealers ?? []).map((d: Record<string, unknown>) => d.dealer_id as string);
    const { lifetime, recent } = await getPrintCounts(admin, dealerIds);

    const atRiskList = (allDealers ?? [])
      .map((d: Record<string, unknown>) => ({
        ...d,
        name: sanitizeName(d.name as string),
        group_name: (d.groups as { name: string } | null)?.name ?? null,
        lifetime_prints: lifetime[d.dealer_id as string] ?? 0,
        last_30_prints: recent[d.dealer_id as string] ?? 0,
      }))
      .filter((d) => d.lifetime_prints >= 50 && d.last_30_prints === 0)
      .sort((a, b) => b.lifetime_prints - a.lifetime_prints);

    return NextResponse.json({ data: atRiskList.slice(from, from + perPage), total: atRiskList.length, page, per_page: perPage });
  }

  // Build main query — DB sort for indexed columns only
  let query = admin.from("dealers").select("*, groups(name)", { count: "exact" });
  if (q) query = query.or(`name.ilike.%${q}%,dealer_id.ilike.%${q}%,city.ilike.%${q}%,primary_contact.ilike.%${q}%`);
  if (active === "true") query = query.eq("active", true);
  else if (active === "false") query = query.eq("active", false);
  if (legacyIdGte) query = query.gte("legacy_id", parseInt(legacyIdGte, 10));

  // Apply DB-level ordering; "created_at" sorts by legacy_id (Aurora _ID, sequential)
  const dbSortCol = DB_SORT_COLS.has(sortCol)
    ? (DB_SORT_COL_MAP[sortCol] ?? sortCol)
    : "legacy_id";
  query = query.order(dbSortCol, { ascending: sortDir, nullsFirst: false }).range(from, from + perPage - 1);

  const { data, error: dbError, count } = await query;
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });

  const dealerIds = (data ?? []).map((d: Record<string, unknown>) => d.dealer_id as string);
  const { lifetime, recent } = await getPrintCounts(admin, dealerIds);

  let enriched = (data ?? []).map((d: Record<string, unknown>) => ({
    ...d,
    name: sanitizeName(d.name as string),
    group_name: (d.groups as { name: string } | null)?.name ?? null,
    lifetime_prints: lifetime[d.dealer_id as string] ?? 0,
    last_30_prints: recent[d.dealer_id as string] ?? 0,
  }));

  // In-memory sort for computed/joined columns
  if (sortCol === "lifetime_prints") {
    enriched = enriched.sort((a, b) => sortDir ? a.lifetime_prints - b.lifetime_prints : b.lifetime_prints - a.lifetime_prints);
  } else if (sortCol === "last_30_prints") {
    enriched = enriched.sort((a, b) => sortDir ? a.last_30_prints - b.last_30_prints : b.last_30_prints - a.last_30_prints);
  } else if (sortCol === "group_name") {
    enriched = enriched.sort((a, b) => {
      const ga = a.group_name ?? "";
      const gb = b.group_name ?? "";
      return sortDir ? ga.localeCompare(gb) : gb.localeCompare(ga);
    });
  }

  return NextResponse.json({ data: enriched, total: count ?? 0, page, per_page: perPage });
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
    return NextResponse.json({ error: "dealer_id and name are required" }, { status: 400 });
  }

  const internalId = Date.now().toString();
  const admin = createAdminSupabaseClient();
  const insertPayload = { dealer_id, name, internal_id: internalId, inventory_dealer_id: dealer_id, ...rest };
  let { data, error: dbError } = await admin.from("dealers").insert(insertPayload).select().single();

  if (dbError && dbError.message.includes("account_type")) {
    const { account_type: _drop, ...payloadWithoutAccountType } = insertPayload as typeof insertPayload & { account_type?: string };
    ({ data, error: dbError } = await admin.from("dealers").insert(payloadWithoutAccountType).select().single());
  }

  if (dbError) {
    if (dbError.code === "23505") return NextResponse.json({ error: "Dealer ID already exists" }, { status: 409 });
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  if (username?.trim() && password?.trim()) {
    const rawUsername = username.trim();
    const authEmail = rawUsername.includes("@") ? rawUsername : `${rawUsername}@dealeraddendums.com`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email: authEmail,
      password: password.trim(),
      email_confirm: true,
      user_metadata: { full_name: (rest.primary_contact as string | undefined) ?? "" },
      app_metadata: { role: "dealer_admin" },
    });

    if (authError) {
      return NextResponse.json({ data, warning: `Dealer created but user account failed: ${authError.message}` }, { status: 201 });
    }

    await admin.from("profiles").upsert({
      id: authUser.user.id,
      email: authEmail,
      full_name: (rest.primary_contact as string | undefined) ?? null,
      role: "dealer_admin" as const,
      dealer_id,
    });
  }

  return NextResponse.json({ data, emailSent: sendNotify ? true : false }, { status: 201 });
}
