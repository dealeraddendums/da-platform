"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Remembers which sections a user has collapsed, per surface.
 *
 * Stores the COLLAPSED keys rather than the expanded ones, so the default is
 * expanded and a category added later shows up open instead of silently hidden
 * behind a stale list.
 *
 * localStorage is read in an effect, never during render, so server and client
 * markup agree on the first paint (both surfaces load their rows via fetch
 * anyway, so the state is in place before any section renders).
 */
export function useCollapsedSections(storageKey: string) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) setCollapsed(new Set(parsed.filter((k): k is string => typeof k === "string")));
      }
    } catch {
      // Private mode / blocked storage — collapsing still works for the session.
    }
  }, [storageKey]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { window.localStorage.setItem(storageKey, JSON.stringify(Array.from(next))); } catch { /* non-fatal */ }
      return next;
    });
  }, [storageKey]);

  const isCollapsed = useCallback((key: string) => collapsed.has(key), [collapsed]);

  return { isCollapsed, toggle };
}

/** Section disclosure caret — points right when closed, down when open. */
export function chevronStyle(open: boolean): React.CSSProperties {
  return {
    display: "inline-block",
    transition: "transform 120ms ease",
    transform: open ? "rotate(90deg)" : "rotate(0deg)",
    lineHeight: 1,
  };
}
