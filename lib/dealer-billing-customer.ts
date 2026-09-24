import { createAdminSupabaseClient } from "@/lib/db";
import { createCustomer, customerExists, searchCustomers, updateCustomer } from "@/lib/billing";

/**
 * Resolve the da-billing customer that a DEALER's own (non-group) billing
 * belongs on, linking to an existing record in preference to minting one.
 *
 * The dealer-side mirror of `ensureGroupCustomer` in lib/group-billing-cascade.ts.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The label-order route used to read a NULL `dealers.billing_customer_id` as
 * "this dealer has no billing" and mint a brand-new da-billing customer on the
 * spot, then overwrite the platform pointer with it. But a NULL pointer means
 * "we have not LINKED this dealer yet" — not "no customer exists".
 *
 * AutoNation Audi Fremont (2026-09-18) is the case that surfaced it: a real,
 * actively-billing customer (created directly in da-billing, pointer never
 * written back) already existed. A label order minted a duplicate, repointed
 * the platform at the empty new record, and left the live $150/mo template
 * stranded on a customer nothing referenced. Every dealer with a NULL pointer
 * was one label order away from the same duplicate.
 *
 * ── Resolution order, each step verified against da-billing before use ──────
 *   1. `billing_customer_id`, when that customer actually exists
 *   2. an active customer already carrying this dealer's `internal_id`
 *   3. the single active customer whose company/name matches the dealer name
 *      exactly — and stamp `internal_id` on it so step 2 resolves it next time
 *   4. create — the LAST resort, never the NULL-pointer default
 *
 * Steps 2+3 search da-billing by dealer NAME (its only search axis is
 * company/name/email), then prefer an `internalId` hit within those results.
 * So a customer filed under a company name unlike the dealer's, carrying only
 * the right internal_id, is still not findable — that needs `internalId` added
 * to da-billing's `GET /customers?search=` filter. Logged, not silently missed.
 */

export interface DealerCustomerSnap {
  /** `dealers.id` (uuid PK) — what the pointer is written back to. */
  id: string;
  name: string | null;
  internal_id: string | null;
  billing_customer_id: string | null;
  primary_contact?: string | null;
  primary_contact_email?: string | null;
}

/**
 * The da-billing + Supabase calls this resolver makes. Injectable so the
 * branch precedence can be unit-tested without network or database — the
 * precedence IS the fix, so it is the part that has to be pinned down.
 * Production callers pass nothing and get the real implementations.
 */
export interface EnsureDealerCustomerDeps {
  customerExists: typeof customerExists;
  searchCustomers: typeof searchCustomers;
  createCustomer: typeof createCustomer;
  updateCustomer: typeof updateCustomer;
  /** Write the resolved customer id back onto `dealers.billing_customer_id`. */
  setPointer: (dealerId: string, customerId: string) => Promise<void>;
}

export interface EnsureDealerCustomerResult {
  customerId: string | null;
  via: "existing_pointer" | "internal_id" | "exact_name" | "created" | "failed";
  /** True only when a brand-new da-billing customer was minted. */
  created: boolean;
  /** Set when `via` is "failed" — the reason, for the caller's log. */
  error?: string;
}

export async function ensureDealerCustomer(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealer: DealerCustomerSnap,
  deps?: Partial<EnsureDealerCustomerDeps>,
): Promise<EnsureDealerCustomerResult> {
  const d: EnsureDealerCustomerDeps = {
    customerExists,
    searchCustomers,
    createCustomer,
    updateCustomer,
    setPointer: async (dealerId, customerId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from("dealers").update({ billing_customer_id: customerId }).eq("id", dealerId);
    },
    ...deps,
  };
  const label = `${dealer.id} (${dealer.name ?? "unnamed"})`;
  const internalId = (dealer.internal_id ?? "").trim();

  const link = async (
    customerId: string,
    via: EnsureDealerCustomerResult["via"],
  ): Promise<EnsureDealerCustomerResult> => {
    await d.setPointer(dealer.id, customerId);
    console.warn(
      `[ensureDealerCustomer] dealer ${label} had billing_customer_id ${dealer.billing_customer_id ?? "null"} — linked to existing customer ${customerId} via ${via} (no duplicate created)`,
    );
    return { customerId, via, created: false };
  };

  // 1. A pointer we already have, if it still resolves. A non-NULL pointer is
  //    never overwritten on a whim — only when da-billing confirms the
  //    customer is gone, and then loudly.
  if (dealer.billing_customer_id) {
    try {
      if (await d.customerExists(dealer.billing_customer_id)) {
        return { customerId: dealer.billing_customer_id, via: "existing_pointer", created: false };
      }
      console.warn(
        `[ensureDealerCustomer] dealer ${label} has a STALE billing_customer_id (${dealer.billing_customer_id}) — no such da-billing customer; re-resolving`,
      );
    } catch (err) {
      // Can't confirm either way — do NOT re-resolve on a transient error, or
      // a da-billing hiccup silently repoints a correctly-linked dealer.
      console.error(`[ensureDealerCustomer] dealer ${label}: customerExists failed, keeping existing pointer:`, err);
      return { customerId: dealer.billing_customer_id, via: "existing_pointer", created: false };
    }
  }

  // 2 + 3. Look before minting.
  const wanted = (dealer.name ?? "").trim().toLowerCase();
  if (wanted) {
    try {
      const matches = await d.searchCustomers(dealer.name ?? "");

      if (internalId) {
        const byId = matches.filter(m => (m.internalId ?? "").trim() === internalId);
        if (byId.length === 1) return link(byId[0].id, "internal_id");
        if (byId.length > 1) {
          console.warn(
            `[ensureDealerCustomer] dealer ${label}: ${byId.length} da-billing customers carry internal_id ${internalId} — ambiguous, not auto-linking`,
          );
        }
      }

      const byName = matches.filter(
        m =>
          (m.company ?? "").trim().toLowerCase() === wanted ||
          (m.name ?? "").trim().toLowerCase() === wanted,
      );
      if (byName.length === 1) {
        const hit = byName[0];
        // Stamp the id so the next resolve takes the id path and da-billing's
        // "G" badge stops depending on the rename-fragile name match.
        if (internalId && !(hit.internalId ?? "").trim()) {
          try {
            await d.updateCustomer(hit.id, { internalId });
          } catch (err) {
            console.warn(`[ensureDealerCustomer] dealer ${label}: linked ${hit.id} but stamping internal_id failed:`, err);
          }
        }
        return link(hit.id, "exact_name");
      }
      if (byName.length > 1) {
        console.warn(
          `[ensureDealerCustomer] dealer ${label}: ${byName.length} active da-billing customers match the name exactly — ambiguous, creating a new one rather than guessing`,
        );
      }
    } catch (err) {
      // A failed lookup must not become a mint — that is precisely how the
      // duplicate got created. Bail and let the caller surface it.
      console.error(`[ensureDealerCustomer] dealer ${label}: customer lookup failed, refusing to create a possible duplicate:`, err);
      return { customerId: null, via: "failed", created: false, error: String(err) };
    }
  }

  // 4. Nothing resolved — mint, carrying internal_id so this dealer is
  //    id-resolvable from here on.
  try {
    const created = await d.createCustomer({
      name: dealer.primary_contact ?? dealer.name ?? "",
      company: dealer.name ?? "",
      email: dealer.primary_contact_email ?? "",
      internalId: internalId || undefined,
      isGroup: false,
    }, { reuseExistingOnDuplicate: true });
    await d.setPointer(dealer.id, created.id);
    if (created.reused) {
      // da-billing's duplicate guard recognised it even though our own lookups
      // didn't (e.g. the name drifted) — that's a link, not a create.
      console.log(`[ensureDealerCustomer] dealer ${label}: da-billing matched an existing customer — linked ${created.id}`);
      return { customerId: created.id, via: "created", created: false };
    }
    console.log(`[ensureDealerCustomer] dealer ${label}: no existing customer resolved — created ${created.id}`);
    return { customerId: created.id, via: "created", created: true };
  } catch (err) {
    console.error(`[ensureDealerCustomer] dealer ${label}: createCustomer failed:`, err);
    return { customerId: null, via: "failed", created: false, error: String(err) };
  }
}
