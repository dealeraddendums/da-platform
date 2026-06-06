import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import {
  getTemplate,
  getPricing,
  listInvoices,
  billingConfigured,
  type BillingPriceEntry,
  type BillingInvoice,
} from "@/lib/billing";
import { isOverAllowance, TRIAL_DAYS_CAP, TRIAL_PRINTS_CAP } from "@/lib/print-eligibility";

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
  notes?: string;
}

function computeTrial(createdAt: string | null, lifetimePrints: number): TrialInfo {
  const createdMs = createdAt ? new Date(createdAt).getTime() : Date.now();
  const dayN = Math.min(
    Math.max(Math.floor((Date.now() - createdMs) / 86_400_000) + 1, 1),
    TRIAL_DAYS_CAP,
  );
  return {
    dayN,
    printN: lifetimePrints,
    overAllowance: isOverAllowance({ created_at: createdAt, lifetime_prints: lifetimePrints }),
    daysCap: TRIAL_DAYS_CAP,
    printsCap: TRIAL_PRINTS_CAP,
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
    .select("id, name, billing_customer_id, internal_id, created_at")
    .eq("dealer_id", resolved.dealerTextId)
    .maybeSingle<{ id: string; name: string; billing_customer_id: string | null; internal_id: string | null; created_at: string | null }>();

  if (!dealer) {
    return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  }

  // Trial progress (lifetime prints from print_history, same source as
  // canPrintForDealer) — drives the "Free"/"Trial" card copy.
  const { count: lifetimePrints } = await admin
    .from("print_history")
    .select("id", { count: "exact", head: true })
    .eq("dealer_id", resolved.dealerTextId);
  const trial = computeTrial(dealer.created_at, lifetimePrints ?? 0);

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

  const [template, pricing, invoiceResult] = await Promise.all([
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
  };
  return NextResponse.json(payload);
}
