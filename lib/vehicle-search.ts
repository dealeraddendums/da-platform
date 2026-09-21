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

/**
 * Text fields a term is matched against — kept aligned with the columns the
 * inventory table actually SHOWS (Stock # · Year / Make / Model · Trim · VIN),
 * because a field that is visible but unsearchable reads as a broken search.
 *
 * `trim` was the missing one: a "2025 Ford F-150 / Raptor" sits right there on
 * the page with Raptor rendered under the model, and searching "Raptor"
 * returned nothing.
 *
 * `year` is an integer column, so it can't take ilike — it is matched
 * separately, and only for a term that actually looks like a model year.
 *
 * `condition` is displayed too but deliberately NOT here: it holds New/Used,
 * so "new" would match half the lot, and the New/Used/CPO filter already
 * covers it precisely.
 */
export const VEHICLE_SEARCH_FIELDS = ["stock_number", "vin", "make", "model", "trim"] as const;

/**
 * Bound on how many terms one search may carry. Each term expands to one
 * condition per searchable field, and the whole tree rides in a query string
 * through nginx and on
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

/**
 * A term that looks like a model year also matches the integer `year` column,
 * so "2025" finds 2025 units. Anything else (a stock number like 41805, a
 * price) must not, or a numeric stock number would drag in a whole model year.
 */
function yearClause(term: string): string {
  const n = Number.parseInt(term, 10);
  return /^\d{4}$/.test(term.trim()) && n >= 1900 && n <= 2099 ? `year.eq.${n}` : "";
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
export function buildVehicleSearchOr(terms: string[]): string | null {
  const clauses: string[] = [];
  for (const term of terms) {
    const pattern = ilikePattern(term);
    for (const field of VEHICLE_SEARCH_FIELDS) clauses.push(`${field}.ilike.${pattern}`);
    const y = yearClause(term);
    if (y) clauses.push(y);
  }
  return clauses.length ? clauses.join(",") : null;
}
