"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

function IconAlert(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

/**
 * Shared scanner-proof OTP code entry — used by both /onboard and the login
 * "Email me a sign-in code" fallback. Length-agnostic (never hardcodes a digit
 * count; Supabase's email_otp is 8 digits today but that can change). Verifies
 * with type 'email' and falls back to 'magiclink' for the magiclink-generated
 * OTP. On success the Supabase session is established (cookies written) and
 * onVerified() is called — the parent decides what comes next (passkey step,
 * route to dashboard, etc.).
 *
 * `resendEndpoint` is a POST {email} → {ok} route that re-issues a fresh code
 * (e.g. /api/onboard/resend or /api/auth/otp-login). Both always return ok to
 * avoid account enumeration.
 */
export default function OtpCodeForm({
  initialEmail = "",
  resendEndpoint,
  onVerified,
  footer,
}: {
  initialEmail?: string;
  resendEndpoint: string;
  onVerified: () => void | Promise<void>;
  footer?: React.ReactNode;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus the code field — the email is usually already known on arrival.
    codeRef.current?.focus();
  }, []);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) { setError("Please enter the email this code was sent to."); return; }
    if (!code) { setError("Enter the verification code from your email."); return; }

    setLoading(true);
    const supabase = createClient();

    let verifyErr = (await supabase.auth.verifyOtp({ email: cleanEmail, token: code, type: "email" })).error;
    if (verifyErr) {
      verifyErr = (await supabase.auth.verifyOtp({ email: cleanEmail, token: code, type: "magiclink" })).error;
    }
    if (verifyErr) {
      setError("That code is invalid or expired. Request a new one below.");
      setLoading(false);
      return;
    }

    // Ensure the session is established (cookies written) before handing off.
    await supabase.auth.getSession();
    setLoading(false);
    await onVerified();
  }

  async function handleResend() {
    setError("");
    setNotice("");
    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) { setError("Enter your email first, then resend."); return; }
    try {
      await fetch(resendEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cleanEmail }),
      });
    } catch {
      // resend endpoints always report success to avoid leaking account existence
    }
    setCode("");
    setNotice("If an account exists for that email, a new code is on its way. It may take a minute to arrive.");
    codeRef.current?.focus();
  }

  return (
    <form onSubmit={e => void handleVerify(e)} noValidate style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <label className="lp-label" htmlFor="otp-email">Email address</label>
        <input
          id="otp-email"
          className="lp-input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@dealership.com"
        />
      </div>

      <div>
        <label className="lp-label" htmlFor="otp-code">Verification code</label>
        <input
          id="otp-code"
          ref={codeRef}
          className="lp-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          placeholder="Code from your email"
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, ""))}
          style={{ fontFamily: "'Courier New', monospace", fontSize: 22, letterSpacing: 8, textAlign: "center" }}
        />
      </div>

      {error && (
        <div role="alert" className="lp-server-error">
          <IconAlert style={{ marginTop: 2, flexShrink: 0, color: "var(--da-red)" }} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div role="status" style={{ fontSize: 13, color: "var(--da-text-soft)" }}>{notice}</div>
      )}

      <button type="submit" className="lp-btn lp-btn-primary" disabled={loading || code.length === 0}>
        {loading ? (<><span className="lp-spinner" /> Verifying…</>) : "Verify code"}
      </button>

      <p style={{ marginTop: 4, textAlign: "center", fontSize: 14, color: "var(--da-text-muted)" }}>
        Didn&apos;t get it?{" "}
        <button type="button" className="lp-btn-link" onClick={() => void handleResend()} style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}>
          Resend code
        </button>
      </p>
      {footer}
    </form>
  );
}
