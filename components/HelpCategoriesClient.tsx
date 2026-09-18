"use client";

import { useState } from "react";

export type HelpCategory = {
  id: string;
  name: string;
  sort_order: number;
  published: boolean;
};

/**
 * Category manager for the Help CMS: create, rename, reorder, publish.
 *
 * Sort order drives the browse order dealers see, so it is edited directly
 * rather than inferred. Unpublishing hides the whole section (and everything in
 * it) from dealers without unpublishing each article — that is the point of
 * having categories be rows.
 */
export default function HelpCategoriesClient({
  categories,
  onChanged,
  articleCounts,
}: {
  categories: HelpCategory[];
  onChanged: () => Promise<void> | void;
  articleCounts: Record<string, number>;
}) {
  const [draft, setDraft] = useState<Record<string, Partial<HelpCategory>>>({});
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  function edited(c: HelpCategory): HelpCategory {
    return { ...c, ...(draft[c.id] ?? {}) };
  }
  function dirty(c: HelpCategory): boolean {
    const d = draft[c.id];
    if (!d) return false;
    return (["name", "sort_order", "published"] as const).some((k) => d[k] !== undefined && d[k] !== c[k]);
  }

  async function save(c: HelpCategory) {
    const next = edited(c);
    if (!next.name.trim()) { setMsg("Name can't be empty"); return; }
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/help/categories/${c.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: next.name, sort_order: next.sort_order, published: next.published }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg(j.error ?? "Save failed"); return; }
    setDraft((d) => { const n = { ...d }; delete n[c.id]; return n; });
    setMsg("✓ Saved");
    await onChanged();
  }

  async function remove(c: HelpCategory) {
    if (!confirm(`Delete the "${c.name}" category?`)) return;
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/help/categories/${c.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) { setMsg((await res.json().catch(() => ({}))).error ?? "Delete failed"); return; }
    setMsg("✓ Deleted");
    await onChanged();
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setMsg(null);
    // Land new categories at the end of the browse order by default.
    const sort = (categories.reduce((m, c) => Math.max(m, c.sort_order), 0) || 0) + 10;
    const res = await fetch("/api/help/categories", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, sort_order: sort, published: true }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg(j.error ?? "Create failed"); return; }
    setNewName(""); setMsg("✓ Added");
    await onChanged();
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: "#2a2b3c", margin: "0 0 6px" }}>Help Center — Categories</h1>
      <p style={{ fontSize: 13, color: "#78828c", margin: "0 0 16px" }}>
        Dealers browse the Help Guides tab by these sections, in this order. Unpublish a category to hide
        the whole section while you write it.
      </p>

      {msg && (
        <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 6, fontSize: 13, background: msg.startsWith("✓") ? "#e8f5e9" : "#ffebee", color: msg.startsWith("✓") ? "#2e7d32" : "#c62828" }}>{msg}</div>
      )}

      <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, overflow: "hidden", background: "#fff" }}>
        <div style={{ display: "grid", gridTemplateColumns: "70px 1fr 110px 120px 150px", gap: 10, padding: "9px 14px", background: "#fafafa", borderBottom: "1px solid #e0e0e0", fontSize: 11, fontWeight: 700, color: "#78828c", textTransform: "uppercase", letterSpacing: ".04em" }}>
          <div>Order</div><div>Name</div><div>Articles</div><div>Published</div><div />
        </div>
        {categories.map((c) => {
          const e = edited(c);
          return (
            <div key={c.id} style={{ display: "grid", gridTemplateColumns: "70px 1fr 110px 120px 150px", gap: 10, padding: "8px 14px", borderBottom: "1px solid #f0f0f0", alignItems: "center" }}>
              <input type="number" value={e.sort_order}
                onChange={(ev) => setDraft((d) => ({ ...d, [c.id]: { ...d[c.id], sort_order: Number(ev.target.value) } }))}
                style={{ ...inp, padding: "6px 8px" }} />
              <input value={e.name}
                onChange={(ev) => setDraft((d) => ({ ...d, [c.id]: { ...d[c.id], name: ev.target.value } }))}
                style={{ ...inp, padding: "6px 8px" }} />
              <div style={{ fontSize: 13, color: "#78828c" }}>{articleCounts[c.id] ?? 0}</div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#33363d" }}>
                <input type="checkbox" checked={e.published}
                  onChange={(ev) => setDraft((d) => ({ ...d, [c.id]: { ...d[c.id], published: ev.target.checked } }))} />
                {e.published ? "Visible" : "Hidden"}
              </label>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => void save(c)} disabled={busy || !dirty(c)}
                  style={{ padding: "6px 12px", borderRadius: 4, border: "none", background: dirty(c) ? "#1976d2" : "#e0e0e0", color: dirty(c) ? "#fff" : "#9aa0a6", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: dirty(c) && !busy ? "pointer" : "default" }}>
                  Save
                </button>
                <button onClick={() => void remove(c)} disabled={busy}
                  style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid #ffcdd2", background: "#fff", color: "#c62828", fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}
        {categories.length === 0 && (
          <div style={{ padding: 16, fontSize: 13, color: "#78828c" }}>No categories yet — add the first one below.</div>
        )}
        <div style={{ display: "flex", gap: 10, padding: "12px 14px", alignItems: "center" }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
            placeholder="New category name…" style={{ ...inp, maxWidth: 320, padding: "7px 10px" }} />
          <button onClick={() => void create()} disabled={busy || !newName.trim()}
            style={{ padding: "8px 14px", borderRadius: 4, border: "none", background: newName.trim() ? "#1976d2" : "#e0e0e0", color: newName.trim() ? "#fff" : "#9aa0a6", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: newName.trim() ? "pointer" : "default" }}>
            + Add category
          </button>
        </div>
      </div>
    </div>
  );
}

const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #e0e0e0", borderRadius: 6, fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" };
