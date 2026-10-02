"use client";

import { useState } from "react";

// Users tab "Login code" (2026-10-02) — for a user who has never signed in and
// isn't receiving their invite email. Setup codes are stored hashed, so the
// emailed one can't be shown: this generates a NEW code on the user's
// invitation (the emailed one stops working) and displays it once for the
// admin to read over the phone. Nothing is emailed. Server: POST
// /api/users/[id]/login-code (managing admins, never-signed-in only, audited).

type Props = {
  user: { id: string; email: string; full_name: string | null };
  onClose: () => void;
};

const NAVY = "#2a2b3c";

export default function LoginCodeModal({ user, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ code: string; email: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");

  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/users/${user.id}/login-code`, { method: "POST", cache: "no-store" });
      const j = await res.json().catch(() => ({})) as { error?: string; code?: string; email?: string; expiresAt?: string };
      if (!res.ok || !j.code) { setErr(j.error ?? "Could not generate a code"); return; }
      setCopied("");
      setIssued({ code: j.code, email: j.email ?? user.email, expiresAt: j.expiresAt ?? "" });
    } catch {
      setErr("Could not generate a code");
    } finally {
      setBusy(false);
    }
  }

  // navigator.clipboard rejects without page focus / permission, so fall back
  // to a selection copy — and say so if both fail rather than pretending.
  async function copyCode(code: string) {
    try { await navigator.clipboard.writeText(code); setCopied("ok"); return; } catch { /* fall through */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = code; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(ok ? "ok" : "fail");
    } catch { setCopied("fail"); }
  }

  const expiry = issued?.expiresAt
    ? new Date(issued.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "";
  const who = user.full_name || user.email;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ background: "#fff", borderRadius: 6, width: 520, maxWidth: "100%", maxHeight: "calc(100vh - 48px)", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", padding: 24, fontFamily: "'Roboto', sans-serif" }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: "#333", margin: "0 0 8px" }}>Login code — {who}</h2>

        {!issued ? (
          <>
            <p style={{ fontSize: 14, color: "#55595c", margin: "0 0 12px", lineHeight: 1.6 }}>
              For someone who hasn&apos;t received their invite email. This creates a <strong>new</strong> 8-digit code for{" "}
              <strong>{user.email}</strong> and shows it here so you can read it to them. It is <strong>not emailed</strong>.
            </p>
            <p style={{ fontSize: 13, color: "#e65100", background: "#fff8e1", border: "1px solid #ffe0b2", borderRadius: 4, padding: "8px 12px", margin: "0 0 12px" }}>
              This replaces any code already emailed to them — that one stops working.
            </p>
            {err && <p style={{ fontSize: 13, color: "#c62828", margin: "0 0 12px" }}>{err}</p>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={() => void generate()} disabled={busy}>
                {busy ? "Generating…" : "Generate login code"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: "#55595c", margin: "4px 0 6px" }}>Read this code to <strong>{issued.email}</strong>:</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <div style={{ userSelect: "all", fontFamily: "'Roboto Mono', Menlo, monospace", fontSize: 30, fontWeight: 700, letterSpacing: 4, color: NAVY, padding: "8px 14px", border: "1px solid #e0e0e0", borderRadius: 6 }}>
                {issued.code.slice(0, 4)} {issued.code.slice(4)}
              </div>
              <button type="button" className="btn btn-primary" onClick={() => void copyCode(issued.code)}>
                {copied === "ok" ? "Copied ✓" : "Copy"}
              </button>
            </div>
            {copied === "fail" && (
              <div style={{ fontSize: 12, color: "#c62828", margin: "-6px 0 10px" }}>Couldn&apos;t copy automatically — click the code to select it, then copy.</div>
            )}
            <div style={{ fontSize: 14, color: "#333", lineHeight: 1.6 }}>
              <div>Valid until <strong>{expiry}</strong> (7 days).</div>
              <div>
                They go to <strong>app.dealeraddendums.com/signup</strong>, click <strong>Enter your setup code</strong> (under
                &ldquo;Were you invited?&rdquo;), then enter <strong>{issued.email}</strong> and this code — and they&apos;re signed in.
                They can choose a password after that.
              </div>
            </div>
            <p style={{ fontSize: 12, color: "#e65100", background: "#fff8e1", border: "1px solid #ffe0b2", borderRadius: 4, padding: "8px 12px", margin: "12px 0" }}>
              Shown only once. Sending another invite or generating another code replaces it.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
