"use client";

import { useState } from "react";
import ImageUploadPicker from "@/components/ImageUploadPicker";

type Props = {
  dealerId: string;
  currentLogoUrl: string | null;
  onUpdated: (newUrl: string | null) => void;
};

export default function DealerLogoUploader({ dealerId, currentLogoUrl, onUpdated }: Props) {
  const [logoUrl, setLogoUrl] = useState(currentLogoUrl);
  const [showPicker, setShowPicker] = useState(false);
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
      setError(err instanceof Error ? err.message : "Save failed");
    }
    setShowPicker(false);
  }

  return (
    <div>
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
          <p className="text-xs" style={{ color: "var(--text-muted)", marginTop: 2 }}>PNG, JPG, or SVG · Max 2 MB</p>
        </div>
      </div>

      {error && <p className="text-xs mt-2" style={{ color: "var(--error)" }}>{error}</p>}

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
