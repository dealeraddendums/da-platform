// Canonical inventory-feed vendor lists for the Inventory Provider
// dropdown. Used on the dealer detail page and (read-only) elsewhere
// the provider name is displayed.
//
// DMS_PROVIDERS are flagged at billing time — selecting any of these
// sets dealers.inventory_provider_is_dms=true, which downstream code
// (e.g. group-billing-cascade.ts, /api/billing/me/subscription) reads
// to decide whether the one-time `dms-setup` line item belongs on the
// dealer's template. account_type still drives the subscription tier
// independently; this flag is informational for billing scaffolding.

export const DMS_PROVIDERS: readonly string[] = [
  "Authenticom",
  "Autosoft",
  "CDK",
  "Dealervault",
  "PBS",
  "Reynolds",
  "Tekion",
];

export const OTHER_PROVIDERS: readonly string[] = [
  "Advent",
  "ASN",
  "Autobase",
  "Autofund",
  "Automate",
  "Autoshot",
  "Autouplink",
  "BPS",
  "CarsForSale",
  "Cobalt",
  "DealerInspire",
  "DealerCenter",
  "DealerDotCom",
  "DealerEProcess",
  "DealerFire",
  "DealerOn",
  "DealersCloud",
  "DealersLink",
  "DealerSocket",
  "DealerSpecialties",
  "DealerSync",
  "DealerTrack",
  "DealerVision",
  "EbizAutos",
  "Firstlook",
  "Flowchar",
  "FusionZone",
  "Homenet",
  "Jabber",
  "LiquidMotors",
  "NakedLime",
  "Netlook",
  "Nexteppe",
  "OmniAuto",
  "ProMax",
  "Redline",
  "Vauto",
  "Vincue",
  "Vinsolutions",
];

const DMS_SET = new Set(DMS_PROVIDERS.map(p => p.toLowerCase()));

/** True iff the given provider name is in the DMS-tier list. Case-insensitive. */
export function isDmsProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return DMS_SET.has(provider.trim().toLowerCase());
}

// ── 4.0 Feed Source → canonical provider normalization (2026-08-09) ─────────
//
// Aurora dealer_dim.FEED_SOURCE is free text; the console Sync maps it onto
// dealers.inventory_provider. Matching collapses to lowercase alphanumerics
// ("Dealer Track" / "dealer.com" / "V-Auto" all resolve), plus an alias table
// for the recurring legacy spellings observed in the fleet. Values that don't
// resolve are returned verbatim with known=false so the sync can flag rather
// than drop them.

const ALL_PROVIDERS: readonly string[] = [...DMS_PROVIDERS, ...OTHER_PROVIDERS];

const collapse = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const CANONICAL_BY_KEY = new Map<string, string>(ALL_PROVIDERS.map(p => [collapse(p), p]));

// Legacy FEED_SOURCE spellings → canonical name (keys are collapsed).
const FEED_SOURCE_ALIASES: Record<string, string> = {
  dealercom: "DealerDotCom", // 4.0 writes "dealer.com"
  reynoldsreynolds: "Reynolds",
  adventdms: "Advent",
  pbssystems: "PBS",
  nexteppenet: "Nexteppe",
  nextsteppe: "Nexteppe",
  vauot: "Vauto", // recurring fleet typo
  autouplink: "Autouplink",
};

// Free-text prefixes that carry trailing commentary ("Vauto- Every hour
// update", "Dealer socket Inventory Plus"). Checked after exact/alias lookup.
const PROVIDER_PREFIXES: ReadonlyArray<[string, string]> = [
  ["vauto", "Vauto"],
  ["dealersocket", "DealerSocket"],
];

/**
 * Map a 4.0 Feed Source value onto the canonical Inventory Provider list.
 * known=false → no canonical match; `provider` is the raw value (trimmed)
 * so the sync copies it verbatim and flags it instead of dropping it.
 */
export function normalizeInventoryProvider(raw: string | null | undefined): { provider: string; known: boolean } | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const key = collapse(trimmed);
  if (!key) return null;
  const exact = CANONICAL_BY_KEY.get(key) ?? FEED_SOURCE_ALIASES[key];
  if (exact) return { provider: exact, known: true };
  for (const [prefix, canonical] of PROVIDER_PREFIXES) {
    if (key.startsWith(prefix)) return { provider: canonical, known: true };
  }
  return { provider: trimmed, known: false };
}
