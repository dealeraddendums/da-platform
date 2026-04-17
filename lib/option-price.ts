// Client-safe: price formatting helpers for option prices.
// No server dependencies — safe to import from client components.

export function formatOptionPrice(price: string): string {
  if (!price) return "N/C";
  const p = price.trim();
  if (!p || ["NC", "NP", "INC", "FR"].includes(p.toUpperCase())) {
    const labels: Record<string, string> = { NC: "N/C", NP: "N/P", INC: "Incl.", FR: "F/R" };
    return labels[p.toUpperCase()] ?? p;
  }
  if (p.startsWith("|") && p.endsWith("|")) {
    const n = parseFloat(p.slice(1, -1));
    return isNaN(n) ? p : `Incl. $${n.toLocaleString()}`;
  }
  if (p.startsWith("^")) {
    const n = parseFloat(p.slice(1));
    return isNaN(n) ? p : `$${n.toLocaleString()}`;
  }
  if (p.endsWith("%")) return p;
  if (p.includes("~")) return `$${parseFloat(p).toLocaleString()}`;
  const n = parseFloat(p);
  if (!isNaN(n)) return `$${n.toLocaleString()}`;
  return p;
}

export function parseOptionPriceValue(price: string): number {
  if (!price) return 0;
  const p = price.trim().toUpperCase();
  if (["NC", "NP", "INC", "FR"].includes(p)) return 0;
  if (p.endsWith("%")) return 0;
  const stripped = p.replace(/[|^~*]/g, "");
  const n = parseFloat(stripped);
  return isNaN(n) ? 0 : n;
}
