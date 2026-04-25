"use client";

import { useEffect, useRef, useState } from "react";
type DocType = "addendum" | "infosheet" | "buyer_guide";

type Props = {
  dealerVehicleId?: string;
  docType: DocType;
  vehicleName: string;
  onClose: () => void;
  onPrinted?: () => void;
  /** Skip PDF generation and use this URL directly (e.g. pre-generated bulk PDF). */
  preloadedUrl?: string;
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

export default function PrintPreviewModal({
  dealerVehicleId,
  docType,
  vehicleName,
  onClose,
  onPrinted,
  preloadedUrl,
}: Props) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(preloadedUrl ?? null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(!preloadedUrl);
  const [genError, setGenError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (preloadedUrl) return; // already have URL — skip generation
    let cancelled = false;

    async function generate() {
      try {
        const body: Record<string, unknown> = {
          dealerVehicleId,
          docType,
          paperSize: DOC_PAPER[docType],
        };

        const res = await fetch("/api/pdf/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) {
          throw new Error(`PDF generation failed (HTTP ${res.status})`);
        }
        const json = await res.json() as { url?: string; error?: string };
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error ?? "PDF generation failed");
        setPdfUrl(json.url!);
        onPrinted?.();
      } catch (e) {
        if (!cancelled) setGenError(e instanceof Error ? e.message : "PDF generation failed");
      } finally {
        if (!cancelled) setGenerating(false);
      }
    }

    void generate();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!pdfUrl) return;
    let objectUrl: string;
    fetch(pdfUrl)
      .then(r => r.blob())
      .then(blob => { objectUrl = URL.createObjectURL(blob); setBlobUrl(objectUrl); });
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
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
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
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
                Generating {label}…
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
                href={pdfUrl}
                download={filename}
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
                onClick={() => {
                  if (!blobUrl) return;
                  const opened = window.open(blobUrl, "_blank");
                  if (!opened) {
                    onClose();
                    window.location.href = "/dashboard";
                    return;
                  }
                  const win: Window = opened;
                  let redirected = false;
                  function doRedirect() {
                    if (redirected) return;
                    redirected = true;
                    try { win.close(); } catch { /* ignore */ }
                    onClose();
                    window.location.href = "/dashboard";
                  }
                  setTimeout(() => {
                    win.print();
                    win.addEventListener("afterprint", doRedirect);
                    setTimeout(doRedirect, 2000);
                  }, 500);
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
