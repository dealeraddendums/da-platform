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
  updateCustomer,
  billingConfigured,
  type BillingCustomerDetail,
} from "@/lib/billing";
import { calcGroupDiscountTier } from "@/lib/group-discount";

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

    // 5. Skip the round-trip when the value matches.
    const currentTier = Number(customer.subscriptionDiscount ?? 0);
    if (currentTier === newTier) {
      return;
    }

    // 6. Push the new tier.
    await updateCustomer(group.billing_customer_id, {
      // updateCustomer's typed fields don't include subscriptionDiscount;
      // lib/billing.ts forwards the JSON body verbatim to da-billing
      // PUT /customers/:id, so the extra field flows through the
      // existing customer-spread pattern on the server side.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscriptionDiscount: newTier,
    } as any);
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
