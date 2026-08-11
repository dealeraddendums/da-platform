"use client";

// ⓘ rules tooltip for product rows (2026-08-11). Hover + focus + tap show a
// read-only popover summarizing the row's vehicle rules via the shared
// lib/rule-summary.ts (same semantics as the matching engine — same-named
// products that differ only by rules become distinguishable at a glance).
//
// The popover renders in a PORTAL with viewport-fixed positioning: the product
// tables live inside rounded cards with overflow:hidden + overflowX:auto
// wrappers, which clipped an in-flow popover on the last rows (Allan's
// screenshots). Fixed+portal is immune to ancestor overflow; it flips left
// near the right edge and above the icon near the bottom edge, and dismisses
// on scroll so it can't drift from its anchor. Keyboard accessible
// (focus/blur/Escape); tap-to-toggle for tablets.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { summarizeRules, NO_RULES_TEXT, type RuleSummaryRow } from "@/lib/rule-summary";

const TIP_WIDTH = 260;
const TIP_EST_HEIGHT = 160; // generous estimate for the flip decision

export default function RulesInfoTip({ row }: { row: RuleSummaryRow }) {
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const phrases = summarizeRules(row);

  const show = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(rect.left, window.innerWidth - TIP_WIDTH - 16);
    const up = rect.bottom + 6 + TIP_EST_HEIGHT > window.innerHeight - 8;
    setPos({ top: up ? rect.top - 6 : rect.bottom + 6, left: Math.max(8, left), up });
  };
  const hide = () => setPos(null);

  // Fixed positioning is viewport-anchored — dismiss on any scroll/resize so
  // the popover can't detach from its icon.
  useEffect(() => {
    if (!pos) return;
    const onMove = () => hide();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [pos]);

  return (
    <span
      style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <button
        ref={btnRef}
        type="button"
        aria-label="Product rules"
        aria-expanded={!!pos}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => { e.stopPropagation(); pos ? hide() : show(); }}
        onKeyDown={(e) => { if (e.key === "Escape") hide(); }}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 18, height: 18, borderRadius: "50%",
          border: "1px solid #c5cbd3", background: "#fff", color: "#78828c",
          fontSize: 11, fontWeight: 700, fontFamily: "Georgia, serif", fontStyle: "italic",
          cursor: "help", padding: 0, lineHeight: 1,
        }}
      >
        i
      </button>
      {pos && typeof document !== "undefined" && createPortal(
        <div
          role="tooltip"
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            transform: pos.up ? "translateY(-100%)" : undefined,
            zIndex: 1000, width: TIP_WIDTH,
            background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6,
            padding: "10px 12px", textAlign: "left",
            boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
            pointerEvents: "none",
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "#78828c", marginBottom: 6 }}>
            Rules
          </div>
          {phrases.length === 0 ? (
            <div style={{ fontSize: 12, color: "#555", lineHeight: 1.45 }}>{NO_RULES_TEXT}</div>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {phrases.map((p, i) => (
                <li key={i} style={{ fontSize: 12, color: "#333", lineHeight: 1.5, whiteSpace: "normal" }}>{p}</li>
              ))}
            </ul>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}
