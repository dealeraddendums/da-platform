"use client";

// Settings → Default Templates → Infosheet → "CPO by mileage" (migration 176).
//
// Lets a dealer treat USED vehicles of the brands they sell, under a mileage
// cap, as CPO when picking the Infosheet template (every used Ford or Lincoln
// under 60,000 miles prints the CPO Infosheet). Template selection only — the
// vehicle record is never changed, and the addendum still follows the
// certified flag. Values live on the Settings form and save with its Save
// button; this component only renders and edits them.

import { useEffect, useState } from "react";
import { makeKey } from "@/lib/make-key";

interface MakeOption { key: string; label: string; count: number }

export default function CpoByMileageCard({
  dealerId, enabled, cap, brands, readOnly, onChange,
}: {
  dealerId: string | null;
  enabled: boolean;
  cap: number | null;
  brands: string[];
  readOnly: boolean;
  onChange: (patch: { cpo_by_mileage_enabled?: boolean; cpo_by_mileage_cap?: number | null; cpo_by_mileage_brands?: string[] | null }) => void;
}) {
  // Suggestions = the makes this dealer actually stocks (same list the brand
  // overrides use). The dealer still picks explicitly; nothing is preselected.
  const [makes, setMakes] = useState<MakeOption[]>([]);
  const [other, setOther] = useState("");
  useEffect(() => {
    const qs = dealerId ? `?dealer_id=${encodeURIComponent(dealerId)}` : "";
    fetch(`/api/settings/make-overrides${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { makes?: MakeOption[] } | null) => setMakes(j?.makes ?? []))
      .catch(() => setMakes([]));
  }, [dealerId]);

  const off = readOnly || !enabled;
  const picked = new Set(brands);
  const labelFor = (k: string) => makes.find((m) => m.key === k)?.label ?? k;
  const toggleBrand = (k: string) => {
    const next = picked.has(k) ? brands.filter((b) => b !== k) : [...brands, k];
    onChange({ cpo_by_mileage_brands: next.length ? next : null });
  };
  const addOther = () => {
    const k = makeKey(other);
    if (k && !picked.has(k)) onChange({ cpo_by_mileage_brands: [...brands, k] });
    setOther("");
  };
  // Picked brands first (incl. any typed in that aren't in stock today), then
  // the rest of the dealer's makes.
  const options = [
    ...brands.map((k) => ({ key: k, label: labelFor(k) })),
    ...makes.filter((m) => !picked.has(m.key)).map((m) => ({ key: m.key, label: `${m.label} (${m.count})` })),
  ];

  return (
    <div className="mt-4 pt-4" style={{ borderTop: "1px solid var(--border)" }}>
      <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
        CPO by mileage
      </p>
      <label className="flex items-start gap-2" style={{ cursor: readOnly ? "not-allowed" : "pointer" }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={readOnly}
          onChange={(e) => onChange({ cpo_by_mileage_enabled: e.target.checked })}
          style={{ marginTop: 3 }}
        />
        <span className="text-sm" style={{ color: "var(--text-primary)" }}>
          Apply the CPO Infosheet to used vehicles by mileage &amp; brand
        </span>
      </label>
      <p className="text-xs mt-1 mb-3" style={{ color: "var(--text-muted)", paddingLeft: 22 }}>
        Certified vehicles always get the CPO Infosheet. This affects the Infosheet only; addendums are unchanged.
      </p>

      <div style={{ paddingLeft: 22, opacity: off ? 0.5 : 1 }}>
        <div className="flex items-center gap-3 mb-1">
          <label className="text-sm" style={{ color: "var(--text-secondary)", minWidth: 110 }}>Mileage under</label>
          <input
            type="number"
            className="input"
            min={1}
            step={1000}
            placeholder="60000"
            disabled={off}
            value={cap ?? ""}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              onChange({ cpo_by_mileage_cap: Number.isFinite(n) && n > 0 ? n : null });
            }}
            style={{ width: 140, height: 34 }}
          />
        </div>
        <p className="text-xs mb-3" style={{ color: "var(--text-muted)", paddingLeft: 122 }}>
          Used vehicles under this mileage are treated as CPO for the Infosheet. Vehicles with no mileage are not.
        </p>

        <label className="text-sm block mb-2" style={{ color: "var(--text-secondary)" }}>Brands you represent</label>
        {options.length === 0 && <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>No makes in your inventory yet. Add one below.</p>}
        <div className="flex flex-wrap gap-2 mb-2">
          {options.map((o) => {
            const on = picked.has(o.key);
            return (
              <button
                key={o.key}
                type="button"
                disabled={off}
                onClick={() => toggleBrand(o.key)}
                aria-pressed={on}
                className="text-xs"
                style={{
                  padding: "4px 10px",
                  borderRadius: 4,
                  border: `1px solid ${on ? "var(--blue)" : "var(--border)"}`,
                  background: on ? "var(--blue)" : "var(--bg-subtle)",
                  color: on ? "#fff" : "var(--text-secondary)",
                  cursor: off ? "not-allowed" : "pointer",
                }}
              >
                {on ? "✓ " : ""}{o.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <input
            className="input text-sm"
            placeholder="Another make"
            disabled={off}
            value={other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOther(); } }}
            style={{ width: 160, height: 32 }}
          />
          <button type="button" className="btn btn-secondary text-xs" style={{ height: 30 }} disabled={off || !makeKey(other)} onClick={addOther}>
            Add
          </button>
        </div>
        {enabled && (!cap || brands.length === 0) && (
          <p className="text-xs mt-2" style={{ color: "#b26a00" }}>
            Set a mileage and pick at least one brand. Until then only certified vehicles get the CPO Infosheet.
          </p>
        )}
      </div>
    </div>
  );
}
