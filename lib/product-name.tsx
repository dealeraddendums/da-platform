// Sanitized rich-text rendering for product names + descriptions.
//
// Operators can author `option_name` / `description` with light
// formatting — bold for emphasis, a colored span (`3<span style="color:red">M</span>`
// for the 3M-style highlight), or an inline `<img>` for a brand logo.
// Rendering as plain text shows the raw HTML; rendering raw user HTML
// is an XSS hole. So we sanitize through a tight allowlist (tags +
// styles + URL scheme + host) and only then drop the result through
// dangerouslySetInnerHTML.
//
// Used by:
//   • <RichName> — product name renderer (table cells, library lists,
//     Add-from-Library modal, AddendumEditor rows, Configure Product
//     preview).
//   • sanitizeProductHtml — product NAME allowlist (tight/inline).
//   • sanitizeProductDescription — product DESCRIPTION allowlist: the
//     name allowlist PLUS the block structure the rich-text editor can
//     author (<p>, <ul>/<ol>/<li> with nested-list indent, font-size +
//     line-height). Description render sites (AddendumEditor row, the
//     Builder/print description widget) route through this so authored
//     bullets / line breaks / font size survive instead of collapsing.

import React from "react";
import DOMPurify from "isomorphic-dompurify";

// Tags operators are allowed to author. The NAME allowlist is tight/inline —
// only the inline emphasis a product name needs (bold, colored span, logo img).
// The DESCRIPTION allowlist adds exactly the block structure the rich-text
// editor (TipTap, components/RichTextEditor.tsx) can author: paragraphs and
// bullet/numbered lists (indent is a NESTED <ul>, not a margin). Nothing more —
// the allowlist should match everything the editor emits and nothing else.
const NAME_TAGS = ["span", "b", "strong", "i", "em", "u", "br", "sub", "sup", "img"];
const DESCRIPTION_TAGS = [...NAME_TAGS, "p", "ul", "ol", "li"];
const ALLOWED_ATTR = ["style", "src", "alt", "width", "height", "title"];

// CSS properties operators are allowed to set inline. DOMPurify applies this
// via the uponSanitizeAttribute hook because the style attribute is a free-form
// bag — needs per-property filtering. NAME stays tight; DESCRIPTION adds the two
// block controls the editor emits — font-size (the Size dropdown) and
// line-height (the line-spacing stepper). Verified against stored descriptions:
// the editor authors no text-align / margin-left, so those are intentionally
// excluded.
const NAME_STYLE_PROP_LIST = [
  "color",
  "font-weight",
  "font-style",
  "text-decoration",
  "background-color",     // for highlighter-style spans
  // Authored image sizing ("width:150px;height:auto" on a logo <img>). Without
  // these the sanitizer stripped the author's size and logos printed at
  // NATURAL resolution — a 1000px LLumar logo blowing out the Required
  // Products row on real stickers. Values are still length-checked and
  // url()/expression-rejected by filterStyleAttribute; purely cosmetic props.
  // (RichName table cells are unaffected — applyImgConstraint replaces the
  // style attribute wholesale there.)
  "width",
  "height",
  "max-width",
  "max-height",
];
const NAME_STYLE_PROPS = new Set(NAME_STYLE_PROP_LIST);
const DESCRIPTION_STYLE_PROPS = new Set([
  ...NAME_STYLE_PROP_LIST,
  "font-size",
  "line-height",
]);

// The uponSanitizeAttribute hook is global, so the style filter reads which
// allowlist to apply from here. DOMPurify.sanitize is synchronous, so setting
// this immediately before a sanitize call and resetting it after is race-free.
let activeStyleProps: Set<string> = NAME_STYLE_PROPS;

// S3 hosts the platform writes product images to. Anything else
// (operator pasted a logo from elsewhere, stale legacy URL) gets the
// <img> dropped — the sanitized output keeps the surrounding text.
const ALLOWED_IMG_HOSTS = new Set<string>([
  "addendum-product-images.s3.us-east-1.amazonaws.com",
  "addendum-product-images.s3.amazonaws.com",
  "dealer-addendums.s3.us-west-1.amazonaws.com",
  "dealer-addendums.s3.amazonaws.com",
]);

// Style-attribute filter — runs after DOMPurify's per-attribute hook.
// Splits the value, drops anything not on ALLOWED_STYLE_PROPS, rebuilds.
// Properties keep their values verbatim (color: red → kept), and the
// `url(…)` value escape DOMPurify performs guards against javascript:
// payloads in e.g. background-image (which we don't allow anyway).
function filterStyleAttribute(raw: string): string {
  const out: string[] = [];
  for (const decl of raw.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (!activeStyleProps.has(prop)) continue;
    if (!value || value.length > 100) continue;
    // Reject url() / expressions / known-malicious tokens regardless of property.
    if (/url\s*\(|expression\s*\(|javascript:/i.test(value)) continue;
    out.push(`${prop}:${value}`);
  }
  return out.join(";");
}

let hooksConfigured = false;
function ensureHooks() {
  if (hooksConfigured) return;
  // Style attribute filter
  DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName !== "style") return;
    data.attrValue = filterStyleAttribute(data.attrValue);
    if (!data.attrValue) data.keepAttr = false;
  });
  // <img> source allowlist — drop the node when the src isn't an
  // https URL on one of the known S3 hosts.
  DOMPurify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName !== "img") return;
    const el = node as Element;
    const src = el.getAttribute?.("src") ?? "";
    if (!isSafeImgSrc(src)) {
      // Replace with nothing — keep surrounding text intact.
      el.parentNode?.removeChild(el);
    }
  });
  hooksConfigured = true;
}

function isSafeImgSrc(src: string): boolean {
  try {
    const u = new URL(src);
    if (u.protocol !== "https:") return false;
    return ALLOWED_IMG_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function runSanitize(raw: string, tags: string[], styleProps: Set<string>): string {
  ensureHooks();
  activeStyleProps = styleProps;
  try {
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: tags,
      ALLOWED_ATTR,
      KEEP_CONTENT: true,      // strip disallowed tags but keep the inner text
    });
  } finally {
    activeStyleProps = NAME_STYLE_PROPS;   // reset so a stray call defaults tight
  }
}

// Legacy-ETL rows (Aurora-era, e.g. the 2026-05-10 LLumar imports) stored the
// WHOLE rich-text value entity-ESCAPED ("&lt;img src=&quot;…&quot;/&gt;…").
// DOMPurify rightly treats entities as literal text, so every surface except
// the Edit modal (which runs decodeNameEntities before its preview) displayed
// raw HTML source — including on printed stickers. Normalize at READ time:
// when the value contains no real tag but does contain escaped angle
// brackets, peel exactly ONE entity layer (same order as decodeNameEntities —
// &amp; LAST so double-encoded values aren't collapsed) and adopt the decoded
// value only if it now contains an authorable tag. A name that legitimately
// renders escaped text (e.g. "Under &lt;$500&gt;") fails the tag probe and
// stays untouched. Typed and picker-inserted HTML (stored raw) is unaffected.
// XSS posture unchanged: the decoded value goes through the SAME sanitizer —
// an escaped <script>/onerror payload decodes and is then stripped like any
// raw one.
const ESCAPED_TAG_PROBE = /<\s*(img|br|b|strong|i|em|u|span|sub|sup|p|ul|ol|li)[\s/>]/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

// MIXED values — real tags AND escaped tag source in the same string — are the
// common shape in the wild, and the whole-string peel above can't touch them
// (a blanket decode would also eat body-text entities that are correctly single
// -encoded, e.g. "Paint &amp; Interior"). Two ways they get made:
//   • legacy-ETL rows that escaped the markup but left the line breaks real
//     ("&lt;div style=&quot;…&quot;&gt;Text<br />&lt;/div&gt;"), and
//   • an operator pasting HTML SOURCE into the rich-text editor, which stores
//     it as text and auto-links any URL inside it
//     ("&lt;img src=&quot;<a href="https://…">https://…</a>&quot;/&gt;").
// Either way the escaped fragment printed as visible tag source on the sticker.
// So decode per FRAGMENT instead: a `&lt;tag …&gt;` run that doesn't cross
// another `&lt;` (which bounds the span — no runaway match), with any real tags
// inside it unwrapped to their text (that's what rescues the auto-linked src).
// Everything outside a fragment is left byte-identical, so body-text entities
// keep their single encoding. The tag list is broader than the render allowlist
// on purpose: an escaped <div>/<font>/<center> should decode and then be
// dropped-but-kept-content by the sanitizer, not printed as source.
const FRAGMENT_TAGS =
  "img|br|b|strong|i|em|u|span|sub|sup|p|ul|ol|li|div|a|font|center|s|strike|small|big|h[1-6]|tt|pre";
const ESCAPED_FRAGMENT_RE = new RegExp(
  `&lt;\\s*/?\\s*(?:${FRAGMENT_TAGS})\\b(?:(?!&lt;)[\\s\\S])*?&gt;`,
  "gi",
);

// An escaped tag token with NO attributes that never reaches its "&gt;" —
// "&lt;/li<br />" or a value truncated mid-tag. There is no terminator to
// decode against, so the fragment rule above can't see it and the bare token
// printed on the sticker. Nothing legitimate reads as "</li", so drop the
// token (its content sits outside it and is untouched). Deliberately narrow:
// a token carrying ATTRIBUTES is left alone — "&lt;img src=&quot;…" with a
// real tag after it is a fragment the rule above handles, and guessing a
// terminator there rewrites a value that renders correctly today.
const UNTERMINATED_BARE_TAG_RE = new RegExp(
  `&lt;\\s*/?\\s*(?:${FRAGMENT_TAGS})\\b\\s*(?=&lt;|<|$)`,
  "gi",
);

function decodeEscapedTagFragments(raw: string): string {
  return raw
    .replace(ESCAPED_FRAGMENT_RE, (fragment) =>
      // Unwrap real tags inside the fragment (the editor's auto-link around a
      // pasted src URL) keeping their text, then decode the fragment itself.
      decodeEntities(fragment.replace(/<[^>]*>/g, "")),
    )
    .replace(UNTERMINATED_BARE_TAG_RE, "");
}

function normalizeEscapedHtml(raw: string): string {
  if (!/&lt;/i.test(raw)) return raw;
  if (raw.includes("<")) return decodeEscapedTagFragments(raw);
  const decoded = decodeEntities(raw);
  if (ESCAPED_TAG_PROBE.test(decoded)) return decoded;
  // Whole-string peel rejected — the value carries no tag the probe knows.
  // Fall through to fragment decoding rather than giving up: the probe list is
  // the inline set, so a value whose only markup is an escaped <div> wrapper
  // (common in legacy-ETL descriptions) failed it and printed as tag source.
  // Fragment decoding is tag-gated per match, so escaped display text that
  // isn't a tag at all ("Under &lt;$500&gt;") is still returned untouched.
  return decodeEscapedTagFragments(raw);
}

/** Repair a stored product name/description whose markup arrived entity-escaped
 *  (wholly, from the legacy ETL, or in fragments — see normalizeEscapedHtml).
 *  Exported for the two call sites that must decide "is this HTML?" BEFORE
 *  sanitizing: the print/canvas description renderer and the rich-text editor's
 *  content loader. Both would otherwise treat escaped markup as plain text and
 *  escape it a second time. NOT a substitute for sanitizing — the result still
 *  goes through sanitizeProductHtml / sanitizeProductDescription to render. */
export function normalizeProductHtmlSource(raw: string | null | undefined): string {
  if (!raw) return "";
  return normalizeEscapedHtml(String(raw));
}

/** Sanitize a product NAME — tight, inline-only allowlist (bold/colored span/
 *  logo img). Returns clean HTML safe for dangerouslySetInnerHTML. */
export function sanitizeProductHtml(raw: string | null | undefined): string {
  if (!raw) return "";
  return runSanitize(normalizeEscapedHtml(String(raw)), NAME_TAGS, NAME_STYLE_PROPS);
}

/** Sanitize a product DESCRIPTION — the name allowlist plus the block structure
 *  the rich-text editor authors: <p>, <ul>/<ol>/<li> (incl. nested-list indent)
 *  and the font-size + line-height inline styles. Keeps the same script/img/url()
 *  rejection as names. Use this for every description render (table row, Builder
 *  canvas, print) so authored bullets/breaks/size survive instead of collapsing. */
export function sanitizeProductDescription(raw: string | null | undefined): string {
  if (!raw) return "";
  return runSanitize(normalizeEscapedHtml(String(raw)), DESCRIPTION_TAGS, DESCRIPTION_STYLE_PROPS);
}

// ── Parsed-name helpers (image metadata extraction) ──────────────────

const IMG_TAG_RE = /<img\b[^>]*?>/i;
const SRC_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;
const ALT_RE = /\balt\s*=\s*["']([^"']*)["']/i;

/** Filename-derived label used as alt-text fallback when the operator
 *  didn't set one on the embedded image. */
export function deriveAltFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    let name = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    name = name.replace(/\.[a-z0-9]+$/i, "");
    name = name.replace(/[_-]+/g, " ").trim();
    name = name.replace(/^\d+\s*/, "");
    return name.replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

export interface ParsedProductName {
  hasImage: boolean;
  imageUrl: string | null;
  alt: string | null;
  /** Best human-readable label: alt → derived filename → fallback. */
  label: string;
}

export function parseProductName(raw: string | null | undefined): ParsedProductName {
  const s = (raw ?? "").trim();
  if (!s) return { hasImage: false, imageUrl: null, alt: null, label: "" };
  const m = s.match(IMG_TAG_RE);
  if (!m) return { hasImage: false, imageUrl: null, alt: null, label: s };
  const tag = m[0];
  const imageUrl = tag.match(SRC_RE)?.[1] ?? null;
  const altAttr = tag.match(ALT_RE)?.[1] ?? null;
  const derived = imageUrl ? deriveAltFromUrl(imageUrl) : "";
  const label = (altAttr && altAttr.trim()) || derived || "Product image";
  return { hasImage: true, imageUrl, alt: altAttr, label };
}

// ── Renderer ─────────────────────────────────────────────────────────

/**
 * Post-process the sanitized HTML to constrain any `<img>` tag to the
 * caller's imgMaxH (overriding any width/height/style the operator
 * authored, since those make logos overflow table rows). The sanitizer
 * already stripped scripts + non-allowlisted attributes, so we only
 * have to handle the size override here.
 */
function applyImgConstraint(clean: string, imgMaxH: number): string {
  const constraint = `max-height:${imgMaxH}px;width:auto;object-fit:contain;vertical-align:middle;display:inline-block`;
  return clean.replace(/<img\b([^>]*)>/gi, (_m, attrs: string) => {
    // Drop the operator's dimensional attributes — our constraint wins.
    let stripped = attrs
      .replace(/\bwidth\s*=\s*["'][^"']*["']/gi, "")
      .replace(/\bheight\s*=\s*["'][^"']*["']/gi, "")
      .replace(/\bstyle\s*=\s*["'][^"']*["']/gi, "");
    if (stripped && !stripped.startsWith(" ")) stripped = " " + stripped;
    return `<img${stripped} style="${constraint}">`;
  });
}

/**
 * Render a product name with sanitized HTML.
 *
 *   name       Raw value from option_name (may include inline tags or
 *              an <img>). Anything outside the allowlist is dropped.
 *   imgMaxH    Constrains embedded images to this px height (width
 *              auto) so a logo doesn't blow out a table row.
 *   showLabel  When true and the name carries an <img>, render the
 *              filename/alt-derived label beside the image. Used in
 *              the table + library list where the dealer needs the
 *              text affordance; omit in the Configure Product preview
 *              where the input already shows the raw value.
 *
 * Why dangerouslySetInnerHTML: operators rely on inline styled spans
 * (the "red M" case). Rendering through React props can't produce
 * that. Sanitization above is the gatekeeper.
 */
export function RichName({
  name,
  imgMaxH = 24,
  showLabel = false,
  className,
  style,
}: {
  name: string | null | undefined;
  imgMaxH?: number;
  showLabel?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const clean = sanitizeProductHtml(name);
  if (!clean) {
    return <span className={className} style={style} />;
  }
  const constrained = applyImgConstraint(clean, imgMaxH);
  const parsed = parseProductName(name);
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: showLabel && parsed.hasImage ? 8 : 0,
        ...style,
      }}
    >
      <span
        style={{ display: "inline-flex", alignItems: "center" }}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: constrained }}
      />
      {showLabel && parsed.hasImage && (
        <span style={{ color: "inherit" }}>{parsed.label}</span>
      )}
    </span>
  );
}
