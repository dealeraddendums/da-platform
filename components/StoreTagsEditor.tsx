"use client";

import { useState, useEffect, useCallback } from "react";
import type { Tag } from "@/components/TagPicker";

/**
 * Store Tags editor for a group_user (Regional Manager). Shows the user's
 * current scope tags as chips (✕ to remove), an add-dropdown of the GROUP's
 * existing tags (tags in use on that group's dealers — creating new tags stays
 * on the dealer/group profiles), and a live "Sees N dealers" preview resolved
 * through the real group∩tag logic (GET /api/users/[id]/store-scope). Saves
 * user_tags via PUT /api/users/[id]/tags on every change (optimistic).
 */
export default function StoreTagsEditor({ userId }: { userId: string }) {
  const [selected, setSelected] = useState<Tag[]>([]);
  const [available, setAvailable] = useState<Tag[]>([]);
  const [preview, setPreview] = useState<{ count: number; dealers: { id: string; name: string }[] }>({ count: 0, dealers: [] });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [addChoice, setAddChoice] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [cur, scope] = await Promise.all([
          fetch(`/api/users/${userId}/tags`).then((r) => (r.ok ? r.json() : { data: [] })),
          fetch(`/api/users/${userId}/store-scope`).then((r) => (r.ok ? r.json() : { available: [], resolved: { count: 0, dealers: [] } })),
        ]);
        if (!active) return;
        setSelected(cur.data ?? []);
        setAvailable(scope.available ?? []);
        setPreview(scope.resolved ?? { count: 0, dealers: [] });
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => { active = false; };
  }, [userId]);

  const refreshPreview = useCallback(async (ids: string[]) => {
    try {
      const r = await fetch(`/api/users/${userId}/store-scope?tag_ids=${ids.join(",")}`);
      if (r.ok) {
        const j = await r.json();
        setPreview(j.resolved ?? { count: 0, dealers: [] });
        if (Array.isArray(j.available)) setAvailable(j.available);
      }
    } catch { /* leave last preview */ }
  }, [userId]);

  const persist = useCallback(async (next: Tag[]) => {
    const prev = selected;
    setSelected(next);            // optimistic
    setSaving(true); setErr(null);
    void refreshPreview(next.map((t) => t.id));
    try {
      const res = await fetch(`/api/users/${userId}/tags`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag_ids: next.map((t) => t.id) }),
      });
      if (!res.ok) { setSelected(prev); setErr("Failed to save tags."); void refreshPreview(prev.map((t) => t.id)); }
    } catch {
      setSelected(prev); setErr("Failed to save tags."); void refreshPreview(prev.map((t) => t.id));
    } finally { setSaving(false); }
  }, [userId, selected, refreshPreview]);

  const addTag = (id: string) => {
    const t = available.find((a) => a.id === id);
    if (t && !selected.some((s) => s.id === id)) void persist([...selected, t]);
    setAddChoice("");
  };
  const removeTag = (id: string) => void persist(selected.filter((s) => s.id !== id));

  const addable = available.filter((a) => !selected.some((s) => s.id === a.id));

  if (!loaded) return <p style={{ fontSize: 12, color: "#78828c" }}>Loading tags…</p>;

  return (
    <div>
      {/* Current tags */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, minHeight: 30, marginBottom: 8 }}>
        {selected.length === 0
          ? <span style={{ fontSize: 12, color: "#78828c" }}>No tags assigned yet.</span>
          : selected.map((t) => (
            <span key={t.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#e3f2fd", color: "#1565c0", borderRadius: 12, padding: "3px 10px", fontSize: 12 }}>
              {t.name}
              <button type="button" onClick={() => removeTag(t.id)} disabled={saving}
                style={{ background: "none", border: "none", color: "#1565c0", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
            </span>
          ))}
      </div>

      {/* Add from the group's tags */}
      <select value={addChoice} onChange={(e) => addTag(e.target.value)} disabled={saving || addable.length === 0}
        style={{ width: "100%", height: 34, padding: "0 8px", fontSize: 13, border: "1px solid #e0e0e0", borderRadius: 4, background: "#fff", marginBottom: 10 }}>
        <option value="">
          {available.length === 0 ? "— no tags exist on this group's dealers yet —"
            : addable.length === 0 ? "— all group tags assigned —"
            : "+ Add a store tag…"}
        </option>
        {addable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>

      {/* Live visibility preview */}
      <div style={{ background: "#f7f8fa", border: "1px solid #eceff1", borderRadius: 4, padding: "8px 10px" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: preview.count === 0 ? "#c62828" : "#37404a" }}>
          {saving ? "Resolving…" : `Sees ${preview.count} dealer${preview.count === 1 ? "" : "s"}:`}
        </div>
        {preview.count === 0
          ? <div style={{ fontSize: 12, color: "#c62828", marginTop: 2 }}>⚠ This user will see no dealers.</div>
          : <div style={{ fontSize: 12, color: "#55595c", marginTop: 4, lineHeight: 1.5 }}>{preview.dealers.map((d) => d.name).join(" · ")}</div>}
      </div>

      {err && <p style={{ fontSize: 12, color: "#c62828", marginTop: 6 }}>{err}</p>}
    </div>
  );
}
