"use client";

import { useState, useEffect, useCallback } from "react";
import TagPicker, { type Tag } from "@/components/TagPicker";

/**
 * Tags card for the dealer + group profile pages. Loads the entity's tags via
 * GET /api/{dealers|groups}/[id]/tags and persists changes (optimistically)
 * via the matching PUT. Editable for super_admin (any) and group_admin
 * (in-group dealer / own group); read-only chips otherwise.
 */
export default function EntityTagsCard({
  kind,
  id,
  editable,
}: {
  kind: "dealers" | "groups" | "users";
  id: string;
  editable: boolean;
}) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/${kind}/${id}/tags`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j: { data: Tag[] }) => { if (active) { setTags(j.data ?? []); setLoaded(true); } })
      .catch(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [kind, id]);

  const save = useCallback(
    async (next: Tag[]) => {
      const prev = tags;
      setTags(next); // optimistic
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(`/api/${kind}/${id}/tags`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tag_ids: next.map((t) => t.id) }),
        });
        if (!res.ok) { setTags(prev); setError("Failed to save tags."); }
      } catch {
        setTags(prev);
        setError("Failed to save tags.");
      } finally {
        setSaving(false);
      }
    },
    [kind, id, tags]
  );

  return (
    <div className="card p-6 mb-4">
      <p className="text-xs font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
        Tags{saving && <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}> · saving…</span>}
      </p>
      {!loaded ? (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : (
        <TagPicker value={tags} editable={editable} onChange={(next) => void save(next)} />
      )}
      {error && <p className="text-xs mt-2" style={{ color: "var(--error)" }}>{error}</p>}
    </div>
  );
}
