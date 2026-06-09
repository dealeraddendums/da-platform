import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import {
  getCustomer,
  listInvoices,
  billingConfigured,
  subscriptionTierLabel,
  type BillingCustomerDetail,
  type BillingInvoice,
} from "@/lib/billing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: { dealerId: string } };

interface DealerBillingDealer {
  id: string;
  dealer_id: string;
  name: string;
  billing_customer_id: string | null;
  subscription_billed_to: "dealer" | "group";
  group: { id: string; name: string } | null;
  /** Friendly plan label ("Automatic Web") — shown in the group-billed summary. */
  subscriptionTier: string | null;
}

interface GroupBilledResponse {
  scenario: "group_billed";
  dealer: DealerBillingDealer;
}

interface DealerBilledResponse {
  scenario: "dealer_billed";
  dealer: DealerBillingDealer;
  customer: BillingCustomerDetail | null;
  /** Unpaid (pending + overdue). */
  outstandingInvoices: BillingInvoice[];
  /** Paid only. */
  paidInvoices: BillingInvoice[];
  outstandingAmount: number;
}

/**
 * GET /api/billing/dealers/[dealerId]
 *
 * Returns the billing view a dealer (or someone acting on their behalf)
 * needs. Two scenarios:
 *
 *   - subscription_billed_to === "group": return scenario="group_billed"
 *     with the group name only. No customer/invoice data is exposed —
 *     the dealer is not authorised to see the group's billing.
 *
 *   - otherwise: return scenario="dealer_billed" with the da-billing
 *     customer + invoices split into outstanding (pending|overdue) and
 *     paid. customer is null when billing_customer_id is unset.
 *
 * Auth:
 *   - super_admin: any dealer
 *   - group_admin: dealers in their group only
 *   - dealer_admin: their own dealer only
 *   - dealer_user / dealer_restricted: 403 (read invoices via the
 *     existing /api/billing/me path if they need self-service)
 */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error || !claims) return error ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!billingConfigured()) return NextResponse.json({ error: "Billing not configured" }, { status: 500 });

  const admin = createAdminSupabaseClient();
  const { data: rawDealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, billing_customer_id, subscription_billed_to, account_type, groups(id, name)")
    .eq("id", params.dealerId)
    .maybeSingle();
  if (!rawDealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  const dealerRow = rawDealer as {
    id: string;
    dealer_id: string;
    name: string;
    billing_customer_id: string | null;
    subscription_billed_to: "dealer" | "group" | null;
    account_type: string | null;
    groups: { id: string; name: string } | null;
  };

  // Authorisation
  if (claims.role === "super_admin") {
    /* allowed */
  } else if (claims.role === "group_admin") {
    if (!dealerRow.groups || dealerRow.groups.id !== claims.group_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (claims.role === "dealer_admin") {
    if (dealerRow.dealer_id !== claims.dealer_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const dealer: DealerBillingDealer = {
    id: dealerRow.id,
    dealer_id: dealerRow.dealer_id,
    name: dealerRow.name,
    billing_customer_id: dealerRow.billing_customer_id,
    subscription_billed_to: dealerRow.subscription_billed_to === "group" ? "group" : "dealer",
    group: dealerRow.groups,
    subscriptionTier: subscriptionTierLabel(dealerRow.account_type),
  };

  // ── Scenario A: group billed ──────────────────────────────────────────────
  if (dealer.subscription_billed_to === "group" && dealer.group) {
    const payload: GroupBilledResponse = { scenario: "group_billed", dealer };
    return NextResponse.json(payload);
  }

  // ── Scenario B: dealer billed ─────────────────────────────────────────────
  if (!dealer.billing_customer_id) {
    const payload: DealerBilledResponse = {
      scenario: "dealer_billed",
      dealer,
      customer: null,
      outstandingInvoices: [],
      paidInvoices: [],
      outstandingAmount: 0,
    };
    return NextResponse.json(payload);
  }

  try {
    const [customer, invoiceResult] = await Promise.all([
      getCustomer(dealer.billing_customer_id),
      listInvoices(dealer.billing_customer_id),
    ]);
    const outstanding = invoiceResult.invoices.filter(i => i.status === "pending" || i.status === "overdue");
    const paid = invoiceResult.invoices.filter(i => i.status === "paid");
    const payload: DealerBilledResponse = {
      scenario: "dealer_billed",
      dealer,
      customer,
      outstandingInvoices: outstanding,
      paidInvoices: paid,
      outstandingAmount: invoiceResult.outstandingAmount,
    };
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
