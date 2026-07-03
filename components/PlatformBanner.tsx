"use client";

import { useEffect, useState } from "react";

type Banner = { id: string; message: string; banner_type: string };

// Type → colors. Roboto + no box-shadow per the design system.
const STYLES: Record<string, { background: string; color: string }> = {
  info: { background: "#1976d2", color: "#ffffff" },
  warning: { background: "#f59e0b", color: "#1f2937" },
  success: { background: "#16a34a", color: "#ffffff" },
  error: { background: "#dc2626", color: "#ffffff" },
};

/**
 * Platform-wide banner shown to ALL authenticated users. Fetches the current
 * active banner from the public /api/banners/active endpoint and renders it
 * below the impersonation bar and above the main content. Dismiss is per-session
 * (sessionStorage), so a dismissed banner stays hidden until the tab is closed.
 */
export default function PlatformBanner() {
  const [banner, setBanner] = useState<Banner | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/banners/active")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: Banner | null) => {
        if (!active || !b || !b.id) return;
        try {
          if (sessionStorage.getItem(`dismissed_banner_${b.id}`) === "1") return;
        } catch {
          /* sessionStorage unavailable — show the banner anyway */
        }
        setBanner(b);
      })
      .catch(() => null);
    return () => {
      active = false;
    };
  }, []);

  if (!banner || dismissed) return null;
  const style = STYLES[banner.banner_type] ?? STYLES.info;

  return (
    <div
      id={`platform-banner-${banner.id}`}
      style={{
        background: style.background,
        color: style.color,
        padding: "12px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexShrink: 0,
        fontFamily: "Roboto, sans-serif",
      }}
    >
      <span style={{ fontFamily: "Roboto, sans-serif", fontSize: 14 }}>{banner.message}</span>
      <button
        aria-label="Dismiss banner"
        onClick={() => {
          try {
            sessionStorage.setItem(`dismissed_banner_${banner.id}`, "1");
          } catch {
            /* ignore */
          }
          setDismissed(true);
        }}
        style={{
          background: "none",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          fontSize: 18,
          lineHeight: 1,
          padding: "0 0 0 16px",
        }}
      >
        ×
      </button>
    </div>
  );
}
