"use client";

import { useState, useEffect, useRef } from "react";

export type Tag = { id: string; name: string; color: string | null };

// Established badge palette — no new colors (see Design System). A tag's stored
// `color` holds one of these keys; unknown/null falls back to a stable hash so
// chips are always on-brand and consistent.
const PALETTE: Record<string, { bg: string; fg: string; border: string }> = {
  blue:   { bg: "#e3f2fd", fg: "#1565c0", border: "#bbdefb" },
  green:  { bg: "#e8f5e9", fg: "#2e7d32", border: "#c8e6c9" },
  amber:  { bg: "#fff8e1", fg: "#e65100", border: "#ffe082" },
  purple: { bg: "#f3e5f5", fg: "#6a1b9a", border: "#e1bee7" },
  pink:   { bg: "#fce4ec", fg: "#c2185b", border: "#f8bbd0" },
  teal:   { bg: "#e0f7fa", fg: "#00838f", border: "#b2ebf2" },
};
const PALETTE_KEYS = Object.keys(PALETTE);

export function tagColors(tag: Tag): { bg: string; fg: string; border: string } {
  if (tag.color && PALETTE[tag.color]) return PALETTE[tag.color];
  // Stable hash of the name → palette key.
  let h = 0;
  const s = tag.name.toLowerCase();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return PALETTE[PALETTE_KEYS[Math.abs(h) % PALETTE_KEYS.length]];
}

/** Read-only chip (used by the list rows + the picker's selected chips). */
export function TagChip({ tag, onRemove }: { tag: Tag; onRemove?: () => void }) {
  const c = tagColors(tag);
  return (
    <span
      className="text-xs font-medium px-2 py-0.5 rounded-full"
      style={{ background: c.bg, color: c.fg, border: `1px solid ${c.border}`, display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}
    >
      {tag.name}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove tag"
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: c.fg, fontSize: 13, lineHeight: 1, fontWeight: 700 }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * Shared tag editor: selected chips + autocomplete from GET /api/tags?q= with a
 * "Create '<x>'" action (POST /api/tags, which dedupes by lower(name)). Calls
 * onChange with the new tag list; the parent persists via the [id]/tags PUT.
 * When not editable, renders read-only chips only.
 */
export default function TagPicker({
  value,
  editable,
  onChange,
}: {
  value: Tag[];
  editable: boolean;
  onChange: (tags: Tag[]) => void;
}) {
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<Tag[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced autocomplete fetch.
  useEffect(() => {
    if (!editable) return;
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/tags?q=${encodeURIComponent(input.trim())}`);
        if (res.ok) {
          const json = (await res.json()) as { data: Tag[] };
          setSuggestions(json.data ?? []);
        }
      } catch { /* ignore */ }
    }, 200);
    return () => clearTimeout(handle);
  }, [input, editable]);

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!editable) {
    return value.length ? (
      <div className="flex flex-wrap gap-2">
        {value.map((t) => <TagChip key={t.id} tag={t} />)}
      </div>
    ) : (
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>No tags.</p>
    );
  }

  const selectedIds = new Set(value.map((t) => t.id));
  const typed = input.trim();
  const filtered = suggestions.filter((s) => !selectedIds.has(s.id));
  const exactExists = suggestions.some((s) => s.name.toLowerCase() === typed.toLowerCase());

  function add(tag: Tag) {
    if (!selectedIds.has(tag.id)) onChange([...value, tag]);
    setInput("");
    setOpen(false);
  }
  function remove(id: string) {
    onChange(value.filter((t) => t.id !== id));
  }
  async function create() {
    if (!typed || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: typed }),
      });
      if (res.ok) {
        const json = (await res.json()) as { data: Tag };
        add(json.data);
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <div className="flex flex-wrap items-center gap-2">
        {value.map((t) => <TagChip key={t.id} tag={t} onRemove={() => remove(t.id)} />)}
        <input
          className="input"
          style={{ height: 30, fontSize: 13, width: 180, flex: "0 0 auto" }}
          placeholder="Add a tag…"
          value={input}
          onChange={(e) => { setInput(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (filtered.length && filtered[0].name.toLowerCase() === typed.toLowerCase()) add(filtered[0]);
              else if (typed && !exactExists) void create();
              else if (filtered.length) add(filtered[0]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>

      {open && (typed.length > 0 || filtered.length > 0) && (
        <div
          style={{
            position: "absolute", top: "100%", left: 0, zIndex: 50, marginTop: 4,
            background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6,
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)", minWidth: 220, maxHeight: 260,
            overflowY: "auto", padding: "4px 0",
          }}
        >
          {filtered.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => add(s)}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "7px 12px", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f5f6f7")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
            >
              <TagChip tag={s} />
            </button>
          ))}
          {typed && !exactExists && (
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating}
              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", padding: "7px 12px", background: "none", border: "none", borderTop: filtered.length ? "1px solid #f0f0f0" : "none", cursor: creating ? "wait" : "pointer", fontSize: 13, color: "var(--blue)", fontWeight: 500 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f5f6f7")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
            >
              {creating ? "Creating…" : <>+ Create &ldquo;{typed}&rdquo;</>}
            </button>
          )}
          {!filtered.length && (!typed || exactExists) && (
            <p className="text-xs" style={{ color: "var(--text-muted)", padding: "7px 12px" }}>
              {exactExists ? "Already added." : "Type to search or create a tag."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
