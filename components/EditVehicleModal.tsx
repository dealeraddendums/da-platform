"use client";

import { useEffect, useState } from "react";
import type { DealerVehicleRow } from "@/lib/db";
import { FUEL_RULE_OPTIONS } from "@/lib/fuel-rule";
import { resolveVehicleCondition } from "@/lib/vehicles";

type Props = {
  vehicle: DealerVehicleRow;
  aiEnabled?: boolean;
  onSaved: (updated: DealerVehicleRow) => void;
  onClose: () => void;
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%", height: 36, border: "1px solid var(--border)", borderRadius: 4,
  padding: "0 10px", fontSize: 13, background: "#fff", color: "var(--text-primary)",
  boxSizing: "border-box",
};
const TEXTAREA_STYLE: React.CSSProperties = {
  width: "100%", border: "1px solid var(--border)", borderRadius: 4,
  padding: "8px 10px", fontSize: 13, background: "#fff", color: "var(--text-primary)",
  boxSizing: "border-box", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5,
};
const LABEL_STYLE: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 600,
  color: "var(--text-secondary)", marginBottom: 4,
};

const CONDITIONS = ["New", "Used", "Certified"];

// The dropdown is the single control for the New/Used/Certified state, which is
// stored across TWO columns: `condition` and `certified`. Certified Pre-Owned
// arrives from every feed as condition='Used' PLUS a certified flag, so that is
// the shape written here too — a hand-edited CPO vehicle is then
// indistinguishable from a feed-ingested one everywhere downstream.
//
// Previously the dropdown wrote condition='Certified' and never touched the
// flag, which no reader recognised (see resolveVehicleCondition in
// lib/vehicles.ts).
function conditionToColumns(sel: string): { condition: string; certified: string } {
  return sel === "Certified"
    ? { condition: "Used", certified: "true" }
    : { condition: sel, certified: "false" };
}

function AiBadge() {
  return (
    <span style={{
      marginLeft: 6, fontSize: 10, fontWeight: 700, padding: "1px 5px",
      background: "#e3f2fd", color: "#1565c0", borderRadius: 3, verticalAlign: "middle",
    }}>✦ AI</span>
  );
}

const DESC_STATE_LABEL: Record<string, string> = {
  saved: "Saved", cached: "Auto (default)", generated: "AI draft", edited: "Edited", empty: "Standard",
};
const DESC_STATE_HELP: Record<string, string> = {
  saved: "Saved for this vehicle — prints on its infosheet.",
  cached: "The auto-generated AI description on file for this vehicle. Click Generate another to apply your current house rules, edit it, then Save Changes.",
  generated: "New AI draft using your current house rules — not saved until you click Save Changes.",
  edited: "Edited by hand — not saved until you click Save Changes.",
  empty: "Nothing saved — the infosheet uses the standard description. Click Generate for an AI draft.",
};

function DescStateChip({ state }: { state: string }) {
  return (
    <span style={{
      flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
      background: "#f5f5f5", color: "var(--text-secondary)", border: "1px solid #e0e0e0",
    }}>{DESC_STATE_LABEL[state]}</span>
  );
}

export default function EditVehicleModal({ vehicle, aiEnabled, onSaved, onClose }: Props) {
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
    fuel: vehicle.fuel ?? "",
    description: vehicle.description ?? "",
    infosheet_ai_description: vehicle.infosheet_ai_description ?? "",
    options: vehicle.options ?? "",
    mileage: vehicle.mileage ? String(vehicle.mileage) : "0",
    msrp: vehicle.msrp ? String(vehicle.msrp) : "",
    cmpg: vehicle.cmpg ?? "",
    hmpg: vehicle.hmpg ?? "",
    // Reflect the RESOLVED state, so a feed-ingested CPO vehicle
    // (condition='Used' + certified='true') opens showing "Certified".
    condition: resolveVehicleCondition(vehicle) === "CPO" ? "Certified" : (vehicle.condition ?? "New"),
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Infosheet AI description (migration 173): Generate = a fresh draft each
  // click (re-roll); the text stays editable and is stored ONLY by Save
  // Changes. Cancel discards a generated draft.
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [generatedOnce, setGeneratedOnce] = useState(false);
  // What the box is showing (2026-10-10). When nothing is saved the box
  // pre-loads the vehicle's cached auto-generated AI description — the text
  // the infosheet prints today — so it is never blank while one exists.
  //   saved     — the dealer's saved text (infosheet_ai_description)
  //   cached    — the auto-generated default; Save keeps it NULL (default behavior)
  //   generated — a fresh Generate draft, not yet saved
  //   edited    — hand-edited, not yet saved
  //   empty     — nothing saved, nothing cached
  const savedText = (vehicle.infosheet_ai_description ?? "").trim();
  type DescState = "saved" | "cached" | "generated" | "edited" | "empty";
  const [descState, setDescState] = useState<DescState>(savedText ? "saved" : "empty");
  const [cachedText, setCachedText] = useState<string | null>(null);
  const [aiOn, setAiOn] = useState(!!aiEnabled);
  const showInfosheetDesc = aiOn || !!aiEnabled || !!savedText || !!cachedText;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/ai-content/vehicle-description?vehicleId=${encodeURIComponent(vehicle.id)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { cachedDescription?: string | null; aiEnabled?: boolean } | null) => {
        if (cancelled || !j) return;
        if (j.aiEnabled) setAiOn(true);
        const cached = (j.cachedDescription ?? "").trim();
        if (!cached) return;
        setCachedText(cached);
        // Only fill an untouched, empty box — never overwrite saved text or a
        // draft the user already started.
        setForm((p) => (p.infosheet_ai_description.trim() ? p : { ...p, infosheet_ai_description: cached }));
        setDescState((st) => (st === "empty" ? "cached" : st));
      })
      .catch(() => null);
    return () => { cancelled = true; };
  }, [vehicle.id]);

  // Clear = back to default behavior: nothing saved for this vehicle, so the
  // infosheet uses its standard (auto) description — shown again if cached.
  function clearInfosheetDesc() {
    setForm((p) => ({ ...p, infosheet_ai_description: cachedText ?? "" }));
    setDescState(cachedText ? "cached" : "empty");
    setGenError(null);
  }

  async function generateInfosheetDesc() {
    setGenBusy(true);
    setGenError(null);
    try {
      const res = await fetch("/api/ai-content/vehicle-description", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicleId: vehicle.id }),
      });
      const j = await res.json().catch(() => ({})) as { description?: string; error?: string };
      if (!res.ok || !j.description) { setGenError(j.error ?? "Couldn't generate a description — try again."); return; }
      setForm((p) => ({ ...p, infosheet_ai_description: j.description as string }));
      setDescState("generated");
      setGeneratedOnce(true);
    } catch {
      setGenError("Couldn't generate a description — try again.");
    } finally {
      setGenBusy(false);
    }
  }

  // Persistent modals (2026-09-02): no Escape-to-close and no backdrop-click
  // dismissal — this modal closes only via its × / Cancel buttons, so an
  // accidental click or keypress cannot discard in-progress edits.

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
        // The cached auto description is shown for reference only — saving it
        // unchanged keeps the column NULL so the vehicle stays on default
        // behavior (and keeps following future regenerations).
        infosheet_ai_description: descState === "cached" ? "" : form.infosheet_ai_description,
        // Expand the single dropdown into the two columns it owns, so the row
        // can never end up half-set (Certified without the flag, or a stale
        // flag left behind after switching to New/Used).
        ...conditionToColumns(form.condition),
        year: form.year ? parseInt(form.year, 10) : null,
        mileage: form.mileage ? parseInt(form.mileage, 10) : 0,
        msrp: form.msrp ? parseFloat(form.msrp) : null,
        cmpg: form.cmpg.trim() || null,
        hmpg: form.hmpg.trim() || null,
        fuel: form.fuel.trim() || null,
      }),
    });
    const json = await res.json() as DealerVehicleRow & { error?: string };
    setSaving(false);
    if (!res.ok) { setSaveError(json.error ?? "Save failed"); return; }
    onSaved(json);
  }

  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000 }} />
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
            <div>
              <label style={LABEL_STYLE}>Fuel</label>
              <select value={form.fuel} onChange={(e) => setForm((p) => ({ ...p, fuel: e.target.value }))} style={INPUT_STYLE}>
                <option value="">—</option>
                {/* Preserve a legacy free-text feed value until the dealer changes it */}
                {form.fuel && !FUEL_RULE_OPTIONS.some((o) => o.label === form.fuel) && (
                  <option value={form.fuel}>{form.fuel}</option>
                )}
                {FUEL_RULE_OPTIONS.map((o) => <option key={o.label} value={o.label}>{o.label}</option>)}
              </select>
            </div>

            <div style={{ gridColumn: "1 / -1" }}>
              <label style={LABEL_STYLE}>
                Description
                {aiEnabled && <AiBadge />}
              </label>
              <textarea
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                style={{ ...TEXTAREA_STYLE, minHeight: 80 }}
                rows={4}
                placeholder="Vehicle description from your feed, or typed by hand"
              />
            </div>

            {showInfosheetDesc && (
              <div style={{ gridColumn: "1 / -1" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <label style={{ ...LABEL_STYLE, marginBottom: 0 }}>
                    Infosheet description
                    <AiBadge />
                  </label>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    {descState !== "cached" && descState !== "empty" && (
                      <button type="button" onClick={clearInfosheetDesc} title="Go back to the standard description for this vehicle"
                        style={{ background: "none", border: "none", padding: 0, fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>
                        Clear
                      </button>
                    )}
                    <button type="button" onClick={() => void generateInfosheetDesc()} disabled={genBusy}
                      style={{ height: 28, padding: "0 12px", background: "#fff", border: "1px solid #1976d2", borderRadius: 4, fontSize: 12, fontWeight: 600, color: "#1976d2", cursor: genBusy ? "not-allowed" : "pointer" }}>
                      {genBusy ? "Generating…" : generatedOnce || form.infosheet_ai_description.trim() ? "✦ Generate another" : "✦ Generate"}
                    </button>
                  </div>
                </div>
                <textarea
                  value={form.infosheet_ai_description}
                  onChange={(e) => { const t = e.target.value; setForm((p) => ({ ...p, infosheet_ai_description: t })); setDescState(t.trim() ? "edited" : "empty"); }}
                  style={{ ...TEXTAREA_STYLE, minHeight: 80 }}
                  rows={4}
                  maxLength={4000}
                  aria-label="Infosheet description"
                  placeholder="Click Generate for an AI description of this vehicle, then edit it as you like."
                />
                <div style={{ fontSize: 11, color: genError ? "#c62828" : "var(--text-muted)", marginTop: 4, display: "flex", gap: 6, alignItems: "baseline" }}>
                  {!genError && <DescStateChip state={descState} />}
                  <span>{genError ?? DESC_STATE_HELP[descState]}</span>
                </div>
              </div>
            )}

            <div style={{ gridColumn: "1 / -1" }}>
              <label style={LABEL_STYLE}>
                Options / Features
                {aiEnabled && <AiBadge />}
              </label>
              <textarea
                value={form.options}
                onChange={(e) => setForm((p) => ({ ...p, options: e.target.value }))}
                style={{ ...TEXTAREA_STYLE, minHeight: 80 }}
                rows={4}
                placeholder="Factory options and features — auto-filled by AI if enabled"
              />
            </div>

            <div><label style={LABEL_STYLE}>Mileage</label><input type="number" value={form.mileage} onChange={(e) => setForm((p) => ({ ...p, mileage: e.target.value }))} style={INPUT_STYLE} min="0" /></div>
            <div><label style={LABEL_STYLE}>MSRP</label><input type="number" value={form.msrp} onChange={(e) => setForm((p) => ({ ...p, msrp: e.target.value }))} style={INPUT_STYLE} min="0" step="100" /></div>
            <div><label style={LABEL_STYLE}>City MPG</label><input type="number" value={form.cmpg} onChange={(e) => setForm((p) => ({ ...p, cmpg: e.target.value }))} style={INPUT_STYLE} min="0" max="200" /></div>
            <div><label style={LABEL_STYLE}>Highway MPG</label><input type="number" value={form.hmpg} onChange={(e) => setForm((p) => ({ ...p, hmpg: e.target.value }))} style={INPUT_STYLE} min="0" max="200" /></div>
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
