"use client";

import { useState } from "react";
import type { DealerCustomSizeRow } from "@/lib/db";
import ImageUploadPicker from "./ImageUploadPicker";

type SizeItem = Pick<DealerCustomSizeRow, "id" | "dealer_id" | "name" | "width_in" | "height_in" | "background_url">;

type Props = {
  dealerId: string;
  initialSizes: SizeItem[];
  onUpdate: (sizes: SizeItem[]) => void;
  onClose: () => void;
};

type EditForm = {
  id?: string;
  name: string;
  width_in: string;
  height_in: string;
  background_url: string | null;
};

export default function CustomSizesModal({ dealerId, initialSizes, onUpdate, onClose }: Props) {
  const [sizes, setSizes] = useState<SizeItem[]>(initialSizes);
  const [form, setForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showBgPicker, setShowBgPicker] = useState(false);

  function setF<K extends keyof EditForm>(k: K, v: EditForm[K]) {
    setForm(f => f ? { ...f, [k]: v } : f);
  }

  function startAdd() {
    setForm({ name: "", width_in: "", height_in: "11", background_url: null });
    setError(null);
  }

  function startEdit(cs: SizeItem) {
    setForm({ id: cs.id, name: cs.name, width_in: String(cs.width_in), height_in: String(cs.height_in), background_url: cs.background_url });
    setError(null);
  }

  async function save() {
    if (!form) return;
    if (!form.name.trim()) { setError("Size name is required"); return; }
    const w = parseFloat(form.width_in);
    const h = parseFloat(form.height_in);
    if (isNaN(w) || w <= 0 || w > 24) { setError("Width must be between 0.1 and 24 inches"); return; }
    if (isNaN(h) || h <= 0 || h > 24) { setError("Height must be between 0.1 and 24 inches"); return; }
    setError(null);
    setSaving(true);
    try {
      const body = JSON.stringify({ name: form.name.trim(), width_in: w, height_in: h, background_url: form.background_url, dealer_id: dealerId });
      const headers = { "Content-Type": "application/json" };
      const [url, method] = form.id
        ? [`/api/custom-sizes/${form.id}`, "PATCH"]
        : ["/api/custom-sizes", "POST"];
      const res = await fetch(url, { method, headers, body });
      const json = await res.json() as { data?: DealerCustomSizeRow; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      const updated = form.id
        ? sizes.map(s => s.id === form.id ? json.data! : s)
        : [...sizes, json.data!];
      setSizes(updated);
      onUpdate(updated);
      setForm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function deleteSize(id: string) {
    setDeleting(id);
    try {
      await fetch(`/api/custom-sizes/${id}`, { method: "DELETE" });
      const updated = sizes.filter(s => s.id !== id);
      setSizes(updated);
      onUpdate(updated);
    } finally {
      setDeleting(null);
    }
  }

  const cell: React.CSSProperties = { padding: "9px 12px" };

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div style={{ background: "#fff", borderRadius: 6, width: 580, maxWidth: "94vw", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}>

          {/* Header */}
          <div style={{ padding: "14px 18px", background: "#2a2b3c", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 14, color: "#fff" }}>Custom Paper Sizes</span>
            <button onClick={onClose} style={{ fontSize: 20, color: "rgba(255,255,255,0.7)", lineHeight: 1, background: "none", border: "none", cursor: "pointer" }}>×</button>
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflow: "auto", padding: 18 }}>

            {/* List */}
            {sizes.length > 0 && (
              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #e0e0e0", background: "#f5f6f7" }}>
                    <th style={{ ...cell, textAlign: "left", fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase" }}>Name</th>
                    <th style={{ ...cell, textAlign: "left", fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase" }}>Dimensions</th>
                    <th style={{ ...cell, textAlign: "left", fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase" }}>Background</th>
                    <th style={{ ...cell, width: 100 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {sizes.map(cs => (
                    <tr key={cs.id} style={{ borderBottom: "1px solid #e0e0e0" }}>
                      <td style={{ ...cell, color: "#333", fontSize: 13 }}>{cs.name}</td>
                      <td style={{ ...cell, color: "#55595c", fontSize: 13 }}>{cs.width_in}&quot; × {cs.height_in}&quot;</td>
                      <td style={cell}>
                        {cs.background_url
                          // eslint-disable-next-line @next/next/no-img-element
                          ? <img src={cs.background_url} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 2, border: "1px solid #e0e0e0" }} />
                          : <span style={{ fontSize: 11, color: "#78828c" }}>Default</span>}
                      </td>
                      <td style={{ ...cell, textAlign: "right" }}>
                        <button onClick={() => startEdit(cs)} style={{ fontSize: 12, color: "#1976d2", background: "none", border: "none", cursor: "pointer", marginRight: 10 }}>Edit</button>
                        <button onClick={() => void deleteSize(cs.id)} disabled={deleting === cs.id}
                          style={{ fontSize: 12, color: "#ff5252", background: "none", border: "none", cursor: "pointer", opacity: deleting === cs.id ? 0.5 : 1 }}>
                          {deleting === cs.id ? "…" : "Delete"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {sizes.length === 0 && !form && (
              <p style={{ color: "#78828c", fontSize: 13, textAlign: "center", padding: "24px 0" }}>No custom sizes yet.</p>
            )}

            {/* Add/Edit form */}
            {form ? (
              <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, padding: 16, background: "#f9f9f9" }}>
                <p style={{ fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase", marginBottom: 12 }}>
                  {form.id ? "Edit Size" : "Add New Size"}
                </p>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: "block", fontSize: 12, color: "#55595c", marginBottom: 4 }}>Size Name *</label>
                  <input
                    autoFocus
                    style={{ width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, outline: "none", boxSizing: "border-box" }}
                    value={form.name} onChange={e => setF("name", e.target.value)} placeholder='e.g. "Wide Format"' />
                </div>
                <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: "block", fontSize: 12, color: "#55595c", marginBottom: 4 }}>Width (inches) *</label>
                    <input type="number" step="0.125" min="0.5" max="24"
                      style={{ width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, outline: "none", boxSizing: "border-box" }}
                      value={form.width_in} onChange={e => setF("width_in", e.target.value)} placeholder="4.25" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: "block", fontSize: 12, color: "#55595c", marginBottom: 4 }}>Height (inches) *</label>
                    <input type="number" step="0.125" min="0.5" max="24"
                      style={{ width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, outline: "none", boxSizing: "border-box" }}
                      value={form.height_in} onChange={e => setF("height_in", e.target.value)} placeholder="11" />
                  </div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ display: "block", fontSize: 12, color: "#55595c", marginBottom: 6 }}>Background Image</label>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {form.background_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={form.background_url} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 3, border: "1px solid #e0e0e0", flexShrink: 0 }} />
                    )}
                    <button type="button" onClick={() => setShowBgPicker(true)}
                      style={{ padding: "5px 12px", fontSize: 12, background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer", color: "#55595c", fontWeight: 600 }}>
                      {form.background_url ? "Change Background" : "Choose Background"}
                    </button>
                    {form.background_url && (
                      <button type="button" onClick={() => setF("background_url", null)}
                        style={{ fontSize: 12, color: "#ff5252", background: "none", border: "none", cursor: "pointer" }}>
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                {error && <p style={{ fontSize: 12, color: "#ff5252", marginBottom: 10 }}>{error}</p>}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => { setForm(null); setError(null); }}
                    style={{ padding: "7px 16px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "#55595c" }}>
                    Cancel
                  </button>
                  <button onClick={() => void save()} disabled={saving}
                    style={{ padding: "7px 16px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: saving ? 0.7 : 1 }}>
                    {saving ? "Saving…" : form.id ? "Save Changes" : "Add Size"}
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={startAdd}
                style={{ padding: "7px 18px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                + Add New Size
              </button>
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: "12px 18px", borderTop: "1px solid #e0e0e0", display: "flex", justifyContent: "flex-end" }}>
            <button onClick={onClose}
              style={{ padding: "7px 18px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "#55595c" }}>
              Done
            </button>
          </div>
        </div>
      </div>

      {showBgPicker && (
        <ImageUploadPicker
          title="Choose Background Image"
          tab1Label="My Backgrounds"
          listEndpoint={`/api/upload-image?bucket=new-addendum-backgrounds&prefix=${encodeURIComponent(`custom/${dealerId}`)}`}
          uploadBucket="new-addendum-backgrounds"
          uploadKeyPrefix={`custom/${dealerId}`}
          acceptedTypes="image/png"
          maxSizeMB={5}
          onSelect={url => { setF("background_url", url); setShowBgPicker(false); }}
          onClose={() => setShowBgPicker(false)}
        />
      )}
    </>
  );
}
