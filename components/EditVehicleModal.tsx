"use client";

import { useState, useEffect } from "react";
import type { DealerVehicleRow } from "@/lib/db";

type Props = {
  vehicle: DealerVehicleRow;
  onSaved: (updated: DealerVehicleRow) => void;
  onClose: () => void;
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%", height: 36, border: "1px solid var(--border)", borderRadius: 4,
  padding: "0 10px", fontSize: 13, background: "#fff", color: "var(--text-primary)",
  boxSizing: "border-box",
};
const LABEL_STYLE: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 600,
  color: "var(--text-secondary)", marginBottom: 4,
};

const CONDITIONS = ["New", "Used", "Certified"];

export default function EditVehicleModal({ vehicle, onSaved, onClose }: Props) {
  const [form, setForm] = useState({
    stock_number: vehicle.stock_number,
    vin: vehicle.vin ?? "",
    year: vehicle.year ? String(vehicle.year) : "",
    make: vehicle.make ?? "",
    model: vehicle.model ?? "",
    trim: vehicle.trim ?? "",
    body_style: vehicle.body_style ?? "",
    exterior_color: vehicle.exterior_color ?? "",
    interior_color: vehicle.interior_color ?? "",
    engine: vehicle.engine ?? "",
    transmission: vehicle.transmission ?? "",
    drivetrain: vehicle.drivetrain ?? "",
    mileage: vehicle.mileage ? String(vehicle.mileage) : "0",
    msrp: vehicle.msrp ? String(vehicle.msrp) : "",
    condition: vehicle.condition,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  function f(k: keyof typeof form) {
    return (
      <input
        type="text"
        value={form[k]}
        onChange={(e) => setForm((p) => ({ ...p, [k]: e.target.value }))}
        style={INPUT_STYLE}
      />
    );
  }

  async function handleSave() {
    if (!form.stock_number.trim()) { setSaveError("Stock Number is required"); return; }
    setSaving(true);
    setSaveError(null);
    const res = await fetch(`/api/dealer-vehicles/${vehicle.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        year: form.year ? parseInt(form.year, 10) : null,
        mileage: form.mileage ? parseInt(form.mileage, 10) : 0,
        msrp: form.msrp ? parseFloat(form.msrp) : null,
      }),
    });
    const json = await res.json() as DealerVehicleRow & { error?: string };
    setSaving(false);
    if (!res.ok) { setSaveError(json.error ?? "Save failed"); return; }
    onSaved(json);
  }

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000 }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        background: "#fff", borderRadius: 6, zIndex: 1001,
        width: "min(700px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
      }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
            Edit Vehicle — {vehicle.stock_number}
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--text-muted)", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={LABEL_STYLE}>Stock Number *</label>
              <input type="text" value={form.stock_number} onChange={(e) => setForm((p) => ({ ...p, stock_number: e.target.value }))} style={INPUT_STYLE} />
            </div>
            <div><label style={LABEL_STYLE}>VIN</label><input type="text" value={form.vin} onChange={(e) => setForm((p) => ({ ...p, vin: e.target.value.toUpperCase() }))} style={{ ...INPUT_STYLE, fontFamily: "monospace" }} maxLength={17} /></div>
            <div><label style={LABEL_STYLE}>Year</label><input type="number" value={form.year} onChange={(e) => setForm((p) => ({ ...p, year: e.target.value }))} style={INPUT_STYLE} min="1900" max="2099" /></div>
            <div><label style={LABEL_STYLE}>Make</label>{f("make")}</div>
            <div><label style={LABEL_STYLE}>Model</label>{f("model")}</div>
            <div><label style={LABEL_STYLE}>Trim</label>{f("trim")}</div>
            <div><label style={LABEL_STYLE}>Body Style</label>{f("body_style")}</div>
            <div><label style={LABEL_STYLE}>Ext. Color</label>{f("exterior_color")}</div>
            <div><label style={LABEL_STYLE}>Int. Color</label>{f("interior_color")}</div>
            <div><label style={LABEL_STYLE}>Engine</label>{f("engine")}</div>
            <div><label style={LABEL_STYLE}>Transmission</label>{f("transmission")}</div>
            <div><label style={LABEL_STYLE}>Drivetrain</label>{f("drivetrain")}</div>
            <div><label style={LABEL_STYLE}>Mileage</label><input type="number" value={form.mileage} onChange={(e) => setForm((p) => ({ ...p, mileage: e.target.value }))} style={INPUT_STYLE} min="0" /></div>
            <div><label style={LABEL_STYLE}>MSRP</label><input type="number" value={form.msrp} onChange={(e) => setForm((p) => ({ ...p, msrp: e.target.value }))} style={INPUT_STYLE} min="0" step="100" /></div>
            <div>
              <label style={LABEL_STYLE}>Condition</label>
              <select value={form.condition} onChange={(e) => setForm((p) => ({ ...p, condition: e.target.value }))} style={{ ...INPUT_STYLE }}>
                {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          {saveError && (
            <div style={{ marginTop: 12, padding: "8px 12px", background: "#ffebee", border: "1px solid #ffcdd2", borderRadius: 4, color: "#c62828", fontSize: 13 }}>
              {saveError}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", display: "flex", gap: 8, justifyContent: "flex-end", flexShrink: 0 }}>
          <button onClick={onClose} style={{ height: 36, padding: "0 16px", background: "#fff", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "var(--text-secondary)" }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ height: 36, padding: "0 16px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer" }}
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </>
  );
}
