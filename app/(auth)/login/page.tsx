"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { AuthShell } from "../shell";
import OtpCodeForm from "../OtpCodeForm";
import PasskeySetup from "../PasskeySetup";

// ── Icons ─────────────────────────────────────────────────────────────────────

function IconEye(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

function IconEyeOff(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>
      <line x1="2" y1="2" x2="22" y2="22"/>
    </svg>
  );
}

function IconArrow(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M5 12h14"/>
      <path d="m12 5 7 7-7 7"/>
    </svg>
  );
}

function IconCheck(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function IconAlert(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  );
}

function IconPasskey(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="8" cy="10" r="4"/>
      <path d="M10.85 12.85 21 23l-2 2"/>
      <path d="m17 19 2-2"/>
    </svg>
  );
}

function IconMail(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2" y="4" width="20" height="16" rx="2"/>
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
    </svg>
  );
}

// ── Field error ───────────────────────────────────────────────────────────────

function FieldError({ msg }: { msg: string }) {
  return (
    <div className="lp-field-error">
      <IconAlert style={{ marginTop: 1, flexShrink: 0 }} />
      <span>{msg}</span>
    </div>
  );
}

// ── Form ─────────────────────────────────────────────────────────────────────

type PasskeyState = "idle" | "prompting" | "success" | "error";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [showPw, setShowPw] = useState(false);
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const [passkeyState, setPasskeyState] = useState<PasskeyState>("idle");
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeySupported, setPasskeySupported] = useState(false);

  // OTP code sign-in fallback (passwordless dealers)
  const [mode, setMode] = useState<"password" | "code" | "passkey-offer">("password");
  const [codeSending, setCodeSending] = useState(false);
  const [codeEmail, setCodeEmail] = useState("");

  function goNext() {
    router.push(next);
    router.refresh();
  }

  // Email me a sign-in code — always available (the recovery path for
  // passwordless users). Only the email needs to be valid.
  async function startCodeLogin() {
    setServerError(null);
    setPasskeyError(null);
    setTouched(t => ({ ...t, email: true }));
    if (!emailValid) { setShakeKey(k => k + 1); return; }
    setCodeSending(true);
    try {
      await fetch("/api/auth/otp-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Forward an explicit ?next so the email's deep-link preserves it.
        body: JSON.stringify({ email, ...(searchParams.get("next") ? { next: searchParams.get("next") } : {}) }),
      });
    } catch {
      // otp-login always reports success; ignore transport errors and proceed
    }
    setCodeEmail(email);
    setCodeSending(false);
    setMode("code");
  }

  // After a successful OTP sign-in, offer a passkey if the user has none.
  async function afterOtpLogin() {
    try {
      const res = await fetch("/api/auth/passkey/list");
      if (res.ok) {
        const { passkeys } = await res.json() as { passkeys?: unknown[] };
        if (!passkeys || passkeys.length === 0) { setMode("passkey-offer"); return; }
      }
    } catch {
      // fall through to dashboard on any error
    }
    goNext();
  }

  // Deep-link from the OTP email's "Go to sign in" button (?email=…&mode=otp):
  // land directly on the code-entry step with the email pre-filled. The user
  // already has the code in hand — no re-request, no auto-submit.
  useEffect(() => {
    const qpEmail = searchParams.get("email");
    if (qpEmail) { setEmail(qpEmail); setCodeEmail(qpEmail); }
    if (searchParams.get("mode") === "otp") { setMode("code"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      !!window.PublicKeyCredential &&
      typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
    ) {
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        .then(available => setPasskeySupported(available))
        .catch(() => setPasskeySupported(false));
    }
  }, []);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const pwValid = password.length >= 6;

  const errors = {
    email: touched.email && !emailValid ? (email ? "Enter a valid email address" : "Email is required") : null,
    password: touched.password && !pwValid ? (password ? "Password must be at least 6 characters" : "Password is required") : null,
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ email: true, password: true });
    setServerError(null);
    setPasskeyError(null);

    if (!emailValid || !pwValid) {
      setShakeKey(k => k + 1);
      return;
    }

    setSubmitting(true);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });

    if (authError) {
      setServerError(authError.message);
      setShakeKey(k => k + 1);
      setSubmitting(false);
      return;
    }

    setSuccess(true);
    setTimeout(() => {
      router.push(next);
      router.refresh();
    }, 800);
  }

  async function handlePasskey() {
    setPasskeyError(null);
    setPasskeyState("prompting");

    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");

      // Get challenge from server
      const startRes = await fetch("/api/auth/passkey/auth-start", { method: "POST" });
      if (!startRes.ok) throw new Error("Could not start passkey authentication.");
      const options = await startRes.json() as { challengeId: string; [key: string]: unknown };
      const { challengeId, ...authOptions } = options;

      // Browser shows passkey picker (Face ID / Touch ID / PIN)
      let credential;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        credential = await startAuthentication({ optionsJSON: authOptions as any });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("cancelled") || msg.includes("NotAllowedError")) {
          throw new Error("Authentication was cancelled.");
        }
        throw new Error("No passkey found for this device.");
      }

      // Verify with server
      const completeRes = await fetch("/api/auth/passkey/auth-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential, challengeId }),
      });

      if (!completeRes.ok) {
        const d = await completeRes.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Passkey authentication failed.");
      }

      const { access_token, refresh_token } = await completeRes.json() as {
        access_token: string;
        refresh_token: string;
      };

      // Set the Supabase session
      const supabase = createClient();
      await supabase.auth.setSession({ access_token, refresh_token });

      setPasskeyState("success");
      setTimeout(() => {
        router.push(next);
        router.refresh();
      }, 600);
    } catch (err) {
      setPasskeyState("idle");
      setPasskeyError(err instanceof Error ? err.message : "Passkey authentication failed. Please try again.");
    }
  }

  // ── Code sign-in step ───────────────────────────────────────────────────────
  if (mode === "code") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Neutral copy — identical whether the email has an account, a pending
            invitation (otp-login auto-resends it), or nothing. Never reveal which. */}
        <p style={{ fontSize: 14, color: "var(--da-text-soft)", margin: 0 }}>
          We&apos;ve sent an email to <strong>{codeEmail || "your email"}</strong>. Enter the sign-in code
          below — no password needed. If you were invited to set up a new account, use the setup
          link and code in that email instead.
        </p>
        <OtpCodeForm
          initialEmail={codeEmail}
          resendEndpoint="/api/auth/otp-login"
          onVerified={afterOtpLogin}
          footer={
            <p style={{ textAlign: "center", fontSize: 14, color: "var(--da-text-muted)" }}>
              <button type="button" className="lp-btn-link" onClick={() => setMode("password")} style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}>
                &larr; Back to password sign-in
              </button>
            </p>
          }
        />
      </div>
    );
  }

  // ── Optional passkey offer after an OTP sign-in ─────────────────────────────
  if (mode === "passkey-offer") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <p style={{ fontSize: 14, color: "var(--da-text-soft)", margin: 0 }}>
          You&apos;re signed in. Set up a passkey for faster, password-free sign-in next time?
        </p>
        <PasskeySetup onDone={goNext} onSkip={goNext} />
      </div>
    );
  }

  return (
    <form
      key={shakeKey}
      onSubmit={handleSubmit}
      noValidate
      autoComplete="on"
      style={{ display: "flex", flexDirection: "column", gap: 18 }}
    >
      {/* Email */}
      <div>
        <label className="lp-label" htmlFor="email">Work email</label>
        <input
          id="email"
          type="email"
          className={`lp-input${errors.email ? " lp-input-error" : ""}`}
          placeholder="you@dealership.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          onBlur={() => setTouched(t => ({ ...t, email: true }))}
          autoComplete="email"
        />
        {errors.email && <FieldError msg={errors.email} />}
      </div>

      {/* Password */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <label className="lp-label" htmlFor="password">Password</label>
          <button
            type="button"
            onClick={() => void startCodeLogin()}
            className="lp-btn-link"
            style={{ fontSize: 12, letterSpacing: ".04em", textTransform: "uppercase", fontWeight: 600, background: "none", border: "none", padding: 0, cursor: "pointer" }}
          >
            Forgot?
          </button>
        </div>
        <div style={{ position: "relative" }}>
          <input
            id="password"
            type={showPw ? "text" : "password"}
            className={`lp-input${errors.password ? " lp-input-error" : ""}`}
            placeholder="Enter your password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onBlur={() => setTouched(t => ({ ...t, password: true }))}
            style={{ paddingRight: 48 }}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="lp-pw-toggle"
            onClick={() => setShowPw(s => !s)}
            aria-label={showPw ? "Hide password" : "Show password"}
          >
            {showPw ? <IconEyeOff /> : <IconEye />}
          </button>
        </div>
        {errors.password && <FieldError msg={errors.password} />}
      </div>

      {/* Server error */}
      {serverError && (
        <div role="alert" className="lp-server-error">
          <IconAlert style={{ marginTop: 2, flexShrink: 0, color: "var(--da-red)" }} />
          <span>{serverError}</span>
        </div>
      )}

      {/* Remember me */}
      <label className="lp-checkbox">
        <input
          type="checkbox"
          checked={remember}
          onChange={e => setRemember(e.target.checked)}
        />
        <span>Keep me signed in on this device</span>
      </label>

      {/* Submit */}
      <button
        type="submit"
        className="lp-btn lp-btn-primary"
        disabled={submitting || success}
      >
        {success ? (
          <><IconCheck /> Signed in</>
        ) : submitting ? (
          <><span className="lp-spinner" /> Signing in…</>
        ) : (
          <>Sign in <IconArrow /></>
        )}
      </button>

      <div className="lp-divider"><span>or</span></div>

      {/* Email me a sign-in code — always available (recovery for passwordless dealers) */}
      <button
        type="button"
        className="lp-btn lp-btn-passkey"
        onClick={() => void startCodeLogin()}
        disabled={codeSending}
      >
        {codeSending ? (
          <><span className="lp-spinner" /> Sending code…</>
        ) : (
          <><IconMail /> Email me a sign-in code</>
        )}
      </button>

      {/* Passkey — only shown when a platform authenticator is available */}
      {passkeySupported && (
        <>
          <button
            type="button"
            className="lp-btn lp-btn-passkey"
            onClick={handlePasskey}
            disabled={passkeyState !== "idle"}
          >
            {passkeyState === "success" ? (
              <><IconCheck /> Authenticated</>
            ) : passkeyState === "prompting" ? (
              <><span className="lp-spinner" /> Waiting for device…</>
            ) : (
              <><IconPasskey /> Sign in with passkey</>
            )}
          </button>

          {passkeyError && (
            <div role="alert" className="lp-server-error" style={{ marginTop: -6 }}>
              <IconAlert style={{ marginTop: 2, flexShrink: 0, color: "var(--da-red)" }} />
              <span>{passkeyError}</span>
            </div>
          )}
        </>
      )}
    </form>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function LoginPageInner() {
  return (
    <AuthShell title="Sign in" subtitle="Welcome back. Pick up where your team left off.">
      <Suspense fallback={<div style={{ height: 320 }} />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}

export default function LoginPage() {
  return <LoginPageInner />;
}
