// DA-CRM timeline previews: email bodies arrive with every link wrapped by
// Outlook Safe Links (and sometimes Barracuda link protection), which turns a
// three-line reply into a wall of encoded URLs. Unwrap them to the real URL,
// then show each link as its short host + path so the preview reads as text.

const SAFELINKS = /^https?:\/\/[a-z0-9.-]*safelinks\.protection\.outlook\.com\//i;
const BARRACUDA = /^https?:\/\/linkprotect\.cudasvc\.com\//i;

/** The real destination of a Safe Links / Barracuda-wrapped URL (nested wrappers too). */
export function unwrapLink(url: string): string {
  let cur = url;
  for (let i = 0; i < 3; i++) {
    let next: string | null = null;
    try {
      if (SAFELINKS.test(cur)) next = new URL(cur).searchParams.get("url");
      else if (BARRACUDA.test(cur)) next = new URL(cur).searchParams.get("a");
    } catch { /* not a URL — keep it */ }
    if (!next || !/^(https?:\/\/|mailto:)/i.test(next)) break;
    cur = next;
  }
  return cur;
}

/** "https://www.tvtoyota.com/new/inventory?x=1" → "tvtoyota.com/new/inventory". */
export function shortLabel(url: string, max = 40): string {
  try {
    const u = new URL(url);
    if (u.protocol === "mailto:") return u.pathname;
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname.replace(/\/$/, "");
    const s = host + (path && path !== "/" ? path : "");
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  } catch {
    return url.length > max ? url.slice(0, max - 1) + "…" : url;
  }
}

export type PreviewPart = { text: string } | { href: string; label: string };

// A URL runs to whitespace or a closing bracket / angle; trailing punctuation is left as text.
const URL_RE = /https?:\/\/[^\s<>()[\]"']+/gi;

/** Split a plain-text body into text and (unwrapped, shortened) links. */
export function previewParts(body: string): PreviewPart[] {
  const parts: PreviewPart[] = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(body); m; m = URL_RE.exec(body)) {
    let raw = m[0];
    const trail = raw.match(/[.,;:!?]+$/)?.[0] ?? "";
    if (trail) raw = raw.slice(0, -trail.length);
    const start = m.index ?? 0;
    if (start > last) parts.push({ text: body.slice(last, start) });
    const href = unwrapLink(raw);
    parts.push({ href, label: shortLabel(href) });
    last = start + raw.length;
  }
  if (last < body.length) parts.push({ text: body.slice(last) });
  return parts;
}

/** Length of the preview as displayed (links count as their short label). */
export function displayLength(parts: PreviewPart[]): number {
  return parts.reduce((n, p) => n + ("text" in p ? p.text.length : p.label.length), 0);
}

export const PREVIEW_LINES = 4;
/** Whether the body needs a "Show more" (more than PREVIEW_LINES lines, or long). */
export function needsClamp(parts: PreviewPart[]): boolean {
  const text = parts.map((p) => ("text" in p ? p.text : p.label)).join("");
  return text.split("\n").length > PREVIEW_LINES || displayLength(parts) > 360;
}
