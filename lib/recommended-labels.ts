import type { SupabaseClient } from "@supabase/supabase-js";

// Paper sizes the Builder stores in templates.template_json.paperSize.
// Maps 1:1 to the physical width of the label stock the printed PDF
// renders against, which is what we use to recommend label SKUs on the
// Order Labels tab.
//
// - 'narrow'    → 3.125" wide stock
// - 'standard'  → 4.25"  wide stock
// - 'infosheet' → 8.5"   wide stock (full sheet)
export type AddendumPaperSize = "narrow" | "standard" | "infosheet";

const ADDENDUM_TEMPLATE_COLUMNS = [
  "default_addendum_new",
  "default_addendum_used",
  "default_addendum_cpo",
] as const;

/**
 * Read the dealer's default addendum templates from dealer_settings,
 * pull each referenced template's paperSize out of template_json, and
 * return the deduplicated set of recommended paper sizes.
 *
 * Returns an empty array when no addendum templates are assigned, so
 * the Order Labels tab can silently render no recommendation in that
 * case (per the feature spec: "If no template is assigned, show no
 * recommendation").
 *
 * Uses the caller-provided admin client so we don't open a second
 * server-role connection from a route that already has one.
 */
export async function getRecommendedAddendumPaperSizes(
  admin: SupabaseClient,
  dealerTextId: string,
): Promise<AddendumPaperSize[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: settings } = await (admin as any)
    .from("dealer_settings")
    .select(ADDENDUM_TEMPLATE_COLUMNS.join(","))
    .eq("dealer_id", dealerTextId)
    .maybeSingle();

  if (!settings) return [];

  const templateIds = ADDENDUM_TEMPLATE_COLUMNS
    .map(col => (settings as Record<string, string | null>)[col])
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  if (templateIds.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: templates } = await (admin as any)
    .from("templates")
    .select("id, template_json")
    .in("id", templateIds);

  const sizes = new Set<AddendumPaperSize>();
  for (const row of (templates ?? []) as Array<{ template_json: { paperSize?: string } | null }>) {
    const ps = row.template_json?.paperSize;
    if (ps === "narrow" || ps === "standard" || ps === "infosheet") sizes.add(ps);
  }
  return Array.from(sizes);
}

// ── UI helpers (used on the Order Labels tab) ─────────────────────────────────

/** Human-readable width string for the recommendation tip. */
export function paperSizeWidthLabel(size: AddendumPaperSize): string {
  switch (size) {
    case "narrow":    return '3.125"';
    case "standard":  return '4.25"';
    case "infosheet": return '8.5" full sheet';
  }
}

/**
 * Whether a label-catalog product matches the given addendum paper size.
 * Matched by leading width string in LabelProduct.size — keeps the
 * paper-size enum and the label SKU catalog decoupled from each other.
 */
export function productMatchesPaperSize(productSize: string, size: AddendumPaperSize): boolean {
  switch (size) {
    case "narrow":    return productSize.startsWith('3.125"');
    case "standard":  return productSize.startsWith('4.25"');
    case "infosheet": return productSize.startsWith('8.5"');
  }
}
