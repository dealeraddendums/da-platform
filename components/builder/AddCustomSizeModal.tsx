"use client";

import { useState } from "react";
import ImageUploadPicker from "@/components/ImageUploadPicker";
import type { CustomSize } from "./types";

type Props = {
  dealerId: string;
  onSave: (size: CustomSize) => void;
  onClose: () => void;
};

export default function AddCustomSizeModal({ dealerId, onSave, onClose }: Props) {
  const [name, setName] = useState("");
  const [widthIn, setWidthIn] = useState("");
  const [heightIn, setHeightIn] = useState("11");
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [showBgPicker, setShowBgPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) { setError("Size name is required"); return; }
    const w = parseFloat(widthIn);
    const h = parseFloat(heightIn);
    if (isNaN(w) || w <= 0 || w > 24) { setError("Width must be between 0.1 and 24 inches"); return; }
    if (isNaN(h) || h <= 0 || h > 24) { setError("Height must be between 0.1 and 24 inches"); return; }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/custom-sizes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), width_in: w, height_in: h, background_url: bgUrl, dealer_id: dealerId }),
      });
      const json = await res.json() as { data?: CustomSize; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      onSave(json.data!);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
    }
  }

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div style={{ background: "#fff", borderRadius: 6, width: 440, maxWidth: "94vw", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}>

          <div style={{ padding: "14px 18px", background: "#2a2b3c", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontWeight: 600, fontSize: 14, color: "#fff" }}>Add Custom Paper Size</span>
            <button onClick={onClose} style={{ fontSize: 20, color: "rgba(255,255,255,0.7)", lineHeight: 1, background: "none", border: "none", cursor: "pointer" }}>×</button>
          </div>

          <div style={{ padding: 20 }}>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 12, color: "#55595c", marginBottom: 4 }}>Size Name *</label>
              <input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder='e.g. "Wide Format"'
                style={{ width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, outline: "none", boxSizing: "border-box" }}
              />
            </div>

            <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: "block", fontSize: 12, color: "#55595c", marginBottom: 4 }}>Width (inches) *</label>
                <input
                  type="number" step="0.125" min="0.5" max="24"
                  value={widthIn}
                  onChange={e => setWidthIn(e.target.value)}
                  placeholder="4.25"
                  style={{ width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, outline: "none", boxSizing: "border-box" }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: "block", fontSize: 12, color: "#55595c", marginBottom: 4 }}>Height (inches) *</label>
                <input
                  type="number" step="0.125" min="0.5" max="24"
                  value={heightIn}
                  onChange={e => setHeightIn(e.target.value)}
                  placeholder="11"
                  style={{ width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, outline: "none", boxSizing: "border-box" }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, color: "#55595c", marginBottom: 6 }}>Background Image</label>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {bgUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={bgUrl} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 3, border: "1px solid #e0e0e0", flexShrink: 0 }} />
                )}
                <button type="button" onClick={() => setShowBgPicker(true)}
                  style={{ padding: "5px 12px", fontSize: 12, background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer", color: "#55595c", fontWeight: 600 }}>
                  {bgUrl ? "Change Background" : "Choose Background"}
                </button>
                {bgUrl && (
                  <button type="button" onClick={() => setBgUrl(null)}
                    style={{ fontSize: 12, color: "#ff5252", background: "none", border: "none", cursor: "pointer" }}>
                    Remove
                  </button>
                )}
              </div>
            </div>

            {error && <p style={{ fontSize: 12, color: "#ff5252", marginBottom: 12 }}>{error}</p>}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={onClose}
                style={{ padding: "7px 16px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "#55595c" }}>
                Cancel
              </button>
              <button onClick={() => void save()} disabled={saving}
                style={{ padding: "7px 16px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: saving ? 0.7 : 1 }}>
                {saving ? "Saving…" : "Add Size"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {showBgPicker && (
        <ImageUploadPicker
          title="Choose Background Image"
          tab1Label="My Backgrounds"
          listEndpoint={`/api/upload-image?bucket=new-addendum-backgrounds&prefix=${encodeURIComponent(dealerId)}`}
          uploadBucket="new-addendum-backgrounds"
          uploadKeyPrefix={dealerId}
          acceptedTypes="image/png"
          maxSizeMB={5}
          onSelect={url => { setBgUrl(url); setShowBgPicker(false); }}
          onClose={() => setShowBgPicker(false)}
        />
      )}
    </>
  );
}
