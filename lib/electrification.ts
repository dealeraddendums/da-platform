// Vehicle electrification level (migration 175) — pure helpers, safe to import
// from client components, API routes, and the PDF renderer alike.
//
// vPIC's ElectrificationLevel comes back as a long label, e.g.
//   "HEV (Hybrid Electric Vehicle) - Level Unknown"
//   "Strong HEV (Hybrid Electric Vehicle)"
//   "PHEV (Plug-in Hybrid Electric Vehicle)"
//   "BEV (Battery Electric Vehicle)"
// We store and print only the SHORT token ("HEV", "Strong HEV", "PHEV", "BEV").
// Non-electric vehicles (vPIC returns "") store nothing.

const NOT_ELECTRIC = new Set(["", "not applicable", "n/a", "na", "none", "null", "0"]);

/** Long vPIC label (or an operator-typed value) → short token; "" for non-electric. */
export function normalizeElectrification(raw: unknown): string {
  if (raw == null) return "";
  let s = String(raw);
  const paren = s.indexOf("(");
  if (paren >= 0) s = s.slice(0, paren);
  s = s.replace(/\s*-\s*level\b.*$/i, "");   // "HEV - Level Unknown" (no-paren form)
  s = s.replace(/[\s-]+$/, "").replace(/\s+/g, " ").trim();
  if (NOT_ELECTRIC.has(s.toLowerCase())) return "";
  return s.slice(0, 32);
}

/**
 * The Trim as it should DISPLAY on an addendum. Appends the electrification
 * token only when the dealer turned the setting on AND the vehicle has one;
 * otherwise returns the trim exactly as stored (no trailing space).
 */
export function trimWithElectrification(
  trim: string | null | undefined,
  electrification: string | null | undefined,
  enabled: boolean,
): string {
  const t = (trim ?? "").trim();
  const e = enabled ? normalizeElectrification(electrification) : "";
  if (!e) return trim ?? "";
  return t ? `${t} ${e}` : e;
}
