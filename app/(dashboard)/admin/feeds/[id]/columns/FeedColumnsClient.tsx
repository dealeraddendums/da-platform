"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { ColumnMapping } from "@/lib/feed-export";

// DA Field option for the dropdown's "Custom Rules" group.
type RuleField = { value: string; label: string };
// Mirrors lib/feed-export ruleFieldRef() + RULE_FIELD_VARIANTS — kept inline so
// this client component doesn't import feed-export's runtime (server-only db dep).
const VARIANT_LABEL: Record<string, string> = { price: "OPTION PRICE", list: "OPTION LIST" };
function buildRuleFields(rules: Array<{ id: string; name: string; is_default?: boolean }>): RuleField[] {
  return rules
    .filter((r) => !r.is_default)
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((r) =>
      (["price", "list"] as const).map((v) => ({ value: `rule:${r.id}:${v}`, label: `${r.name} — ${VARIANT_LABEL[v]}` })),
    );
}

// First three mappings are the fixed identity block — always present, locked.
const LOCKED: ColumnMapping[] = [
  { recipientColumn: "DEALER_ID", daField: "DEALER_ID" },
  { recipientColumn: "VIN_NUMBER", daField: "VIN_NUMBER" },
  { recipientColumn: "STOCK_NUMBER", daField: "STOCK_NUMBER" },
];

const isLockedRow = (m: ColumnMapping, i: number) =>
  i < LOCKED.length && m.recipientColumn === LOCKED[i].recipientColumn && m.daField === LOCKED[i].daField;

const inputStyle: React.CSSProperties = {
  width: "100%", height: 36, padding: "0 10px", fontSize: 13,
  border: "1px solid #e0e0e0", borderRadius: 4, background: "#fff", color: "#2a2b3c",
};

export default function FeedColumnsClient({
  feedId,
  initialMappings,
  rawFields,
  computedFields,
  customRuleFields: initialCustomRuleFields = [],
}: {
  feedId: string;
  initialMappings: ColumnMapping[];
  rawFields: string[];
  computedFields: string[];
  customRuleFields?: RuleField[];
}) {
  // Normalize: locked rows first (exactly once), then the rest.
  const rest = initialMappings.filter((m, i) => !isLockedRow(m, i));
  const [rows, setRows] = useState<ColumnMapping[]>([...LOCKED, ...rest.filter(r => !LOCKED.some(l => l.recipientColumn === r.recipientColumn && l.daField === r.daField))]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Custom Rules dropdown group. Seeded from the server prop for instant paint,
  // then refetched live on mount so renames/adds/deletes made in the rules
  // manager show immediately — even on a soft client-side navigation, where
  // Next's Router Cache would otherwise serve a stale server payload (this was
  // the "Tuttleclick exclusions" phantom: the old name of a since-renamed rule).
  const [customRuleFields, setCustomRuleFields] = useState<RuleField[]>(initialCustomRuleFields);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/feed-exclusion-rules", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { data?: Array<{ id: string; name: string; is_default?: boolean }> };
        if (!cancelled && Array.isArray(j.data)) setCustomRuleFields(buildRuleFields(j.data));
      } catch { /* keep the server-seeded list on network error */ }
    })();
    return () => { cancelled = true; };
  }, []);

  function update(i: number, key: keyof ColumnMapping, value: string) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  }

  async function save() {
    for (const r of rows) {
      if (!r.recipientColumn.trim() || !r.daField) {
        setMsg({ ok: false, text: "Every row needs a column name and a DA field." });
        return;
      }
    }
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/feeds/${feedId}/columns`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings: rows }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) setMsg({ ok: false, text: j.error ?? "Save failed" });
      else setMsg({ ok: true, text: "✓ Column mappings saved" });
    } catch {
      setMsg({ ok: false, text: "Network error — try again" });
    }
    setSaving(false);
  }

  return (
    <div className="card" style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: 24, maxWidth: 760 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 40px", gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "#78828c" }}>Recipient Column</div>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "#78828c" }}>DA Field</div>
        <div />
      </div>

      {rows.map((m, i) => {
        const locked = i < 3;
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 40px", gap: 10, marginBottom: 8, alignItems: "center" }}>
            <input
              style={{ ...inputStyle, background: locked ? "#f5f6f7" : "#fff" }}
              value={m.recipientColumn}
              disabled={locked}
              onChange={(e) => update(i, "recipientColumn", e.target.value)}
              placeholder="Their column name"
            />
            <select
              style={{ ...inputStyle, background: locked ? "#f5f6f7" : "#fff" }}
              value={m.daField}
              disabled={locked}
              onChange={(e) => update(i, "daField", e.target.value)}
            >
              <option value="">— select field —</option>
              <optgroup label="Vehicle Fields">
                {rawFields.map((f) => <option key={f} value={f}>{f}</option>)}
              </optgroup>
              <optgroup label="Computed Fields">
                {computedFields.map((f) => <option key={f} value={f}>{f}</option>)}
              </optgroup>
              {customRuleFields.length > 0 && (
                <optgroup label="Custom Rules">
                  {customRuleFields.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </optgroup>
              )}
              {/* A mapping saved against a since-deleted rule keeps its stored
                  value selectable so it isn't silently dropped on the next save. */}
              {m.daField.startsWith("rule:") && !customRuleFields.some((f) => f.value === m.daField) && (
                <option value={m.daField}>{m.daField} (deleted rule)</option>
              )}
            </select>
            {locked ? (
              <span title="Fixed column" style={{ color: "#c5cad0", textAlign: "center" }}>🔒</span>
            ) : (
              <button
                title="Remove row"
                onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                style={{ background: "none", border: "none", color: "#c62828", fontSize: 16, cursor: "pointer" }}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}

      <div style={{ marginTop: 12 }}>
        <button
          className="btn btn-secondary"
          onClick={() => setRows((prev) => [...prev, { recipientColumn: "", daField: "" }])}
        >
          + Add New
        </button>
      </div>

      {msg && (
        <p style={{ marginTop: 14, fontSize: 13, color: msg.ok ? "#2e7d32" : "#c62828" }}>{msg.text}</p>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20, borderTop: "1px solid #f0f0f0", paddingTop: 16 }}>
        <Link href="/admin/feeds" className="btn btn-secondary" style={{ textDecoration: "none" }}>Back to Feeds</Link>
        <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
