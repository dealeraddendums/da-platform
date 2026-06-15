import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { GroupRow, GroupUpdate } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { createCustomer, billingConfigured } from "@/lib/billing";
import { fireAndForget } from "@/lib/billing-sync";
import { fireGroupSync } from "@/lib/sync-hubspot";
import { SOURCE_FORM } from "@/lib/hubspot";
import { createGroupFolder, boxConfigured } from "@/lib/box";

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

  // Count dealers per group + check which groups have a group_admin
  const groupIds = (data ?? []).map((g: Record<string, unknown>) => g.id as string);
  const dealerCounts: Record<string, number> = {};
  const groupsWithAdmin = new Set<string>();

  if (groupIds.length > 0) {
    const [{ data: dealerRows }, { data: adminProfiles }] = await Promise.all([
      admin.from("dealers").select("group_id").in("group_id", groupIds),
      admin.from("profiles").select("group_id").in("group_id", groupIds).eq("role", "group_admin"),
    ]);
    for (const r of dealerRows ?? []) {
      if (r.group_id) dealerCounts[r.group_id] = (dealerCounts[r.group_id] ?? 0) + 1;
    }
    for (const p of adminProfiles ?? []) {
      if (p.group_id) groupsWithAdmin.add(p.group_id as string);
    }
  }

  // hubspot_company_id is stored directly in the Supabase groups table
  let enriched = (data ?? []).map((g: Record<string, unknown>) => ({
    ...g,
    dealer_count: dealerCounts[g.id as string] ?? 0,
    hubspot_company_id: g.hubspot_company_id ?? null,
    has_group_admin: groupsWithAdmin.has(g.id as string),
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
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: {
    name?: string;
    internal_id?: string;
    username?: string;
    password?: string;
    sendNotify?: boolean;
    // etl_locked is a post-hoc super_admin toggle (PATCH only), never set at
    // create — excluded so it doesn't flow into the insert payload (the
    // generated Supabase types don't carry it until regenerated).
  } & Omit<GroupUpdate, "etl_locked" | "etl_locked_at" | "etl_locked_reason" | "etl_locked_by">;
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

  // Default billing address fields to the physical address fields when
  // they aren't explicitly supplied. Most groups use the same address
  // for both, so saving the operator from re-typing avoids the empty-
  // address da-billing rejection we saw on first launch. Contact/email/
  // phone are intentionally not defaulted — they're entered separately.
  const billingDefaults: Record<string, string | null | undefined> = {};
  if (rest.billing_address == null && rest.address != null) billingDefaults.billing_address = rest.address;
  if (rest.billing_city    == null && rest.city    != null) billingDefaults.billing_city    = rest.city;
  if (rest.billing_state   == null && rest.state   != null) billingDefaults.billing_state   = rest.state;
  if (rest.billing_zip     == null && rest.zip     != null) billingDefaults.billing_zip     = rest.zip;
  if (rest.billing_country == null) billingDefaults.billing_country = rest.country ?? "US";

  const admin = createAdminSupabaseClient();

  // Pre-check the login email BEFORE creating anything — a duplicate must fail
  // cleanly (409) and create no group/user, not create the group then 201 with a
  // swallowed warning. Case-insensitive profile existence check (auth schema
  // isn't on the data API), mirroring the dealer Users-tab route.
  if (username?.trim() && password?.trim()) {
    const rawUsername = username.trim();
    const preEmail = (rawUsername.includes("@") ? rawUsername : `${rawUsername}@dealeraddendums.com`).toLowerCase();
    const { data: dupProfile } = await admin
      .from("profiles")
      .select("id")
      .ilike("email", preEmail)
      .maybeSingle<{ id: string }>();
    if (dupProfile) {
      return NextResponse.json({ error: "That email is already registered — use a different email." }, { status: 409 });
    }
  }

  const insertPayload = { name: name.trim(), internal_id: groupInternalId, ...rest, ...billingDefaults };
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

  // Login email of the created user (if any) — used as the welcome-email
  // fallback when no separate contact email was supplied.
  let createdUserEmail: string | null = null;

  // Optionally create a group_admin auth user
  if (username?.trim() && password?.trim()) {
    const rawUsername = username.trim();
    const authEmail = rawUsername.includes("@") ? rawUsername : `${rawUsername}@dealeraddendums.com`;
    createdUserEmail = authEmail;
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
      phone: ((rest as Record<string, unknown>).phone as string | undefined) ?? null,
      role: "group_admin" as const,
      group_id: group.id,
    });
  }

  // Provision a Box.com folder for the group (fire-and-forget). Stores
  // the returned id in groups.box_folder_id so the group detail page
  // and future doc flows can deep-link without re-resolving by name.
  if (boxConfigured()) {
    fireAndForget(async () => {
      const folderId = await createGroupFolder(group.name);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: updateErr } = await (admin as any)
        .from("groups")
        .update({ box_folder_id: folderId })
        .eq("id", group.id)
        .is("box_folder_id", null);
      if (updateErr) throw new Error(`groups update failed: ${updateErr.message} (folder ${folderId})`);
    }, {
      event: "box.folder.create",
      groupId: group.id,
      payload: { groupName: group.name, entity: "group" },
    });
  }

  // Eager billing customer creation. Non-blocking via fireAndForget, which
  // writes any failure to billing_sync_errors so super_admin can spot
  // groups whose customer create silently failed. The lazy create path in
  // group-billing-cascade.ts is still the safety net for older groups.
  if (billingConfigured() && !group.billing_customer_id) {
    // Pull from the final group row so we see the billing_* defaults we
    // just injected from the physical address fields.
    const contactName  = (group.billing_contact ?? group.primary_contact) || group.name;
    const contactEmail = (group.billing_email   ?? group.primary_contact_email) || undefined;
    const contactPhone = group.billing_phone   || undefined;
    const addr         = group.billing_address || undefined;
    const stateField   = group.billing_state   || undefined;

    fireAndForget(async () => {
      const created = await createCustomer({
        name: contactName,
        company: group.name,
        email: contactEmail,
        phone: contactPhone,
        address: addr,
        state: stateField,
        isGroup: true,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: updateErr } = await (admin as any)
        .from("groups")
        .update({ billing_customer_id: created.id })
        .eq("id", group.id);
      if (updateErr) {
        // Throw so runSync writes the error to billing_sync_errors — the
        // da-billing side succeeded but the Supabase write didn't, so the
        // group now has an orphan customer record. Surface it.
        throw new Error(`groups update failed: ${updateErr.message} (billing customer ${created.id})`);
      }
    }, {
      event: "billing.customer.create",
      groupId: group.id,
      payload: { groupName: group.name, contactEmail, contactPhone, addr, stateField },
    });
  }

  // Get creator's display name for internal notification
  const { data: creatorProfile } = await admin
    .from("profiles")
    .select("full_name")
    .eq("id", claims.sub)
    .maybeSingle<{ full_name: string | null }>();
  const creatorName = creatorProfile?.full_name ?? claims.email;

  const contactName = (rest.primary_contact as string | null) ?? null;
  const contactEmail = (rest.primary_contact_email as string | null) ?? null;
  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });

  // Welcome email (sendNotify button only). Prefer the explicit contact email;
  // fall back to the created user's login email so a notify-with-user create
  // still reaches the person even when no separate contact email was entered.
  const welcomeTo = contactEmail ?? createdUserEmail;
  if (sendNotify && welcomeTo) {
    void sendMandrillEmail({
      subject: `Welcome to DealerAddendums — ${group.name}`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email: welcomeTo, name: contactName ?? undefined }],
      html: `<p>Hi ${contactName ?? "there"},</p>
<p>Your DealerAddendums group account <strong>${group.name}</strong> has been created.</p>
<p><strong>Your login details:</strong><br>
Username: ${username?.trim() ? (username.trim().includes("@") ? username.trim() : `${username.trim()}@dealeraddendums.com`) : "(not set)"}</p>
<p>You can access your account at: <a href="https://app.dealeraddendums.com">https://app.dealeraddendums.com</a></p>
<p>If you have any questions, contact <a href="mailto:support@dealeraddendums.com">support@dealeraddendums.com</a></p>`,
    }).catch((err) => console.error("[groups/notify] welcome email failed:", err instanceof Error ? err.message : err));
  }

  // Internal notification — always sent on every new group creation
  void sendMandrillEmail({
    subject: `New Group Created — ${group.name}`,
    from_email: "noreply@dealeraddendums.com",
    from_name: "DealerAddendums",
    to: [{ email: "support@dealeraddendums.com", name: "DA Support" }],
    html: `<p><strong>Group Name:</strong> ${group.name}<br>
<strong>Group ID:</strong> ${group.internal_id}<br>
<strong>Contact:</strong> ${contactName ?? "—"} / ${contactEmail ?? "—"}<br>
<strong>Created by:</strong> ${creatorName}<br>
<strong>Created at:</strong> ${now} ET</p>`,
  }).catch((err) => console.error("[groups/notify] internal email failed:", err instanceof Error ? err.message : err));

  // Phase 14a — HubSpot Company upsert for the group. Default
  // lifecyclestage is "Group/Reseller Trial" on first sync; operator
  // flips to Customer in HubSpot when the group starts paying.
  // source_form="Group Add by DA Admin" (create-only) — this route is super_admin-gated.
  fireGroupSync(group.id, SOURCE_FORM.GROUP_BY_ADMIN);

  return NextResponse.json(
    { data: group, emailSent: !!(sendNotify && welcomeTo) },
    { status: 201 }
  );
}
