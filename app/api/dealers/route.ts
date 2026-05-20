import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerUpdate } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import {
  createCustomer,
  createTemplate,
  lookupPrice,
  subscriptionDescriptorFor,
  firstOfNextMonthIso,
  billingConfigured,
  type BillingProduct,
} from "@/lib/billing";
import { runSync } from "@/lib/billing-sync";
import { fireGroupAssignCascade } from "@/lib/group-billing-cascade";

interface NewBillingCustomerArgs {
  adminClient: ReturnType<typeof createAdminSupabaseClient>;
  dealerUuid: string;
  /** Dealer's internal_id (the auto-generated billing _ID timestamp). Used to tag the subscription line item via lineItemDescription. */
  dealerInternalId: string;
  /** Dealer name; used in lineItemDescription + as customer company. */
  dealerName: string;
  /** Primary contact name → da-billing customer `name`. */
  contactName: string;
  accountType: string | null;
  email?: string;
  address?: string;
  phone?: string;
  state?: string;
}

/**
 * Event 1: create a da-billing customer for a newly-created dealer, save
 * the returned UUID, then create the recurring subscription template
 * using the price looked up from da-billing's Pricing settings (so a
 * single price change in da-billing applies to every dealer instantly).
 * Trial / Free / Inactive account types skip the template step.
 *
 * Fire-and-forget — never blocks the API response. Failures land in
 * billing_sync_errors with the specific event_type so super_admin can
 * retry just the failing step.
 */
async function fireAndForgetCustomerCreate(args: NewBillingCustomerArgs): Promise<void> {
  if (!billingConfigured()) {
    console.warn("[dealers POST] BILLING_API_KEY not set — skipping da-billing customer create");
    return;
  }
  // Step A: create customer + persist UUID.
  const customerResult = await runSync(
    async () => {
      const cust = await createCustomer({
        name: args.contactName,
        company: args.dealerName,
        email: args.email,
        address: args.address,
        phone: args.phone,
        state: args.state,
        isGroup: false,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (args.adminClient as any)
        .from("dealers")
        .update({ billing_customer_id: cust.id })
        .eq("id", args.dealerUuid);
      return cust;
    },
    {
      event: "billing.customer.create",
      payload: { dealerUuid: args.dealerUuid, contact: args.contactName, company: args.dealerName },
      dealerId: args.dealerUuid,
    },
  );
  if (!customerResult.ok) return;

  // Step B: create recurring template (skipped for trial/free/inactive).
  // da-billing's /pricing endpoint is keyed by short id ("sub-manual" etc.).
  // Templates take productId (for the cascading price update from da-billing's
  // Settings → Pricing tab), `quantity` (the UI form reads this, not `qty`),
  // and lineItemDescription="<internal_id>::<dealer_name>" so the line is
  // attributable to a specific dealer — same convention the existing label
  // order flow already uses.
  const descriptor = subscriptionDescriptorFor(args.accountType);
  if (!descriptor) return;

  await runSync(
    async () => {
      const price = await lookupPrice(descriptor.key);
      if (price == null) {
        throw new Error(`No da-billing price entry for "${descriptor.key}"`);
      }
      // Build the template's product list. Subscription line first; if
      // the dealer is on sub-auto-dms, append the one-time DMS Setup
      // Charge tagged with "<internal_id>::dms-setup" so it can be
      // detected and removed in lockstep with the dealer if needed.
      const products: BillingProduct[] = [{
        productId: descriptor.key,
        name: descriptor.name,
        quantity: 1,
        price,
        lineItemDescription: `${args.dealerInternalId}::${args.dealerName}`,
      }];
      if (descriptor.key === "sub-auto-dms") {
        const setupPrice = (await lookupPrice("dms-setup")) ?? 0;
        products.push({
          productId: "dms-setup",
          name: "One Time DMS Setup Charge",
          quantity: 1,
          price: setupPrice,
          lineItemDescription: `${args.dealerInternalId}::dms-setup`,
        });
      }
      await createTemplate({
        customerId: customerResult.data.id,
        products,
        nextInvoiceDate: firstOfNextMonthIso(),
        scheduleInterval: "monthly",
      });
      // Mirror customer_id into dealers.template_id by convention —
      // da-billing's template API is keyed by customerId, not by a
      // separate template id, so this is the "template exists" flag.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (args.adminClient as any)
        .from("dealers")
        .update({ template_id: customerResult.data.id })
        .eq("id", args.dealerUuid)
        .is("template_id", null);
    },
    {
      event: "billing.template.create",
      payload: {
        dealerUuid: args.dealerUuid,
        customerId: customerResult.data.id,
        productKey: descriptor.key,
      },
      dealerId: args.dealerUuid,
    },
  );
}

// Strip HTML tags from dealer names
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

// hubspot_company_id is stored directly in the Supabase dealers table.
// This helper is retained as a no-op shim so call sites need no changes.
function extractHubspotMap(dealers: Record<string, unknown>[]): Record<string, number | null> {
  const map: Record<string, number | null> = {};
  for (const d of dealers) {
    const inventoryId = d.inventory_dealer_id as string | null;
    const raw = d.hubspot_company_id as string | null;
    if (inventoryId) {
      map[inventoryId] = raw ? (parseInt(raw, 10) || null) : null;
    }
  }
  return map;
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
// Sort the "created" column by the real created_at timestamp. The
// previous remap to legacy_id was a perf optimisation (sequential int,
// indexed) that silently broke for platform-created dealers — legacy_id
// is null for those, which (with the default nullsFirst:false ordering)
// pushed every platform-native dealer to the bottom of the list and
// off the first page. Surfaced as "group dealers missing from the
// list" because most group dealers were created on the new platform.
// Both Aurora-migrated and platform-native dealers have created_at.
const DB_SORT_COLS = new Set<SortableCol>(["name", "active", "account_type", "created_at"]);
const DB_SORT_COL_MAP: Partial<Record<SortableCol, string>> = {};

/**
 * GET /api/dealers
 * Paginated dealer list. super_admin only.
 * Query params: q, active (true|false), at_risk (true), page, per_page, sort, sort_dir
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // group_admin: return their group's dealers
  if (claims.role === "group_admin") {
    if (!claims.group_id) return NextResponse.json({ data: [], total: 0 });
    const admin = createAdminSupabaseClient();
    const { searchParams } = req.nextUrl;
    const q = searchParams.get("q") ?? "";
    const activeFilter = searchParams.get("active");
    let query = admin
      .from("dealers")
      .select("id, dealer_id, name, active, is_test, city, state, phone, primary_contact, primary_contact_email, account_type, group_id, internal_id", { count: "exact" })
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

  // Convert the legacy_id_gte query param (Unix seconds, sent by the UI's
  // date-range filter) to a created_at ISO threshold so platform-created
  // dealers (legacy_id NULL) aren't excluded from results.
  const createdSinceIso = legacyIdGte
    ? new Date(parseInt(legacyIdGte, 10) * 1000).toISOString()
    : null;

  if (atRisk) {
    let allQuery = admin.from("dealers").select("*, groups(name)").eq("active", true).limit(2500);
    if (q) allQuery = allQuery.or(`name.ilike.%${q}%,dealer_id.ilike.%${q}%`);
    if (createdSinceIso) allQuery = allQuery.gte("created_at", createdSinceIso);
    const { data: allDealers, error: allErr } = await allQuery;
    if (allErr) return NextResponse.json({ error: allErr.message }, { status: 500 });

    const dealerIds = (allDealers ?? []).map((d: Record<string, unknown>) => d.dealer_id as string);
    const hubspotMap = extractHubspotMap(allDealers ?? []);
    const [{ lifetime, recent }, atRiskProfileRows] = await Promise.all([
      getPrintCounts(admin, dealerIds),
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
  if (createdSinceIso) query = query.gte("created_at", createdSinceIso);

  // Apply DB-level ordering; "created_at" sorts by legacy_id (sequential int)
  const dbSortCol = DB_SORT_COLS.has(sortCol)
    ? (DB_SORT_COL_MAP[sortCol] ?? sortCol)
    : "legacy_id";
  query = query.order(dbSortCol, { ascending: sortDir, nullsFirst: false }).range(from, from + perPage - 1);

  const { data, error: dbError, count } = await query;
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });

  const dealerIds = (data ?? []).map((d: Record<string, unknown>) => d.dealer_id as string);
  const hubspotMap = extractHubspotMap(data ?? []);
  const [{ lifetime, recent }, profileRows] = await Promise.all([
    getPrintCounts(admin, dealerIds),
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

  // Event 1: provision billing for the new dealer (fire-and-forget).
  // Branch on subscription_billed_to:
  //   - 'group' (+ group_id present): append a line item to the group's
  //     da-billing template via cascadeOnGroupAssign. No standalone
  //     dealer customer/template is created — the group owns billing.
  //   - 'dealer' (default): create a standalone da-billing customer
  //     and recurring template for the dealer.
  // Skipped entirely for dealers migrated from legacy Aurora (legacy_id is
  // set for those, null for platform-created dealers). Legacy dealers map
  // to FreshBooks-imported customers in da-billing under internal_id, so
  // we don't want to create a duplicate customer for them.
  const createdDealer = data as Record<string, unknown>;
  const createdDealerId = createdDealer.id as string;
  const createdDealerGroupId = createdDealer.group_id as string | null;
  const subscriptionBilledTo = (createdDealer.subscription_billed_to as string | null) ?? "dealer";
  const hasLegacyBilling = createdDealer.legacy_id != null;

  if (!hasLegacyBilling) {
    if (subscriptionBilledTo === "group" && createdDealerGroupId) {
      // Group owns the subscription line. Cascade adds a tagged line
      // item to the group's template (creating the template + customer
      // if needed) using the dealer's account_type as productId.
      fireGroupAssignCascade(createdDealerId, createdDealerGroupId);
    } else {
      void fireAndForgetCustomerCreate({
        adminClient: admin,
        dealerUuid: createdDealerId,
        dealerInternalId: internalId,
        dealerName: name.trim(),
        contactName: ((rest.primary_contact as string | null) ?? name).trim(),
        accountType: (createdDealer.account_type as string | null) ?? null,
        email: (rest.primary_contact_email as string | null) ?? undefined,
        address: (rest.address as string | null) ?? undefined,
        phone: (rest.phone as string | null) ?? undefined,
        state: (rest.state as string | null) ?? undefined,
      });
    }
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

  const dealer = data as Record<string, unknown>;

  // Get creator name and group name in parallel (fire off DB lookups)
  const groupId = (rest.group_id as string | null) ?? null;
  const [creatorResult, groupResult] = await Promise.all([
    admin.from("profiles").select("full_name").eq("id", claims.sub).maybeSingle<{ full_name: string | null }>(),
    groupId
      ? admin.from("groups").select("name").eq("id", groupId).maybeSingle<{ name: string }>()
      : Promise.resolve({ data: null }),
  ]);
  const creatorName = (creatorResult.data as { full_name: string | null } | null)?.full_name ?? claims.email;
  const groupName = (groupResult.data as { name: string } | null)?.name ?? null;
  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });

  // Internal notification — always sent on every new dealer creation
  void sendMandrillEmail({
    subject: `New Dealer Created — ${name.trim()}`,
    from_email: "noreply@dealeraddendums.com",
    from_name: "DealerAddendums",
    to: [{ email: "support@dealeraddendums.com", name: "DA Support" }],
    html: `<p><strong>Dealer Name:</strong> ${name.trim()}<br>
<strong>Dealer ID:</strong> ${dealer_id}<br>
<strong>Contact:</strong> ${(rest.primary_contact as string | null) ?? "—"} / ${(rest.primary_contact_email as string | null) ?? "—"}<br>
<strong>Subscription:</strong> ${(dealer.account_type as string | null) ?? "—"}<br>
<strong>Group:</strong> ${groupName ?? "None"}<br>
<strong>Created by:</strong> ${creatorName}<br>
<strong>Created at:</strong> ${now} ET</p>`,
  }).catch((err) => console.error("[dealers/notify] internal email failed:", err instanceof Error ? err.message : err));

  return NextResponse.json({ data, emailSent: sendNotify ? true : false }, { status: 201 });
}
