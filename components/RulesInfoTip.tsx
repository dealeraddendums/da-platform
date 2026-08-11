"use client";

// ⓘ rules tooltip for product rows (2026-08-11). Hover + focus + tap show a
// read-only popover summarizing the row's vehicle rules via the shared
// lib/rule-summary.ts (same semantics as the matching engine — same-named
// products that differ only by rules become distinguishable at a glance).
// Keyboard accessible (focus/blur/Escape); tap-to-toggle for tablets; flips
// to the left of the icon when it would clip the right viewport edge.

import { useRef, useState } from "react";
import { summarizeRules, NO_RULES_TEXT, type RuleSummaryRow } from "@/lib/rule-summary";

export default function RulesInfoTip({ row }: { row: RuleSummaryRow }) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const phrases = summarizeRules(row);

  const show = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    // Flip when a ~280px popover would clip the right edge of the viewport.
    setAlignRight(!!rect && rect.left + 280 > window.innerWidth - 16);
    setOpen(true);
  };
  const hide = () => setOpen(false);

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
        aria-expanded={open}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => { e.stopPropagation(); open ? hide() : show(); }}
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
      {open && (
        <div
          role="tooltip"
          style={{
            position: "absolute", top: "calc(100% + 6px)",
            ...(alignRight ? { right: 0 } : { left: 0 }),
            zIndex: 60, width: 260,
            background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6,
            padding: "10px 12px", textAlign: "left",
            boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
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
        </div>
      )}
    </span>
  );
}
