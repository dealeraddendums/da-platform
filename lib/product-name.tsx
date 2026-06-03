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
//   • sanitizeProductHtml — exported separately so the description
//     render in AddendumEditor can route through the SAME allowlist
//     (the existing dangerouslySetInnerHTML there was unsanitized).

import React from "react";
import DOMPurify from "isomorphic-dompurify";

// Tags and attributes operators are allowed to author. Everything else
// is dropped by DOMPurify per the spec doc.
const ALLOWED_TAGS = ["span", "b", "strong", "i", "em", "u", "br", "sub", "sup", "img"];
const ALLOWED_ATTR = ["style", "src", "alt", "width", "height", "title"];

// CSS properties operators are allowed to set inline. DOMPurify
// applies this via the uponSanitizeAttribute hook because the style
// attribute is a free-form bag — needs per-property filtering.
const ALLOWED_STYLE_PROPS = new Set([
  "color",
  "font-weight",
  "font-style",
  "text-decoration",
  "background-color",     // for highlighter-style spans
]);

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
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue;
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

/** Run the input through the configured DOMPurify allowlist. Returns a
 *  string of clean HTML safe to pass to dangerouslySetInnerHTML. */
export function sanitizeProductHtml(raw: string | null | undefined): string {
  if (!raw) return "";
  ensureHooks();
  return DOMPurify.sanitize(String(raw), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    KEEP_CONTENT: true,      // strip the tags but keep the inner text
  });
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
