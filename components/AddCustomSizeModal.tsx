"use client";

import { useRef, useState } from "react";
import type { DealerCustomSizeRow } from "@/lib/db";

type Props = {
  dealerId: string;
  editing?: DealerCustomSizeRow;
  onSaved: (row: DealerCustomSizeRow) => void;
  onClose: () => void;
};

export default function AddCustomSizeModal({ dealerId, editing, onSaved, onClose }: Props) {
  const [name, setName] = useState(editing?.name ?? "");
  const [widthIn, setWidthIn] = useState(editing ? String(editing.width_in) : "");
  const [heightIn, setHeightIn] = useState(editing ? String(editing.height_in) : "11");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  async function handleSave() {
    if (!name.trim()) { setError("Size name is required."); return; }
    const w = parseFloat(widthIn);
    const h = parseFloat(heightIn);
    if (isNaN(w) || w <= 0 || w > 24) { setError("Width must be between 0 and 24 inches."); return; }
    if (isNaN(h) || h <= 0 || h > 24) { setError("Height must be between 0 and 24 inches."); return; }

    setError(null);
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append("name", name.trim());
      fd.append("width_in", String(w));
      fd.append("height_in", String(h));
      if (!editing) fd.append("dealer_id", dealerId);
      const file = fileRef.current?.files?.[0];
      if (file) fd.append("file", file);

      const url = editing
        ? `/api/custom-sizes/${editing.id}`
        : `/api/custom-sizes`;
      const method = editing ? "PATCH" : "POST";

      const res = await fetch(url, { method, body: fd });
      const json = await res.json() as { data?: DealerCustomSizeRow; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      onSaved(json.data!);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card" style={{ width: 440, maxWidth: "90vw", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}>
        <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>
            {editing ? "Edit Custom Size" : "Add Custom Size"}
          </span>
          <button onClick={onClose} style={{ fontSize: 20, color: "var(--text-muted)", lineHeight: 1, background: "none", border: "none", cursor: "pointer" }}>×</button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="label">Size Name *</label>
            <input className="input w-full" value={name} onChange={e => setName(e.target.value)} placeholder='e.g. "Wide Format", "Half Sheet"' />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="label">Width (inches) *</label>
              <input className="input w-full" type="number" step="0.125" min="1" max="24" value={widthIn} onChange={e => setWidthIn(e.target.value)} placeholder="4.25" />
            </div>
            <div className="flex-1">
              <label className="label">Height (inches)</label>
              <input className="input w-full" type="number" step="0.125" min="1" max="24" value={heightIn} onChange={e => setHeightIn(e.target.value)} placeholder="11" />
            </div>
          </div>

          <div>
            <label className="label">Background Image</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                ref={fileRef}
                type="file"
                accept="image/png"
                style={{ display: "none" }}
                onChange={e => setFileName(e.target.files?.[0]?.name ?? null)}
              />
              <button
                className="btn btn-secondary"
                style={{ fontSize: 12, height: 30, padding: "0 12px" }}
                onClick={() => fileRef.current?.click()}
              >
                {fileName ? "Change File" : "Choose PNG"}
              </button>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                {fileName ?? (editing?.background_url ? "Current image will be kept" : "Optional — PNG-24 with transparency, max 5 MB")}
              </span>
            </div>
          </div>

          {error && <p className="text-xs" style={{ color: "var(--error)" }}>{error}</p>}
        </div>

        <div className="px-5 py-4 flex justify-end gap-2" style={{ borderTop: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : editing ? "Save Changes" : "Add Size"}
          </button>
        </div>
      </div>
    </div>
  );
}
