import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerUpdate } from "@/lib/db";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

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

async function getHubspotCompanyIds(inventoryIds: (string | null | undefined)[]): Promise<Record<string, number>> {
  const ids = inventoryIds.filter((v): v is string => !!v);
  if (ids.length === 0) return {};
  try {
    const placeholders = ids.map(() => "?").join(",");
    const [rows] = await getPool().execute<RowDataPacket[]>(
      `SELECT DEALER_ID, HUBSPOT_COMPANY_ID FROM dealer_dim WHERE DEALER_ID IN (${placeholders}) AND HUBSPOT_COMPANY_ID IS NOT NULL`,
      ids
    );
    const map: Record<string, number> = {};
    for (const row of rows) {
      if (row.DEALER_ID && row.HUBSPOT_COMPANY_ID) map[row.DEALER_ID as string] = row.HUBSPOT_COMPANY_ID as number;
    }
    return map;
  } catch {
    return {};
  }
}

// Geocode a dealer address via Mapbox and write lat/lng back to the dealers table.
// Fire-and-forget: errors are logged but do NOT fail dealer creation.
async function geocodeDealer(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealer: { id: string; lat: unknown; lng: unknown },
  fields: Record<string, unknown>
) {
  if (dealer.lat != null && dealer.lng != null) return; // already geocoded
  const address = [fields.address, fields.city, fields.state, fields.zip].filter(Boolean).join(", ");
  if (!address) return;

  const token = process.env.MAPBOX_PUBLIC_TOKEN;
  if (!token || token === "pk.your_token_here") return;

  try {
    const encoded = encodeURIComponent(address);
    const res = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${token}&country=US&limit=1`
    );
    if (!res.ok) return;
    const json = await res.json() as {
      features?: Array<{ center: [number, number] }>;
    };
    const coords = json.features?.[0]?.center;
    if (!coords) return;
    const [lng, lat] = coords;
    await admin.from("dealers").update({ lat: String(lat), lng: String(lng) }).eq("id", dealer.id);
  } catch (err) {
    console.error("[dealers/geocode]", err instanceof Error ? err.message : err);
  }
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
  const { claims, error } = await requireAuth();
  if (error) return error;

  // group_admin: return their group's dealers (no Aurora enrichment needed)
  if (claims.role === "group_admin") {
    if (!claims.group_id) return NextResponse.json({ data: [], total: 0 });
    const admin = createAdminSupabaseClient();
    const { searchParams } = req.nextUrl;
    const q = searchParams.get("q") ?? "";
    const activeFilter = searchParams.get("active");
    let query = admin
      .from("dealers")
      .select("id, dealer_id, name, active, city, state, phone, primary_contact, primary_contact_email, account_type, group_id, internal_id", { count: "exact" })
      .eq("group_id", claims.group_id)
      .order("name");
    if (q) query = query.or(`name.ilike.%${q}%`);
    if (activeFilter === "true")  query = query.eq("active", true);
    if (activeFilter === "false") query = query.eq("active", false);
    const { data, count } = await query;
    return NextResponse.json({
      data: (data ?? []).map(d => ({ ...d, lifetime_prints: 0, last_30_prints: 0, hubspot_company_id: null, group_name: null })),
      total: count ?? 0, page: 1, per_page: count ?? 0,
    });
  }

  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
    const inventoryIds = (allDealers ?? []).map((d: Record<string, unknown>) => d.inventory_dealer_id as string | null);
    const [{ lifetime, recent }, hubspotMap, atRiskProfileRows] = await Promise.all([
      getPrintCounts(admin, dealerIds),
      getHubspotCompanyIds(inventoryIds),
      admin
        .from("profiles")
        .select("dealer_id")
        .in("dealer_id", dealerIds)
        .in("role", ["dealer_admin", "dealer_user", "dealer_restricted"])
        .then(({ data: rows }) => rows ?? []),
    ]);
    const atRiskDealersWithUsers = new Set((atRiskProfileRows as { dealer_id: string }[]).map((p) => p.dealer_id));

    const atRiskList = (allDealers ?? [])
      .map((d: Record<string, unknown>) => ({
        ...d,
        name: sanitizeName(d.name as string),
        group_name: (d.groups as { name: string } | null)?.name ?? null,
        lifetime_prints: lifetime[d.dealer_id as string] ?? 0,
        last_30_prints: recent[d.dealer_id as string] ?? 0,
        hubspot_company_id: hubspotMap[d.inventory_dealer_id as string] ?? null,
        has_users: atRiskDealersWithUsers.has(d.dealer_id as string),
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
  const inventoryIds = (data ?? []).map((d: Record<string, unknown>) => d.inventory_dealer_id as string | null);
  const [{ lifetime, recent }, hubspotMap, profileRows] = await Promise.all([
    getPrintCounts(admin, dealerIds),
    getHubspotCompanyIds(inventoryIds),
    admin
      .from("profiles")
      .select("dealer_id")
      .in("dealer_id", dealerIds)
      .in("role", ["dealer_admin", "dealer_user", "dealer_restricted"])
      .then(({ data: rows }) => rows ?? []),
  ]);
  const dealersWithUsers = new Set((profileRows as { dealer_id: string }[]).map((p) => p.dealer_id));

  let enriched = (data ?? []).map((d: Record<string, unknown>) => ({
    ...d,
    name: sanitizeName(d.name as string),
    group_name: (d.groups as { name: string } | null)?.name ?? null,
    lifetime_prints: lifetime[d.dealer_id as string] ?? 0,
    last_30_prints: recent[d.dealer_id as string] ?? 0,
    hubspot_company_id: hubspotMap[d.inventory_dealer_id as string] ?? null,
    has_users: dealersWithUsers.has(d.dealer_id as string),
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
 * Create a new dealer. super_admin or group_admin.
 * group_admin: auto-generates dealer_id, auto-sets group_id.
 * super_admin: optional username + password to create a dealer_admin auth user.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  const { name, username, password, sendNotify, ...rest } = body;
  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const internalId = Date.now().toString();
  // group_admin: auto-generate dealer_id and force their group_id
  const dealer_id = claims.role === "group_admin"
    ? `ga_${internalId}`
    : (body.dealer_id?.trim() ?? "");
  if (claims.role === "super_admin" && !dealer_id) {
    return NextResponse.json({ error: "dealer_id is required" }, { status: 400 });
  }
  if (claims.role === "group_admin") {
    rest.group_id = claims.group_id;
  }

  const admin = createAdminSupabaseClient();
  const insertPayload = { dealer_id, name: name.trim(), internal_id: internalId, inventory_dealer_id: dealer_id, ...rest };
  let { data, error: dbError } = await admin.from("dealers").insert(insertPayload).select().single();

  if (dbError && dbError.message.includes("account_type")) {
    const { account_type: _drop, ...payloadWithoutAccountType } = insertPayload as typeof insertPayload & { account_type?: string };
    ({ data, error: dbError } = await admin.from("dealers").insert(payloadWithoutAccountType).select().single());
  }

  if (dbError) {
    if (dbError.code === "23505") return NextResponse.json({ error: "Dealer ID already exists" }, { status: 409 });
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  // Geocode the new dealer's address if coordinates are missing
  void geocodeDealer(admin, data as { id: string; lat: unknown; lng: unknown }, rest);

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
