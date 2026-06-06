// Strict sanitizer for super_admin-authored help article bodies.
//
// SECURITY: article HTML may include embedded video. We allow ONLY:
//   • <iframe> whose src is a YouTube or Vimeo *embed* URL (no arbitrary iframes)
//   • <video>/<source> whose src is our own S3 help/ prefix (uploaded clips)
// Anything else (other iframes, foreign video hosts, javascript: URIs) is dropped.
import DOMPurify from "isomorphic-dompurify";

const ALLOWED_IFRAME_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "player.vimeo.com",
]);

function isAllowedIframeSrc(src: string): boolean {
  try {
    const u = new URL(src);
    if (u.protocol !== "https:") return false;
    if (!ALLOWED_IFRAME_HOSTS.has(u.hostname)) return false;
    if (u.hostname.includes("youtube")) return u.pathname.startsWith("/embed/");
    if (u.hostname === "player.vimeo.com") return u.pathname.startsWith("/video/");
    return false;
  } catch {
    return false;
  }
}

// Uploaded clips live under the help/ prefix of our public-read bucket only.
const VIDEO_SRC_RE = /^https:\/\/new-infobox-images\.s3\.[a-z0-9-]+\.amazonaws\.com\/help\//;
function isAllowedVideoSrc(src: string): boolean {
  return VIDEO_SRC_RE.test(src);
}

// Register the element hook ONCE at module load. A per-call addHook/removeHook
// pair mutates DOMPurify's global hook state and can fail-open under concurrent
// renders. The hook is a no-op for any tag other than iframe/video/source, so it
// is safe for every other DOMPurify.sanitize call in the app.
DOMPurify.addHook("uponSanitizeElement", (node, data) => {
  const el = node as Element;
  if (data.tagName === "iframe") {
    if (!isAllowedIframeSrc(el.getAttribute("src") || "")) el.remove();
  } else if (data.tagName === "video") {
    const src = el.getAttribute("src") || "";
    if (src && !isAllowedVideoSrc(src)) el.remove();
  } else if (data.tagName === "source") {
    if (!isAllowedVideoSrc(el.getAttribute("src") || "")) el.remove();
  }
});

export function sanitizeHelpHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ["iframe", "video", "source"],
    ADD_ATTR: ["allow", "allowfullscreen", "frameborder", "controls", "src", "type", "width", "height", "poster"],
  });
}
