"use client";

// Review a held trial signup in a modal over the /admin/trial-signups queue,
// with Back / Next / Close — instead of the old standalone page, which was a
// dead end: no way back to the queue and no way to reach the next held signup
// except the browser back button.
//
// ⚠️ HOUSE CONVENTION (Allan, 2026-09-02, commit 7aeec32): a modal closes ONLY
// via an explicit on-screen control. There is deliberately NO backdrop onClick
// and NO Escape handler here — an accidental outside-click was discarding
// in-progress work elsewhere, and re-adding either would reintroduce that.
// da-platform has no shared modal primitive, so this matches the hand-rolled
// shape used by EditVehicleModal et al.
//
// Back/Next walk the array the caller passed, which is the list the reviewer
// actually clicked from, so "next" means what they see on screen. No fetching:
// the page already loaded these rows, so paging is instant and a decision is
// reflected by updating the row in place.

import { useState } from "react";
import SelfServeReviewCard, { type ReviewRow } from "@/components/SelfServeReviewCard";

export default function SelfServeReviewModal({
  rows,
  startIndex,
  onClose,
  onDecided,
}: {
  rows: ReviewRow[];
  startIndex: number;
  onClose: () => void;
  /** Bubble a decision up so the underlying list + the topbar badge refresh. */
  onDecided?: (rowId: string, decision: "approved" | "denied") => void;
}) {
  const [index, setIndex] = useState(startIndex);
  // Local decision overlay, so a row decided in this modal reads correctly when
  // the reviewer pages back to it without a reload.
  const [decided, setDecided] = useState<Record<string, "approved" | "denied">>({});

  const base = rows[index];
  if (!base) return null;
  const row: ReviewRow = decided[base.id]
    ? { ...base, decision: decided[base.id], review_token: null }
    : base;

  const atFirst = index <= 0;
  const atLast = index >= rows.length - 1;

  const navBtn = (disabled: boolean): React.CSSProperties => ({
    height: 34, padding: "0 16px",
    background: "#fff",
    border: "1px solid var(--border)", borderRadius: 4,
    fontSize: 13, fontWeight: 500, fontFamily: "inherit",
    color: disabled ? "var(--text-muted)" : "var(--text-primary)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  });

  return (
    <>
      {/* Backdrop — intentionally inert (no onClick). */}
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000 }} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Trial signup review — ${row.dealership ?? row.email}`}
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          background: "#fff", borderRadius: 6, zIndex: 1001,
          width: "min(680px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        }}
      >
        {/* Header — title + the X, which is one of the two explicit closers. */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)", margin: 0 }}>
              {row.decision === "pending_review" ? "Trial signup — held for review" : `Trial signup — ${row.decision}`}
            </p>
            <h2 style={{ margin: "3px 0 0", fontSize: 17, fontWeight: 600, color: "var(--text-primary)", overflowWrap: "anywhere" }}>
              {row.dealership ?? row.email}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close"
            style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "var(--text-muted)", lineHeight: 1, flexShrink: 0 }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflowY: "auto", flex: 1, minHeight: 0 }}>
          <SelfServeReviewCard
            // Remount on row change so the card's busy/done/error state can't
            // leak from the previous signup onto this one.
            key={row.id}
            row={row}
            onDecided={(decision) => {
              setDecided(d => ({ ...d, [base.id]: decision }));
              onDecided?.(base.id, decision);
            }}
          />
        </div>

        {/* Footer — Back / Next on the left, Close on the right. */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", background: "var(--bg-subtle)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button type="button" disabled={atFirst} onClick={() => setIndex(i => Math.max(0, i - 1))} style={navBtn(atFirst)}>
              ← Back
            </button>
            <button type="button" disabled={atLast} onClick={() => setIndex(i => Math.min(rows.length - 1, i + 1))} style={navBtn(atLast)}>
              Next →
            </button>
            <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 4 }}>
              {index + 1} of {rows.length}
            </span>
          </div>
          <button type="button" onClick={onClose} style={{ ...navBtn(false), fontWeight: 600 }}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}
