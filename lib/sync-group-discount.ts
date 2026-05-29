// Auto-apply the group subscription discount based on active member-dealer
// count. Called fire-and-forget from:
//
//   - POST   /api/groups/[groupId]/dealers           (dealer added)
//   - DELETE /api/groups/[groupId]/dealers/[dealerId] (dealer removed)
//   - PATCH  /api/dealers/[id] with { active: false } (dealer deactivated)
//
// Skips entirely when the group's da-billing customer has
// discountLocked=true — operators can hand-edit subscriptionDiscount
// and the platform will never overwrite their value.
//
// DA Platform never sets prices. This sync only writes
// subscriptionDiscount (a percentage 0-100); product prices are owned
// by da-billing.

import { createAdminSupabaseClient } from "@/lib/db";
import {
  getCustomer,
  billingConfigured,
  type BillingCustomerDetail,
} from "@/lib/billing";
import { calcGroupDiscountTier } from "@/lib/group-discount";

// The four values calcGroupDiscountTier can ever emit. Any
// subscriptionDiscount that isn't one of these is, by definition, a
// custom value an operator hand-set in da-billing — and this sync must
// not touch it under any circumstances.
const AUTO_TIER_VALUES: ReadonlySet<number> = new Set([0, 10, 20, 30]);

// da-billing's Customer type includes `subscriptionDiscount` and
// `discountLocked` but lib/billing.ts's BillingCustomerDetail is the
// loose-typed projection we read from /customers/:id, so extend it
// inline here rather than upstream the rename.
interface CustomerWithDiscount extends BillingCustomerDetail {
  subscriptionDiscount?: number;
  discountLocked?: boolean;
}

/**
 * Recompute the group's discount tier from current active member count
 * and PUT to da-billing iff the value would change AND the customer
 * isn't discountLocked. Never throws — failures log to console.
 */
export async function syncGroupDiscount(groupId: string): Promise<void> {
  if (!billingConfigured()) {
    console.log(`[group-discount] billing not configured, skipping for group ${groupId}`);
    return;
  }

  const admin = createAdminSupabaseClient();

  try {
    // 1. Load group's billing_customer_id.
    const { data: group } = await admin
      .from("groups")
      .select("id, name, billing_customer_id")
      .eq("id", groupId)
      .maybeSingle<{ id: string; name: string; billing_customer_id: string | null }>();
    if (!group) {
      console.warn(`[group-discount] group ${groupId} not found`);
      return;
    }
    if (!group.billing_customer_id) {
      console.log(`[group-discount] group ${groupId} (${group.name}) has no billing_customer_id, skipping`);
      return;
    }

    // 2. Count active dealers in the group.
    const { count, error: countErr } = await admin
      .from("dealers")
      .select("id", { count: "exact", head: true })
      .eq("group_id", groupId)
      .eq("active", true);
    if (countErr) {
      console.error(`[group-discount] dealer count failed for group ${groupId}:`, countErr.message);
      return;
    }
    const dealerCount = count ?? 0;
    const newTier = calcGroupDiscountTier(dealerCount);

    // 3. Fetch current customer state.
    const customer = (await getCustomer(group.billing_customer_id)) as CustomerWithDiscount | null;
    if (!customer) {
      console.warn(`[group-discount] da-billing customer ${group.billing_customer_id} not found for group ${groupId}`);
      return;
    }

    // 4. Locked wins, no matter the tier.
    if (customer.discountLocked === true) {
      console.log(`[group-discount] group ${groupId} (${group.name}) is discountLocked — skipping (would have been ${newTier}%)`);
      return;
    }

    // 5. Custom-value guard: if the current subscriptionDiscount isn't one
    //    of the auto-tier values (0/10/20/30), an operator has hand-set it
    //    in da-billing and the sync must not touch it. This catches the
    //    case where discountLocked wasn't flipped but the value is clearly
    //    not auto-tier (e.g. 17%). Prevents a dealer-count change from
    //    wiping a custom discount.
    const currentTier = Number(customer.subscriptionDiscount ?? 0);
    if (!AUTO_TIER_VALUES.has(currentTier)) {
      console.log(
        `[group-discount] group ${groupId} (${group.name}) has custom subscriptionDiscount=${currentTier}% — skipping (auto-tier would have been ${newTier}%)`,
      );
      return;
    }

    // 6. Skip the round-trip when the value matches.
    if (currentTier === newTier) {
      return;
    }

    // 7. Push the new tier. PUT /customers/:id directly here (instead of
    //    via updateCustomer) so we can tag this request with the
    //    X-DA-Auto-Tier-Sync header — da-billing uses that as a second
    //    line of defense, ignoring subscriptionDiscount in the body when
    //    the header is present and the existing value is non-auto-tier.
    const BASE = "https://billing.dealeraddendums.com/api/v1";
    const apiKey = process.env.BILLING_API_KEY;
    if (!apiKey) {
      console.warn("[group-discount] BILLING_API_KEY not set — skipping");
      return;
    }
    const res = await fetch(`${BASE}/customers/${encodeURIComponent(group.billing_customer_id)}`, {
      method: "PUT",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
        "X-DA-Auto-Tier-Sync": "1",
      },
      body: JSON.stringify({ subscriptionDiscount: newTier }),
    });
    if (!res.ok) {
      console.error(`[group-discount] PUT failed for group ${groupId}: ${res.status} ${await res.text().catch(() => "")}`);
      return;
    }
    console.log(`[group-discount] group ${groupId} (${group.name}): ${dealerCount} active dealers → ${currentTier}% → ${newTier}%`);
  } catch (err) {
    console.error(
      `[group-discount] sync failed for group ${groupId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Fire-and-forget convenience wrapper. */
export function fireGroupDiscountSync(groupId: string): void {
  void syncGroupDiscount(groupId);
}
