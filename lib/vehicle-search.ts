/**
 * Vehicle free-text search → a PostgREST `.or()` tree.
 *
 * Two things this has to get right, both learned the hard way:
 *
 * 1. ESCAPING. PostgREST reads `,` `(` `)` as logic-tree syntax, so a raw
 *    value interpolated into `.or()` can break the whole request — that is
 *    the dealer-search bug fixed platform-wide in 8de784b. Same quoting
 *    applies here.
 *
 * 2. TOKENIZING. The inventory box accepted only ONE term, so pasting a list
 *    of stock numbers ("T42746,T42675,T42720") jammed the commas straight
 *    into each ilike — which both failed to parse AND, being the `.or()`
 *    delimiter, produced a nonsense tree. Pasting a list is the natural thing
 *    to do with a pull sheet, so a list is now the supported input: terms are
 *    split, escaped, and OR'd, giving the UNION of matches.
 */

/** Fields a term is matched against, in the order the UI presents them. */
export const VEHICLE_SEARCH_FIELDS = ["stock_number", "vin", "make", "model"] as const;

/**
 * Bound on how many terms one search may carry. Each term expands to four
 * conditions, and the whole tree rides in a query string through nginx and on
 * to PostgREST, so an unbounded paste could blow the request-line limit and
 * fail as an opaque 4xx. Callers surface `truncated` rather than silently
 * searching a subset.
 */
export const MAX_SEARCH_TERMS = 25;

/**
 * Split a query into search terms on commas, whitespace and newlines — the
 * separators you actually get from a pasted column of stock numbers or a
 * hand-typed "F-150, Explorer". Empty and repeated separators are tolerated;
 * duplicates collapse (case-insensitively) so a sloppy paste doesn't inflate
 * the tree.
 */
export function tokenizeSearch(q: string): { terms: string[]; truncated: boolean } {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of (q ?? "").split(/[\s,]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
  }
  return { terms: terms.slice(0, MAX_SEARCH_TERMS), truncated: terms.length > MAX_SEARCH_TERMS };
}

/**
 * Double-quoted ilike pattern (8de784b). Quoting is what makes a term
 * containing a comma, paren or quote safe inside the tree.
 */
function ilikePattern(term: string): string {
  return `"%${term.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}%"`;
}

/** A 4-digit year is also matched against the year column, as before. */
function yearClause(term: string): string {
  const n = Number.parseInt(term, 10);
  return /^\d{4}$/.test(term.trim()) && n >= 1900 && n <= 2099 ? `,year.eq.${n}` : "";
}

/**
 * Build the OR tree for a set of terms: every term is OR'd across every
 * field, and all of it is OR'd together, so the result is the union — a
 * vehicle matching ANY term is returned.
 *
 * Matching stays CONTAINS (`%term%`) for every field, deliberately. Exact
 * matching on stock_number/vin would return the listed units more tightly,
 * but it would also break the everyday partial search ("T427", "F-150") that
 * this box has always supported — and for a pasted list of full stock
 * numbers or VINs, contains already returns exactly those units.
 *
 * Returns null when there is nothing to search, so callers can skip `.or()`.
 */
export function buildVehicleSearchOr(
  terms: string[],
  opts: { includeYear?: boolean } = {},
): string | null {
  const clauses: string[] = [];
  for (const term of terms) {
    const pattern = ilikePattern(term);
    for (const field of VEHICLE_SEARCH_FIELDS) clauses.push(`${field}.ilike.${pattern}`);
    if (opts.includeYear !== false) {
      const y = yearClause(term);
      if (y) clauses.push(y.slice(1));
    }
  }
  return clauses.length ? clauses.join(",") : null;
}
