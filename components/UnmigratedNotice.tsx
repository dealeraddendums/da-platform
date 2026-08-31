"use client";

import { useEffect, useState } from "react";

/**
 * Soft migration notice (policy change 2026-08-31): dealer-role users of a
 * not-yet-migrated dealer used to be HARD-redirected to the dead-end
 * /not-migrated page. They now get the full 5.0 dashboard with this
 * dismissible banner instead. Reassuring, not alarming — these are
 * legitimately-invited users (only invited users have 5.0 credentials).
 * Dismiss is per-session + per-dealer (sessionStorage), matching
 * PlatformBanner's convention.
 */
export default function UnmigratedNotice({ status, dealerTextId }: { status: string; dealerTextId: string }) {
  const storageKey = `dismissed_unmigrated_${dealerTextId}`;
  // Start hidden until we've checked sessionStorage to avoid a flash.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(storageKey) === "1") return;
    } catch { /* sessionStorage unavailable — show the notice */ }
    setVisible(true);
  }, [storageKey]);

  if (!visible) return null;

  const detail =
    status === "invited" || status === "migrating"
      ? "Our team is finishing your migration behind the scenes — your billing stays on your current plan until it completes, and there's nothing you need to do."
      : "Your dealership's full move to 5.0 hasn't been completed yet — your billing stays on your current plan until it is, and there's nothing you need to do.";

  return (
    <div
      style={{
        background: "#fff8e1",
        borderBottom: "1px solid #ffe082",
        color: "#5d4037",
        padding: "10px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexShrink: 0,
        fontFamily: "Roboto, sans-serif",
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div>
        <strong style={{ color: "#4e342e" }}>You&apos;re not fully migrated yet — you can start using DealerAddendums 5.0 now.</strong>{" "}
        {detail}{" "}
        Questions? <a href="mailto:support@dealeraddendums.com" style={{ color: "#1976d2", textDecoration: "underline" }}>support@dealeraddendums.com</a>
      </div>
      <button
        onClick={() => {
          try { sessionStorage.setItem(storageKey, "1"); } catch { /* best-effort */ }
          setVisible(false);
        }}
        aria-label="Dismiss migration notice"
        style={{
          background: "none",
          border: "none",
          color: "#8d6e63",
          fontSize: 18,
          lineHeight: 1,
          cursor: "pointer",
          padding: "2px 6px",
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
