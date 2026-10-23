"use client";

// DA-CRM slide-over: a panel from the right on top of the current screen
// (cockpit rule — tickets, tasks, threads and compose open here, never as a
// page navigation). Esc or the backdrop closes it.

import { useEffect } from "react";

export default function SlideOver({
  open, title, onClose, width = 640, children,
}: {
  open: boolean;
  title: React.ReactNode;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(27,31,42,0.35)" }} />
      <aside role="dialog" aria-modal="true"
        style={{ position: "relative", width: `min(${width}px, 100vw)`, height: "100%", background: "#fff", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-surface)", color: "var(--text-primary)" }}>
          <strong style={{ fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</strong>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 22, lineHeight: 1, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>{children}</div>
      </aside>
    </div>
  );
}
