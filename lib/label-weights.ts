// Per-SKU shipment weight (in pounds) for label orders. Used by the XPS
// shipping payload in app/api/orders/labels/route.ts as the per-line item
// weight and as the summed package weight.
//
// XPS uses flat-rate shipping, so the exact number doesn't matter as long
// as the package is under the 70 lb cutoff. The values here are intentionally
// coarse — one weight per SKU regardless of quantity — so we don't have to
// measure every box or keep a quantity-tier table in sync. Two pounds for
// the narrow / 4.25" rolls and four pounds for the full-sheet boxes is
// the right order of magnitude for any normal order quantity.
//
// Unknown SKUs fall back to DEFAULT_WEIGHT_LBS and log a console.warn so
// new label products surface in /var/log/da-platform/ instead of silently
// shipping with an unmapped value.

const LABEL_WEIGHT_LBS: Record<string, number> = {
  "8300-1": 2,  // Regular 4.25x11
  "9300-1": 2,  // Regular 4.25x11 — Waterproof
  "8300-3": 2,  // Narrow 3.125x11
  "9300-3": 2,  // Narrow 3.125x11 — Waterproof
  "8300":   4,  // Full Sheet 8.5x11
  "9300":   4,  // Full Sheet 8.5x11 — Waterproof
};

const DEFAULT_WEIGHT_LBS = 5;

/** Look up the shipment weight for a single SKU. */
export function getLabelWeightLbs(sku: string): number {
  const w = LABEL_WEIGHT_LBS[sku];
  if (w == null) {
    console.warn(`[label-weights] no weight mapped for SKU "${sku}", defaulting to ${DEFAULT_WEIGHT_LBS} lbs`);
    return DEFAULT_WEIGHT_LBS;
  }
  return w;
}

/**
 * Sum SKU weights across an order's items. Each line contributes its SKU's
 * weight once (not multiplied by quantity) — the table is per-SKU-shipment,
 * not per-unit. Use this as the XPS package weight.
 */
export function getOrderWeightLbs(items: ReadonlyArray<{ sku: string }>): number {
  return items.reduce((sum, item) => sum + getLabelWeightLbs(item.sku), 0);
}
