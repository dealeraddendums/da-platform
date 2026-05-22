// Tier rules for the auto-applied group subscription discount.
// Called by lib/sync-group-discount.ts whenever a dealer is added,
// removed, or deactivated within a group.
//
//   1 dealer     → 0%   (no discount, also covers 0/empty groups)
//   2–10 dealers → 10%
//   11–30 dealers → 20%
//   31+ dealers   → 30%

export function calcGroupDiscountTier(dealerCount: number): number {
  if (dealerCount <= 1) return 0;
  if (dealerCount <= 10) return 10;
  if (dealerCount <= 30) return 20;
  return 30;
}
