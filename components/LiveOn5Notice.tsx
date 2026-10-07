"use client";

import { useEffect, useState } from "react";

/**
 * One-time notice shown on the login that migrated the dealer
 * (lib/first-login-migration.ts). The login response sets a short-lived
 * cookie; the layout renders this only when it's present, and the first mount
 * deletes it — so a refresh or the next login shows nothing. Colors are the
 * PlatformBanner "success" pair (design system, no shadow).
 */
export default function LiveOn5Notice({ cookieName }: { cookieName: string }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    document.cookie = `${cookieName}=; Max-Age=0; path=/; SameSite=Lax; Secure`;
  }, [cookieName]);

  if (!visible) return null;

  return (
    <div
      role="status"
      style={{
        background: "#16a34a",
        color: "#ffffff",
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
        <strong>You&apos;re now live on 5.0 — your 4.0 access has moved here.</strong>{" "}
        From now on, sign in here at app.dealeraddendums.com. Questions?{" "}
        <a href="mailto:support@dealeraddendums.com" style={{ color: "#ffffff", textDecoration: "underline" }}>support@dealeraddendums.com</a>
      </div>
      <button
        onClick={() => setVisible(false)}
        aria-label="Dismiss"
        style={{ background: "none", border: "none", color: "inherit", fontSize: 18, lineHeight: 1, cursor: "pointer", padding: "2px 6px", flexShrink: 0 }}
      >
        ×
      </button>
    </div>
  );
}
