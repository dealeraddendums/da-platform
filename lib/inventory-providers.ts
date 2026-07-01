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
