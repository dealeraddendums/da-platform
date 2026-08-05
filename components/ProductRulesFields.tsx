"use client";

import { useState } from "react";
import MakeModelTrimSelect from "@/components/MakeModelTrimSelect";
import FuelRuleSelect from "@/components/FuelRuleSelect";

// Shared "Assign with Rules" block — the ONE rules UI for both the dealer
// Configure Product modal (OptionsLibrary) and the group Add/Edit Corporate
// Product modal (CorporateProductModal). Extracted 2026-08-05 (same playbook
// as ProductAuthoringFields, 5e7b0b2) after the corporate modal drifted to a
// reduced field set (no Bodystyle/Year/Mileage/MSRP/show-models-only and a
// one-button IN↔NOT-IN chip). The matching engine (lib/options-engine.ts
// matchesRulesRow) evaluates the identical rule columns for both
// addendum_library and group_options, so the authoring UI must offer the
// identical fields.
//
// Numeric fields are STRINGS here (raw input state); each modal converts to
// number-or-null at save time. Empty field = match all values (engine
// semantics).

export type ProductRulesValue = {
  makes: string; makes_not: boolean;
  models: string; models_not: boolean;
  trims: string; trims_not: boolean;
  body_styles: string;
  fuel: string; fuel_not: boolean;
  year_condition: number; year_value: string;
  miles_condition: number; miles_value: string;
  msrp_condition: number; msrp1: string; msrp2: string;
  show_models_only: boolean;
};

export const BLANK_RULES: ProductRulesValue = {
  makes: "", makes_not: false, models: "", models_not: false,
  trims: "", trims_not: false, body_styles: "", fuel: "", fuel_not: false,
  year_condition: 0, year_value: "", miles_condition: 0, miles_value: "",
  msrp_condition: 0, msrp1: "", msrp2: "", show_models_only: false,
};

const inp: React.CSSProperties = {
  width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4,
  fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", background: "#fff",
};
const lbl: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: "#55595c", textTransform: "uppercase",
  letterSpacing: ".05em", display: "block", marginBottom: 5,
};
const btnGhost: React.CSSProperties = {
  padding: "7px 14px", background: "#fff", color: "#55595c",
  border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer", fontSize: 13,
};

function TagInput({ value, onChange, placeholder = "Type and press Enter…" }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  const [input, setInput] = useState("");
  const tags = value ? value.split(",").map(s => s.trim()).filter(Boolean) : [];

  function add() {
    const trimmed = input.trim();
    if (!trimmed) return;
    onChange([...tags.filter(t => t !== trimmed), trimmed].join(","));
    setInput("");
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          style={{ ...inp, flex: 1 }}
        />
        <button type="button" onClick={add} style={{ ...btnGhost, padding: "7px 12px" }}>+</button>
      </div>
      {tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
          {tags.map(t => (
            <span key={t} style={{ background: "#e3f2fd", color: "#1565c0", fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 12, display: "flex", alignItems: "center", gap: 4 }}>
              {t}
              <button type="button" onClick={() => onChange(tags.filter(x => x !== t).join(","))} style={{ background: "none", border: "none", cursor: "pointer", color: "#1565c0", fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Two-button IN / NOT IN toggle — both states always visible (a one-button
// chip reads as a static label; that's how the corporate modal's NOT IN went
// unnoticed).
function InNotIn({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: "1px solid #e0e0e0", width: "fit-content" }}>
      {[false, true].map(v => (
        <button
          key={String(v)}
          type="button"
          onClick={() => onChange(v)}
          style={{
            padding: "5px 12px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700,
            background: value === v ? "#1976d2" : "#fff",
            color: value === v ? "#fff" : "#55595c",
          }}
        >
          {v ? "NOT IN" : "IN"}
        </button>
      ))}
    </div>
  );
}

export default function ProductRulesFields({ value, onChange }: {
  value: ProductRulesValue;
  onChange: (patch: Partial<ProductRulesValue>) => void;
}) {
  const row = (label: string, children: React.ReactNode) => (
    <div style={{ marginBottom: 14 }}>
      <label style={lbl}>{label}</label>
      {children}
    </div>
  );

  return (
    <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, padding: "14px 16px", marginBottom: 14, background: "#fafafa" }}>
      <MakeModelTrimSelect
        make={value.makes}
        model={value.models}
        trim={value.trims}
        onChange={({ make, model, trim }) => onChange({ makes: make, models: model, trims: trim })}
        makeRight={<InNotIn value={value.makes_not} onChange={v => onChange({ makes_not: v })} />}
        modelRight={<InNotIn value={value.models_not} onChange={v => onChange({ models_not: v })} />}
        trimRight={<InNotIn value={value.trims_not} onChange={v => onChange({ trims_not: v })} />}
      />

      <div style={{ marginTop: 14 }}>
        {row("Bodystyle", (
          <TagInput value={value.body_styles} onChange={v => onChange({ body_styles: v })} placeholder="All bodystyles" />
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <FuelRuleSelect
          value={value.fuel}
          onChange={v => onChange({ fuel: v })}
          not={value.fuel_not}
          onNotChange={v => onChange({ fuel_not: v })}
        />
      </div>

      {row("Year", (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={value.year_condition} onChange={e => onChange({ year_condition: parseInt(e.target.value) })}
            style={{ ...inp, width: 130, flex: "none" }}>
            <option value={0}>All years</option>
            <option value={1}>Equal to</option>
            <option value={2}>Before</option>
            <option value={3}>After</option>
          </select>
          {value.year_condition !== 0 && (
            <input type="number" value={value.year_value} onChange={e => onChange({ year_value: e.target.value })}
              style={{ ...inp, width: 100, flex: "none" }} placeholder="e.g. 2020" min={1990} max={2030} />
          )}
        </div>
      ))}

      {row("Mileage", (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={value.miles_condition} onChange={e => onChange({ miles_condition: parseInt(e.target.value) })}
            style={{ ...inp, width: 130, flex: "none" }}>
            <option value={0}>All mileage</option>
            <option value={1}>Under</option>
            <option value={2}>Over</option>
          </select>
          {value.miles_condition !== 0 && (
            <input type="number" value={value.miles_value} onChange={e => onChange({ miles_value: e.target.value })}
              style={{ ...inp, width: 120, flex: "none" }} placeholder="miles" min={0} />
          )}
        </div>
      ))}

      {row("MSRP", (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={value.msrp_condition} onChange={e => onChange({ msrp_condition: parseInt(e.target.value) })}
            style={{ ...inp, width: 130, flex: "none" }}>
            <option value={0}>All prices</option>
            <option value={1}>Under</option>
            <option value={2}>Over</option>
            <option value={3}>Between</option>
          </select>
          {value.msrp_condition !== 0 && (
            <input type="number" value={value.msrp1} onChange={e => onChange({ msrp1: e.target.value })}
              style={{ ...inp, width: 120, flex: "none" }} placeholder="$" min={0} />
          )}
          {value.msrp_condition === 3 && (
            <>
              <span style={{ fontSize: 12, color: "#78828c" }}>and</span>
              <input type="number" value={value.msrp2} onChange={e => onChange({ msrp2: e.target.value })}
                style={{ ...inp, width: 120, flex: "none" }} placeholder="$" min={0} />
            </>
          )}
        </div>
      ))}

      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "#333" }}>
        <input type="checkbox" checked={value.show_models_only}
          onChange={e => onChange({ show_models_only: e.target.checked })}
          style={{ width: 14, height: 14 }} />
        Show only for specified models
      </label>

      <p style={{ fontSize: 11, color: "#78828c", marginTop: 10, marginBottom: 0 }}>
        Leave any field empty to match all values for that field.
      </p>
    </div>
  );
}
