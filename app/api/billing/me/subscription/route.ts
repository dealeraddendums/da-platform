import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import {
  getTemplate,
  putTemplate,
  createCustomer,
  createTemplate,
  firstOfNextMonthIso,
  lookupPrice,
  subscriptionDescriptorFor,
  billingConfigured,
  type BillingProduct,
} from "@/lib/billing";
import { fireDealerReliable } from "@/lib/sync-hubspot";

// dealers.account_type value for each tier — flips Trial → a paying type on
// conversion so the print gate unblocks and HubSpot moves Trial → Customer.
const ACCOUNT_TYPE_FOR_TIER: Record<string, string> = {
  "sub-manual": "Manual",
  "sub-auto-web": "Automatic Web",
  "sub-auto-dms": "Automatic DMS",
};

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
    .select("id, name, internal_id, billing_customer_id, legacy_id, account_type, primary_contact, primary_contact_email, phone, address, state")
    .eq("dealer_id", dealerTextId)
    .maybeSingle<{
      id: string; name: string; internal_id: string | null; billing_customer_id: string | null;
      legacy_id: number | null; account_type: string | null;
      primary_contact: string | null; primary_contact_email: string | null;
      phone: string | null; address: string | null; state: string | null;
    }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  if (!dealer.internal_id) {
    return NextResponse.json({ error: "Dealer missing internal_id (line item tag)" }, { status: 409 });
  }

  // Three da-billing customer cases:
  //   1. billing_customer_id set         → existing platform customer (tier swap).
  //   2. null + legacy_id set            → legacy dealer; FreshBooks customer is
  //                                         keyed by internal_id (don't recreate).
  //   3. null + legacy_id null (native)  → TRIAL → PAID conversion: no da-billing
  //                                         customer exists yet (billing skipped at
  //                                         trial) — create customer + template now.
  const isConversion = !dealer.billing_customer_id && dealer.legacy_id == null;
  const customerKey = dealer.billing_customer_id ?? dealer.internal_id;

  // Look up the new price; abort if /pricing doesn't have an entry.
  const newPrice = await lookupPrice(descriptor.key);
  if (newPrice == null) {
    return NextResponse.json(
      { error: `No da-billing price entry for "${descriptor.key}". Update Settings → Pricing in da-billing first.` },
      { status: 409 },
    );
  }

  const newSubLine: BillingProduct = {
    productId: descriptor.key,
    name: descriptor.name,
    quantity: 1,
    price: newPrice,
    lineItemDescription: `${dealer.internal_id}::${dealer.name}`,
  };

  // Build the product list. Conversion → brand-new template (just the sub line).
  // Otherwise merge over the existing template, preserving non-subscription
  // (label-order) lines, identified by productId NOT starting with "sub-".
  let merged: BillingProduct[];
  if (isConversion) {
    merged = [newSubLine];
  } else {
    const current = await getTemplate(customerKey);
    merged = current
      ? [newSubLine, ...current.products.filter((p) => !p.productId?.startsWith?.("sub-"))]
      : [newSubLine];
  }

  // sub-auto-dms → ensure a one-time DMS Setup Charge (de-duped by productId or
  // the "<internal_id>::dms-setup" tag so re-runs never double-bill).
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

  let effectiveCustomerKey = customerKey;
  if (isConversion) {
    // First subscription for a trial dealer — create the da-billing customer +
    // recurring template (reuses the create path from POST /api/dealers).
    const cust = await createCustomer({
      name: (dealer.primary_contact ?? dealer.name).trim(),
      company: dealer.name,
      email: dealer.primary_contact_email ?? undefined,
      phone: dealer.phone ?? undefined,
      address: dealer.address ?? undefined,
      state: dealer.state ?? undefined,
      isGroup: false,
    });
    effectiveCustomerKey = cust.id;
    // Persist the customer id (+ template_id mirror) BEFORE creating the
    // template so a retry sees billing_customer_id and takes the existing path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("dealers")
      .update({ billing_customer_id: cust.id, template_id: cust.id })
      .eq("id", dealer.id);
    await createTemplate({
      customerId: cust.id,
      products: merged,
      nextInvoiceDate: firstOfNextMonthIso(),
      scheduleInterval: "monthly",
    });
  } else {
    await putTemplate(customerKey, merged);
  }

  // Conversion only: flip Trial → the paid account_type (unblocks the print
  // gate) and fire the reliable HubSpot sync (lifecyclestage Trial → Customer).
  // Existing paying dealers swapping tiers keep their account_type + behavior.
  if (isConversion) {
    const newAccountType = ACCOUNT_TYPE_FOR_TIER[descriptor.key];
    if (newAccountType && newAccountType !== dealer.account_type) {
      await admin.from("dealers").update({ account_type: newAccountType }).eq("id", dealer.id);
    }
    fireDealerReliable(dealer.id, "trial→paid conversion (lifecycle)");
  }

  return NextResponse.json({
    ok: true,
    tier: descriptor.key,
    name: descriptor.name,
    price: newPrice,
    customerId: effectiveCustomerKey,
    converted: isConversion,
  });
}
