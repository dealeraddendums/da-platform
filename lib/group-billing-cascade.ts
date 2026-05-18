// Group-billing cascade helpers for Events 3 & 4.
//
// When a dealer is added to a group with subscription_billed_to='group' or
// labels_billed_to='group', their subscription line moves to the group's
// template and the dealer's own template gets a $0 placeholder. When
// removed from the group, the reverse happens.
//
// Line items added under cascade are tagged with a stable
// `cascadeFromDealer` field on the BillingProduct payload so the
// unassign path can find and remove them again. da-billing's PUT template
// replaces products wholesale, so the helpers always read+merge+write.

import { createAdminSupabaseClient } from "@/lib/db";
import {
  appendToTemplate,
  createCustomer,
  getTemplate,
  putTemplate,
  type BillingProduct,
} from "@/lib/billing";

interface DealerSnap {
  id: string;                // dealers.id UUID
  name: string;
  billing_customer_id: string | null;
  internal_id: string | null;  // da-billing _ID (stable, used to tag line items)
  subscription_billed_to: "dealer" | "group";
  labels_billed_to: "dealer" | "group";
  account_type: string | null;
}

interface GroupSnap {
  id: string;
  name: string;
  billing_customer_id: string | null;
}

function dealerCustomerKey(d: DealerSnap): string | null {
  return d.billing_customer_id ?? d.internal_id ?? null;
}

async function ensureGroupCustomer(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  group: GroupSnap,
): Promise<string | null> {
  if (group.billing_customer_id) return group.billing_customer_id;
  const created = await createCustomer({
    name: group.name,
    company: group.name,
    isGroup: true,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from("groups")
    .update({ billing_customer_id: created.id })
    .eq("id", group.id);
  return created.id;
}

/**
 * Event 3 cascade: dealer just got assigned to `group`. If the dealer is
 * flagged as billed-to-group for subscription, add a line item to the
 * group's template tagged with cascadeFromDealer = dealer.id, and zero
 * out the dealer's own template subscription line. (We can't tell what
 * the dealer's "own" subscription line looked like without convention —
 * caller is expected to drop their template's products via the standard
 * flow.) For labels billed to group, nothing happens here; label_orders
 * routes to the right template at checkout time.
 */
export async function cascadeOnGroupAssign(args: {
  dealerUuid: string;
  groupId: string;
}): Promise<void> {
  const admin = createAdminSupabaseClient();
  const [{ data: dealer }, { data: group }] = await Promise.all([
    admin
      .from("dealers")
      .select("id, name, billing_customer_id, internal_id, subscription_billed_to, labels_billed_to, account_type")
      .eq("id", args.dealerUuid)
      .maybeSingle<DealerSnap>(),
    admin
      .from("groups")
      .select("id, name, billing_customer_id")
      .eq("id", args.groupId)
      .maybeSingle<GroupSnap>(),
  ]);
  if (!dealer || !group) return;

  if (dealer.subscription_billed_to !== "group") return; // nothing to cascade

  const groupCustomerId = await ensureGroupCustomer(admin, group);
  if (!groupCustomerId) return;

  // Add a subscription line item to the group's template tagged with
  // "{dealer.internal_id}::{dealer.name}" — same convention as the
  // dealer's own subscription line and the existing label-order flow.
  // da-billing's UI uses the internal_id portion to link the line to
  // the dealer. Without internal_id we can't safely cascade — bail.
  if (!dealer.internal_id) return;
  const subscriptionName = `Subscription — ${dealer.name}${dealer.account_type ? ` (${dealer.account_type})` : ""}`;
  await appendToTemplate(groupCustomerId, [
    {
      name: subscriptionName,
      quantity: 1,
      price: 0, // group admin sets the actual price in da-billing
      lineItemDescription: `${dealer.internal_id}::${dealer.name}`,
    } as BillingProduct & { lineItemDescription: string },
  ]);

  // Zero out the dealer's own template subscription line(s) by replacing
  // the products array with an empty list. The group now owns billing.
  const dealerKey = dealerCustomerKey(dealer);
  if (dealerKey) {
    const current = await getTemplate(dealerKey);
    if (current) await putTemplate(dealerKey, []);
  }
}

/**
 * Event 4 cascade: dealer just left `group`. Remove any line items in the
 * group's template tagged cascadeFromDealer:<dealer.id>. Reset the
 * dealer's own flags to 'dealer' (caller does this in SQL alongside
 * group_id=null). Optional: re-create a starter subscription line in the
 * dealer's own template — left as a manual step since price isn't known.
 */
export async function cascadeOnGroupUnassign(args: {
  dealerUuid: string;
  groupId: string;
}): Promise<void> {
  const admin = createAdminSupabaseClient();
  const [{ data: dealer }, { data: group }] = await Promise.all([
    admin
      .from("dealers")
      .select("internal_id")
      .eq("id", args.dealerUuid)
      .maybeSingle<{ internal_id: string | null }>(),
    admin
      .from("groups")
      .select("id, name, billing_customer_id")
      .eq("id", args.groupId)
      .maybeSingle<GroupSnap>(),
  ]);
  if (!group?.billing_customer_id || !dealer?.internal_id) return;

  const current = await getTemplate(group.billing_customer_id);
  if (!current) return;
  // Strip any line items tagged "<internal_id>::*" — same prefix used by
  // cascadeOnGroupAssign and the label-order flow when labels_billed_to=group.
  const prefix = `${dealer.internal_id}::`;
  const remaining = current.products.filter(
    (p) => !(p as BillingProduct & { lineItemDescription?: string }).lineItemDescription?.startsWith(prefix),
  );
  if (remaining.length !== current.products.length) {
    await putTemplate(group.billing_customer_id, remaining);
  }
}

/**
 * Convenience: fire-and-forget wrapper for use inside route handlers.
 */
export function fireGroupAssignCascade(dealerUuid: string, groupId: string): void {
  fireAndForgetWrap(() => cascadeOnGroupAssign({ dealerUuid, groupId }), "billing.template.upsert", {
    dealerUuid,
    groupId,
    event: "group.assign",
  });
}

export function fireGroupUnassignCascade(dealerUuid: string, groupId: string): void {
  fireAndForgetWrap(() => cascadeOnGroupUnassign({ dealerUuid, groupId }), "billing.template.upsert", {
    dealerUuid,
    groupId,
    event: "group.unassign",
  });
}

// Local fire-and-forget wrapper (avoids circular imports vs lib/billing-sync).
function fireAndForgetWrap(
  fn: () => Promise<void>,
  syncEvent: "billing.template.upsert",
  payload: Record<string, unknown>,
): void {
  void (async () => {
    try { await fn(); }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[group-billing-cascade] ${syncEvent} failed:`, message);
      try {
        const admin = createAdminSupabaseClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (admin as any).from("billing_sync_errors").insert({
          event_type: syncEvent,
          payload,
          error_message: message,
          dealer_id: (payload.dealerUuid as string) ?? null,
          group_id: (payload.groupId as string) ?? null,
        });
      } catch { /* swallow */ }
    }
  })();
}
