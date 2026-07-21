"use client";

import { useState } from "react";
import ProductAuthoringFields from "@/components/ProductAuthoringFields";
import MakeModelTrimSelect from "@/components/MakeModelTrimSelect";
import FuelRuleSelect from "@/components/FuelRuleSelect";
import type { GroupOptionRow } from "@/lib/db";

type FormState = {
  option_name: string;
  option_price: string;
  description: string;
  required: boolean;            // true = Required, false = Suggested
  locked: boolean;              // true (default) = dealer cannot remove on a vehicle
  applies_to: "all" | "rules" | "none";
  ad_types: string[];           // ["New","Used","CPO"]
  models: string;
  models_not: boolean;
  trims: string;
  trims_not: boolean;
  makes: string;
  makes_not: boolean;
  fuel: string;
  fuel_not: boolean;
  separator_above: boolean;
  separator_below: boolean;
  spaces: number;
};

const BLANK: FormState = {
  option_name: "",
  option_price: "NC",
  description: "",
  required: true,
  locked: true,
  applies_to: "all",
  ad_types: ["New", "Used", "CPO"],
  models: "",
  models_not: false,
  trims: "",
  trims_not: false,
  makes: "",
  makes_not: false,
  fuel: "",
  fuel_not: false,
  separator_above: false,
  separator_below: false,
  spaces: 0,
};

function rowToForm(r: GroupOptionRow): FormState {
  const adTypes = (r.ad_types && r.ad_types.length > 0) ? r.ad_types : ["New", "Used", "CPO"];
  return {
    option_name: r.option_name ?? "",
    option_price: r.option_price ?? "NC",
    description: r.description ?? "",
    required: r.required ?? !(r.is_suggested ?? false),
    locked: typeof r.locked === "boolean" ? r.locked : true,
    applies_to: (r.applies_to as "all" | "rules" | "none") ?? "all",
    ad_types: adTypes,
    models: r.models ?? "",
    models_not: r.models_not ?? false,
    trims: r.trims ?? "",
    trims_not: r.trims_not ?? false,
    makes: r.makes ?? "",
    makes_not: r.makes_not ?? false,
    fuel: r.fuel ?? "",
    fuel_not: r.fuel_not ?? false,
    separator_above: r.separator_above ?? false,
    separator_below: r.separator_below ?? false,
    spaces: r.spaces ?? 0,
  };
}

const inp: React.CSSProperties = {
  width: "100%", padding: "8px 10px", height: 36,
  border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff",
  fontSize: 13, color: "#333",
};
const lbl: React.CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: "0.05em", color: "#78828c", marginBottom: 5,
};

// Shared pill-toggle style. Mirror of components/OptionsLibrary.tsx —
// keep the two in sync. Convention: selected = blue (#1976d2 / #e3f2fd),
// unselected = white. The legacy TypePill signature is preserved so
// existing call sites keep working without per-pill color args.
function pillToggleStyle(on: boolean): React.CSSProperties {
  return {
    flex: 1, padding: "8px 0", borderRadius: 4, fontWeight: 600, fontSize: 13,
    cursor: "pointer", fontFamily: "inherit",
    border: `2px solid ${on ? "#1976d2" : "#e0e0e0"}`,
    background: on ? "#e3f2fd" : "#fff",
    color: on ? "#1976d2" : "#55595c",
  };
}

function TypePill({ active, label, onClick }: {
  active: boolean; label: string; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} style={pillToggleStyle(active)}>
      {label}
    </button>
  );
}

export default function CorporateProductModal({
  groupId,
  initial,
  onClose,
  onSaved,
}: {
  groupId: string;
  initial: GroupOptionRow | null;
  onClose: () => void;
  onSaved: (saved: GroupOptionRow) => void;
}) {
  const [form, setForm] = useState<FormState>(initial ? rowToForm(initial) : BLANK);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dealer assignment lives in the standalone Assign button on the Corporate
  // Products row now — see AssignProductModal. This modal handles only the
  // product attributes.

  function f<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }
  function toggleAdType(t: "New" | "Used" | "CPO") {
    setForm(prev => {
      const set = new Set(prev.ad_types);
      if (set.has(t)) set.delete(t); else set.add(t);
      return { ...prev, ad_types: Array.from(set) };
    });
  }
  async function save() {
    setError(null);
    if (!form.option_name.trim()) { setError("Item name is required"); return; }
    setSaving(true);
    const body = {
      option_name: form.option_name.trim(),
      option_price: form.option_price.trim() || "NC",
      description: form.description,
      required: form.required,
      locked: form.locked,
      // Mirror old is_suggested semantics for backward-compat with the engine
      // until Stage 4 lands and everything reads the new required column.
      is_suggested: !form.required,
      applies_to: form.applies_to,
      ad_types: form.ad_types,
      models: form.models.trim(),
      models_not: form.models_not,
      trims: form.trims.trim(),
      trims_not: form.trims_not,
      makes: form.makes.trim(),
      makes_not: form.makes_not,
      fuel: form.fuel.trim(),
      fuel_not: form.fuel_not,
      separator_above: form.separator_above,
      separator_below: form.separator_below,
      spaces: form.spaces,
    };
    const url = initial
      ? `/api/group-options/${groupId}/${initial.id}`
      : `/api/group-options/${groupId}`;
    const method = initial ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      setError(j.error ?? `Save failed (${res.status})`);
      setSaving(false);
      return;
    }
    const { data: saved } = await res.json() as { data: GroupOptionRow };
    setSaving(false);
    onSaved(saved);
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 20, overflowY: "auto" }}
    >
      <div className="card" style={{ width: 640, maxWidth: "100%", display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
        <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 className="font-semibold text-base" style={{ color: "var(--text-primary)" }}>
            {initial ? "Edit Corporate Product" : "Add Corporate Product"}
          </h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, color: "var(--text-muted)", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        <div className="px-5 py-4" style={{ overflowY: "auto", maxHeight: "70vh" }}>
          {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}

          {/* Item Name + Price + Description — shared with the dealer Configure
              Product modal (components/ProductAuthoringFields): "?" price helper,
              ✦ AI Generate, font-size "A", and add-image-to-name/description.
              Group-authored images upload under a group/{id} prefix in the shared
              product-images bucket (rendered on every member dealer's addendum). */}
          <ProductAuthoringFields
            itemName={form.option_name}
            price={form.option_price}
            description={form.description}
            onItemName={(v) => f("option_name", v)}
            onPrice={(v) => f("option_price", v)}
            onDescription={(v) => f("description", v)}
            imageKeyPrefix={`group/${groupId}`}
          />

          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Product Type</label>
            <div style={{ display: "flex", gap: 8 }}>
              <TypePill active={form.required} label="Required" onClick={() => f("required", true)} />
              <TypePill active={!form.required} label="Suggested" onClick={() => f("required", false)} />
            </div>
            <p style={{ fontSize: 11, color: "#78828c", marginTop: 6, marginBottom: 0 }}>
              {form.required
                ? "Required — auto-prepended and locked on every assigned dealer's addendum."
                : "Suggested — offered to dealers; visibility controlled by dealer assignment below."}
            </p>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={form.locked}
                onChange={e => f("locked", e.target.checked)}
                style={{ width: 16, height: 16, cursor: "pointer" }}
              />
              <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>
                {form.locked ? "🔒 Locked" : "🔓 Unlocked"}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {form.locked
                  ? "Dealers cannot remove this product from their addendums."
                  : "Dealers can dismiss this product on individual vehicles."}
              </span>
            </label>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Applies To</label>
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { v: "all" as const, label: "All Vehicles" },
                { v: "rules" as const, label: "Assign with Rules" },
                { v: "none" as const, label: "No Vehicles" },
              ].map(opt => {
                const on = form.applies_to === opt.v;
                return (
                  <button key={opt.v} type="button" onClick={() => f("applies_to", opt.v)}
                    style={pillToggleStyle(on)}>
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Vehicle Type</label>
            <div style={{ display: "flex", gap: 8 }}>
              {(["New", "Used", "CPO"] as const).map(t => {
                const on = form.ad_types.includes(t);
                return (
                  <button key={t} type="button" onClick={() => toggleAdType(t)}
                    style={pillToggleStyle(on)}>
                    {t}
                  </button>
                );
              })}
            </div>
          </div>

          {form.applies_to === "rules" && (
            <div style={{ marginBottom: 14 }}>
              <MakeModelTrimSelect
                make={form.makes}
                model={form.models}
                trim={form.trims}
                onChange={({ make, model, trim }) => {
                  setForm(prev => ({ ...prev, makes: make, models: model, trims: trim }));
                }}
                makeRight={<NotPill on={form.makes_not} onClick={() => f("makes_not", !form.makes_not)} />}
                modelRight={<NotPill on={form.models_not} onClick={() => f("models_not", !form.models_not)} />}
                trimRight={<NotPill on={form.trims_not} onClick={() => f("trims_not", !form.trims_not)} />}
              />
              <div style={{ marginTop: 12 }}>
                <FuelRuleSelect
                  value={form.fuel}
                  onChange={v => f("fuel", v)}
                  not={form.fuel_not}
                  onNotChange={v => f("fuel_not", v)}
                />
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#55595c" }}>
              <input type="checkbox" checked={form.separator_above} onChange={e => f("separator_above", e.target.checked)} />
              Separator above
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#55595c" }}>
              <input type="checkbox" checked={form.separator_below} onChange={e => f("separator_below", e.target.checked)} />
              Separator below
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#55595c" }}>
              Spaces
              <input type="number" min={0} max={10} value={form.spaces}
                onChange={e => f("spaces", Math.max(0, Math.min(10, parseInt(e.target.value, 10) || 0)))}
                style={{ ...inp, width: 60, height: 32, padding: "4px 8px" }} />
            </label>
          </div>

          <p style={{ fontSize: 11, color: "#78828c", marginTop: 18 }}>
            Dealer assignment is managed from the Assign button on this product&apos;s row in the Corporate Products table.
          </p>
        </div>

        <div className="px-5 py-3" style={{ borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
          {error && <span style={{ fontSize: 12, color: "#c62828", marginRight: "auto" }}>{error}</span>}
          <button type="button" onClick={onClose}
            style={{ height: 36, padding: "0 16px", border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", color: "#333", cursor: "pointer", fontSize: 13 }}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={saving}
            style={{ height: 36, padding: "0 16px", border: "none", borderRadius: 6, background: "#1976d2", color: "#fff", cursor: saving ? "default" : "pointer", fontSize: 13, fontWeight: 600 }}>
            {saving ? "Saving…" : initial ? "Save Changes" : "Add Product"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NotPill({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        height: 36, padding: "0 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer",
        border: `1px solid ${on ? "#c62828" : "#e0e0e0"}`,
        background: on ? "#ffebee" : "#fff",
        color: on ? "#c62828" : "#78828c", whiteSpace: "nowrap",
      }}>
      {on ? "NOT IN" : "IN"}
    </button>
  );
}
