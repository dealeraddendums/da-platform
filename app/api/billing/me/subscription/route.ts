import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import {
  getTemplate,
  putTemplate,
  deleteTemplate,
  createCustomer,
  createTemplate,
  archiveCustomer,
  customerExists,
  setBillingState,
  firstOfNextMonthIso,
  subscriptionDescriptorFor,
  billingConfigured,
  type BillingProduct,
} from "@/lib/billing";
import { fireDealerReliable } from "@/lib/sync-hubspot";
import { fireConversionWebhook } from "@/lib/marketing-webhook";
import { sendMandrillEmail } from "@/lib/mandrill";

const SUPPORT_EMAIL = process.env.SUPPORT_NOTIFICATION_EMAIL ?? "support@dealeraddendums.com";

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
  } else if (claims.role === "group_admin" && claims.dealer_id) {
    // group_admin managing a member dealer's billing while switched in: honor the
    // active dealer (claims.dealer_id) with a defensive group re-check, so the
    // dealer-context Billing tab works without a ?dealer_id= param.
    const { data: chk } = await admin
      .from("dealers")
      .select("group_id")
      .eq("dealer_id", claims.dealer_id)
      .maybeSingle<{ group_id: string | null }>();
    if (!chk || chk.group_id !== claims.group_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
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
    .select("id, name, internal_id, billing_customer_id, billing_id, legacy_id, account_type, primary_contact, primary_contact_email, phone, address, state")
    .eq("dealer_id", dealerTextId)
    .maybeSingle<{
      id: string; name: string; internal_id: string | null; billing_customer_id: string | null;
      billing_id: string | null; legacy_id: number | null; account_type: string | null;
      primary_contact: string | null; primary_contact_email: string | null;
      phone: string | null; address: string | null; state: string | null;
    }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  if (!dealer.internal_id) {
    return NextResponse.json({ error: "Dealer missing internal_id (line item tag)" }, { status: 409 });
  }

  // On the new platform EVERY paying dealer — native or migrated — bills via
  // da-billing (FreshBooks is suspended at cutover), so a trial→paid upgrade must
  // ensure a da-billing customer exists regardless of legacy_id. The old code
  // skipped customer-create when legacy_id was set (a stale FreshBooks
  // assumption), so migrated trials never converted: no customer, account_type
  // stuck on Trial → print locked + "Upgrade Now" persists.
  //
  // "Conversion" = the dealer is NOT already on a paid tier (native Trial OR
  // migrated Trial with legacy_id). An already-paying dealer swapping tiers is
  // not a conversion — it keeps its account_type + funnel date.
  const wasPaying = subscriptionDescriptorFor(dealer.account_type) != null;

  // Resolve / provision the da-billing customer. Link-don't-duplicate: a migrated
  // dealer already carries its da-billing customer UUID in billing_id — if it
  // still resolves, LINK it instead of creating a dup (~1.8k migrated customers).
  // Otherwise create one. Always against the da-billing customer UUID, never
  // internal_id (templates are keyed by customer UUID).
  let effectiveCustomerKey = dealer.billing_customer_id;
  let createdCustomerId: string | null = null; // a customer THIS request created (for rollback)
  if (!effectiveCustomerKey) {
    // Release a legacy internal_id-keyed ORPHAN template first (task #125): dead data
    // from the old Case-2 putTemplate(internal_id) path — a template whose "customer"
    // (the internal_id) doesn't exist. da-billing's duplicate-dealer guard would
    // otherwise reject the new template ("dealer already on a template for
    // {internal_id}"). Safe to delete: no customer backs it, so it can't bill.
    if ((await getTemplate(dealer.internal_id)) && !(await customerExists(dealer.internal_id))) {
      await deleteTemplate(dealer.internal_id);
    }
    if (dealer.billing_id && (await customerExists(dealer.billing_id))) {
      effectiveCustomerKey = dealer.billing_id;
    } else {
      const cust = await createCustomer({
        name: (dealer.primary_contact ?? dealer.name).trim(),
        company: dealer.name,
        email: dealer.primary_contact_email ?? undefined,
        phone: dealer.phone ?? undefined,
        address: dealer.address ?? undefined,
        state: dealer.state ?? undefined,
        isGroup: false,
        // Self-serve subscription: dealer is paying now → bill immediately.
        billingState: "active",
      });
      effectiveCustomerKey = cust.id;
      createdCustomerId = cust.id;
    }
    // Persist the customer id (+ template_id mirror) BEFORE the template write so
    // a retry sees billing_customer_id and skips re-provisioning.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("dealers")
      .update({ billing_customer_id: effectiveCustomerKey, template_id: effectiveCustomerKey })
      .eq("id", dealer.id);
  }

  // Ensure billing state is 'active' for any conversion — a pre-existing
  // customer may still be in 'setup' mode (invoices held). Best-effort so it
  // never blocks the upgrade if the billing-state endpoint is unreachable.
  if (!wasPaying && effectiveCustomerKey) {
    try { await setBillingState(effectiveCustomerKey, "active"); } catch { /* non-blocking */ }
  }

  // No price is sent — da-billing is the sole price authority and canonicalizes
  // sub-*/dms-setup server-side; discounts apply via subscriptionDiscount.
  // See docs/billing-price-integrity.md.
  const newSubLine: BillingProduct = {
    productId: descriptor.key,
    name: descriptor.name,
    quantity: 1,
    lineItemDescription: `${dealer.internal_id}::${dealer.name}`,
  };

  // Build the product list. Merge over any existing template, preserving
  // non-subscription (label-order) lines, identified by productId NOT starting
  // with "sub-". A freshly created/linked customer with no template yet → a
  // brand-new template with just the sub line.
  const current = await getTemplate(effectiveCustomerKey);
  const merged: BillingProduct[] = current
    ? [newSubLine, ...current.products.filter((p) => !p.productId?.startsWith?.("sub-"))]
    : [newSubLine];

  // sub-auto-dms → ensure a one-time DMS Setup Charge (de-duped by productId or
  // the "<internal_id>::dms-setup" tag so re-runs never double-bill).
  if (descriptor.key === "sub-auto-dms") {
    const hasSetup = merged.some(p =>
      p.productId === "dms-setup"
      || (p as BillingProduct & { lineItemDescription?: string }).lineItemDescription === `${dealer.internal_id}::dms-setup`
    );
    if (!hasSetup) {
      merged.push({
        productId: "dms-setup",
        name: "One Time DMS Setup Charge",
        quantity: 1,
        lineItemDescription: `${dealer.internal_id}::dms-setup`,
      } as BillingProduct & { lineItemDescription: string });
    }
  }

  // Write the template. Defensive (task #125): if it fails AND we just created the
  // customer this request, archive that customer and revert the persisted pointer so
  // we never leave a dangling customer (or a billing_customer_id pointing at a
  // template-less one). A linked pre-existing customer is left intact — it's real,
  // and a retry will reattach the template.
  try {
    if (current) {
      await putTemplate(effectiveCustomerKey, merged);
    } else {
      await createTemplate({
        customerId: effectiveCustomerKey,
        products: merged,
        nextInvoiceDate: firstOfNextMonthIso(),
        scheduleInterval: "monthly",
      });
    }
  } catch (err) {
    if (createdCustomerId) {
      try { await archiveCustomer(createdCustomerId); } catch { /* best-effort rollback */ }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from("dealers")
        .update({ billing_customer_id: null, template_id: null })
        .eq("id", dealer.id);
    }
    throw err;
  }

  // Conversion (dealer was NOT already on a paid tier) → flip Trial/expired →
  // the paid account_type (unblocks the print gate, clears the "Upgrade Now"
  // CTA), stamp the funnel date, clear any downgraded_at, and fire the reliable
  // HubSpot sync (lifecyclestage Trial → Customer). Runs for native AND migrated
  // dealers — the legacy_id-based skip is gone. An already-paying dealer swapping
  // tiers keeps its account_type + funnel date.
  if (!wasPaying) {
    const newAccountType = ACCOUNT_TYPE_FOR_TIER[descriptor.key];
    if (newAccountType && newAccountType !== dealer.account_type) {
      // Stamp converted_at + clear any prior downgraded_at so a re-conversion
      // within the grace window re-stamps the funnel date. Drives the BI tab's
      // "Trials converted to paying" metric (migration 095).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from("dealers")
        .update({ account_type: newAccountType, converted_at: new Date().toISOString(), downgraded_at: null })
        .eq("id", dealer.id);
    }
    fireDealerReliable(dealer.id, "trial→paid conversion (lifecycle)");
    // Notify Marketing OS so its funnel's Converted stage lights up in real
    // time. dealerTextId (ss_*) is the marketing_leads.da_dealer_id join key.
    // Fire-and-forget — never blocks/breaks the upgrade.
    fireConversionWebhook({
      dealerId: dealerTextId,
      convertedAt: new Date().toISOString(),
      plan: descriptor.name,
    });
    // Staff notification — fire-and-forget.
    sendMandrillEmail({
      subject: `Trial Converted to Paid: ${dealer.name}`,
      html: `<p><strong>Trial account has upgraded to a paid subscription.</strong></p>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
  <tr><td style="padding:4px 12px 4px 0;color:#666">Dealership</td><td><strong>${dealer.name}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Plan</td><td>${descriptor.name}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Contact</td><td>${dealer.primary_contact ?? "—"} &lt;${dealer.primary_contact_email ?? "—"}&gt;</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Dealer ID</td><td>${dealerTextId}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Converted</td><td>${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT</td></tr>
</table>`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DA Platform",
      to: [{ email: SUPPORT_EMAIL, name: "DA Support" }],
    }).catch(err => console.error("[notify-support] trial→paid:", err instanceof Error ? err.message : err));
  }

  return NextResponse.json({
    ok: true,
    tier: descriptor.key,
    name: descriptor.name,
    customerId: effectiveCustomerKey,
    converted: !wasPaying,
  });
}
