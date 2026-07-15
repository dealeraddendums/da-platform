"use client";

import type { EmailCheckStatus } from "@/lib/use-email-check";

/** Inline status line under an email input — spinner / green ✓ / red ✗. */
export default function EmailAvailability({ status }: { status: EmailCheckStatus }) {
  if (status === "idle") return null;
  if (status === "checking") {
    return (
      <p style={{ fontSize: 12, marginTop: 4, color: "#78828c", display: "flex", alignItems: "center", gap: 6 }}>
        <span
          aria-hidden
          style={{
            width: 10, height: 10, borderRadius: "50%",
            border: "2px solid #c5cad0", borderTopColor: "#1976d2",
            display: "inline-block", animation: "da-email-spin .7s linear infinite",
          }}
        />
        Checking…
        <style>{`@keyframes da-email-spin { to { transform: rotate(360deg); } }`}</style>
      </p>
    );
  }
  if (status === "available") {
    return <p style={{ fontSize: 12, marginTop: 4, color: "#2e7d32" }}>✓ Email is available</p>;
  }
  return <p style={{ fontSize: 12, marginTop: 4, color: "#c62828" }}>✗ This email is already registered</p>;
}
