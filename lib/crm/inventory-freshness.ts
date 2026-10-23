// DA-CRM company page: the dealer's feed / DMS name and how fresh its inventory
// is. A fed dealer with nothing new in STALE_DAYS shows red — the feed has
// probably stopped. Manual dealers are never flagged.

export const STALE_DAYS = 3;

/** The feed or DMS name: inventory_provider, else the legacy feed_source. */
export function feedName(provider: string | null | undefined, feedSource: string | null | undefined): string | null {
  return (provider ?? "").trim() || (feedSource ?? "").trim() || null;
}

export function isFed(name: string | null, feedId: string | null | undefined): boolean {
  if (name && name.toLowerCase() === "manual") return false;
  return !!name || !!(feedId ?? "").trim();
}

export type Freshness = { newest: string | null; days: number | null; stale: boolean; label: string };

/** newest = max(dealer_vehicles.date_added) for the dealer, or null when it has none. */
export function inventoryFreshness(newest: string | null, fed: boolean, now: Date): Freshness {
  if (!newest) return { newest: null, days: null, stale: fed, label: "No vehicles yet" };
  const days = Math.max(0, Math.floor((now.getTime() - new Date(newest).getTime()) / 86_400_000));
  const label = days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days} days ago`;
  return { newest, days, stale: fed && days >= STALE_DAYS, label };
}
