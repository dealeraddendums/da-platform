import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { billingConfigured, requestBillingExtension } from "@/lib/billing";
import { invalidateBillingStatusCache } from "@/lib/print-eligibility";

export const dynamic = "force-dynamic";

// (Not exported — route files may only export handlers/config.)
const GROUP_BILLED_EXTENSION_MESSAGE =
  "Billing is managed by your group — contact your group admin to request an extension.";

/**
 * POST /api/billing/request-extension — dealer self-service one-time 10-day
 * past-due extension (auto-granted, one per rolling 90 days; da-billing
 * enforces the throttle and owns the grant).
 *
 * The da-billing customer is resolved SERVER-SIDE from the dealer row — never
 * from the client. Responsible-payer rule mirrors the print lock
 * (lib/print-eligibility dealerPastDue): subscription_billed_to='group' → the
 * GROUP's customer, else the dealer's own (billing_customer_id, falling back
 * to internal_id like /api/billing/me).
 *
 * Authorization:
 *   - self-billed dealer → dealer_admin on that dealer, group_admin of its
 *     group, or super_admin. dealer_user may not request.
 *   - group-billed dealer → group_admin/super_admin ONLY: the grant lands on
 *     the group customer and lifts the print lock for EVERY member store, so
 *     one store's admin must not silently extend the whole group.
 *
 * Body: { dealer_id?: string } (text dealer_id; defaults to the caller's own
 * dealer context). Money-safe: da-billing only moves the grace window.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!billingConfigured()) {
    return NextResponse.json({ error: "Billing API not configured" }, { status: 503 });
  }

  let body: { dealer_id?: string } = {};
  try { body = await req.json(); } catch { /* body optional */ }

  // Resolve the target dealer text id from the caller's context (same shape
  // as /api/billing/me): dealer roles → own dealer; group_admin → active
  // dealer or explicit param (group-verified below); super_admin → ghost
  // context or explicit param.
  const dealerTextId = body.dealer_id?.trim() || claims.dealer_id || null;
  if (!dealerTextId) {
    return NextResponse.json({ error: "No dealer context" }, { status: 400 });
  }
  if ((claims.role === "dealer_admin" || claims.role === "dealer_user") && dealerTextId !== claims.dealer_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Only a dealer admin can request a billing extension." }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, name, dealer_id, billing_customer_id, internal_id, subscription_billed_to, group_id")
    .eq("dealer_id", dealerTextId)
    .maybeSingle<{
      id: string; name: string; dealer_id: string;
      billing_customer_id: string | null; internal_id: string | null;
      subscription_billed_to: "dealer" | "group" | null; group_id: string | null;
    }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  // group_admin must own the dealer's group (both self- and group-billed cases).
  if (claims.role === "group_admin" && dealer.group_id !== claims.group_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Resolve the RESPONSIBLE PAYER's da-billing customer.
  let customerId: string | null;
  if (dealer.subscription_billed_to === "group" && dealer.group_id) {
    // Group-billed: the grant covers the whole group → group_admin/super_admin only.
    if (claims.role !== "group_admin" && claims.role !== "super_admin") {
      return NextResponse.json({ error: GROUP_BILLED_EXTENSION_MESSAGE, groupBilled: true }, { status: 403 });
    }
    const { data: g } = await admin
      .from("groups")
      .select("billing_customer_id")
      .eq("id", dealer.group_id)
      .maybeSingle<{ billing_customer_id: string | null }>();
    customerId = g?.billing_customer_id ?? null;
  } else {
    customerId = dealer.billing_customer_id ?? dealer.internal_id ?? null;
  }
  if (!customerId) {
    return NextResponse.json({ error: "No billing customer found for this account." }, { status: 404 });
  }

  try {
    const result = await requestBillingExtension(customerId, claims.email ?? claims.sub ?? null);
    if (result.granted) {
      // da-billing also fires the cache-invalidate webhook; bust locally too so
      // the print lock lifts on this box even if the webhook is delayed.
      invalidateBillingStatusCache(customerId);
      console.log(`[billing-extension] granted dealer=${dealer.dealer_id} payer=${customerId} by=${claims.email ?? claims.sub} until=${result.protectedUntil}`);
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Extension request failed" }, { status: 502 });
  }
}
