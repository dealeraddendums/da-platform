// Received email HTML → something safe to show staff. Server-only.
// The result is rendered in a sandboxed iframe (no scripts, opaque origin), so
// this is defence in depth: strip active content, point cid: inline images at
// our attachment route, and open links in a new tab.
/* eslint-disable @typescript-eslint/no-explicit-any */
import DOMPurify from "isomorphic-dompurify";

const FORBID = ["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "base", "meta", "link", "frame", "frameset", "applet"];

export function displayEmailHtml(html: string | null, text: string | null, cid: Record<string, string>): string {
  if (!html) {
    const esc = (text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<pre style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;font-size:14px;margin:0">${esc}</pre>`;
  }
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: FORBID,
    FORBID_ATTR: ["srcset", "formaction", "ping"],
    ADD_TAGS: ["style"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ADD_URI_SAFE_ATTR: [],
  }) as unknown as string;
  // cid:abc@01D… → /api/crm/inbox/attachments/{id}
  const withCid = clean.replace(/(src=["'])cid:([^"']+)(["'])/gi, (m, a, id, z) => {
    const hit = cid[id] ?? cid[id.replace(/^<|>$/g, "")];
    return hit ? `${a}${hit}${z}` : m;
  });
  const base = `<base target="_blank">`;
  return /<head[^>]*>/i.test(withCid) ? withCid.replace(/<head[^>]*>/i, (h) => `${h}${base}`) : `${base}${withCid}`;
}
