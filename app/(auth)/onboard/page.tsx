"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { AuthShell } from "../shell";

function IconAlert(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function OnboardInner() {
  const searchParams = useSearchParams();
  const emailParam = searchParams.get("email") ?? "";

  const [email, setEmail] = useState(emailParam);
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"code" | "passkey">("code");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus the code field when the email is prefilled from the link.
    if (emailParam) codeRef.current?.focus();
  }, [emailParam]);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) { setError("Please enter the email this code was sent to."); return; }
    if (!/^\d{6}$/.test(code)) { setError("Enter the 6-digit code from your email."); return; }

    setLoading(true);
    const supabase = createClient();

    // The code came from generateLink({type:'magiclink'}); on the installed
    // supabase-js the paired verify type is 'email'. Fall back to 'magiclink'
    // for older behavior before surfacing an error.
    let verifyErr = (await supabase.auth.verifyOtp({ email: cleanEmail, token: code, type: "email" })).error;
    if (verifyErr) {
      verifyErr = (await supabase.auth.verifyOtp({ email: cleanEmail, token: code, type: "magiclink" })).error;
    }

    if (verifyErr) {
      setError("That code is invalid or expired. Request a new one below.");
      setLoading(false);
      return;
    }

    // Confirm the session is established (cookies written) before the passkey
    // step, which calls a session-authenticated API route.
    await supabase.auth.getSession();
    setLoading(false);
    setStep("passkey");
  }

  async function handlePasskey() {
    setError("");
    setLoading(true);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");

      const startRes = await fetch("/api/auth/passkey/register-start", { method: "POST" });
      if (!startRes.ok) {
        const d = await startRes.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Could not start passkey setup.");
      }
      const options = await startRes.json();

      let credential;
      try {
        credential = await startRegistration({ optionsJSON: options });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("cancelled") || msg.includes("NotAllowedError")) {
          throw new Error("Passkey setup was cancelled. Try again, or skip for now.");
        }
        throw err;
      }

      const completeRes = await fetch("/api/auth/passkey/register-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      if (!completeRes.ok) {
        const d = await completeRes.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Passkey setup failed.");
      }

      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey setup failed.");
      setLoading(false);
    }
  }

  async function handleResend() {
    setError("");
    setNotice("");
    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) { setError("Enter your email first, then resend."); return; }
    try {
      await fetch("/api/onboard/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cleanEmail }),
      });
    } catch {
      // resend always reports success to avoid leaking account existence
    }
    setCode("");
    setNotice("If an account exists for that email, a new code is on its way. It may take a minute to arrive.");
    codeRef.current?.focus();
  }

  // ── Passkey setup step (after the code is verified) ─────────────────────────
  if (step === "passkey") {
    return (
      <AuthShell title="Set up your passkey" subtitle="Sign in instantly next time with Face ID, Touch ID, or your device PIN — no password to remember.">
        {error && (
          <div role="alert" className="lp-server-error" style={{ marginBottom: 18 }}>
            <IconAlert style={{ marginTop: 2, flexShrink: 0, color: "var(--da-red)" }} />
            <span>{error}</span>
          </div>
        )}
        <button type="button" className="lp-btn lp-btn-primary" disabled={loading} onClick={() => void handlePasskey()}>
          {loading ? (<><span className="lp-spinner" /> Setting up…</>) : "Set up passkey"}
        </button>
        <p style={{ marginTop: 14, textAlign: "center", fontSize: 14 }}>
          <a href="/dashboard" className="lp-btn-link">Skip for now</a>
        </p>
      </AuthShell>
    );
  }

  // ── Code-entry step ─────────────────────────────────────────────────────────
  return (
    <AuthShell title="Enter your code" subtitle="We emailed you a 6-digit code to finish setting up your account.">
      <form onSubmit={e => void handleVerify(e)} noValidate style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div>
          <label className="lp-label" htmlFor="email">Email address</label>
          <input
            id="email"
            className="lp-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@dealership.com"
          />
        </div>

        <div>
          <label className="lp-label" htmlFor="code">6-digit code</label>
          <input
            id="code"
            ref={codeRef}
            className="lp-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            placeholder="123456"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
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

        <button type="submit" className="lp-btn lp-btn-primary" disabled={loading || code.length !== 6}>
          {loading ? (<><span className="lp-spinner" /> Verifying…</>) : "Verify code"}
        </button>

        <p style={{ marginTop: 4, textAlign: "center", fontSize: 14, color: "var(--da-text-muted)" }}>
          Didn&apos;t get it?{" "}
          <button type="button" className="lp-btn-link" onClick={() => void handleResend()} style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}>
            Resend code
          </button>
        </p>
        <p style={{ textAlign: "center", fontSize: 14, color: "var(--da-text-muted)" }}>
          Already set up? <Link href="/login" className="lp-btn-link">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}

export default function OnboardPage() {
  return (
    <Suspense fallback={
      <AuthShell title="Welcome to DA Platform" subtitle="Loading…">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 0", color: "var(--da-text-soft)", fontSize: 14 }}>
          <span className="lp-spinner" style={{ marginRight: 8 }} />
          One moment…
        </div>
      </AuthShell>
    }>
      <OnboardInner />
    </Suspense>
  );
}
