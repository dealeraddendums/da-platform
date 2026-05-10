/**
 * Triggers the system print dialog for a PDF blob URL using a hidden iframe.
 * Replaces the older window.open(blob)+setTimeout pattern, which:
 *   - opened a separate browser tab the user could see and interact with
 *   - auto-closed the tab and the print dialog after a fixed timeout, ripping
 *     printer settings out of the user's hands mid-configuration
 *
 * The iframe approach keeps the print flow on the current page: the system
 * dialog opens directly, the user picks settings at their own pace, and the
 * iframe is cleaned up after `afterprint` fires (or via a focus fallback for
 * Safari, which doesn't reliably emit afterprint).
 */
export function printPdfFromBlobUrl(blobUrl: string): void {
  if (typeof document === "undefined") return;

  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.top = "-10000px";
  iframe.style.left = "-10000px";
  iframe.style.width = "1px";
  iframe.style.height = "1px";
  iframe.style.opacity = "0";
  iframe.setAttribute("aria-hidden", "true");
  iframe.src = blobUrl;
  document.body.appendChild(iframe);

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try { iframe.contentWindow?.removeEventListener("afterprint", cleanup); } catch { /* ignore */ }
    window.removeEventListener("focus", cleanup);
    try { document.body.removeChild(iframe); } catch { /* ignore */ }
    // Don't revoke the blob URL — the parent component still owns it for the
    // <embed> preview and the Download PDF link. The parent revokes on unmount.
  }

  iframe.onload = () => {
    setTimeout(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.addEventListener("afterprint", cleanup);
        iframe.contentWindow?.print();
        // Safari fallback: window-focus returning to the parent indicates the
        // print dialog has been dismissed. No fixed timeout — the iframe just
        // stays attached if neither event fires until the page is unloaded.
        window.addEventListener("focus", cleanup);
      } catch {
        cleanup();
      }
    }, 500);
  };
}
