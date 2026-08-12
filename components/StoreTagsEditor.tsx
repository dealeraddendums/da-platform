"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Tag } from "@/components/TagPicker";
import DealerCheckList from "@/components/DealerCheckList";

/**
 * Store scope editor for a group_user (Regional Manager).
 *
 * Primary control (2026-08-12, migration 142): a searchable CHECKBOX LIST of
 * the group's member dealers — checking stores defines the user's scope
 * directly, no tag pre-building required. Under the hood the selection is a
 * hidden per-user system tag (setUserDirectScope), so the group ∩ user_tags
 * engine is unchanged.
 *
 * Secondary control: the original named store-tag chips + dropdown for
 * operators who keep reusable groupings (e.g. a shared "Chicago Region" tag).
 * Effective scope = direct stores ∪ named-tag stores; the live "Sees N
 * dealers" preview resolves the union through the real engine logic
 * (GET /api/users/[id]/store-scope). Saves via PUT /api/users/[id]/tags on
 * every change (optimistic, reverts on failure).
 */
export default function StoreTagsEditor({ userId }: { userId: string }) {
  const [groupDealers, setGroupDealers] = useState<{ id: string; name: string }[]>([]);
  const [directIds, setDirectIds] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
  const [available, setAvailable] = useState<Tag[]>([]);
  const [preview, setPreview] = useState<{ count: number; dealers: { id: string; name: string }[] }>({ count: 0, dealers: [] });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [addChoice, setAddChoice] = useState("");
  const [showTags, setShowTags] = useState(false);
  const reqSeq = useRef(0);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        type ScopeResp = {
          available?: Tag[];
          group_dealers?: { id: string; name: string }[];
          direct_dealer_ids?: string[];
          resolved?: { count: number; dealers: { id: string; name: string }[] };
        };
        const [cur, scope] = await Promise.all([
          fetch(`/api/users/${userId}/tags`).then((r) => (r.ok ? r.json() : { data: [] })) as Promise<{ data?: Tag[] }>,
          fetch(`/api/users/${userId}/store-scope`).then((r) => (r.ok ? r.json() : {})) as Promise<ScopeResp>,
        ]);
        if (!active) return;
        setSelectedTags(cur.data ?? []);
        setAvailable(scope.available ?? []);
        setGroupDealers(scope.group_dealers ?? []);
        setDirectIds(new Set<string>(scope.direct_dealer_ids ?? []));
        setPreview(scope.resolved ?? { count: 0, dealers: [] });
        if ((cur.data ?? []).length > 0) setShowTags(true); // named tags in use → keep visible
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => { active = false; };
  }, [userId]);

  const refreshPreview = useCallback(async (tagIds: string[], dealerIds: string[]) => {
    const seq = ++reqSeq.current;
    try {
      const r = await fetch(`/api/users/${userId}/store-scope?tag_ids=${tagIds.join(",")}&dealer_ids=${dealerIds.join(",")}`);
      if (r.ok && seq === reqSeq.current) {
        const j = await r.json();
        setPreview(j.resolved ?? { count: 0, dealers: [] });
        if (Array.isArray(j.available)) setAvailable(j.available);
      }
    } catch { /* leave last preview */ }
  }, [userId]);

  const persist = useCallback(async (nextTags: Tag[], nextDirect: Set<string>) => {
    const prevTags = selectedTags;
    const prevDirect = directIds;
    setSelectedTags(nextTags);      // optimistic
    setDirectIds(nextDirect);
    setSaving(true); setErr(null);
    const tagIds = nextTags.map((t) => t.id);
    const dealerIds = Array.from(nextDirect);
    void refreshPreview(tagIds, dealerIds);
    try {
      const res = await fetch(`/api/users/${userId}/tags`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag_ids: tagIds, dealer_ids: dealerIds }),
      });
      if (!res.ok) {
        setSelectedTags(prevTags); setDirectIds(prevDirect); setErr("Failed to save scope.");
        void refreshPreview(prevTags.map((t) => t.id), Array.from(prevDirect));
      }
    } catch {
      setSelectedTags(prevTags); setDirectIds(prevDirect); setErr("Failed to save scope.");
      void refreshPreview(prevTags.map((t) => t.id), Array.from(prevDirect));
    } finally { setSaving(false); }
  }, [userId, selectedTags, directIds, refreshPreview]);

  const addTag = (id: string) => {
    const t = available.find((a) => a.id === id);
    if (t && !selectedTags.some((s) => s.id === id)) void persist([...selectedTags, t], directIds);
    setAddChoice("");
  };
  const removeTag = (id: string) => void persist(selectedTags.filter((s) => s.id !== id), directIds);

  const addable = available.filter((a) => !selectedTags.some((s) => s.id === a.id));

  if (!loaded) return <p style={{ fontSize: 12, color: "#78828c" }}>Loading scope…</p>;

  return (
    <div>
      {/* Direct dealer selection — the primary scoping path. */}
      <div style={{ fontSize: 12, fontWeight: 600, color: "#37404a", marginBottom: 6 }}>
        Stores this user can see
      </div>
      {groupDealers.length === 0 ? (
        <p style={{ fontSize: 12, color: "#78828c" }}>This group has no member dealers yet.</p>
      ) : (
        <div style={{ border: "1px solid #e0e0e0", borderRadius: 4, background: "#fff", padding: 10, marginBottom: 10 }}>
          <DealerCheckList
            dealers={groupDealers}
            selected={directIds}
            onChange={(next) => void persist(selectedTags, next)}
          />
        </div>
      )}

      {/* Optional named tags — reusable groupings shared across users. */}
      {!showTags && addable.length > 0 && selectedTags.length === 0 ? (
        <button type="button" onClick={() => setShowTags(true)}
          style={{ background: "none", border: "none", color: "#1976d2", cursor: "pointer", fontSize: 12, padding: 0, marginBottom: 10 }}>
          + Also scope by a store tag (optional)
        </button>
      ) : (showTags || selectedTags.length > 0) && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#37404a", marginBottom: 6 }}>
            Store tags (optional — adds every store carrying the tag)
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, minHeight: selectedTags.length ? 30 : 0, marginBottom: selectedTags.length ? 8 : 0 }}>
            {selectedTags.map((t) => (
              <span key={t.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#e3f2fd", color: "#1565c0", borderRadius: 12, padding: "3px 10px", fontSize: 12 }}>
                {t.name}
                <button type="button" onClick={() => removeTag(t.id)} disabled={saving}
                  style={{ background: "none", border: "none", color: "#1565c0", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
              </span>
            ))}
          </div>
          <select value={addChoice} onChange={(e) => addTag(e.target.value)} disabled={saving || addable.length === 0}
            style={{ width: "100%", height: 34, padding: "0 8px", fontSize: 13, border: "1px solid #e0e0e0", borderRadius: 4, background: "#fff" }}>
            <option value="">
              {available.length === 0 ? "— no tags exist on this group's dealers yet —"
                : addable.length === 0 ? "— all group tags assigned —"
                : "+ Add a store tag…"}
            </option>
            {addable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}

      {/* Live visibility preview (direct stores ∪ tagged stores). */}
      <div style={{ background: "#f7f8fa", border: "1px solid #eceff1", borderRadius: 4, padding: "8px 10px" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: preview.count === 0 ? "#c62828" : "#37404a" }}>
          {saving ? "Saving…" : `Sees ${preview.count} dealer${preview.count === 1 ? "" : "s"}:`}
        </div>
        {preview.count === 0
          ? <div style={{ fontSize: 12, color: "#c62828", marginTop: 2 }}>⚠ This user will see no dealers.</div>
          : <div style={{ fontSize: 12, color: "#55595c", marginTop: 4, lineHeight: 1.5 }}>{preview.dealers.map((d) => d.name).join(" · ")}</div>}
      </div>

      {err && <p style={{ fontSize: 12, color: "#c62828", marginTop: 6 }}>{err}</p>}
    </div>
  );
}
