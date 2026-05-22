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
  archiveCustomer,
  createCustomer,
  getTemplate,
  putTemplate,
  lookupPrice,
  subscriptionDescriptorFor,
  type BillingProduct,
} from "@/lib/billing";
import { fireGroupDiscountSync } from "@/lib/sync-group-discount";

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

  // Resolve productId + price from da-billing's Pricing settings so the
  // group template line carries the same identifiers the dealer-side
  // path uses. da-billing owns canonical pricing; we just echo it back.
  const descriptor = subscriptionDescriptorFor(dealer.account_type);
  const price = descriptor ? (await lookupPrice(descriptor.key)) ?? 0 : 0;

  const subscriptionName = descriptor
    ? `${descriptor.name} — ${dealer.name}`
    : `Subscription — ${dealer.name}${dealer.account_type ? ` (${dealer.account_type})` : ""}`;
  const newLines: (BillingProduct & { lineItemDescription: string })[] = [
    {
      productId: descriptor?.key,
      name: subscriptionName,
      quantity: 1,
      price,
      lineItemDescription: `${dealer.internal_id}::${dealer.name}`,
    },
  ];
  // sub-auto-dms triggers a one-time DMS Setup Charge alongside the
  // recurring subscription line. Tagged with "<internal_id>::dms-setup"
  // so unassign cleanup (which strips by internal_id prefix) sweeps it.
  if (descriptor?.key === "sub-auto-dms") {
    const setupPrice = (await lookupPrice("dms-setup")) ?? 0;
    newLines.push({
      productId: "dms-setup",
      name: "One Time DMS Setup Charge",
      quantity: 1,
      price: setupPrice,
      lineItemDescription: `${dealer.internal_id}::dms-setup`,
    });
  }
  await appendToTemplate(groupCustomerId, newLines);

  // Mirror the group's billing_customer_id into groups.template_id so the
  // platform has a single column to check for "this group has an active
  // template" without round-tripping to da-billing. da-billing's template
  // API is keyed by customerId (GET /templates/customer/:customerId), so
  // we use the customer id as the template id by convention.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from("groups")
    .update({ template_id: groupCustomerId })
    .eq("id", group.id)
    .is("template_id", null);

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

// ── Super-admin "move existing standalone dealer into a group" cascade ──────
//
// Called from PATCH /api/dealers/[id] when group_id transitions from null
// to a group UUID. Handles three scenarios driven by the dealer's
// subscription_billed_to + labels_billed_to flags (already updated in the
// row by the time we run):
//
//   A — sub=group, labels=dealer:
//       Strip sub-* lines from the dealer's standalone template (keep
//       labels lines); append the sub line to the group template
//       tagged "<internal_id>::<name>"; set dealers.template_id to the
//       group customer id by convention.
//
//   B — sub=group, labels=group:
//       Archive the dealer's standalone da-billing customer; append
//       both sub + labels lines (productId "labels") to the group
//       template; null out dealers.billing_customer_id; set
//       dealers.template_id to the group customer id.
//
//   C — sub=dealer:
//       No billing changes. Returns immediately.
//
// In all three, fires fireGroupDiscountSync(groupId) at the end so the
// group's auto-discount tier recalculates against the new active count.

interface SuperAdminAssignDealer {
  id: string;
  name: string;
  internal_id: string | null;
  billing_customer_id: string | null;
  template_id: string | null;
  subscription_billed_to: "dealer" | "group";
  labels_billed_to: "dealer" | "group";
  account_type: string | null;
}

export async function cascadeSuperAdminGroupAssign(args: {
  dealerUuid: string;
  groupId: string;
}): Promise<void> {
  const admin = createAdminSupabaseClient();
  const [{ data: dealer }, { data: group }] = await Promise.all([
    admin
      .from("dealers")
      .select("id, name, internal_id, billing_customer_id, template_id, subscription_billed_to, labels_billed_to, account_type")
      .eq("id", args.dealerUuid)
      .maybeSingle<SuperAdminAssignDealer>(),
    admin
      .from("groups")
      .select("id, name, billing_customer_id")
      .eq("id", args.groupId)
      .maybeSingle<GroupSnap>(),
  ]);
  if (!dealer || !group) return;

  // Scenario C: subscription stays on the dealer's standalone customer.
  // Nothing to change in da-billing. Still need to refresh the discount.
  if (dealer.subscription_billed_to !== "group") {
    fireGroupDiscountSync(group.id);
    return;
  }

  // Both Scenario A and B need the group to have a billing customer.
  if (!group.billing_customer_id) {
    console.warn(
      `[cascadeSuperAdminGroupAssign] group ${group.id} (${group.name}) has no billing_customer_id — skipping billing cascade. The group needs to be re-saved or have its customer created via /api/billing/groups/[id]/create-customer first.`,
    );
    fireGroupDiscountSync(group.id);
    return;
  }
  if (!dealer.internal_id) {
    console.warn(`[cascadeSuperAdminGroupAssign] dealer ${dealer.id} missing internal_id — cannot tag line items`);
    fireGroupDiscountSync(group.id);
    return;
  }

  const descriptor = subscriptionDescriptorFor(dealer.account_type);
  const subPrice = descriptor ? ((await lookupPrice(descriptor.key)) ?? 0) : 0;
  const subName  = descriptor ? `${descriptor.name} — ${dealer.name}` : `Subscription — ${dealer.name}`;
  const subLine: BillingProduct & { lineItemDescription: string } = {
    productId: descriptor?.key,
    name: subName,
    quantity: 1,
    price: subPrice,
    lineItemDescription: `${dealer.internal_id}::${dealer.name}`,
  };

  if (dealer.labels_billed_to === "dealer") {
    // Scenario A — keep dealer customer (still receives label orders),
    // strip only sub-* lines from its template; sub moves to group.
    const dealerKey = dealer.billing_customer_id ?? dealer.internal_id;
    if (dealerKey) {
      const current = await getTemplate(dealerKey);
      if (current) {
        const nonSub = current.products.filter(p => !p.productId?.startsWith?.("sub-"));
        if (nonSub.length !== current.products.length) {
          await putTemplate(dealerKey, nonSub);
        }
      }
    }
    await appendToTemplate(group.billing_customer_id, [subLine]);
    // template_id mirrors the customer key by platform convention.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from("dealers")
      .update({ template_id: group.billing_customer_id })
      .eq("id", dealer.id);
  } else {
    // Scenario B — archive dealer customer entirely; sub + labels both
    // route to the group template.
    if (dealer.billing_customer_id) {
      await archiveCustomer(dealer.billing_customer_id);
    }
    const labelsLine: BillingProduct & { lineItemDescription: string } = {
      productId: "labels",
      name: `Labels — ${dealer.name}`,
      quantity: 1,
      price: 0,  // da-billing owns the price for labels; this is a placeholder marker line
      lineItemDescription: `${dealer.internal_id}::${dealer.name}`,
    };
    await appendToTemplate(group.billing_customer_id, [subLine, labelsLine]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from("dealers")
      .update({
        billing_customer_id: null,
        template_id: group.billing_customer_id,
      })
      .eq("id", dealer.id);
  }

  // Group active-dealer count grew — recompute auto-discount tier.
  fireGroupDiscountSync(group.id);
}

export function fireSuperAdminGroupAssignCascade(dealerUuid: string, groupId: string): void {
  fireAndForgetWrap(
    () => cascadeSuperAdminGroupAssign({ dealerUuid, groupId }),
    "billing.template.upsert",
    { dealerUuid, groupId, event: "super-admin.group.assign" },
  );
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
