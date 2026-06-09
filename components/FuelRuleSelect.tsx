"use client";

import { useEffect, useMemo, useState } from "react";

type Option = { label: string; keywords: string[] };

/**
 * Fuel rule control for Configure Product → Assign with Rules. Shows the
 * curated canonical fuel labels from GET /api/vehicles/fuel-types (Gasoline,
 * Diesel, Hybrid, …) with an IN / NOT IN toggle. Selecting a label stores that
 * category's lowercase substring KEYWORDS into the `fuel` rule CSV, so the
 * matcher (vehicleFuel.includes(keyword)) catches the messy feed variants.
 *
 * The stored value is the keyword CSV (e.g. "gas,unleaded,unl"); a category is
 * "checked" when all its keywords are present. Empty = all fuels. The toggle
 * maps to `fuel_not` (IN=false / NOT IN=true).
 */
export default function FuelRuleSelect({
  value,
  onChange,
  not,
  onNotChange,
}: {
  value: string;
  onChange: (csv: string) => void;
  not: boolean;
  onNotChange: (v: boolean) => void;
}) {
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(false);

  const selectedKw = useMemo(
    () => new Set((value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
    [value],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch("/api/vehicles/fuel-types")
      .then((r) => r.json())
      .then((j: { data?: Option[] }) => { if (alive) setOptions(j.data ?? []); })
      .catch(() => { /* leave empty */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const isChecked = (o: Option) => o.keywords.length > 0 && o.keywords.every((k) => selectedKw.has(k.toLowerCase()));

  function toggle(o: Option) {
    const next = new Set(selectedKw);
    if (isChecked(o)) {
      for (const k of o.keywords) next.delete(k.toLowerCase());
    } else {
      for (const k of o.keywords) next.add(k.toLowerCase());
    }
    onChange(Array.from(next).join(","));
  }

  const checkedLabels = options.filter(isChecked).map((o) => o.label);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#55595c" }}>Fuel</span>
        <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: "1px solid #e0e0e0" }}>
          {[false, true].map((v) => (
            <button
              key={String(v)}
              type="button"
              onClick={() => onNotChange(v)}
              style={{
                padding: "4px 10px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700,
                background: not === v ? "#1976d2" : "#fff", color: not === v ? "#fff" : "#55595c",
              }}
            >
              {v ? "NOT IN" : "IN"}
            </button>
          ))}
        </div>
      </div>
      <div style={{ border: "1px solid #e0e0e0", borderRadius: 4, maxHeight: 150, overflowY: "auto", padding: "6px 10px", background: "#fff", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px" }}>
        {loading && options.length === 0 ? (
          <div style={{ fontSize: 12, color: "#9aa0a6" }}>Loading…</div>
        ) : (
          options.map((o) => (
            <label key={o.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#333", padding: "2px 0", cursor: "pointer" }}>
              <input type="checkbox" checked={isChecked(o)} onChange={() => toggle(o)} />
              {o.label}
            </label>
          ))
        )}
      </div>
      <div style={{ fontSize: 11, color: "#9aa0a6", marginTop: 4 }}>
        {checkedLabels.length === 0 ? "All fuels" : `${not ? "Exclude" : "Only"}: ${checkedLabels.join(", ")}`}
      </div>
    </div>
  );
}
