import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import {
  getTemplate,
  getPricing,
  listInvoices,
  billingConfigured,
  subscriptionTierLabel,
  getBillingStatus,
  type BillingPriceEntry,
  type BillingInvoice,
  type BillingExtensionState,
} from "@/lib/billing";
import { isOverAllowance, TRIAL_DAYS_CAP, TRIAL_PRINTS_CAP } from "@/lib/print-eligibility";
import { printedVehicleCount } from "@/lib/print-counts";

interface SubscriptionInfo {
  productId: string | null;
  name: string | null;
  price: number | null;
  nextInvoiceDate: string | null;
}

// Trial progress for the "Free" card copy (no-subscription dealers are on Trial).
interface TrialInfo {
  dayN: number;          // 1..daysCap, clamped
  printN: number;        // lifetime print count
  overAllowance: boolean;
  daysCap: number;
  printsCap: number;
}

interface BillingMeResponse {
  dealer: {
    id: string;
    name: string;
    billing_customer_id: string | null;
    internal_id: string | null;
  };
  subscription: SubscriptionInfo | null;
  pricing: BillingPriceEntry[];
  invoices: BillingInvoice[];
  outstandingAmount: number;
  trial: TrialInfo;
  /** Who pays. "group" → the subscription + invoices live on the group's
   *  da-billing customer; this dealer can't see/pay them. Drives the
   *  read-only group-billed summary in the UI. Absent/"self" → normal view. */
  billedBy?: "self" | "group";
  /** Group name when billedBy === "group". */
  groupName?: string | null;
  /** Friendly subscription tier ("Automatic Web") for the group-billed summary. */
  subscriptionTier?: string | null;
  /** False for group-billed dealers (no Change Plan / Pay). */
  canManage?: boolean;
  /** Group-billed only: the group's da-billing customer is past due → printing
   *  is paused. Same read the print lock uses; fail-open (false) on any error. */
  groupPastDue?: boolean;
  /** Self-service 10-day extension state for the RESPONSIBLE PAYER's customer
   *  (self-billed → own; group-billed → the group's). Null when da-billing is
   *  unreachable / no customer resolves. */
  extension?: BillingExtensionState | null;
  /** Whether THIS caller's role may request the extension: self-billed →
   *  dealer_admin+; group-billed → group_admin/super_admin only (a grant on
   *  the group customer lifts the lock for every member store). */
  extensionRequestAllowed?: boolean;
  notes?: string;
}

function computeTrial(
  createdAt: string | null,
  lifetimePrints: number,
  overrides?: { trial_ends_at?: string | null; trial_prints_cap?: number | null },
): TrialInfo {
  const createdMs = createdAt ? new Date(createdAt).getTime() : Date.now();
  // With an extend-trial override (migration 126) the window runs to
  // trial_ends_at, so express "day N of cap" against that longer window.
  const endsMs = overrides?.trial_ends_at
    ? new Date(overrides.trial_ends_at).getTime()
    : createdMs + TRIAL_DAYS_CAP * 86_400_000;
  const daysCap = Math.max(Math.round((endsMs - createdMs) / 86_400_000), 1);
  const dayN = Math.min(
    Math.max(Math.floor((Date.now() - createdMs) / 86_400_000) + 1, 1),
    daysCap,
  );
  return {
    dayN,
    printN: lifetimePrints,
    overAllowance: isOverAllowance({ created_at: createdAt, lifetime_prints: lifetimePrints, ...overrides }),
    daysCap,
    printsCap: overrides?.trial_prints_cap ?? TRIAL_PRINTS_CAP,
  };
}

async function resolveDealerId(
  req: NextRequest,
  claims: JwtClaims,
): Promise<{ dealerTextId: string } | { dealerError: NextResponse }> {
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    if (!claims.dealer_id) {
      return { dealerError: NextResponse.json({ error: "No dealer assigned" }, { status: 403 }) };
    }
    return { dealerTextId: claims.dealer_id };
  }
  // super_admin (in ghost mode) carries claims.dealer_id; otherwise needs ?dealer_id=
  if (claims.role === "super_admin" && claims.dealer_id) {
    return { dealerTextId: claims.dealer_id };
  }
  // group_admin managing a member dealer's billing while switched in: claims.dealer_id
  // is the selected active dealer (group-verified at selection). Honor it with a
  // defensive group re-check so the dealer-context Billing tab works without a param.
  if (claims.role === "group_admin" && claims.dealer_id) {
    const admin = createAdminSupabaseClient();
    const { data: dealer } = await admin
      .from("dealers")
      .select("group_id")
      .eq("dealer_id", claims.dealer_id)
      .maybeSingle<{ group_id: string | null }>();
    if (!dealer || dealer.group_id !== claims.group_id) {
      return { dealerError: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return { dealerTextId: claims.dealer_id };
  }
  const param = req.nextUrl.searchParams.get("dealer_id");
  if (!param) {
    return { dealerError: NextResponse.json({ error: "dealer_id param required" }, { status: 400 }) };
  }
  if (claims.role === "group_admin") {
    const admin = createAdminSupabaseClient();
    const { data: dealer } = await admin
      .from("dealers")
      .select("group_id")
      .eq("dealer_id", param)
      .maybeSingle<{ group_id: string | null }>();
    if (!dealer || dealer.group_id !== claims.group_id) {
      return { dealerError: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
  }
  return { dealerTextId: param };
}

/**
 * GET /api/billing/me
 *
 * Aggregates the dealer's billing state from da-billing + the platform's
 * dealers row. Returns:
 *   - dealer identifiers (id, name, billing_customer_id, internal_id)
 *   - subscription: current product/price/nextInvoiceDate from the
 *     da-billing template (null when no template exists yet)
 *   - pricing: full /pricing list so the Change Plan UI can show all tiers
 *   - invoices: filtered to this dealer's customerId
 *   - outstandingAmount: sum of pending+overdue invoice totals
 *
 * Used by ProfileClient's Billing tab.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const resolved = await resolveDealerId(req, claims);
  if ("dealerError" in resolved) return resolved.dealerError;

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, name, billing_customer_id, internal_id, created_at, subscription_billed_to, group_id, account_type, trial_ends_at, trial_prints_cap")
    .eq("dealer_id", resolved.dealerTextId)
    .maybeSingle<{
      id: string; name: string; billing_customer_id: string | null; internal_id: string | null;
      created_at: string | null; subscription_billed_to: "dealer" | "group" | null;
      group_id: string | null; account_type: string | null;
      trial_ends_at: string | null; trial_prints_cap: number | null;
    }>();

  if (!dealer) {
    return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  }

  // Trial progress (lifetime DISTINCT vehicles printed, same source as
  // canPrintForDealer — reprints don't inflate it) — drives the "Free"/"Trial"
  // card copy.
  const lifetimePrints = await printedVehicleCount(admin, { dealerId: resolved.dealerTextId });
  const trial = computeTrial(dealer.created_at, lifetimePrints, { trial_ends_at: dealer.trial_ends_at, trial_prints_cap: dealer.trial_prints_cap });

  // ── Group-billed dealer ───────────────────────────────────────────────────
  // The subscription + invoices live on the GROUP's da-billing customer, not
  // this dealer's — so there's no own template/invoices to fetch. Return a
  // read-only summary (plan + who pays) and skip da-billing entirely. Keyed on
  // subscription_billed_to === 'group' (NOT mere group membership): a self-billed
  // dealer that happens to sit in a group keeps the normal view below.
  if (dealer.subscription_billed_to === "group") {
    let groupName: string | null = null;
    let groupPastDue = false;
    let extension: BillingExtensionState | null = null;
    if (dealer.group_id) {
      const { data: g } = await admin
        .from("groups")
        .select("name, billing_customer_id")
        .eq("id", dealer.group_id)
        .maybeSingle<{ name: string; billing_customer_id: string | null }>();
      groupName = g?.name ?? null;
      // Group billing health — so a group-billed dealer understands a paused-
      // print state. Same getBillingStatus the print lock reads; fail-open.
      if (billingConfigured() && g?.billing_customer_id) {
        try {
          const status = await getBillingStatus(g.billing_customer_id);
          groupPastDue = status?.past_due === true;
          extension = status?.extension ?? null;
        } catch {
          /* fail open — never block the summary on a da-billing hiccup */
        }
      }
    }
    const payload: BillingMeResponse = {
      dealer: {
        id: dealer.id,
        name: dealer.name,
        billing_customer_id: dealer.billing_customer_id,
        internal_id: dealer.internal_id,
      },
      subscription: null,
      pricing: [],
      invoices: [],
      outstandingAmount: 0,
      trial,
      billedBy: "group",
      groupName,
      subscriptionTier: subscriptionTierLabel(dealer.account_type),
      canManage: false,
      groupPastDue,
      extension,
      // Group-billed: only group_admin/super_admin may extend — the grant
      // lands on the GROUP customer and lifts every member store's lock.
      extensionRequestAllowed: claims.role === "group_admin" || claims.role === "super_admin",
    };
    return NextResponse.json(payload);
  }

  if (!billingConfigured()) {
    const payload: BillingMeResponse = {
      dealer: {
        id: dealer.id,
        name: dealer.name,
        billing_customer_id: dealer.billing_customer_id,
        internal_id: dealer.internal_id,
      },
      subscription: null,
      pricing: [],
      invoices: [],
      outstandingAmount: 0,
      trial,
      notes: "Billing API not configured",
    };
    return NextResponse.json(payload);
  }

  // Prefer billing_customer_id (platform-created), fall back to internal_id
  // (legacy migrated dealers). Without either we can't talk to da-billing.
  const customerKey = dealer.billing_customer_id ?? dealer.internal_id;
  if (!customerKey) {
    const payload: BillingMeResponse = {
      dealer: {
        id: dealer.id,
        name: dealer.name,
        billing_customer_id: dealer.billing_customer_id,
        internal_id: dealer.internal_id,
      },
      subscription: null,
      pricing: [],
      invoices: [],
      outstandingAmount: 0,
      trial,
      notes: "No billing customer yet for this dealer",
    };
    return NextResponse.json(payload);
  }

  const [template, pricing, invoiceResult, billingStatus] = await Promise.all([
    getTemplate(customerKey).catch((err) => {
      console.error("[billing/me] getTemplate failed:", err instanceof Error ? err.message : err);
      return null;
    }),
    getPricing().catch((err) => {
      console.error("[billing/me] getPricing failed:", err instanceof Error ? err.message : err);
      return [] as BillingPriceEntry[];
    }),
    listInvoices(customerKey).catch((err) => {
      console.error("[billing/me] listInvoices failed:", err instanceof Error ? err.message : err);
      return { invoices: [], total: 0, outstandingAmount: 0 };
    }),
    // Extension state for the self-billed payer (fail-open null).
    getBillingStatus(customerKey).catch((err) => {
      console.error("[billing/me] getBillingStatus failed:", err instanceof Error ? err.message : err);
      return null;
    }),
  ]);

  let subscription: SubscriptionInfo | null = null;
  if (template && template.products.length > 0) {
    const first = template.products[0];
    subscription = {
      productId: first.productId ?? null,
      name: first.name ?? null,
      price: first.price ?? null,
      nextInvoiceDate: template.nextInvoiceDate ?? null,
    };
  }

  const payload: BillingMeResponse = {
    dealer: {
      id: dealer.id,
      name: dealer.name,
      billing_customer_id: dealer.billing_customer_id,
      internal_id: dealer.internal_id,
    },
    subscription,
    pricing,
    invoices: invoiceResult.invoices,
    outstandingAmount: invoiceResult.outstandingAmount,
    trial,
    billedBy: "self",
    extension: billingStatus?.extension ?? null,
    // Self-billed: dealer_admin and up may request; dealer_user may not.
    extensionRequestAllowed: claims.role !== "dealer_user",
  };
  return NextResponse.json(payload);
}
