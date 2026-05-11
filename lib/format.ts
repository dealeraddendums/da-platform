// Shared display formatters. Importing into a component is cheaper than
// re-implementing these inline -- the dealer-name HTML-entity bug bit us
// because there were three render sites and only one of them happened to
// decode.

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": "\"",
  "&apos;": "'",
  "&nbsp;": " ",
};

// Stripped characters: C0 controls (except \t \n \r), DEL, and the Unicode
// replacement glyph U+FFFD -- these render as the "small square" boxes
// trailing some legacy dealer IDs and names. Built from escape sequences so
// the source stays ASCII-clean and survives copy/paste.
const STRIP_BAD_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\uFFFD]",
  "g",
);

/**
 * Decode HTML entities that have leaked into stored dealer/group names
 * (e.g. `Allan&#039;s Wed test Group Dealer`). Pure-string implementation so
 * it works in both server and client components -- DealerList's older
 * <textarea>-based decodeHtml only worked on the client.
 */
export function decodeHtmlEntities(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, m => NAMED_ENTITIES[m] ?? m)
    .replace(/&#0*39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(STRIP_BAD_CHARS, "");
}

/**
 * Format a `created_at` / `updated_at` timestamp as M/D/YYYY, or return null
 * if the value is missing, unparseable, or obviously bogus (Unix epoch 0
 * renders as 12/31/1969 in US time zones and was leaking into the Group
 * detail page). Callers should hide the "Created" / "Last updated" line
 * entirely when this returns null instead of rendering a stale fallback.
 */
export function formatCreatedDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getFullYear() < 2010) return null;
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
}
