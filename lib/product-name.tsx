// Shared rendering of `addendum_library.option_name` / `vehicle_options.option_name`
// values. The platform allows operators to embed an `<img …>` tag in a
// product name (logo at the start of an Item Name); displaying it as
// plain text shows the raw HTML, while passing user-authored HTML to
// dangerouslySetInnerHTML opens an XSS surface.
//
// Strategy:
//   1. parseProductName(raw) pulls the first <img> tag out (if any) with
//      regex tuned to the SPECIFIC tag shape the platform writes
//      (`<img src="…" alt="…" width="125" style="…" />`). It is NOT a
//      general HTML parser — anything more elaborate stays in `text`.
//   2. <ProductName name> renders a CONTROLLED <img> + label, never the
//      raw HTML. Thumbnail only when src is https AND on the allowlisted
//      S3 hosts. Anything else collapses to label-only.

import React from "react";

const IMG_TAG_RE = /<img\b[^>]*?>/i;
const SRC_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;
const ALT_RE = /\balt\s*=\s*["']([^"']*)["']/i;

// Hosts that DA writes product-image URLs to. Anything else (operator
// pasted in a logo from elsewhere, a stale legacy URL, etc.) renders as
// label-only — no remote image is fetched.
const SAFE_HOSTS = new Set<string>([
  "addendum-product-images.s3.us-east-1.amazonaws.com",
  "addendum-product-images.s3.amazonaws.com",
  "dealer-addendums.s3.us-west-1.amazonaws.com",
  "dealer-addendums.s3.amazonaws.com",
]);

function isSafeSrc(src: string): boolean {
  try {
    const u = new URL(src);
    if (u.protocol !== "https:") return false;
    return SAFE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Derive a human-friendly label from an S3 image URL when no alt is set.
 *  Strips path + extension, decodes %-escapes, replaces _/- with spaces,
 *  drops a leading all-digits token (typical upload-timestamp prefix). */
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
  /** Plain text remaining after the <img> tag is removed (rarely used today). */
  text: string;
}

export function parseProductName(raw: string | null | undefined): ParsedProductName {
  const s = (raw ?? "").trim();
  if (!s) return { hasImage: false, imageUrl: null, alt: null, label: "", text: "" };

  const imgMatch = s.match(IMG_TAG_RE);
  if (!imgMatch) {
    return { hasImage: false, imageUrl: null, alt: null, label: s, text: s };
  }
  const tag = imgMatch[0];
  const imageUrl = tag.match(SRC_RE)?.[1] ?? null;
  const altAttr = tag.match(ALT_RE)?.[1] ?? null;
  const derived = imageUrl ? deriveAltFromUrl(imageUrl) : "";
  const label =
    (altAttr && altAttr.trim())
    || (derived && derived)
    || "Product image";
  const leftover = s.replace(IMG_TAG_RE, "").trim();
  return {
    hasImage: true,
    imageUrl,
    alt: altAttr,
    label,
    text: leftover,
  };
}

/**
 * Render a product name. Plain names pass through; names containing an
 * `<img>` tag render as a controlled thumbnail + label so the dealer
 * sees what the product is instead of "<img src=…>" code.
 *
 *   thumb       Height (px) of the thumbnail when shown. Defaults to 24
 *               which fits comfortably in table rows.
 */
export function ProductName({
  name,
  thumb = 24,
  className,
  style,
}: {
  name: string | null | undefined;
  thumb?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const parsed = parseProductName(name);
  if (!parsed.hasImage) {
    return <span className={className} style={style}>{parsed.label}</span>;
  }
  const showThumb = parsed.imageUrl != null && isSafeSrc(parsed.imageUrl);
  const trailing = parsed.text && parsed.text !== parsed.label ? ` ${parsed.text}` : "";
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 8, ...style }}
    >
      {showThumb && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={parsed.imageUrl as string}
          alt={parsed.label}
          style={{
            height: thumb,
            maxWidth: thumb * 3.5,
            objectFit: "contain",
            display: "block",
            flexShrink: 0,
          }}
        />
      )}
      <span>{parsed.label}{trailing}</span>
    </span>
  );
}
