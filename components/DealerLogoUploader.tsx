"use client";

import { useState, useEffect } from "react";
import ImageUploadPicker from "@/components/ImageUploadPicker";
import LogoStudio from "@/components/LogoStudio";

type Props = {
  dealerId: string;
  currentLogoUrl: string | null;
  onUpdated: (newUrl: string | null) => void;
  /** Offer "Clean up / vectorize" (Logo Studio). Print Settings only: it acts
   *  on the SESSION's dealer, so it isn't offered where an admin views some
   *  other dealer's profile. */
  vectorize?: boolean;
  /** Modal-only mode (Template Builder): skip the card and open straight into
   *  the Change Logo picker or the Logo Studio; onDone fires when it closes. */
  open?: "picker" | "studio";
  /** error = the save failure message, so the host can show it (the card's
   *  inline error line isn't rendered in this mode). */
  onDone?: (error?: string) => void;
};

export default function DealerLogoUploader({ dealerId, currentLogoUrl, onUpdated, vectorize = false, open, onDone }: Props) {
  const [logoUrl, setLogoUrl] = useState(currentLogoUrl);
  const [showPicker, _setShowPicker] = useState(open === "picker");
  const [showStudio, _setShowStudio] = useState(open === "studio");
  // In modal-only mode, closing the one modal ends the whole interaction.
  const setShowPicker = (v: boolean) => { _setShowPicker(v); if (!v && open) onDone?.(); };
  const setShowStudio = (v: boolean) => { _setShowStudio(v); if (!v && open) onDone?.(); };

  // Sync prop → state when parent loads logo asynchronously after initial render
  useEffect(() => { setLogoUrl(currentLogoUrl); }, [currentLogoUrl]);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRemove() {
    setError(null);
    setRemoving(true);
    try {
      const res = await fetch(`/api/dealers/${dealerId}/logo`, { method: "DELETE" });
      if (!res.ok) throw new Error("Remove failed");
      setLogoUrl(null);
      onUpdated(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setRemoving(false);
    }
  }

  async function handleSelect(url: string) {
    setError(null);
    try {
      const res = await fetch(`/api/dealers/${dealerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logo_url: url }),
      });
      if (!res.ok) {
        const j = await res.json() as { error?: string };
        throw new Error(j.error ?? "Save failed");
      }
      setLogoUrl(url);
      onUpdated(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setError(msg);
      if (open) { _setShowPicker(false); onDone?.(msg); return; }
    }
    setShowPicker(false);
  }

  return (
    <div>
      {!open && (<>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 20 }}>
        {/* Preview */}
        <div style={{ width: 180, height: 80, border: "1px solid var(--border)", borderRadius: 4, background: "#fafafa", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`${logoUrl}?t=${Date.now()}`} alt="Dealer logo" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }} />
          ) : (
            <span style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "0 12px" }}>No logo uploaded</span>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button className="btn btn-primary" style={{ fontSize: 12, height: 30, padding: "0 12px" }} onClick={() => setShowPicker(true)}>
            {logoUrl ? "Change Logo" : "Upload Logo"}
          </button>
          {logoUrl && (
            <button className="btn btn-secondary" style={{ fontSize: 12, height: 30, padding: "0 12px" }} disabled={removing} onClick={() => void handleRemove()}>
              {removing ? "Removing…" : "Remove Logo"}
            </button>
          )}
          {vectorize && (
            <button className="btn btn-secondary" style={{ fontSize: 12, height: 30, padding: "0 12px" }} onClick={() => setShowStudio(true)}>
              Clean up / vectorize a logo
            </button>
          )}
          <p className="text-xs" style={{ color: "var(--text-muted)", marginTop: 2 }}>PNG, JPG, or SVG · Max 2 MB</p>
        </div>
      </div>

      {error && <p className="text-xs mt-2" style={{ color: "var(--error)" }}>{error}</p>}
      </>)}

      {showStudio && (
        // Persistent modal (no backdrop/Escape dismiss — explicit Close only).
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 6, width: "min(760px, 100%)", maxHeight: "90vh", overflowY: "auto", padding: "18px 22px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: "#2a2b3c" }}>Clean up / vectorize a logo</span>
              <button aria-label="Close" onClick={() => setShowStudio(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#78828c" }}>×</button>
            </div>
            <LogoStudio
              mode="dealer"
              dealerId={dealerId}
              onLogoSet={(url) => { setLogoUrl(url); onUpdated(url); }}
              onClose={() => setShowStudio(false)}
            />
          </div>
        </div>
      )}

      {showPicker && (
        <ImageUploadPicker
          title="Dealer Logo"
          currentImageUrl={logoUrl}
          onRemove={logoUrl ? () => void handleRemove().then(() => setShowPicker(false)) : undefined}
          uploadBucket="new-dealer-logos"
          uploadKeyPrefix={dealerId}
          acceptedTypes="image/png,image/jpeg,image/jpg,image/svg+xml"
          maxSizeMB={2}
          onSelect={url => void handleSelect(url)}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
