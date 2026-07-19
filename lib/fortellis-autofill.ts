// Single source of truth for resolving a selected Supabase dealer into the
// Fortellis "Add Dealer" autofill values. Used by the Add-Dealer modal and
// (later) the Phase 5 "Convert from CDK Dealers" helper, so the dealer_id /
// dealerCode mapping lives in exactly one place.

import { createAdminSupabaseClient } from "@/lib/db";

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export interface DealerAutofill {
  dealer_id: string;          // dealers.dealer_id (the Supabase text key)
  dealer_name: string;        // dealers.name
  inventory_dealer_id: string | null;
  dealer_code: string | null; // best-known CDK DMS code (cdk_dealers.DEALER_ID, else inventory_dealer_id)
  web_id: string | null;      // not stored today — always null for now
  cdk_fed: boolean;           // matched a cdk_dealers row (i.e. being converted off CDK)
  already_added: boolean;     // a fortellis_dealers row already exists for this dealer_id
}

/**
 * Resolve autofill values for a dealer chosen in the Fortellis Add-Dealer flow.
 * `dealerKey` is a dealers.dealer_id (the picker's value). Returns null if no
 * such dealer exists.
 */
export async function resolveDealerAutofill(admin: Admin, dealerKey: string): Promise<DealerAutofill | null> {
  const key = dealerKey.trim();
  if (!key) return null;

  const { data: dealer } = await admin
    .from("dealers")
    .select("dealer_id, inventory_dealer_id, name")
    .eq("dealer_id", key)
    .maybeSingle<{ dealer_id: string; inventory_dealer_id: string | null; name: string }>();
  if (!dealer) return null;

  // Best-known CDK DMS code: a cdk_dealers row whose DEALER_ID matches either
  // this dealer's dealer_id or its inventory_dealer_id. Fall back to the
  // inventory_dealer_id (the feed/ETL supplier id) when there's no CDK row.
  const candidates = [dealer.dealer_id, dealer.inventory_dealer_id].filter(Boolean) as string[];
  let cdkCode: string | null = null;
  if (candidates.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cdk } = await (admin as any)
      .from("cdk_dealers")
      .select("DEALER_ID")
      .in("DEALER_ID", candidates)
      .maybeSingle();
    cdkCode = (cdk as { DEALER_ID?: string } | null)?.DEALER_ID ?? null;
  }
  const cdkFed = Boolean(cdkCode);
  const dealerCode = cdkCode ?? dealer.inventory_dealer_id ?? null;

  // Already connected to Fortellis?
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (admin as any)
    .from("fortellis_dealers")
    .select("id")
    .eq("dealer_id", dealer.dealer_id)
    .maybeSingle();

  return {
    dealer_id: dealer.dealer_id,
    dealer_name: dealer.name,
    inventory_dealer_id: dealer.inventory_dealer_id,
    dealer_code: dealerCode,
    web_id: null,
    cdk_fed: cdkFed,
    already_added: Boolean(existing),
  };
}
