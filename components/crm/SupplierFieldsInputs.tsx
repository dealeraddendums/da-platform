"use client";

// The supplier's own order questions (crm_feed_supplier_settings.extra_fields —
// Autosoft: account number, GO dealer, which transfer row). Used by Start feed
// order and the order slide-over. Fields with only_with appear once their
// condition holds; problems are shown inline (same rules the server applies,
// lib/crm/feeds/extra-fields.ts).

import { checkSupplierFields, fieldActive, type ExtraField } from "@/lib/crm/feeds/extra-fields";

export default function SupplierFieldsInputs({ defs, values, onChange, supplierName }: {
  defs: ExtraField[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void; supplierName?: string | null;
}) {
  if (!defs.length) return null;
  const check = checkSupplierFields(defs, values);
  const shown = { ...check.values, ...values };
  return (
    <div style={{ display: "grid", gap: 8, padding: "8px 10px", background: "var(--bg-subtle)", borderRadius: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>{supplierName ? `${supplierName} needs` : "The supplier needs"}</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
        {defs.filter((f) => fieldActive(f, shown)).map((f) => (
          <div key={f.key} style={f.type === "choice" && (f.options?.length ?? 0) > 2 ? { gridColumn: "1 / -1" } : undefined}>
            <label className="label">{f.label}{f.required ? "" : " (optional)"}</label>
            {f.type === "choice" ? (
              <select className="input" value={shown[f.key] ?? ""} onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}>
                {!f.default && <option value="">—</option>}
                {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input className="input" value={values[f.key] ?? ""} onChange={(e) => onChange({ ...values, [f.key]: e.target.value })} />
            )}
            {f.help && <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-muted)" }}>{f.help}</p>}
          </div>
        ))}
      </div>
      {check.errors.length > 0 && <p style={{ margin: 0, fontSize: 12, color: "var(--error)" }}>{check.errors.join(" ")}</p>}
      {check.missing.length > 0 && <p style={{ margin: 0, fontSize: 12, color: "#b26a00" }}>Still needed: {check.missing.join(", ")} — you can save now and fill it in later.</p>}
    </div>
  );
}
