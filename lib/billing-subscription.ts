// Apply a dealer subscription-tier change to da-billing, for the super_admin
// account_type edit path (Dealer profile → Subscription). Mirrors the existing
// self-serve flows exactly so there's ONE billing-write convention:
//   • paying tier  → me/subscription's template swap (no price sent; da-billing
//                    is the sole price authority — docs/billing-price-integrity.md)
//   • Free/Trial   → me/close's deleteTemplate (stops the recurring cron)
//   • group-billed → the dealer's "sub-*" line lives in the GROUP's template
//                    tagged "{internal_id}::{name}" (group-billing-cascade.ts)
//
// This helper ONLY mutates da-billing. The caller (PATCH /api/dealers/[id]) still
// owns the platform-side account_type write + downgraded_at/converted_at stamps +
// HubSpot sync. Returns a result the UI surfaces inline (synchronous by design).

import { createAdminSupabaseClient } from "@/lib/db";
import {
  getTemplate,
  putTemplate,
  createTemplate,
  deleteTemplate,
  createCustomer,
  customerExists,
  firstOfNextMonthIso,
  subscriptionDescriptorFor,
  billingConfigured,
  type BillingProduct,
} from "@/lib/billing";

export type SubscriptionBillingResult =
  | { ok: true; action: "tier_set" | "cancelled" | "noop"; billedTo: "dealer" | "group"; message: string }
  | { ok: false; blocked: boolean; message: string };

interface DealerSnap {
  id: string;
  name: string;
  internal_id: string | null;
  billing_customer_id: string | null;
  billing_id: string | null;
  subscription_billed_to: "dealer" | "group" | null;
  group_id: string | null;
  account_type: string | null;
}

interface GroupSnap {
  id: string;
  name: string;
  billing_customer_id: string | null;
}

const isSub = (p: BillingProduct): boolean => Boolean(p.productId?.startsWith?.("sub-"));

// ── Pure template planners (no IO — unit-tested in scripts/qa-subscription-billing.ts) ──
//
// These compute the new products array; the async wrappers below do the da-billing
// read/write around them. Keeping the mutation logic pure makes the risky bits
// (group-template line replacement + the last-subscription guard) deterministically
// testable without touching real billing data.

/** Dealer's OWN template: swap the sub-* line, preserve label-order + dms-setup
 *  lines. `current` is the existing products (null = no template yet). */
export function planDealerMerge(
  current: BillingProduct[] | null,
  newSubLine: BillingProduct,
  descriptorKey: string,
  internalId: string,
): BillingProduct[] {
  const merged = current ? [newSubLine, ...current.filter((p) => !isSub(p))] : [newSubLine];
  if (descriptorKey === "sub-auto-dms") ensureDmsSetup(merged, internalId);
  return merged;
}

/** Group template, tier change: replace ONLY this dealer's sub-* line (matched by
 *  "{internalId}::" tag), keep its labels line + every other dealer's lines. */
export function planGroupTierChange(
  products: BillingProduct[],
  internalId: string,
  dealerName: string,
  descriptor: NonNullable<ReturnType<typeof subscriptionDescriptorFor>>,
): BillingProduct[] {
  const prefix = `${internalId}::`;
  const kept = products.filter((p) => !(isSub(p) && p.lineItemDescription?.startsWith(prefix)));
  const newSubLine: BillingProduct = {
    productId: descriptor.key,
    name: `${descriptor.name} — ${dealerName}`,
    quantity: 1,
    lineItemDescription: `${internalId}::${dealerName}`,
  };
  const merged = [...kept, newSubLine];
  if (descriptor.key === "sub-auto-dms") ensureDmsSetup(merged, internalId);
  return merged;
}

/** Group template, cancel: remove this dealer's sub-* + dms-setup lines, keep its
 *  labels line + other dealers. `blocked` = removing leaves the template with no
 *  subscription at all (da-billing rejects that) → caller must not write. */
export function planGroupCancel(
  products: BillingProduct[],
  internalId: string,
): { remaining: BillingProduct[]; changed: boolean; blocked: boolean } {
  const prefix = `${internalId}::`;
  const remaining = products.filter((p) => {
    const mine = p.lineItemDescription?.startsWith(prefix);
    const subOrSetup = isSub(p) || p.productId === "dms-setup";
    return !(mine && subOrSetup);
  });
  const changed = remaining.length !== products.length;
  const blocked = changed && !remaining.some(isSub);
  return { remaining, changed, blocked };
}

/**
 * Mutate da-billing to reflect a dealer's new account_type. `newAccountType` is
 * the value just written to the dealers row. Never throws — failures are logged
 * to billing_sync_errors and returned as { ok:false } so the caller can surface
 * them without rolling back the platform-side change.
 */
export async function applyDealerSubscriptionChange(
  dealerUuid: string,
  newAccountType: string | null,
): Promise<SubscriptionBillingResult> {
  if (!billingConfigured()) {
    return { ok: false, blocked: false, message: "Billing API not configured — da-billing not updated." };
  }

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, name, internal_id, billing_customer_id, billing_id, subscription_billed_to, group_id, account_type")
    .eq("id", dealerUuid)
    .maybeSingle<DealerSnap>();
  if (!dealer) return { ok: false, blocked: false, message: "Dealer not found for billing sync." };

  const billedTo: "dealer" | "group" = dealer.subscription_billed_to === "group" ? "group" : "dealer";
  const descriptor = subscriptionDescriptorFor(newAccountType); // null = Free/Trial/unknown

  try {
    if (descriptor) {
      return billedTo === "group"
        ? await setGroupTier(admin, dealer, descriptor)
        : await setDealerTier(admin, dealer, descriptor);
    }
    // Free / Trial → cancel the recurring subscription.
    return billedTo === "group"
      ? await cancelGroup(admin, dealer)
      : await cancelDealer(dealer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logBillingError(admin, dealerUuid, dealer.group_id, message, { newAccountType, billedTo });
    return { ok: false, blocked: false, message: `da-billing update failed — ${message}` };
  }
}

// ── Paying tier, billed to the dealer's OWN template ────────────────────────
async function setDealerTier(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealer: DealerSnap,
  descriptor: NonNullable<ReturnType<typeof subscriptionDescriptorFor>>,
): Promise<SubscriptionBillingResult> {
  if (!dealer.internal_id) {
    return { ok: false, blocked: false, message: "Dealer missing internal_id (billing line tag) — da-billing not updated." };
  }

  // Resolve / provision the da-billing customer (link-don't-duplicate), mirroring
  // me/subscription so a Trial→paid upgrade always has a customer to bill.
  let key = dealer.billing_customer_id;
  if (!key) {
    // Release a legacy internal_id-keyed orphan template (template w/ no customer)
    // so da-billing's duplicate-dealer guard doesn't reject the new template.
    if ((await getTemplate(dealer.internal_id)) && !(await customerExists(dealer.internal_id))) {
      await deleteTemplate(dealer.internal_id);
    }
    if (dealer.billing_id && (await customerExists(dealer.billing_id))) {
      key = dealer.billing_id;
    } else {
      // Self-pay Trial→paid upgrade: the dealer is paying now, so bill
      // immediately (not held in setup). billingState:'active' => cron emails.
      const cust = await createCustomer({ name: dealer.name, company: dealer.name, isGroup: false, billingState: "active" });
      key = cust.id;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("dealers")
      .update({ billing_customer_id: key, template_id: key })
      .eq("id", dealer.id);
  }

  const newSubLine: BillingProduct = {
    productId: descriptor.key,
    name: descriptor.name,
    quantity: 1,
    lineItemDescription: `${dealer.internal_id}::${dealer.name}`,
  };

  const current = await getTemplate(key);
  const merged = planDealerMerge(current?.products ?? null, newSubLine, descriptor.key, dealer.internal_id);

  if (current) await putTemplate(key, merged);
  else await createTemplate({ customerId: key, products: merged, nextInvoiceDate: firstOfNextMonthIso(), scheduleInterval: "monthly" });

  return { ok: true, action: "tier_set", billedTo: "dealer", message: `da-billing: subscription set to ${descriptor.name} (effective next invoice).` };
}

// ── Paying tier, billed to the GROUP's template ─────────────────────────────
async function setGroupTier(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealer: DealerSnap,
  descriptor: NonNullable<ReturnType<typeof subscriptionDescriptorFor>>,
): Promise<SubscriptionBillingResult> {
  if (!dealer.internal_id) {
    return { ok: false, blocked: false, message: "Dealer missing internal_id (billing line tag) — da-billing not updated." };
  }
  const group = await loadGroup(admin, dealer.group_id);
  if (!group?.billing_customer_id) {
    return { ok: false, blocked: true, message: `Group has no da-billing customer — set the group's subscription up in da-billing, then re-save. Platform tier updated.` };
  }

  const current = await getTemplate(group.billing_customer_id);
  if (!current) {
    return { ok: false, blocked: true, message: `Group has no da-billing template — update the group in da-billing manually. Platform tier updated.` };
  }

  const merged = planGroupTierChange(current.products, dealer.internal_id, dealer.name, descriptor);
  await putTemplate(group.billing_customer_id, merged);
  return { ok: true, action: "tier_set", billedTo: "group", message: `da-billing: subscription set to ${descriptor.name} in ${group.name}'s group template.` };
}

// ── Free / Trial downgrade, dealer-billed → cancel the recurring template ───
async function cancelDealer(dealer: DealerSnap): Promise<SubscriptionBillingResult> {
  const key = dealer.billing_customer_id ?? dealer.internal_id;
  if (!key) return { ok: true, action: "noop", billedTo: "dealer", message: "No da-billing customer — nothing to cancel." };
  // Idempotent: deleteTemplate treats a 404 as success. Archive is left to the
  // +60-day archive-downgraded cron, matching me/close.
  await deleteTemplate(key);
  return { ok: true, action: "cancelled", billedTo: "dealer", message: "da-billing: recurring subscription cancelled." };
}

// ── Free / Trial downgrade, group-billed → strip this dealer's lines ────────
async function cancelGroup(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealer: DealerSnap,
): Promise<SubscriptionBillingResult> {
  if (!dealer.internal_id) return { ok: true, action: "noop", billedTo: "group", message: "Dealer has no billing line tag — nothing to cancel." };
  const group = await loadGroup(admin, dealer.group_id);
  if (!group?.billing_customer_id) return { ok: true, action: "noop", billedTo: "group", message: "Group has no da-billing customer — nothing to cancel." };

  const current = await getTemplate(group.billing_customer_id);
  if (!current) return { ok: true, action: "noop", billedTo: "group", message: "Group has no da-billing template — nothing to cancel." };

  const { remaining, changed, blocked } = planGroupCancel(current.products, dealer.internal_id);
  if (!changed) {
    return { ok: true, action: "noop", billedTo: "group", message: "No subscription line for this dealer in the group template." };
  }

  // Block + flag: da-billing rejects a template with zero subscription lines.
  // If this dealer held the last "sub-*" line, don't mutate the group template
  // (it would orphan other dealers' label lines or be rejected) — flag for manual.
  if (blocked) {
    const msg = `This dealer holds the LAST subscription line in ${group.name}'s da-billing template — removing it would leave the group with no subscription (da-billing rejects that). Platform set to Free; cancel/restructure the group template in da-billing manually.`;
    await logBillingError(admin, dealer.id, dealer.group_id, msg, { reason: "last_sub_in_group" });
    return { ok: false, blocked: true, message: msg };
  }

  await putTemplate(group.billing_customer_id, remaining);
  return { ok: true, action: "cancelled", billedTo: "group", message: `da-billing: subscription line removed from ${group.name}'s group template.` };
}

// ── helpers ─────────────────────────────────────────────────────────────────
function ensureDmsSetup(products: BillingProduct[], internalId: string): void {
  const tag = `${internalId}::dms-setup`;
  const has = products.some((p) => p.productId === "dms-setup" || p.lineItemDescription === tag);
  if (!has) {
    products.push({ productId: "dms-setup", name: "One Time DMS Setup Charge", quantity: 1, lineItemDescription: tag });
  }
}

async function loadGroup(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  groupId: string | null,
): Promise<GroupSnap | null> {
  if (!groupId) return null;
  const { data } = await admin
    .from("groups")
    .select("id, name, billing_customer_id")
    .eq("id", groupId)
    .maybeSingle<GroupSnap>();
  return data ?? null;
}

async function logBillingError(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealerId: string,
  groupId: string | null,
  message: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("billing_sync_errors").insert({
      event_type: "billing.template.upsert",
      payload: { ...payload, source: "dealer-subscription-edit" },
      error_message: message,
      dealer_id: dealerId,
      group_id: groupId,
    });
  } catch { /* swallow — logging must never throw */ }
}
