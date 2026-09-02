// Tier rules for the auto-applied group subscription discount.
// Called by lib/sync-group-discount.ts whenever a dealer is added,
// removed, or deactivated within a group.
//
//   1 dealer     → 0%   (no discount, also covers 0/empty groups)
//   2–10 dealers → 20%
//   11–30 dealers → 25%
//   31+ dealers   → 30%
//
// WHAT COUNTS TOWARD THE TIER (policy, Allan 2026-09-01): only dealers on a
// PAYING subscription. Free, Downgraded and Trial rooftops are excluded — the
// volume discount is earned by paying rooftops, not by parked ones. Before this
// change the count was every active dealer in the group, so a group could be
// pushed into a higher bracket by stores generating no revenue (StarShield:
// 32 active → 30%, but only 29 paying → 25%).
//
// Tier VALUES and thresholds are unchanged; only the population counted changed.

export function calcGroupDiscountTier(dealerCount: number): number {
  if (dealerCount <= 1) return 0;
  if (dealerCount <= 10) return 20;
  if (dealerCount <= 30) return 25;
  return 30;
}

/**
 * account_type values that do NOT count toward a group's discount tier.
 * Compared lowercased and with any legacy custom-price suffix stripped
 * ("Automatic Web $135" → "automatic web"), so priced legacy plans still
 * count as paying. `Standard` is the DB default a dealer row can be born
 * with before a real plan is chosen — it is not a paying plan either.
 */
const NON_BILLABLE_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  "free",
  "downgraded",
  "trial",
  "trial expired",
  "standard",
]);

/** True when this account_type represents a paying subscription. */
export function isBillableAccountType(accountType: string | null | undefined): boolean {
  const base = String(accountType ?? "").split(" $")[0].trim().toLowerCase();
  if (!base) return false; // no plan on the row = not paying
  return !NON_BILLABLE_ACCOUNT_TYPES.has(base);
}
