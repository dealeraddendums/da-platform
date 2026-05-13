// Client-safe: price formatting helpers for option prices.
// No server dependencies — safe to import from client components.
//
// Modifier codes:
//   NP             → render nothing
//   FR             → "Free"
//   INC            → "Included"
//   NC             → "No Charge"
//   N% (e.g. 5%)   → render as-is (percentage of MSRP)
//   |N             → render price; excluded from subtotal
//   ^N             → hide price; included in subtotal
//   N~text         → render price with trailing text (e.g. 199~* → $199.00*)
//   numeric        → render as $X,XXX.00

const NULL_CODES = new Set(['NP']);
const LABEL_CODES: Record<string, string> = {
  FR: 'Free',
  INC: 'Included',
  NC: 'No Charge',
};

function formatNumber(n: number, decimals: boolean): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  });
}

/**
 * Format a single option price. The optional `decimals` flag controls the
 * fraction-digit policy for numeric portions:
 *   - true  (default) → always two decimal places, e.g. $499.00
 *   - false           → no decimals, e.g. $499
 * Modifier codes (FR, INC, NC, NP, ^, |, ~, %) bypass numeric formatting
 * and are unaffected by this flag.
 */
export function formatOptionPrice(price: string | null | undefined, decimals: boolean = true): string {
  if (price == null) return '';
  const p = String(price).trim();
  if (!p) return '';

  const upper = p.toUpperCase();
  if (NULL_CODES.has(upper)) return '';
  if (LABEL_CODES[upper]) return LABEL_CODES[upper];

  if (p.endsWith('%')) return p;

  // ^ prefix → hide displayed price (still counted in subtotal)
  if (p.startsWith('^')) return '';

  // | prefix → show price; exclude from subtotal (display behaves normally)
  let body = p.startsWith('|') ? p.slice(1) : p;

  // ~ suffix → text after ~ is appended after the formatted price
  let suffix = '';
  const tildeIdx = body.indexOf('~');
  if (tildeIdx >= 0) {
    suffix = body.slice(tildeIdx + 1);
    body = body.slice(0, tildeIdx);
  }

  const n = parseFloat(body);
  if (!isNaN(n)) return `$${formatNumber(n, decimals)}${suffix}`;
  return p;
}

/**
 * Decide whether a set of numeric prices should be displayed with two decimal
 * places. Returns true if any amount has a fractional part. Use the result
 * across every price label on the same addendum so they all agree (product
 * rows, subtotal, MSRP, asking price, suggested price).
 */
export function priceSetUsesDecimals(amounts: Array<number | null | undefined>): boolean {
  return amounts.some(a => typeof a === 'number' && Number.isFinite(a) && a % 1 !== 0);
}

/**
 * Format a single numeric currency amount with or without decimals according
 * to the shared rule. Pair with priceSetUsesDecimals() to keep every price on
 * one addendum aligned.
 */
export function formatCurrencyAmount(amount: number, decimals: boolean): string {
  return '$' + amount.toLocaleString('en-US', {
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  });
}

export function parseOptionPriceValue(price: string | null | undefined): number {
  if (price == null) return 0;
  const p = String(price).trim();
  if (!p) return 0;

  const upper = p.toUpperCase();
  if (NULL_CODES.has(upper) || LABEL_CODES[upper]) return 0;
  if (p.endsWith('%')) return 0;

  // | prefix → excluded from subtotal
  if (p.startsWith('|')) return 0;

  // ^ prefix → counted in subtotal (price is hidden)
  let body = p.startsWith('^') ? p.slice(1) : p;

  // ~ suffix is annotation text, ignore for value parsing
  const tildeIdx = body.indexOf('~');
  if (tildeIdx >= 0) body = body.slice(0, tildeIdx);

  const n = parseFloat(body);
  return isNaN(n) ? 0 : n;
}
