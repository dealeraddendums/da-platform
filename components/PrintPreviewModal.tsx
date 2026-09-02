"use client";
import { printPdfFromBlobUrl } from "@/lib/print-pdf";

import { useEffect, useRef, useState } from "react";
type DocType = "addendum" | "infosheet" | "buyer_guide";

type Props = {
  dealerVehicleId?: string;
  docType: DocType;
  vehicleName: string;
  onClose: () => void;
  /** Fired once the print is actually RECORDED (Send to Printer / Download),
   *  not on generation — a cancelled preview never counts as a print. */
  onPrinted?: () => void;
  /** Skip PDF generation and use this URL directly (e.g. pre-generated bulk PDF). */
  preloadedUrl?: string;
  /** Pending-print token from a pre-generated PDF (bulk path) — confirmed on
   *  Send/Download via POST /api/print/confirm. The in-modal generate path
   *  captures its own token from the generate response. */
  printToken?: string;
};

const DOC_LABELS: Record<DocType, string> = {
  addendum: "Addendum",
  infosheet: "Info Sheet",
  buyer_guide: "Buyer Guide",
};

const DOC_PAPER: Record<DocType, string> = {
  addendum: "standard",
  infosheet: "infosheet",
  buyer_guide: "standard",
};

/**
 * Poll /api/pdf/status/:jobId every second until the service reports
 * complete (returns signedUrl) or failed (throws). Stops early when
 * `isCancelled()` returns true so an unmount halts polling immediately.
 * `setLabel` updates the spinner text — moves from "Rendering…" to
 * "Uploading…" to give a sense of progress.
 */
async function pollUntilComplete(
  statusUrl: string,
  isCancelled: () => boolean,
  setLabel: (s: string) => void,
): Promise<string> {
  const deadline = Date.now() + 120_000; // 2 min cap, matches server poll
  let tick = 0;
  while (Date.now() < deadline) {
    if (isCancelled()) throw new Error("cancelled");
    const res = await fetch(statusUrl);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const j = await res.json() as {
      status: "pending" | "running" | "complete" | "failed";
      signedUrl?: string;
      error?: string;
    };
    if (j.status === "complete" && j.signedUrl) return j.signedUrl;
    if (j.status === "failed") throw new Error(j.error ?? "PDF render failed");
    tick++;
    setLabel(tick < 3 ? "Rendering…" : tick < 8 ? "Almost ready…" : "Finalizing…");
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("PDF render timed out");
}

export default function PrintPreviewModal({
  dealerVehicleId,
  docType,
  vehicleName,
  onClose,
  onPrinted,
  preloadedUrl,
  printToken,
}: Props) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(preloadedUrl ?? null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(!preloadedUrl);
  const [progressLabel, setProgressLabel] = useState("Rendering…");
  const [genError, setGenError] = useState<string | null>(null);
  // Retail/Wholesale 'ask' mode: probe the effective template before rendering;
  // when it carries an ask-mode widget, collect a price first. null = not yet
  // probed / no prompt needed; 'prompt' shows the input; a number or "skip"
  // resolves it. The entered price is render-only (never saved to the vehicle).
  const [askPrompt, setAskPrompt] = useState<"pending" | "prompt" | "done">("pending");
  const [askPriceInput, setAskPriceInput] = useState("");
  const askPriceRef = useRef<number | null>(null);
  const genStartedRef = useRef(false); // guards duplicate generation across askPrompt re-runs
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const tokenRef = useRef<string | null>(printToken ?? null);
  const confirmedRef = useRef(false);

  // Record the print on the user's actual action. Idempotent client-side
  // (confirmedRef) and server-side (the token is claimed atomically), so
  // Download followed by Send only records once.
  async function confirmPrint() {
    if (confirmedRef.current) return;
    confirmedRef.current = true;
    const token = tokenRef.current;
    if (token) {
      try {
        await fetch("/api/print/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          keepalive: true,
        });
      } catch (e) {
        console.error("[print] confirm failed:", e);
      }
    }
    // No token = the server fell back to generation-time logging (pending
    // table unavailable) — the print is already recorded; still notify.
    onPrinted?.();
  }

  useEffect(() => {
    if (preloadedUrl) return; // already have URL — skip generation
    let cancelled = false;

    async function generate() {
      try {
        // Retail/Wholesale 'ask' probe (addendums only): does the effective
        // template want a printer-entered price? Same resolution path as the
        // real render (checkPromptOnly), so the prompt can't drift.
        if (askPrompt === "pending" && docType === "addendum") {
          try {
            const probeRes = await fetch("/api/pdf/generate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ dealerVehicleId, docType, paperSize: DOC_PAPER[docType], checkPromptOnly: true }),
            });
            if (probeRes.ok) {
              const pj = await probeRes.json() as { askRetailWholesale?: boolean };
              if (pj.askRetailWholesale && !cancelled) { setAskPrompt("prompt"); setGenerating(false); return; }
            }
          } catch { /* probe failure → render with the no-price fallback */ }
          // NO state change here — the no-prompt path continues in THIS run.
          // Setting askPrompt('done') mid-run re-fired the effect (deps
          // [askPrompt]) whose CLEANUP set cancelled=true on this in-flight
          // run: the PDF result was discarded while the re-run was blocked by
          // genStartedRef → every addendum preview rendered blank (prod
          // incident 2026-08-07). The only state-driven re-run is the user's
          // prompt→done click, where this run has already returned.
        }
        if (askPrompt === "prompt") return; // waiting on the price input
        if (genStartedRef.current) return;  // already generated (post-prompt re-run safety)
        genStartedRef.current = true;

        const body: Record<string, unknown> = {
          dealerVehicleId,
          docType,
          paperSize: DOC_PAPER[docType],
        };
        if (askPriceRef.current != null) body.retailWholesalePrice = askPriceRef.current;

        // ?async=1 asks the server to enqueue and return { jobId } so
        // the UI can show progress while the PDF service renders.
        // If USE_PDF_SERVICE is OFF on the server, the endpoint
        // ignores ?async and returns PDF bytes directly — we detect
        // that via Content-Type and fall back to the blob path.
        const res = await fetch("/api/pdf/generate?async=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const json = await res.json() as { error?: string };
          throw new Error(json.error ?? "PDF generation failed");
        }
        if (cancelled) return;

        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          // Async path: poll until complete, then use the signed URL.
          const j = await res.json() as { jobId: string; statusUrl: string; printToken?: string | null };
          tokenRef.current = j.printToken ?? null;
          const signedUrl = await pollUntilComplete(j.statusUrl, () => cancelled, setProgressLabel);
          if (cancelled) return;
          setPdfUrl(signedUrl);
        } else {
          // Sync path: response body is the PDF bytes (USE_PDF_SERVICE off
          // OR async wasn't honored). Blob it like the old flow.
          tokenRef.current = res.headers.get("X-Print-Token");
          const blob = await res.blob();
          setPdfUrl(URL.createObjectURL(blob));
        }
        // NOTE: onPrinted intentionally NOT fired here — the print is only
        // recorded (and onPrinted fired) on Send/Download via confirmPrint().
      } catch (e) {
        if (!cancelled) setGenError(e instanceof Error ? e.message : "PDF generation failed");
      } finally {
        if (!cancelled) setGenerating(false);
      }
    }

    void generate();
    return () => { cancelled = true; };
  // Re-runs when the ask-price step resolves (askPrompt 'prompt' → 'done');
  // genStartedRef prevents a duplicate render on the pending→done transition.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askPrompt]);

  useEffect(() => {
    if (!pdfUrl) return;
    if (pdfUrl.startsWith("blob:")) { setBlobUrl(pdfUrl); return; }
    // Cross-origin signed S3 URL (Phase E async path). Try to convert to
    // a blob URL so the Send-to-Printer button has a same-origin source,
    // but if the S3 bucket doesn't have CORS allowed for our origin the
    // fetch will reject — in that case fall back to the signed URL
    // directly. The <iframe> tag has no CORS restriction for display, so
    // the preview still renders even without the blob conversion.
    let objectUrl: string | null = null;
    let cancelled = false;
    fetch(pdfUrl)
      .then(r => r.blob())
      .then(blob => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setBlobUrl(pdfUrl);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pdfUrl]);

  const label = DOC_LABELS[docType];
  const filename = `${vehicleName.replace(/[^a-zA-Z0-9]+/g, "_")}_${label.replace(/\s+/g, "_")}.pdf`;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "#fff", borderRadius: 6,
          width: "min(900px, 96vw)", height: "min(90vh, 820px)",
          display: "flex", flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0,
        }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>
            {label} — {vehicleName}
          </span>
          <button
            onClick={onClose}
            style={{ fontSize: 20, color: "var(--text-muted)", lineHeight: 1, background: "none", border: "none", cursor: "pointer", padding: "0 4px" }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, position: "relative", background: "#f0f0f0" }}>
          {askPrompt === "prompt" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "48px 24px" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#2a2b3c" }}>Enter the wholesale price</div>
              <div style={{ fontSize: 12, color: "#78828c", textAlign: "center", maxWidth: 360 }}>
                This template shows a struck-through retail price with your entered price below it. The price is used for this print only — it is not saved to the vehicle.
              </div>
              <input
                type="number" min={0} step={1} autoFocus placeholder="e.g. 32000" value={askPriceInput}
                onChange={(e) => setAskPriceInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && parseFloat(askPriceInput) > 0) { askPriceRef.current = Math.round(parseFloat(askPriceInput)); setGenerating(true); setAskPrompt("done"); } }}
                style={{ width: 200, padding: "10px 12px", border: "1px solid #e0e0e0", borderRadius: 6, fontSize: 18, fontFamily: "monospace", textAlign: "center", outline: "none" }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button"
                  disabled={!(parseFloat(askPriceInput) > 0)}
                  onClick={() => { askPriceRef.current = Math.round(parseFloat(askPriceInput)); setGenerating(true); setAskPrompt("done"); }}
                  style={{ padding: "8px 20px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: parseFloat(askPriceInput) > 0 ? 1 : 0.5 }}>
                  Continue
                </button>
                <button type="button"
                  onClick={() => { askPriceRef.current = null; setGenerating(true); setAskPrompt("done"); }}
                  title="Print without a wholesale price — the retail line prints normally (no strikethrough)"
                  style={{ padding: "8px 20px", background: "#fff", color: "#55595c", border: "1px solid #e0e0e0", borderRadius: 6, fontSize: 13, cursor: "pointer" }}>
                  Skip
                </button>
              </div>
            </div>
          )}
          {generating && (
            <div style={{
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 16,
            }}>
              <style>{`@keyframes ppm-spin { to { transform: rotate(360deg); } }`}</style>
              <div style={{
                width: 36, height: 36, border: "3px solid var(--border)",
                borderTop: "3px solid #1976d2", borderRadius: "50%",
                animation: "ppm-spin 0.8s linear infinite",
              }} />
              <p style={{ color: "var(--text-secondary)", fontSize: 14, margin: 0 }}>
                {label} — {progressLabel}
              </p>
            </div>
          )}

          {genError && (
            <div style={{
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 16, padding: 32,
            }}>
              <p style={{ color: "var(--error)", fontSize: 14, textAlign: "center", margin: 0 }}>
                {genError}
              </p>
            </div>
          )}

          {blobUrl && !generating && (
            <iframe
              ref={iframeRef}
              src={blobUrl}
              style={{ width: "100%", height: "100%", border: "none", display: "block" }}
              title={`${label} Preview`}
            />
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8,
          padding: "12px 16px", borderTop: "1px solid var(--border)", flexShrink: 0,
          background: "var(--bg-subtle)",
        }}>
          <button
            onClick={onClose}
            style={{
              height: 36, padding: "0 16px", background: "#fff",
              border: "1px solid var(--border)", borderRadius: 4,
              fontSize: 13, cursor: "pointer", color: "var(--text-secondary)",
            }}
          >
            Cancel
          </button>
          {pdfUrl && blobUrl && (
            <>
              <a
                href={blobUrl}
                download={filename}
                onClick={() => { void confirmPrint(); }}
                style={{
                  height: 36, padding: "0 16px", background: "#fff",
                  border: "1px solid var(--border)", borderRadius: 4,
                  fontSize: 13, color: "var(--text-primary)", textDecoration: "none",
                  display: "inline-flex", alignItems: "center",
                }}
              >
                Download PDF
              </a>
              <button
                onClick={async () => {
                  if (!blobUrl) return;
                  // Record first so the post-close refresh (inventory rows +
                  // dashboard cards) sees the new print state.
                  await confirmPrint();
                  printPdfFromBlobUrl(blobUrl);
                  onClose();
                }}
                style={{
                  height: 36, padding: "0 16px", background: "#1976d2", color: "#fff",
                  border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Send to Printer
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
