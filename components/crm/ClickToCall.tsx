"use client";

// DA-CRM phone button. Mapped staff (crm_staff_profiles.dialpad_user_id + Dialpad configured):
// click → POST /api/crm/dialpad/call → Dialpad rings the staff member's
// devices, then dials. Unmapped → plain tel: link; a Dialpad failure shows
// the reason plus a tel: link (never auto-opens the phone app).

import { useState } from "react";
import { formatPhone } from "@/lib/crm/phone";

export default function ClickToCall({ phone, canDial }: { phone: string | null; canDial: boolean }) {
  const [status, setStatus] = useState<"idle" | "calling" | "ringing" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  if (!phone) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const label = formatPhone(phone) || phone;
  const tel = `tel:${phone}`;

  if (!canDial) {
    return <a href={tel} style={{ color: "var(--blue)", textDecoration: "none", whiteSpace: "nowrap" }} title="Call (not mapped to a Dialpad user)">{label}</a>;
  }

  async function dial() {
    setStatus("calling");
    setMsg(null);
    try {
      const res = await fetch("/api/crm/dialpad/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus("ringing");
        setMsg("Dialpad is ringing you…");
        setTimeout(() => { setStatus("idle"); setMsg(null); }, 8000);
        return;
      }
      setStatus("error");
      setMsg(j.reason ?? j.error ?? "Dialpad call failed");
    } catch {
      setStatus("error");
      setMsg("Dialpad call failed");
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
      <button
        type="button"
        onClick={dial}
        disabled={status === "calling"}
        title="Call with Dialpad"
        style={{
          display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "1px solid var(--border)",
          borderRadius: 4, padding: "2px 8px", color: "var(--blue)", cursor: "pointer", fontSize: 13, fontFamily: "inherit",
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
        {status === "calling" ? "Calling…" : label}
      </button>
      {msg && <span style={{ fontSize: 12, color: status === "error" ? "var(--error)" : "var(--text-muted)" }}>{msg}</span>}
      {status === "error" && <a href={tel} style={{ fontSize: 12, color: "var(--blue)" }}>Call by phone instead</a>}
    </span>
  );
}
