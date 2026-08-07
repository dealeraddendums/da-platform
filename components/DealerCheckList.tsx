"use client";

import { useMemo, useState } from "react";
import { decodeHtmlEntities } from "@/lib/format";

// Searchable member-dealer checkbox list, shared by the group template
// "Assign to Dealers" modal and the corporate product Assign modal. Built for
// big groups (Dealer General: 182 dealers — request from their group admin).
//
// Semantics:
//   • Search filters as you type (name + dealer_id/inventory id, case-insens).
//   • Selections PERSIST across filtering — the parent owns the Set; this
//     component only adds/removes ids.
//   • With a filter active, All/None act on the VISIBLE rows only and are
//     labeled "All shown"/"Clear shown" — so "search 'Arrigo' → All shown"
//     selects the Arrigo stores in one motion without touching the rest.
//   • "Selected (N)" toggles a review of just the checked set.

export type CheckableDealer = {
  id: string;
  name: string;
  dealer_id?: string | null;
  inventory_dealer_id?: string | null;
};

export default function DealerCheckList({ dealers, selected, onChange, accent = "#1976d2" }: {
  dealers: CheckableDealer[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Highlight color for checked rows / links (template modal uses blue, product modal purple). */
  accent?: string;
}) {
  const [q, setQ] = useState("");
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);

  const visible = useMemo(() => {
    let list = dealers;
    const t = q.trim().toLowerCase();
    if (t) {
      list = list.filter((d) =>
        decodeHtmlEntities(d.name ?? "").toLowerCase().includes(t)
        || (d.dealer_id ?? "").toLowerCase().includes(t)
        || (d.inventory_dealer_id ?? "").toLowerCase().includes(t));
    }
    if (showSelectedOnly) list = list.filter((d) => selected.has(d.id));
    return list;
  }, [dealers, q, showSelectedOnly, selected]);

  const filtered = q.trim() !== "" || showSelectedOnly;
  const allShown = () => {
    const next = new Set(selected);
    for (const d of visible) next.add(d.id);
    onChange(next);
  };
  const clearShown = () => {
    const next = new Set(selected);
    for (const d of visible) next.delete(d.id);
    onChange(next);
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };

  const linkBtn: React.CSSProperties = { background: "none", border: "none", fontSize: 11, cursor: "pointer", padding: 0 };

  return (
    <div>
      {dealers.length > 6 && (
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search dealers by name or ID…"
          style={{ width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, marginBottom: 8, boxSizing: "border-box", outline: "none" }}
        />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: "#78828c", fontWeight: 600 }}>
          {selected.size} of {dealers.length} selected{filtered ? ` · ${visible.length} shown` : ""}
        </span>
        <div style={{ display: "flex", gap: 10 }}>
          {selected.size > 0 && (
            <button type="button" style={{ ...linkBtn, color: showSelectedOnly ? accent : "#78828c", fontWeight: showSelectedOnly ? 700 : 400 }}
              onClick={() => setShowSelectedOnly((v) => !v)}>
              Selected ({selected.size})
            </button>
          )}
          <button type="button" style={{ ...linkBtn, color: accent }} onClick={allShown}>
            {filtered ? "All shown" : "All"}
          </button>
          <button type="button" style={{ ...linkBtn, color: "#78828c" }} onClick={clearShown}>
            {filtered ? "Clear shown" : "None"}
          </button>
        </div>
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto" }}>
        {visible.length === 0 ? (
          <p style={{ fontSize: 12, color: "#78828c", padding: "8px 2px" }}>
            {dealers.length === 0 ? "No dealers in this group." : showSelectedOnly ? "Nothing selected yet." : `No dealers match “${q.trim()}”.`}
          </p>
        ) : visible.map((d) => (
          <label key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 4, cursor: "pointer", background: selected.has(d.id) ? "#e3f2fd" : "transparent" }}>
            <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
            <span style={{ fontSize: 13, color: "var(--text-primary, #333)" }}>{decodeHtmlEntities(d.name)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
