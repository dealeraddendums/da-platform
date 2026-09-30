"use client";

// Small shared UI bits for the Image Builder. Design system: navy #2a2b3c,
// orange #ffa500, blue #1976d2, flat, no shadows, radius ≤ 6px.

import type { CSSProperties, ReactNode } from "react";

export const NAVY = "#2a2b3c";
export const ORANGE = "#ffa500";
export const BLUE = "#1976d2";

export const btn = (variant: "primary" | "secondary" | "danger" = "secondary", disabled = false): CSSProperties => ({
  height: 32,
  padding: "0 12px",
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 500,
  fontFamily: "inherit",
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.5 : 1,
  whiteSpace: "nowrap",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  ...(variant === "primary"
    ? { background: BLUE, color: "#fff", border: `1px solid ${BLUE}` }
    : variant === "danger"
      ? { background: "#fff", color: "#c62828", border: "1px solid #e0e0e0" }
      : { background: "#fff", color: "#333", border: "1px solid #c0c0c0" }),
});

export const input: CSSProperties = {
  height: 30,
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid #c0c0c0",
  borderRadius: 4,
  padding: "0 8px",
  fontSize: 13,
  fontFamily: "inherit",
  color: "#333",
  background: "#fff",
};

export const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #e0e0e0",
  borderRadius: 6,
};

export function TypeChip({ children }: { children: ReactNode }) {
  return (
    <span style={{
      display: "inline-block", fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 4,
      background: "#e3f2fd", color: "#1565c0", whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

/** Persistent modal: closes only via its own buttons (no backdrop click, no Escape). */
export function Modal({ title, children, footer, width = 440 }: {
  title: string; children: ReactNode; footer: ReactNode; width?: number;
}) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div role="dialog" aria-modal="true" style={{ ...card, width, maxWidth: "100%", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #e0e0e0", fontSize: 16, fontWeight: 600, color: "#333" }}>{title}</div>
        <div style={{ padding: 18, overflowY: "auto", fontSize: 14, color: "#333" }}>{children}</div>
        <div style={{ padding: "12px 18px", borderTop: "1px solid #e0e0e0", display: "flex", justifyContent: "flex-end", gap: 8 }}>{footer}</div>
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: "#666", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      {children}
    </label>
  );
}
