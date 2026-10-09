// Steven's data tools (Phase S1) — READ-ONLY answers from the logged-in
// dealer's own data. Spec: steven-data-tools-spec.md (suite root).
//
// THE SECURITY MODEL (every tool, no exceptions):
//  1. Whose data is read is decided HERE from the session claims — never from
//     the model or the chat text. Single-store roles are pinned to their own
//     dealer; any dealer the model names is ignored.
//  2. Only group_admin / group_user may name a member store (`store`), and it
//     must (a) resolve INSIDE the caller's own group and (b) pass the existing
//     authorizeDealerAction (in-group; tag scope for group_user).
//  3. Read-only. Nothing here writes, except the fire-and-forget audit row.
//  4. Safe fields only: no payment instruments, no internal ids beyond the
//     dealer's own Dealer ID, no staff notes. Billing amounts only for roles
//     that see billing on screen; everyone else gets status-level.
//  5. Every call is audited (steven_tool_calls, migration 170), never blocking.
//  6. A tool that fails or times out returns { error } and Steven answers
//     without it.
/* eslint-disable @typescript-eslint/no-explicit-any */

import type Anthropic from "@anthropic-ai/sdk";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { authorizeDealerAction, resolveEffectiveDealer } from "@/lib/dealer-authz";
import {
  TRIAL_DAYS_CAP, TRIAL_PRINTS_CAP, canPrintForDealer, isPaidAccountType, isTrialAccountType, hasActiveTrialOverride,
} from "@/lib/print-eligibility";
import { trialPrintCount } from "@/lib/print-counts";
import { getDealerCardStats } from "@/lib/dealer-stats";
import { billingConfigured, getBillingStatus, getTemplate, listInvoices } from "@/lib/billing";
import { explainVehicleProducts } from "@/lib/steven-products";
import { getGroupOptionsForDealer } from "@/lib/options-engine";
import { summarizeRules, NO_RULES_TEXT } from "@/lib/rule-summary";
import { formatOptionPrice } from "@/lib/option-price";
import { dealerFeedHealth, FEED_HEALTH_MEANING } from "@/lib/feed-health";

type Admin = ReturnType<typeof createAdminSupabaseClient>;
const GROUP_ROLES = new Set(["group_admin", "group_user"]);
const BILLING_AMOUNT_ROLES = new Set(["dealer_admin", "group_admin", "super_admin"]);
// The store's user list is admin-only — same people who see the Users page.
const USER_LIST_ROLES = new Set(["dealer_admin", "group_admin", "super_admin"]);
const TOOL_TIMEOUT_MS = 8000;

const STORE_PARAM = {
  store: {
    type: "string",
    description:
      "ONLY for group admins / group users asking about one of their member stores: the store's name or Dealer ID. " +
      "Leave empty for the store the user is currently working in. Ignored for single-store users.",
  },
} as const;

export const STEVEN_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_account_status",
    description:
      "The user's dealership account: plan (Trial / Paid / Free), trial days left and trial prints used vs cap, whether printing is allowed right now and why not, and whether the store is on DA 5.0 (native or migrated from 4.0). Use for 'what plan am I on', 'why can't I print', 'when does my trial end'.",
    input_schema: { type: "object", properties: { ...STORE_PARAM } },
  },
  {
    name: "get_billing_status",
    description:
      "Billing status for the user's dealership: who pays (the store itself or its group), whether the account is past due and since when, and (for users allowed to see billing) the balance, next invoice date and last invoice. Never returns payment details. Use for 'am I past due', 'what do I owe', 'when is my next invoice'.",
    input_schema: { type: "object", properties: { ...STORE_PARAM } },
  },
  {
    name: "get_inventory_summary",
    description:
      "Counts for the dealership's active inventory: vehicles, added today and in the last 7 days, printed vs not yet printed, and print coverage %. Same numbers as the Inventory dashboard cards. Use for 'how many cars do I have', 'how many still need printing'.",
    input_schema: { type: "object", properties: { ...STORE_PARAM } },
  },
  {
    name: "get_print_activity",
    description:
      "Printing activity for the dealership: vehicles printed in the last 30 and 365 days, the most recently printed vehicle (stock #, VIN, date), and trial prints used if on a trial. Use for 'how much have we printed', 'what did we print last'.",
    input_schema: { type: "object", properties: { ...STORE_PARAM } },
  },
  {
    name: "explain_vehicle_products",
    description:
      "For ONE vehicle in the user's own inventory (by VIN — full or last 6+ characters — or stock number): which products print on its addendum (name, price, Required/Suggested) and, for products that DON'T apply, the exact rule that excludes each (condition, make/model/trim, MSRP range, mileage, year, manual-only, not assigned to the store, removed from the vehicle). Same product set Print Now uses. Use for 'why isn't X showing on this truck', 'what products are on VIN …'. Pass product_name when they ask about a specific product.",
    input_schema: {
      type: "object",
      properties: {
        vin_or_stock: { type: "string", description: "The vehicle's VIN (full or last 6+ characters) or stock number." },
        product_name: { type: "string", description: "Optional: the product they're asking about." },
        ...STORE_PARAM,
      },
      required: ["vin_or_stock"],
    },
  },
  {
    name: "get_products",
    description:
      "The dealership's product library (its own products plus the corporate/group products that apply to it): name, price, Required/Suggested, and a short summary of each product's vehicle rules. Use for 'what products do I have', 'what's my price on X', 'what are the rules on X'.",
    input_schema: { type: "object", properties: { ...STORE_PARAM } },
  },
  {
    name: "get_templates",
    description:
      "The dealership's default templates for New / Used / CPO vehicles (addendum, infosheet, buyer's guide, and any second addendum), any make-based overrides (e.g. Genesis vehicles use a different template), and whether each is the store's own template or a group template. Use for 'what's my default used template'.",
    input_schema: { type: "object", properties: { ...STORE_PARAM } },
  },
  {
    name: "get_website_integration",
    description:
      "Whether the dealership's website addendum button (Magic Button) is set up: which integration (Dealer.com, Generate Button API, Icon Button API), on or off, and what it shows. No keys or code.",
    input_schema: { type: "object", properties: { ...STORE_PARAM } },
  },
  {
    name: "get_users",
    description:
      "Who has a login for the dealership: name and role (Dealer Admin / Dealer User / Dealer Restricted), plus pending invitations. Only answered for admins; other users get a refusal.",
    input_schema: { type: "object", properties: { ...STORE_PARAM } },
  },
  {
    name: "get_print_queue",
    description:
      "The dealership's print queue (vehicles queued with Print Later in the mobile app): how many, and which ones (stock #, VIN, year/make/model). Use for 'what's in my print queue'.",
    input_schema: { type: "object", properties: { ...STORE_PARAM } },
  },
  {
    name: "get_label_orders",
    description:
      "The dealership's recent label / supply orders (same list as My Profile → Orders → Label Order History), newest first, up to 10: order date, who ordered, items with quantities (e.g. 'Regular Addendums × 250'), total, shipment status (Pending shipment / Shipped / Delivered) and tracking number + carrier. Use for 'when did I last order labels', 'what size did I order', 'has my label order shipped', 'what's my tracking number', 'how much were my last labels'. For how to order more, use the Order Supplies help article.",
    input_schema: { type: "object", properties: { ...STORE_PARAM } },
  },
  {
    name: "get_feed_provider",
    description:
      "The dealership's inventory feed: who the provider is (as on file, or inferred from recent inventory when nothing is on file — never guessed), whether a live feed is connected, and how fresh the inventory is (active vehicles, how many feed vehicles were refreshed in the last 3 days, newest vehicle the feed added). Use for 'who is my feed provider', 'is my inventory feed connected / working', 'why isn't my inventory updating'. Changing providers is done through support.",
    input_schema: { type: "object", properties: { ...STORE_PARAM } },
  },
];

export const STEVEN_TOOL_NAMES = new Set(STEVEN_TOOLS.map((t) => t.name));

// ── Scope resolution: the ONLY place a target dealer is decided ────────────

type Scope =
  | { ok: true; dealerId: string; dealerName: string | null }
  | { ok: false; denied: boolean; message: string };

async function resolveScope(admin: Admin, claims: JwtClaims, input: Record<string, unknown>): Promise<Scope> {
  const own = resolveEffectiveDealer(claims);
  const asked = typeof input.store === "string" ? input.store.trim().slice(0, 120) : "";

  // Single-store roles and super_admin: the session's dealer, full stop. A
  // store the model named is ignored on purpose (rule 1).
  if (!GROUP_ROLES.has(claims.role) || !asked) {
    if (!own) {
      return {
        ok: false, denied: false,
        message: GROUP_ROLES.has(claims.role)
          ? "No store is selected. Ask which member store they mean (by name), or have them switch into it."
          : "No dealership is in context for this user.",
      };
    }
    const { data } = await admin.from("dealers").select("name").eq("dealer_id", own).maybeSingle<{ name: string | null }>();
    return { ok: true, dealerId: own, dealerName: data?.name ?? null };
  }

  // Group roles naming a member store: look it up INSIDE the caller's group only.
  if (!claims.group_id) return { ok: false, denied: true, message: "That store isn't one of yours." };
  const pattern = asked.replace(/[%_,()\\]/g, " ").trim();
  const { data: byId } = await admin.from("dealers").select("dealer_id, name")
    .eq("group_id", claims.group_id).eq("dealer_id", asked).limit(1);
  let matches = (byId ?? []) as { dealer_id: string; name: string | null }[];
  if (!matches.length && pattern) {
    const { data: byName } = await admin.from("dealers").select("dealer_id, name")
      .eq("group_id", claims.group_id).ilike("name", `%${pattern}%`).limit(6);
    matches = (byName ?? []) as { dealer_id: string; name: string | null }[];
  }
  if (!matches.length) return { ok: false, denied: true, message: "That store isn't one of yours." };
  if (matches.length > 1) {
    const exact = matches.find((m) => (m.name || "").toLowerCase() === asked.toLowerCase());
    if (!exact) {
      return { ok: false, denied: false, message: `More than one of your stores matches: ${matches.map((m) => m.name).join("; ")}. Ask which one.` };
    }
    matches = [exact];
  }
  const authz = await authorizeDealerAction(claims, matches[0].dealer_id);
  if (!authz.ok) return { ok: false, denied: true, message: "That store isn't one of yours." };
  return { ok: true, dealerId: matches[0].dealer_id, dealerName: matches[0].name };
}

// ── The tools (all read-only) ──────────────────────────────────────────────

async function accountStatus(admin: Admin, dealerId: string) {
  const { data: d } = await admin.from("dealers")
    .select("name, account_type, created_at, trial_ends_at, trial_prints_cap, migration_status, is_native, converted_at")
    .eq("dealer_id", dealerId).maybeSingle<any>();
  if (!d) return { error: "dealership not found" };
  const onTrial = isTrialAccountType(d.account_type) || hasActiveTrialOverride(d);
  let trial: Record<string, unknown> | null = null;
  if (onTrial) {
    const used = await trialPrintCount(admin, dealerId);
    const createdMs = d.created_at ? new Date(d.created_at).getTime() : Date.now();
    const endMs = d.trial_ends_at ? new Date(d.trial_ends_at).getTime() : createdMs + TRIAL_DAYS_CAP * 86_400_000;
    const cap = d.trial_prints_cap ?? TRIAL_PRINTS_CAP;
    trial = {
      ends_on: new Date(endMs).toISOString().slice(0, 10),
      days_left: Math.max(0, Math.ceil((endMs - Date.now()) / 86_400_000)),
      vehicles_printed: used, vehicle_print_cap: cap, prints_left: Math.max(0, cap - used),
    };
  }
  const gate = await canPrintForDealer(dealerId).catch(() => null);
  return {
    dealership: d.name,
    plan: d.account_type,
    plan_kind: isPaidAccountType(d.account_type) ? "paid" : onTrial ? "trial" : "free_or_downgraded",
    trial,
    printing_allowed: gate ? gate.ok : null,
    printing_blocked_reason: gate && !gate.ok ? gate.reason : null,
    printing_blocked_message: gate && !gate.ok ? gate.message : null,
    platform: d.is_native ? "created on DA 5.0"
      : d.migration_status === "migrated" ? `migrated from DA 4.0 to 5.0${d.converted_at ? ` on ${String(d.converted_at).slice(0, 10)}` : ""}`
      : "still on DA 4.0 (not fully moved to 5.0 yet)",
  };
}

async function billingStatus(admin: Admin, claims: JwtClaims, dealerId: string) {
  const { data: d } = await admin.from("dealers")
    .select("name, subscription_billed_to, billing_customer_id, group_id").eq("dealer_id", dealerId).maybeSingle<any>();
  if (!d) return { error: "dealership not found" };
  const groupBilled = d.subscription_billed_to === "group" && !!d.group_id;
  let customerId: string | null = d.billing_customer_id ?? null;
  let groupName: string | null = null;
  if (groupBilled) {
    const { data: g } = await admin.from("groups").select("name, billing_customer_id").eq("id", d.group_id).maybeSingle<any>();
    customerId = g?.billing_customer_id ?? null;
    groupName = g?.name ?? null;
  }
  const payer = groupBilled ? `the group${groupName ? ` (${groupName})` : ""}` : "the dealership itself";
  if (!billingConfigured() || !customerId) return { dealership: d.name, payer, billing_available: false };

  const status = await getBillingStatus(customerId);
  if (!status) return { dealership: d.name, payer, billing_available: false };
  const daysSince = status.oldest_overdue_date
    ? Math.max(0, Math.floor((Date.now() - new Date(status.oldest_overdue_date).getTime()) / 86_400_000)) : null;
  const base = {
    dealership: d.name,
    payer,
    who_to_contact: groupBilled ? "their Group Administrator (billing is handled by the group)" : "support@dealeraddendums.com, or pay from My Profile → Billing",
    past_due: status.past_due,
    oldest_unpaid_invoice_date: status.oldest_overdue_date,
    days_since_oldest_unpaid_invoice: daysSince,
    printing_paused_for_billing: status.past_due,
  };

  // Amounts only for roles that see billing on screen — and a group's money
  // only for group roles (a member store's staff see status, not the group's books).
  const mayAmounts = BILLING_AMOUNT_ROLES.has(claims.role) && (!groupBilled || GROUP_ROLES.has(claims.role) || claims.role === "super_admin");
  if (!mayAmounts) return { ...base, amounts: "not shown to this user's role" };

  const [tpl, inv] = await Promise.all([
    getTemplate(customerId).catch(() => null),
    listInvoices(customerId).catch(() => null),
  ]);
  const last = (inv?.invoices ?? []).filter((i) => i.status !== "void")
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  return {
    ...base,
    outstanding_balance: status.outstanding_balance,
    next_invoice_date: tpl && tpl.active !== false ? tpl.nextInvoiceDate ?? null : null,
    last_invoice: last ? { date: String(last.date).slice(0, 10), amount: last.total, status: last.status } : null,
  };
}

async function inventorySummary(admin: Admin, dealerId: string) {
  const s = await getDealerCardStats(admin, dealerId);
  const { count: added7 } = await admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
    .eq("dealer_id", dealerId).eq("status", "active")
    .gte("date_added", new Date(Date.now() - 7 * 86_400_000).toISOString());
  return {
    active_vehicles: s.totalVehicles,
    added_today: s.addedToday,
    added_last_7_days: added7 ?? 0,
    printed: s.printedActive,
    not_yet_printed: Math.max(0, s.totalVehicles - s.printedActive),
    coverage_pct: s.coveragePct,
    queued: s.queued,
    note: "printed = active vehicles with any document printed (addendum, info sheet, or buyer's guide)",
  };
}

async function printActivity(admin: Admin, dealerId: string) {
  const s = await getDealerCardStats(admin, dealerId);
  const { data: lastRows } = await admin.from("dealer_vehicles")
    .select("stock_number, vin, year, make, model, print_date")
    .eq("dealer_id", dealerId).not("print_date", "is", null)
    .order("print_date", { ascending: false }).limit(1);
  const last = (lastRows ?? [])[0] as any;
  const { data: d } = await admin.from("dealers").select("account_type, trial_ends_at").eq("dealer_id", dealerId).maybeSingle<any>();
  const onTrial = d && (isTrialAccountType(d.account_type) || hasActiveTrialOverride(d));
  return {
    vehicles_printed_last_30_days: s.printed30,
    vehicles_printed_last_365_days: s.printed365,
    last_printed_vehicle: last ? {
      stock_number: last.stock_number, vin: last.vin,
      vehicle: [last.year, last.make, last.model].filter(Boolean).join(" "),
      printed_on: String(last.print_date).slice(0, 10),
    } : null,
    trial_vehicles_printed: onTrial ? await trialPrintCount(admin, dealerId) : null,
  };
}

async function printQueue(admin: Admin, dealerId: string) {
  const { data, count } = await admin.from("dealer_vehicles")
    .select("stock_number, vin, year, make, model, print_queue_at", { count: "exact" })
    .eq("dealer_id", dealerId).eq("status", "active").eq("print_queue", 1)
    .order("print_queue_at", { ascending: true, nullsFirst: false }).limit(20);
  return {
    queued_count: count ?? 0,
    vehicles: ((data ?? []) as any[]).map((v) => ({
      stock_number: v.stock_number, vin: v.vin,
      vehicle: [v.year, v.make, v.model].filter(Boolean).join(" "),
      queued_on: v.print_queue_at ? String(v.print_queue_at).slice(0, 10) : null,
    })),
    shown: Math.min(count ?? 0, 20),
  };
}

async function productsList(admin: Admin, dealerId: string) {
  const { data: lib } = await (admin as any).from("addendum_library")
    .select("option_name, item_price, required, active, applies_to, ad_types, makes, makes_not, models, models_not, trims, trims_not, body_styles, fuel, fuel_not, year_condition, year_value, miles_condition, miles_value, msrp_condition, msrp1, msrp2, apply_when_no_msrp")
    .eq("dealer_id", dealerId).order("sort_order", { ascending: true }).limit(300);
  const rows = (lib ?? []) as any[];
  const corporate = await getGroupOptionsForDealer(dealerId);
  const shape = (r: any, price: string | null, required: boolean) => ({
    name: r.option_name,
    price: formatOptionPrice(price) || price || "",
    type: required ? "Required" : "Suggested",
    rules: (summarizeRules(r).join("; ")) || NO_RULES_TEXT,
  });
  const own = rows.filter((r) => r.active !== false);
  return {
    own_products: own.slice(0, 80).map((r) => shape(r, r.item_price, r.required !== false)),
    own_products_total: own.length,
    inactive_products: rows.length - own.length,
    corporate_products: corporate.slice(0, 60).map((g) => shape(g, g.option_price, g.required)),
    corporate_products_total: corporate.length,
  };
}

async function templatesInfo(admin: Admin, dealerId: string) {
  const a = admin as any;
  const cols = ["default_addendum_new", "default_addendum_used", "default_addendum_cpo", "default_infosheet_new", "default_infosheet_used",
    "default_infosheet_cpo", "default_buyersguide_new", "default_buyersguide_used", "default_buyersguide_cpo",
    "default_addendum_new_second", "default_addendum_used_second", "default_addendum_cpo_second"];
  const { data: st } = await a.from("dealer_settings").select(cols.join(",")).eq("dealer_id", dealerId).maybeSingle();
  const { data: overrides } = await a.from("template_make_overrides").select("make_key, condition, doc_type, template_id").eq("dealer_id", dealerId);
  const ids = new Set<string>();
  for (const c of cols) if (st?.[c]) ids.add(st[c]);
  for (const o of overrides ?? []) if (o.template_id) ids.add(o.template_id);
  const idList = Array.from(ids);
  const [own, grp] = await Promise.all([
    idList.length ? a.from("templates").select("id, name").in("id", idList) : { data: [] },
    idList.length ? a.from("group_templates").select("id, name").in("id", idList) : { data: [] },
  ]);
  const names = new Map<string, string>();
  for (const t of (own.data ?? []) as any[]) names.set(t.id, t.name);
  for (const t of (grp.data ?? []) as any[]) names.set(t.id, `${t.name} (group template)`);
  // An unset PRIMARY default prints the starter layout; an unset SECOND
  // addendum just means no second page (Steven once told a dealer it would
  // print the starter layout).
  const label = (id: string | null | undefined, second = false) => (id ? names.get(id) ?? "a template that no longer exists"
    : second ? "none (no second addendum prints)" : "none set (prints the starter layout)");
  const block = (doc: string, second = false) => ({
    new: label(st?.[`default_${doc}_new${second ? "_second" : ""}`], second),
    used: label(st?.[`default_${doc}_used${second ? "_second" : ""}`], second),
    cpo: label(st?.[`default_${doc}_cpo${second ? "_second" : ""}`], second),
  });
  const hasSecond = ["new", "used", "cpo"].some((c) => st?.[`default_addendum_${c}_second`]);
  return {
    addendum_defaults: block("addendum"),
    ...(hasSecond ? { second_addendum_defaults: block("addendum", true) } : {}),
    infosheet_defaults: block("infosheet"),
    buyers_guide_defaults: block("buyersguide"),
    make_overrides: ((overrides ?? []) as any[]).map((o) => ({
      make: o.make_key, condition: o.condition, document: o.doc_type, template: label(o.template_id),
    })),
  };
}

const PROVIDER_LABEL: Record<string, string> = { dealer_com: "Dealer.com", api: "Generate Button API", api_icon: "Icon Button API" };

async function websiteIntegration(admin: Admin, dealerId: string) {
  const { data } = await (admin as any).from("dealer_website_integrations")
    .select("provider, enabled, feature, button_label, updated_at").eq("dealer_id", dealerId);
  const rows = ((data ?? []) as any[]).filter((r) => PROVIDER_LABEL[r.provider]);
  return {
    configured: rows.length > 0,
    integrations: rows.map((r) => ({
      integration: PROVIDER_LABEL[r.provider],
      on: r.enabled === true,
      shows: r.feature ?? null,
      button_label: r.button_label ?? null,
      last_changed: r.updated_at ? String(r.updated_at).slice(0, 10) : null,
    })),
    where: "My Profile → Website Integrations",
  };
}

// Same source + scoping as GET /api/orders/labels (the Orders tab): label_orders
// is keyed by the dealer's UUID. Only the columns the tab shows — billing
// routing/status and the ship-to address are deliberately left out.
async function labelOrders(admin: Admin, dealerId: string) {
  const { data: d } = await admin.from("dealers").select("id").eq("dealer_id", dealerId).maybeSingle<{ id: string }>();
  if (!d) return { error: "dealership not found" };
  const { data, error } = await (admin as any).from("label_orders")
    .select("items, total_amount, xps_status, xps_tracking_number, xps_carrier, created_at, ordered_by_name")
    .eq("dealer_id", d.id).order("created_at", { ascending: false }).limit(10);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as any[];
  return {
    orders: rows.map((o) => ({
      ordered_on: String(o.created_at).slice(0, 10),
      ordered_by: o.ordered_by_name ?? null,
      items: (Array.isArray(o.items) ? o.items : []).map((it: any) => `${it.productName ?? it.sku} × ${Number(it.qty ?? 0).toLocaleString("en-US")}`),
      total: o.total_amount != null ? `$${Number(o.total_amount).toFixed(2)}` : null,
      status: o.xps_status === "delivered" ? "Delivered" : o.xps_status === "shipped" ? "Shipped" : "Pending shipment",
      tracking_number: o.xps_tracking_number ?? null,
      carrier: o.xps_carrier ?? null,
    })),
    shown: rows.length,
    note: rows.length ? "newest first; at most the 10 most recent orders" : "no label orders on file for this store",
    where: "My Profile → Orders (history) · Order Supplies (place a new order)",
  };
}

// Provider + connection + freshness come from lib/feed-health.ts — the SAME
// definition the fleet stale-feed scan and daily digest use.
async function feedProvider(admin: Admin, dealerId: string) {
  const { data: d } = await admin.from("dealers").select("inventory_provider, inventory_dealer_id")
    .eq("dealer_id", dealerId).maybeSingle<{ inventory_provider: string | null; inventory_dealer_id: string | null }>();
  if (!d) return { error: "dealership not found" };
  const h = await dealerFeedHealth(admin, { dealer_id: dealerId, ...d });
  return {
    provider: h.provider ?? "unknown",
    provider_source: h.providerSource === "on_file" ? "on file for the dealership (shown on the dealer profile)"
      : h.providerSource === "inferred" ? "inferred from the store's feed (nothing on file)"
      : "not on file and can't be determined — say so, don't guess a brand",
    feed_dealer_id: h.feedDealerId,
    live_feed_connected: h.health !== "no_live_feed",
    feed_health: h.health,
    feed_health_meaning: FEED_HEALTH_MEANING[h.health],
    active_vehicles: h.activeVehicles,
    vehicles_from_feed: h.feedVehicles,
    vehicles_added_by_hand: h.handAddedActive,
    feed_vehicles_refreshed_last_3_days: h.feedRefreshedLast3d,
    newest_vehicle_from_feed: h.newestFeedAdded,
    ...(h.health === "no_live_feed" && h.handAddedOlderThan180d > 0 ? {
      note: `${h.handAddedOlderThan180d} active vehicles were added by hand over 180 days ago. Without a feed nothing marks sold cars inactive, so many of these are likely sold — the dealer can clean them up in Inventory, or ask support.`,
    } : {}),
    to_change_provider: "contact support@dealeraddendums.com",
  };
}

const ROLE_LABEL: Record<string, string> = { dealer_admin: "Dealer Admin", dealer_user: "Dealer User", dealer_restricted: "Dealer Restricted" };

async function usersList(admin: Admin, dealerId: string) {
  const a = admin as any;
  const [{ data: profs }, { data: invites }] = await Promise.all([
    a.from("profiles").select("full_name, email, role").eq("dealer_id", dealerId).in("role", Object.keys(ROLE_LABEL)).order("full_name"),
    a.from("invitations").select("email, role, expires_at, accepted_at").eq("dealer_id", dealerId).is("accepted_at", null).limit(50),
  ]);
  const pending = ((invites ?? []) as any[]).filter((i) => !i.expires_at || Date.parse(i.expires_at) > Date.now());
  return {
    users: ((profs ?? []) as any[]).map((p) => ({ name: p.full_name || p.email, email: p.email, role: ROLE_LABEL[p.role] ?? p.role })),
    pending_invitations: pending.map((i) => ({ email: i.email, role: ROLE_LABEL[i.role] ?? i.role })),
    where: "Users (sidebar)",
    // Stated here because Steven has twice invented "only a super admin can
    // create a Dealer Admin" when answering from this list.
    who_can_invite: "A Dealer Admin can invite any of the three roles — Dealer Admin, Dealer User, or Dealer Restricted (Users → + Invite User).",
  };
}

// ── Dispatcher (audited, time-boxed, never throws) ─────────────────────────

export async function runStevenTool(
  name: string,
  rawInput: unknown,
  claims: JwtClaims,
  conversationId: string | null,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const admin = createAdminSupabaseClient();
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const audit = (outcome: "ok" | "denied" | "error", target: string | null, detail: string | null) =>
    fireWrite((admin as any).from("steven_tool_calls").insert({
      user_id: claims.sub, role: claims.role, conversation_id: conversationId, tool: name,
      session_dealer_id: resolveEffectiveDealer(claims), target_dealer_id: target,
      outcome, detail: detail?.slice(0, 500) ?? null, duration_ms: Date.now() - started,
    }), "steven tool audit");

  if (!STEVEN_TOOL_NAMES.has(name)) {
    audit("error", null, "unknown tool");
    return { error: "unknown tool" };
  }
  try {
    const work = (async () => {
      const scope = await resolveScope(admin, claims, input);
      if (!scope.ok) {
        audit(scope.denied ? "denied" : "error", null, `${scope.message}${input.store ? ` (asked: ${String(input.store).slice(0, 80)})` : ""}`);
        return { error: scope.message, scope_refused: scope.denied };
      }
      let result: Record<string, unknown>;
      switch (name) {
        case "get_account_status": result = await accountStatus(admin, scope.dealerId); break;
        case "get_billing_status": result = await billingStatus(admin, claims, scope.dealerId); break;
        case "get_inventory_summary": result = await inventorySummary(admin, scope.dealerId); break;
        case "get_print_activity": result = await printActivity(admin, scope.dealerId); break;
        case "explain_vehicle_products":
          result = await explainVehicleProducts(admin, scope.dealerId, String(input.vin_or_stock ?? ""),
            typeof input.product_name === "string" ? input.product_name.slice(0, 120) : null);
          break;
        case "get_products": result = await productsList(admin, scope.dealerId); break;
        case "get_templates": result = await templatesInfo(admin, scope.dealerId); break;
        case "get_website_integration": result = await websiteIntegration(admin, scope.dealerId); break;
        case "get_users":
          if (!USER_LIST_ROLES.has(claims.role)) {
            audit("denied", scope.dealerId, "user list is admin-only");
            return { error: "Only a Dealer Admin (or group admin) can see the account's user list.", role_refused: true };
          }
          result = await usersList(admin, scope.dealerId);
          break;
        case "get_print_queue": result = await printQueue(admin, scope.dealerId); break;
        case "get_label_orders": result = await labelOrders(admin, scope.dealerId); break;
        case "get_feed_provider": result = await feedProvider(admin, scope.dealerId); break;
        default: result = { error: "unknown tool" };
      }
      audit("ok", scope.dealerId, null);
      return { store: scope.dealerName, ...result };
    })();
    return await Promise.race([
      work,
      new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve({ error: "timed out" }), TOOL_TIMEOUT_MS)),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[steven-tools] ${name} failed:`, msg);
    audit("error", null, msg);
    return { error: "unavailable right now" };
  }
}
