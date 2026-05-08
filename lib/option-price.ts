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

function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatOptionPrice(price: string | null | undefined): string {
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
  if (!isNaN(n)) return `$${formatNumber(n)}${suffix}`;
  return p;
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
