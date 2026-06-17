"use client";

import Link from "next/link";

// Shared SuperAdmin row actions for the Dealers + Groups lists. Same three
// controls, same order, both lists (approved mockup):
//   Edit (pencil)  — primary button → the entity's profile page. Always on.
//   Ghost (👻)     — primary button, co-equal with Edit → ghost handler. Always on.
//   │ divider
//   Impersonate    — MUTED icon-only (eye) → impersonate handler. Disabled (greyed
//                    + tooltip) when there's no user to become. NO auto-ghost.

const BLUE = "#1976d2";

const Pencil = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
  </svg>
);
const Eye = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" />
  </svg>
);

export interface EntityRowActionsProps {
  /** Profile page for this entity — /dealers/{id} or /groups/{id}. */
  editHref: string;
  /** Existing ghost handler (handleEnterGhost / handleGroupGhost). */
  onGhost: () => void;
  /** Existing impersonate handler (handleImpersonate / handleGroupImpersonate). */
  onImpersonate: () => void;
  /** Is there a user to become? dealer.has_users / group.has_group_admin. */
  canImpersonate: boolean;
  /** Which action is mid-flight (shows a spinner + disables), if any. */
  busy?: "ghost" | "impersonate" | null;
}

export default function EntityRowActions({ editHref, onGhost, onImpersonate, canImpersonate, busy = null }: EntityRowActionsProps) {
  const busyAny = busy !== null;
  const primary: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
    height: 30, padding: "0 12px", borderRadius: 6, border: "none",
    background: BLUE, color: "#fff", fontSize: 13, fontWeight: 600,
    fontFamily: "'Roboto', sans-serif", cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap",
  };
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <Link href={editHref} style={primary} title="Open profile" aria-label="Edit">
        <Pencil /> Edit
      </Link>
      <button
        type="button"
        onClick={onGhost}
        disabled={busyAny}
        title="Enter Ghost Mode (operate this account; no user needed)"
        aria-label="Ghost"
        style={{ ...primary, opacity: busyAny ? 0.6 : 1, cursor: busyAny ? "wait" : "pointer" }}
      >
        <span style={{ fontSize: 14, lineHeight: 1 }} aria-hidden="true">👻</span>
        {busy === "ghost" ? "…" : "Ghost"}
      </button>

      <span aria-hidden="true" style={{ width: 1, height: 20, background: "var(--border, #e0e0e0)", margin: "0 2px", flexShrink: 0 }} />

      <button
        type="button"
        onClick={onImpersonate}
        disabled={!canImpersonate || busyAny}
        title={canImpersonate ? "Impersonate — log in as this user" : "No user to impersonate — use Ghost"}
        aria-label={canImpersonate ? "Impersonate — log in as this user" : "No user to impersonate — use Ghost"}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 30, height: 30, borderRadius: 6, padding: 0,
          border: "1px solid var(--border, #e0e0e0)", background: "#fff",
          color: canImpersonate ? "var(--text-muted, #78828c)" : "#c8ccd0",
          cursor: !canImpersonate || busyAny ? "not-allowed" : "pointer",
        }}
      >
        {busy === "impersonate" ? "…" : <Eye />}
      </button>
    </div>
  );
}
