"use client";

import { useState } from "react";

type Props = { dealerId: string };

export default function ClearPrintHistoryButton({ dealerId }: Props) {
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function confirm() {
    setClearing(true);
    try {
      const res = await fetch(`/api/dealers/${encodeURIComponent(dealerId)}/clear-print-history`, {
        method: "POST",
      });
      const json = await res.json() as { cleared_vehicles?: number; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to clear");
      setOpen(false);
      setToast(`Print history cleared for ${json.cleared_vehicles ?? 0} active vehicles`);
      setTimeout(() => {
        setToast(null);
        window.location.reload();
      }, 2500);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to clear print history");
    } finally {
      setClearing(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          height: 32, padding: "0 12px", fontSize: 12, fontWeight: 500,
          background: "#fff", border: "1px solid #c0c0c0", borderRadius: 4,
          color: "#55595c", cursor: "pointer", transition: "border-color 0.1s, color 0.1s",
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#ff5252"; (e.currentTarget as HTMLButtonElement).style.color = "#ff5252"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#c0c0c0"; (e.currentTarget as HTMLButtonElement).style.color = "#55595c"; }}
      >
        Clear Print History
      </button>

      {open && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div style={{
            background: "#fff", borderRadius: 6, width: "min(480px, 92vw)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden",
          }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "14px 16px", borderBottom: "1px solid var(--border)",
            }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>
                Clear Print History
              </span>
              <button
                onClick={() => setOpen(false)}
                style={{ fontSize: 20, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", lineHeight: 1, padding: "0 2px" }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: "16px 16px 20px" }}>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
                This will reset the print status for all active vehicles in your inventory.
                Green printed indicators will return to white and you will be able to reprint
                all vehicles. Historical addendum data for sold or inactive vehicles is preserved.
              </p>
            </div>

            <div style={{
              display: "flex", gap: 8, justifyContent: "flex-end",
              padding: "12px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-subtle)",
            }}>
              <button
                onClick={() => setOpen(false)}
                disabled={clearing}
                style={{
                  height: 36, padding: "0 16px", background: "#fff",
                  border: "1px solid var(--border)", borderRadius: 4,
                  fontSize: 13, cursor: "pointer", color: "var(--text-secondary)",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => void confirm()}
                disabled={clearing}
                style={{
                  height: 36, padding: "0 16px", background: "#ff5252", color: "#fff",
                  border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600,
                  cursor: clearing ? "not-allowed" : "pointer",
                  opacity: clearing ? 0.7 : 1,
                }}
              >
                {clearing ? "Clearing…" : "Clear Print History"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 2000,
          background: "#333", color: "#fff", padding: "10px 16px",
          borderRadius: 4, fontSize: 13, fontWeight: 500,
          boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
        }}>
          {toast}
        </div>
      )}
    </>
  );
}
