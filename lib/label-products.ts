export interface LabelOption {
  qty: number;
  price: number;
  shipping: 'standard' | 'fedex';
}

export interface LabelProduct {
  sku: string;
  name: string;
  size: string;
  options: LabelOption[];
}

// ── Live pricing (da-billing is the source of truth) ─────────────────────────
//
// da-billing serves the KV-backed catalog at GET /api/v1/settings/label-pricing
// (public — it's a price list). The hardcoded LABEL_PRODUCTS below stays as the
// fallback when da-billing is unreachable, so Order Supplies never goes blank.

export interface LabelPricingEntry {
  id: string;
  labelType: string;    // da-billing slug, e.g. "4.25x11-standard"
  description: string;
  quantity: number;
  fedex: boolean;
  price: number;
}

/** labelType slug → Order Supplies card identity. Inverse of the
 *  SKU_TO_LABEL_TYPE map in app/api/orders/labels/route.ts. Order here is
 *  the card display order. */
export const LABEL_TYPE_TO_PRODUCT: Record<string, { sku: string; name: string; size: string }> = {
  '4.25x11-standard':   { sku: '8300-1', name: 'Regular Addendums',              size: '4.25"×11"' },
  '4.25x11-waterproof': { sku: '9300-1', name: 'Regular Addendums — Waterproof', size: '4.25"×11"' },
  '3.125x11-standard':  { sku: '8300-3', name: 'Narrow Addendums',               size: '3.125"×11"' },
  '3.125x11-waterproof':{ sku: '9300-3', name: 'Narrow Addendums — Waterproof',  size: '3.125"×11"' },
  '8.5x11-standard':    { sku: '8300',   name: 'Full Sheet Labels',              size: '8.5"×11"' },
  '8.5x11-waterproof':  { sku: '9300',   name: 'Full Sheet Labels — Waterproof', size: '8.5"×11"' },
};

const BILLING_API_URL = () => process.env.BILLING_API_URL ?? 'https://billing.dealeraddendums.com';

/**
 * Fetch the raw pricing entries from da-billing. `fresh: true` bypasses the
 * Next data cache (order placement must price against the live catalog);
 * otherwise cached for an hour (Order Supplies display). Returns null on any
 * failure — callers fall back (display → LABEL_PRODUCTS; orders → caller price).
 */
export async function fetchLabelPricingEntries(opts?: { fresh?: boolean }): Promise<LabelPricingEntry[] | null> {
  try {
    const res = await fetch(`${BILLING_API_URL()}/api/v1/settings/label-pricing`, {
      ...(opts?.fresh ? { cache: 'no-store' as const } : { next: { revalidate: 3600 } }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { entries?: LabelPricingEntry[] };
    if (!Array.isArray(data.entries) || data.entries.length === 0) return null;
    return data.entries;
  } catch {
    return null;
  }
}

/**
 * The Order Supplies catalog: live entries from da-billing grouped into
 * LabelProduct cards, falling back to the hardcoded LABEL_PRODUCTS when
 * da-billing is unreachable. Server-side only (fetch + env).
 */
export async function fetchLabelProducts(): Promise<LabelProduct[]> {
  const entries = await fetchLabelPricingEntries();
  if (!entries) return LABEL_PRODUCTS;

  const products: LabelProduct[] = [];
  for (const [labelType, meta] of Object.entries(LABEL_TYPE_TO_PRODUCT)) {
    const options = entries
      .filter((e) => e.labelType === labelType)
      .sort((a, b) => a.quantity - b.quantity || Number(a.fedex) - Number(b.fedex))
      .map((e) => ({ qty: e.quantity, price: e.price, shipping: e.fedex ? 'fedex' as const : 'standard' as const }));
    if (options.length) products.push({ sku: meta.sku, name: meta.name, size: meta.size, options });
  }
  // A live catalog missing every known type would render an empty page —
  // treat it as a bad read and fall back.
  return products.length ? products : LABEL_PRODUCTS;
}

export const LABEL_PRODUCTS: LabelProduct[] = [
  {
    sku: '8300-1',
    name: 'Regular Addendums',
    size: '4.25"×11"',
    options: [
      { qty: 250, price: 75, shipping: 'standard' },
      { qty: 250, price: 125, shipping: 'fedex' },
      { qty: 500, price: 135, shipping: 'standard' },
      { qty: 1000, price: 255, shipping: 'standard' },
      { qty: 2000, price: 455, shipping: 'standard' },
    ],
  },
  {
    sku: '9300-1',
    name: 'Regular Addendums — Waterproof',
    size: '4.25"×11"',
    options: [
      { qty: 250, price: 115, shipping: 'standard' },
      { qty: 250, price: 165, shipping: 'fedex' },
      { qty: 500, price: 220, shipping: 'standard' },
      { qty: 1000, price: 430, shipping: 'standard' },
      { qty: 2000, price: 810, shipping: 'standard' },
    ],
  },
  {
    sku: '8300-3',
    name: 'Narrow Addendums',
    size: '3.125"×11"',
    options: [
      { qty: 250, price: 75, shipping: 'standard' },
      { qty: 250, price: 125, shipping: 'fedex' },
      { qty: 500, price: 135, shipping: 'standard' },
      { qty: 1000, price: 255, shipping: 'standard' },
      { qty: 2000, price: 455, shipping: 'standard' },
    ],
  },
  {
    sku: '9300-3',
    name: 'Narrow Addendums — Waterproof',
    size: '3.125"×11"',
    options: [
      { qty: 250, price: 75, shipping: 'standard' },
      { qty: 250, price: 165, shipping: 'fedex' },
      { qty: 500, price: 220, shipping: 'standard' },
      { qty: 1000, price: 430, shipping: 'standard' },
      { qty: 2000, price: 810, shipping: 'standard' },
    ],
  },
  {
    sku: '8300',
    name: 'Full Sheet Labels',
    size: '8.5"×11"',
    options: [
      { qty: 250, price: 105, shipping: 'standard' },
      { qty: 500, price: 190, shipping: 'standard' },
      { qty: 1000, price: 370, shipping: 'standard' },
      { qty: 2000, price: 725, shipping: 'standard' },
    ],
  },
  {
    sku: '9300',
    name: 'Full Sheet Labels — Waterproof',
    size: '8.5"×11"',
    options: [
      { qty: 100, price: 135, shipping: 'standard' },
      { qty: 200, price: 250, shipping: 'standard' },
      { qty: 400, price: 490, shipping: 'standard' },
      { qty: 800, price: 810, shipping: 'standard' },
    ],
  },
];
