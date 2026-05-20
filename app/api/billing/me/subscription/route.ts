import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import {
  getTemplate,
  putTemplate,
  lookupPrice,
  subscriptionDescriptorFor,
  billingConfigured,
  type BillingProduct,
} from "@/lib/billing";

/**
 * PATCH /api/billing/me/subscription
 * Body: { tier: "manual" | "auto-web" | "auto-dms" }  (or full product names)
 *
 * Swap the dealer's recurring-template subscription product to the new
 * tier at the current da-billing price. Effective on the next invoice
 * (1st of next month) — no proration. dealer_admin only; group_admin /
 * super_admin can act on a dealer's behalf via the ghost-mode dealer_id
 * already in claims.
 *
 * Implementation:
 *   1. Resolve dealer → billing_customer_id (or internal_id fallback)
 *   2. Look up new price from da-billing /pricing
 *   3. Read current template, swap the first product (preserving any
 *      label-order lines that were appended via /api/orders/labels)
 *   4. PUT the merged products array back to da-billing
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // dealer_admin manages their own subscription. super_admin can manage any.
  // dealer_user / dealer_restricted read-only.
  if (
    claims.role !== "dealer_admin"
    && claims.role !== "super_admin"
    && claims.role !== "group_admin"
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!billingConfigured()) {
    return NextResponse.json({ error: "Billing API not configured" }, { status: 500 });
  }

  let body: { tier?: string };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const tier = body.tier?.trim();
  if (!tier) return NextResponse.json({ error: "tier required" }, { status: 400 });

  const descriptor = subscriptionDescriptorFor(tier);
  if (!descriptor) {
    return NextResponse.json({ error: `Unknown subscription tier "${tier}"` }, { status: 400 });
  }

  // Resolve the acting dealer.
  const admin = createAdminSupabaseClient();
  let dealerTextId: string | null = null;
  if (claims.role === "dealer_admin") {
    dealerTextId = claims.dealer_id;
  } else {
    const param = req.nextUrl.searchParams.get("dealer_id");
    if (!param) return NextResponse.json({ error: "dealer_id required" }, { status: 400 });
    dealerTextId = param;
    if (claims.role === "group_admin") {
      const { data: chk } = await admin
        .from("dealers")
        .select("group_id")
        .eq("dealer_id", dealerTextId)
        .maybeSingle<{ group_id: string | null }>();
      if (!chk || chk.group_id !== claims.group_id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }
  }
  if (!dealerTextId) return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, name, internal_id, billing_customer_id")
    .eq("dealer_id", dealerTextId)
    .maybeSingle<{ id: string; name: string; internal_id: string | null; billing_customer_id: string | null }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  const customerKey = dealer.billing_customer_id ?? dealer.internal_id;
  if (!customerKey) {
    return NextResponse.json({ error: "Dealer has no da-billing customer" }, { status: 409 });
  }
  if (!dealer.internal_id) {
    return NextResponse.json({ error: "Dealer missing internal_id (line item tag)" }, { status: 409 });
  }

  // Look up the new price; abort if /pricing doesn't have an entry.
  const newPrice = await lookupPrice(descriptor.key);
  if (newPrice == null) {
    return NextResponse.json(
      { error: `No da-billing price entry for "${descriptor.key}". Update Settings → Pricing in da-billing first.` },
      { status: 409 },
    );
  }

  // Read current template + merge. The subscription line is identified by
  // productId starting with "sub-" — preserve any label-order line items
  // appended via /api/orders/labels.
  const current = await getTemplate(customerKey);
  const newSubLine: BillingProduct = {
    productId: descriptor.key,
    name: descriptor.name,
    quantity: 1,
    price: newPrice,
    lineItemDescription: `${dealer.internal_id}::${dealer.name}`,
  };

  let merged: BillingProduct[];
  if (!current) {
    // No template yet — create implicitly by PUTting (createTemplate would
    // require nextInvoiceDate which is up to da-billing). PUT with the new
    // sub line, leaving da-billing to set defaults if it supports that.
    merged = [newSubLine];
  } else {
    const nonSub = current.products.filter((p) => !p.productId?.startsWith?.("sub-"));
    merged = [newSubLine, ...nonSub];
  }

  // When the new tier is sub-auto-dms, ensure a one-time DMS Setup Charge
  // is present. Skip if the dealer already has one — detect by productId
  // OR by the "<internal_id>::dms-setup" tag so re-runs never double-bill.
  if (descriptor.key === "sub-auto-dms") {
    const hasSetup = merged.some(p =>
      p.productId === "dms-setup"
      || (p as BillingProduct & { lineItemDescription?: string }).lineItemDescription === `${dealer.internal_id}::dms-setup`
    );
    if (!hasSetup) {
      const setupPrice = (await lookupPrice("dms-setup")) ?? 0;
      merged.push({
        productId: "dms-setup",
        name: "One Time DMS Setup Charge",
        quantity: 1,
        price: setupPrice,
        lineItemDescription: `${dealer.internal_id}::dms-setup`,
      } as BillingProduct & { lineItemDescription: string });
    }
  }

  await putTemplate(customerKey, merged);

  return NextResponse.json({
    ok: true,
    tier: descriptor.key,
    name: descriptor.name,
    price: newPrice,
    customerId: customerKey,
  });
}
