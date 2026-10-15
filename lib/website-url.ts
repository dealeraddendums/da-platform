// Dealer website URL normalization (2026-10-15).
//
// KEEP IN SYNC with da-marketing-os/src/lib/website-url.ts — the signup form
// validates with that copy and this one re-validates server-side.
//
// Forgiving on input, strict on output:
//   "example.com"               → "https://example.com"
//   "WWW.Example.com/"          → "https://www.example.com"
//   "http://example.com/used?x" → "http://example.com/used?x"
// Rejected: any scheme other than http(s) (javascript:, data:, mailto:, ftp:…),
// credentials (user:pass@), IP addresses and single-label hosts (localhost),
// and anything that doesn't look like a domain. Format only — no HTTP check.

export type WebsiteUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const MAX_LENGTH = 500;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const INVALID = "Please enter your dealership's website, like yourdealership.com.";

export function normalizeWebsiteUrl(raw: unknown): WebsiteUrlResult {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return { ok: false, error: "Website is required." };
  if (input.length > MAX_LENGTH || /\s/.test(input)) return { ok: false, error: INVALID };

  // A scheme is present when the text starts "letters:" — except "host:port".
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(input);
  const hasScheme = schemeMatch !== null && !/^[^:]+:\d/.test(input);
  if (hasScheme) {
    const scheme = schemeMatch![1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      return { ok: false, error: "Website must start with http:// or https://." };
    }
    if (!/^https?:\/\//i.test(input)) return { ok: false, error: INVALID };
  }

  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? input : `https://${input.replace(/^\/+/, "")}`);
  } catch {
    return { ok: false, error: INVALID };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: INVALID };
  if (parsed.username || parsed.password) return { ok: false, error: INVALID };

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return { ok: false, error: INVALID };
  if (!TLD_RE.test(labels[labels.length - 1])) return { ok: false, error: INVALID };

  const port = parsed.port ? `:${parsed.port}` : "";
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return { ok: true, url: `${parsed.protocol}//${host}${port}${path}${parsed.search}` };
}

/** For optional fields: blank → null, invalid → error, valid → normalized. */
export function normalizeOptionalWebsiteUrl(raw: unknown): WebsiteUrlResult | { ok: true; url: null } {
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) return { ok: true, url: null };
  return normalizeWebsiteUrl(raw);
}
