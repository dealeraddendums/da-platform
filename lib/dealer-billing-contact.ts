// Dealer → da-billing billing email (2026-10-16, Land Rover Cape Fear).
//
// A dealer's da-billing customer could be born with no email — the admin
// Trial→paid path (lib/billing-subscription.ts setDealerTier) created it from
// the dealer NAME only — and nothing ever filled it in later. Since 5519f71
// da-billing accepts an email-less customer, so there was no error or retry
// row to notice: invoices were generated and silently not emailed.
//
// Two pieces, used by every dealer customer-create path and by the hooks that
// can supply a contact later (dealer PATCH, user add, invite accept):
//   - resolveDealerBillingEmail: primary_contact_email, else the earliest
//     active dealer_admin's email.
//   - backfillDealerBillingEmail: set the customer's email ONLY when it is
//     currently empty. Never overwrites an address a human set, touches only
//     `email` (no amounts/templates/discounts/billingState), and never runs
//     against the group's customer (group-billed invoices go to the group).
//
// fireDealerBillingEmailBackfill is the fire-and-forget wrapper — a billing
// hiccup can never fail a dealer save, user add or invite accept.

import { createAdminSupabaseClient } from "@/lib/db";
import { billingConfigured, getCustomer, updateCustomer } from "@/lib/billing";

type Admin = ReturnType<typeof createAdminSupabaseClient>;

// Synthesized logins (`{username}@dealeraddendums.com`, created when a dealer
// account is set up with a bare username) and our own test domains are not
// anyone's billing inbox.
const NOT_BILLING = /@(test\.)?dealeraddendums\.com$/i;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isUsableBillingEmail(raw: string | null | undefined): boolean {
  const e = (raw ?? "").trim();
  return EMAIL_SHAPE.test(e) && !NOT_BILLING.test(e);
}

export interface ResolvedBillingEmail {
  email: string;
  source: "primary_contact" | "dealer_admin";
}

export async function resolveDealerBillingEmail(
  admin: Admin,
  dealer: { dealer_id: string | null; primary_contact_email?: string | null },
): Promise<ResolvedBillingEmail | null> {
  if (isUsableBillingEmail(dealer.primary_contact_email)) {
    return { email: dealer.primary_contact_email!.trim(), source: "primary_contact" };
  }
  if (!dealer.dealer_id) return null;
  const { data } = await admin
    .from("profiles")
    .select("email, active, created_at")
    .eq("dealer_id", dealer.dealer_id)
    .eq("role", "dealer_admin")
    .order("created_at", { ascending: true });
  const first = ((data ?? []) as { email: string | null; active: boolean | null }[])
    .find((p) => p.active !== false && isUsableBillingEmail(p.email));
  return first ? { email: first.email!.trim(), source: "dealer_admin" } : null;
}

export interface BillingEmailBackfillResult {
  status: "set" | "skipped";
  reason?: string;
  email?: string;
  source?: ResolvedBillingEmail["source"];
  customerId?: string;
}

export async function backfillDealerBillingEmail(
  dealerUuid: string,
  admin: Admin = createAdminSupabaseClient(),
): Promise<BillingEmailBackfillResult> {
  const skip = (reason: string): BillingEmailBackfillResult => ({ status: "skipped", reason });
  if (!billingConfigured()) return skip("billing not configured");

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, primary_contact_email, billing_customer_id, group_id")
    .eq("id", dealerUuid)
    .maybeSingle<{ id: string; dealer_id: string; primary_contact_email: string | null; billing_customer_id: string | null; group_id: string | null }>();
  if (!dealer) return skip("dealer not found");
  const customerId = dealer.billing_customer_id;
  if (!customerId) return skip("no da-billing customer");

  // Never write the dealer's contact onto the GROUP's customer.
  if (dealer.group_id) {
    const { data: grp } = await admin
      .from("groups").select("billing_customer_id").eq("id", dealer.group_id)
      .maybeSingle<{ billing_customer_id: string | null }>();
    if (grp?.billing_customer_id && grp.billing_customer_id === customerId) return skip("customer is the group's");
  }

  const customer = await getCustomer(customerId);
  if (!customer) return skip("da-billing customer not found");
  if ((customer as { archived?: boolean }).archived) return skip("customer archived");
  if ((customer.email ?? "").trim()) return skip("customer already has a billing email");

  const resolved = await resolveDealerBillingEmail(admin, dealer);
  if (!resolved) return skip("dealer has no usable contact email");

  // Re-read right before writing so an operator who just typed an address in
  // da-billing isn't overwritten by a race.
  const fresh = await getCustomer(customerId);
  if ((fresh?.email ?? "").trim()) return skip("customer already has a billing email");

  await updateCustomer(customerId, { email: resolved.email });
  console.log(`[billing-email] dealer ${dealer.dealer_id}: customer ${customerId} billing email set to ${resolved.email} (from ${resolved.source})`);
  return { status: "set", email: resolved.email, source: resolved.source, customerId };
}

export function fireDealerBillingEmailBackfill(dealerUuid: string | null | undefined, trigger: string): void {
  if (!dealerUuid) return;
  void backfillDealerBillingEmail(dealerUuid).catch((err) => {
    console.error(`[billing-email] backfill after ${trigger} failed for dealer ${dealerUuid}:`, err instanceof Error ? err.message : err);
  });
}

/** Same, keyed by the dealer's TEXT id (profiles carry dealer_id text). */
export function fireDealerBillingEmailBackfillByTextId(dealerTextId: string | null | undefined, trigger: string): void {
  if (!dealerTextId) return;
  void (async () => {
    const admin = createAdminSupabaseClient();
    const { data } = await admin.from("dealers").select("id").eq("dealer_id", dealerTextId).maybeSingle<{ id: string }>();
    if (data?.id) await backfillDealerBillingEmail(data.id, admin);
  })().catch((err) => {
    console.error(`[billing-email] backfill after ${trigger} failed for dealer ${dealerTextId}:`, err instanceof Error ? err.message : err);
  });
}
