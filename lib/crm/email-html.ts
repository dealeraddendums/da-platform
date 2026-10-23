// DA-CRM email HTML: sanitize editor / imported HTML to a small allowlist and
// emit markup Outlook renders the way the editor showed it. Server-only
// (DOMPurify via jsdom).
//
// Outlook (Word engine) ignores <style> blocks, most CSS on <div>, max-width
// and data: URIs, and gives <p> large default margins. So: every element gets
// inline styles, images keep explicit width attributes and must be https
// (inline images are uploaded to S3, never embedded as base64), and the whole
// body sits in one font-declaring wrapper.
/* eslint-disable @typescript-eslint/no-explicit-any */
import DOMPurify from "isomorphic-dompurify";

const ALLOWED_TAGS = ["p", "br", "strong", "b", "em", "i", "u", "s", "a", "img", "span", "ul", "ol", "li",
  "h1", "h2", "h3", "blockquote", "hr", "table", "tbody", "thead", "tr", "td", "th", "div"];
// Table attributes Outlook needs for the company signature layout (lib/crm/signature.ts).
const ALLOWED_ATTR = ["href", "target", "rel", "src", "alt", "title", "width", "height", "style", "colspan", "rowspan", "align", "valign", "cellpadding", "cellspacing", "border"];
// Inline style properties we keep (everything else is dropped).
const SAFE_STYLE = /^(color|background-color|font-size|font-weight|font-style|font-family|text-decoration|text-align|line-height|width|height|border|border-collapse|border-left|border-right|border-top|border-bottom|padding|padding-left|padding-right|padding-top|padding-bottom|margin|vertical-align|white-space)$/i;

export const EMAIL_FONT = "Arial, Helvetica, sans-serif";
const BASE: Record<string, string> = {
  p: "margin:0 0 12px 0;",
  ul: "margin:0 0 12px 0;padding:0 0 0 24px;",
  ol: "margin:0 0 12px 0;padding:0 0 0 24px;",
  li: "margin:0 0 4px 0;",
  a: "color:#1976d2;text-decoration:underline;",
  h1: "margin:0 0 12px 0;font-size:22px;font-weight:bold;",
  h2: "margin:0 0 12px 0;font-size:18px;font-weight:bold;",
  h3: "margin:0 0 12px 0;font-size:16px;font-weight:bold;",
  blockquote: "margin:0 0 12px 0;padding:0 0 0 12px;border-left:3px solid #e0e0e0;color:#55595c;",
  hr: "border:0;border-top:1px solid #e0e0e0;margin:12px 0;",
  img: "border:0;outline:none;text-decoration:none;",
};

function cleanStyle(style: string | null): string {
  if (!style) return "";
  return style.split(";").map((d) => d.trim()).filter(Boolean).filter((d) => {
    const [prop, ...rest] = d.split(":");
    const val = rest.join(":").trim();
    return SAFE_STYLE.test(prop.trim()) && val && !/url\(|expression|javascript:/i.test(val);
  }).join(";");
}

function safeHref(href: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(href.trim()) || /^\{\{[^}]+\}\}$/.test(href.trim());
}

/** Allowlist-sanitize, then inline Outlook-safe styles. Returns body HTML (no wrapper). */
export function toEmailHtml(html: string): string {
  const frag = DOMPurify.sanitize(html ?? "", {
    ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;
  const walk = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      if (!safeHref(href)) el.removeAttribute("href");
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener");
    }
    if (tag === "img") {
      const src = el.getAttribute("src") ?? "";
      if (!/^https:\/\//i.test(src)) { el.remove(); return; }
      // Outlook needs a width attribute; take it from the style if the editor set one.
      if (!el.getAttribute("width")) {
        const m = /width:\s*(\d+)px/i.exec(el.getAttribute("style") ?? "");
        if (m) el.setAttribute("width", m[1]);
      }
      if (!el.getAttribute("alt")) el.setAttribute("alt", "");
    }
    const kept = cleanStyle(el.getAttribute("style"));
    const style = `${BASE[tag] ?? ""}${kept}`;
    if (style) el.setAttribute("style", style); else el.removeAttribute("style");
    for (const child of Array.from(el.children)) walk(child);
  };
  for (const child of Array.from(frag.children ?? [])) walk(child);
  const holder = (frag as any).ownerDocument.createElement("div");
  holder.appendChild(frag);
  // Editors emit <p></p> for blank lines; Outlook collapses them — keep the gap.
  return holder.innerHTML.replace(/<p([^>]*)><\/p>/g, "<p$1>&nbsp;</p>");
}

/** The full message body: font wrapper + body + optional signature block. */
export function wrapEmail(bodyHtml: string, signatureHtml: string | null): string {
  const sig = signatureHtml ? `<div style="margin:16px 0 0 0;">${signatureHtml}</div>` : "";
  return `<div style="font-family:${EMAIL_FONT};font-size:14px;line-height:1.5;color:#333333;">${bodyHtml}${sig}</div>`;
}

/** Plain-text alternative part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-3]|blockquote|tr)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/(ul|ol)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => (label.replace(/<[^>]+>/g, "").trim() === href ? href : `${label} (${href})`))
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Storage-time sanitize for template bodies: same allowlist, styles filtered,
 * but no Outlook styling added — the editor keeps round-tripping its own
 * markup and toEmailHtml() inlines styles at send time.
 */
export function sanitizeTemplateHtml(html: string): string {
  const frag = DOMPurify.sanitize(html ?? "", { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true }) as unknown as DocumentFragment;
  const walk = (el: Element) => {
    const s = cleanStyle(el.getAttribute("style"));
    if (s) el.setAttribute("style", s); else el.removeAttribute("style");
    if (el.tagName.toLowerCase() === "a" && !safeHref(el.getAttribute("href") ?? "")) el.removeAttribute("href");
    if (el.tagName.toLowerCase() === "img" && !/^https:\/\//i.test(el.getAttribute("src") ?? "")) { el.remove(); return; }
    for (const c of Array.from(el.children)) walk(c);
  };
  for (const c of Array.from(frag.children ?? [])) walk(c);
  const holder = (frag as any).ownerDocument.createElement("div");
  holder.appendChild(frag);
  return holder.innerHTML;
}
