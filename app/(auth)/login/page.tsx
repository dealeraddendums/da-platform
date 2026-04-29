"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "5.0.0";
const BUILD_NUMBER = process.env.NEXT_PUBLIC_BUILD_NUMBER ?? "209";

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

// ── Animated gradient backdrop ────────────────────────────────────────────────

function MotionGradient() {
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#0B1220" }}>
      <div className="lp-blob lp-blob-a" />
      <div className="lp-blob lp-blob-b" />
      <div className="lp-blob lp-blob-c" />
      <svg
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", mixBlendMode: "overlay", opacity: 0.35 }}
        aria-hidden
      >
        <filter id="lp-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" />
        </filter>
        <rect width="100%" height="100%" filter="url(#lp-grain)" />
      </svg>
      <div style={{ position: "absolute", inset: "auto 0 0 0", height: 1, background: "linear-gradient(90deg, transparent, rgba(255,255,255,.2), transparent)" }} />
    </div>
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

    if (typeof window === "undefined" || !window.PublicKeyCredential) {
      setPasskeyState("idle");
      setPasskeyError("Passkeys are not supported on this device or browser.");
      return;
    }

    try {
      // Passkey/WebAuthn challenge flow — endpoint to be implemented
      const challengeRes = await fetch("/api/auth/passkey/challenge", { method: "POST" });
      if (!challengeRes.ok) throw new Error("Passkey sign-in is not yet configured.");
      // Full WebAuthn flow continues here once the endpoint is ready
      setPasskeyState("success");
      setTimeout(() => setPasskeyState("idle"), 2000);
    } catch (err) {
      setPasskeyState("idle");
      setPasskeyError(err instanceof Error ? err.message : "Passkey authentication failed. Please try again.");
    }
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
          <a
            href="/reset-password"
            className="lp-btn-link"
            style={{ fontSize: 12, letterSpacing: ".04em", textTransform: "uppercase", fontWeight: 600 }}
          >
            Forgot?
          </a>
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

      {/* Divider */}
      <div className="lp-divider"><span>or</span></div>

      {/* Passkey */}
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
    </form>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const LOGIN_CSS = `
  :root {
    --da-ink: #0B1220;
    --da-ink-2: #11192B;
    --da-blue: #2B5BD7;
    --da-red: #D03A2E;
    --da-amber: #E9A23B;
    --da-green: #2E8B57;
    --da-radius: 10px;
    --da-radius-lg: 16px;
    --da-text: #0B1220;
    --da-text-muted: #5A6478;
    --da-text-soft: #8A93A6;
    --da-line: #E5E3DA;
    --da-line-strong: #C9C6B8;
    --da-paper-2: #F2F1EC;
  }

  .lp-page {
    position: fixed;
    inset: 0;
    display: grid;
    grid-template-rows: auto 1fr auto;
    overflow: auto;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    color: var(--da-text);
    background: #0B1220;
  }

  /* Blobs */
  .lp-blob {
    position: absolute;
    border-radius: 50%;
    filter: blur(40px);
  }
  .lp-blob-a {
    width: 900px; height: 900px; left: -15%; top: -20%;
    background: radial-gradient(circle, rgba(43,91,215,.55), transparent 60%);
    animation: lpBlobA 22s ease-in-out infinite alternate;
  }
  .lp-blob-b {
    width: 800px; height: 800px; right: -15%; top: 20%;
    background: radial-gradient(circle, rgba(233,162,59,.45), transparent 60%);
    animation: lpBlobB 28s ease-in-out infinite alternate;
  }
  .lp-blob-c {
    width: 700px; height: 700px; left: 30%; bottom: -25%;
    background: radial-gradient(circle, rgba(110,68,200,.4), transparent 60%);
    animation: lpBlobC 25s ease-in-out infinite alternate;
  }

  /* Topbar */
  .lp-topbar {
    position: relative; z-index: 2;
    display: flex; justify-content: space-between; align-items: center;
    padding: 24px 40px;
    color: #fff;
  }
  .lp-logo {
    text-decoration: none;
    display: inline-flex; align-items: center;
  }
  .lp-logo img {
    height: 36px; width: auto;
    display: block;
  }
  .lp-topbar-right {
    display: flex; align-items: center; gap: 18px;
    color: rgba(255,255,255,.7); font-size: 13px;
  }
  .lp-topbar-right a {
    color: rgba(255,255,255,.85); text-decoration: none;
  }
  .lp-topbar-right a:hover { color: #fff; }
  .lp-status-pill {
    display: inline-flex; align-items: center; gap: 8px;
  }
  .lp-live-dot {
    display: inline-block;
    width: 6px; height: 6px; border-radius: 50%;
    background: #2E8B57;
    box-shadow: 0 0 0 0 rgba(46,139,87,.6);
    animation: lpLivePulse 2s ease-out infinite;
  }

  /* Card area */
  .lp-card-wrap {
    position: relative; z-index: 2;
    display: grid; place-items: center;
    padding: 24px 16px 64px;
  }
  .lp-card {
    width: 100%; max-width: 440px;
    background: rgba(255,255,255,0.96);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,0.4);
    border-radius: var(--da-radius-lg);
    padding: 40px 40px 32px;
    box-shadow: 0 40px 80px -20px rgba(0,0,0,.5), 0 8px 16px -8px rgba(0,0,0,.3);
  }
  .lp-card-title {
    font-family: 'Newsreader', Georgia, serif;
    font-size: 32px; font-weight: 500; letter-spacing: -0.02em;
    margin: 0; color: var(--da-ink);
  }
  .lp-card-sub {
    font-size: 14.5px; color: var(--da-text-muted);
    margin: 6px 0 26px; line-height: 1.5;
  }

  /* Footer */
  .lp-footer {
    position: relative; z-index: 2;
    display: flex; justify-content: space-between; align-items: flex-end;
    padding: 0 40px 24px;
    color: rgba(255,255,255,.55); font-size: 12px;
  }
  .lp-footer a { color: rgba(255,255,255,.8); text-decoration: none; }
  .lp-footer a:hover { color: #fff; }
  .lp-footer-version {
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
    letter-spacing: .1em;
  }

  /* Form primitives */
  .lp-label {
    display: block;
    font-size: 12px; font-weight: 600;
    letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--da-text-muted);
    margin-bottom: 8px;
  }
  .lp-input {
    width: 100%;
    height: 48px;
    padding: 0 14px;
    font-family: inherit; font-size: 15px;
    color: var(--da-text); background: #fff;
    border: 1px solid var(--da-line);
    border-radius: var(--da-radius);
    outline: none;
    transition: border-color .15s, box-shadow .15s;
    box-sizing: border-box;
  }
  .lp-input::placeholder { color: var(--da-text-soft); }
  .lp-input:hover { border-color: var(--da-line-strong); }
  .lp-input:focus {
    border-color: var(--da-blue);
    box-shadow: 0 0 0 4px rgba(43,91,215,.12);
  }
  .lp-input-error {
    border-color: var(--da-red) !important;
    box-shadow: 0 0 0 4px rgba(208,58,46,.10) !important;
  }
  .lp-pw-toggle {
    position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
    color: var(--da-text-soft); cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border-radius: 6px;
    background: transparent; border: none;
  }
  .lp-pw-toggle:hover { color: var(--da-text); background: var(--da-paper-2); }

  /* Buttons */
  .lp-btn {
    display: inline-flex; align-items: center; justify-content: center;
    gap: 8px; height: 48px; padding: 0 18px; width: 100%;
    font-family: inherit; font-size: 15px; font-weight: 600;
    white-space: nowrap;
    border-radius: var(--da-radius);
    border: 1px solid transparent; cursor: pointer;
    transition: transform .04s, background .15s, border-color .15s;
    user-select: none; box-sizing: border-box;
  }
  .lp-btn > svg { flex-shrink: 0; }
  .lp-btn:active { transform: translateY(1px); }
  .lp-btn:disabled { opacity: .65; cursor: not-allowed; }

  .lp-btn-primary { background: var(--da-ink); color: #fff; }
  .lp-btn-primary:hover:not(:disabled) { background: var(--da-ink-2, #11192B); }

  .lp-btn-passkey {
    background: #fff; color: var(--da-text);
    border-color: var(--da-line);
  }
  .lp-btn-passkey:hover:not(:disabled) {
    background: var(--da-paper-2);
    border-color: var(--da-line-strong);
  }

  .lp-btn-link {
    background: transparent; color: var(--da-text-muted);
    border: none; padding: 0;
    font-family: inherit; font-weight: 500; cursor: pointer;
    text-decoration: underline; text-decoration-color: transparent;
    text-underline-offset: 3px;
  }
  .lp-btn-link:hover { color: var(--da-text); text-decoration-color: currentColor; }

  /* Divider */
  .lp-divider {
    display: flex; align-items: center; gap: 12px;
    color: var(--da-text-soft);
    font-size: 12px; letter-spacing: .1em; text-transform: uppercase;
  }
  .lp-divider::before, .lp-divider::after {
    content: ''; flex: 1; height: 1px; background: var(--da-line);
  }

  /* Checkbox */
  .lp-checkbox {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 14px; color: var(--da-text-muted);
    cursor: pointer; user-select: none;
  }
  .lp-checkbox input {
    appearance: none; -webkit-appearance: none;
    width: 18px; height: 18px; flex-shrink: 0;
    border: 1.5px solid var(--da-line-strong);
    border-radius: 4px; background: #fff; cursor: pointer;
    transition: all .15s; position: relative;
  }
  .lp-checkbox input:hover { border-color: var(--da-text-muted); }
  .lp-checkbox input:checked { background: var(--da-ink); border-color: var(--da-ink); }
  .lp-checkbox input:checked::after {
    content: ''; position: absolute; left: 4px; top: 1px;
    width: 5px; height: 9px;
    border: solid #fff; border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  /* Errors */
  .lp-field-error {
    display: flex; gap: 6px; align-items: center;
    margin-top: 8px;
    color: var(--da-red); font-size: 12.5px;
    animation: lpFadeUp .2s ease both;
  }
  .lp-server-error {
    display: flex; gap: 10px; align-items: flex-start;
    background: rgba(208,58,46,.06);
    color: #7A1D15;
    border: 1px solid rgba(208,58,46,.2);
    padding: 10px 12px;
    border-radius: var(--da-radius);
    font-size: 13px; line-height: 1.45;
    animation: lpFadeUp .25s ease both;
  }

  /* Spinner */
  .lp-spinner {
    display: inline-block;
    width: 16px; height: 16px; border-radius: 50%;
    border: 2px solid currentColor; border-right-color: transparent;
    animation: lpSpin .7s linear infinite;
    flex-shrink: 0;
  }

  /* Keyframes */
  @keyframes lpSpin { to { transform: rotate(360deg); } }
  @keyframes lpFadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes lpShake {
    10%, 90% { transform: translateX(-1px); }
    20%, 80% { transform: translateX(2px); }
    30%, 50%, 70% { transform: translateX(-3px); }
    40%, 60% { transform: translateX(3px); }
  }
  @keyframes lpLivePulse {
    0%   { box-shadow: 0 0 0 0 rgba(46,139,87,.55); }
    70%  { box-shadow: 0 0 0 8px rgba(46,139,87,0); }
    100% { box-shadow: 0 0 0 0 rgba(46,139,87,0); }
  }
  @keyframes lpBlobA {
    0%   { transform: translate(0,0) scale(1); }
    100% { transform: translate(80px,40px) scale(1.1); }
  }
  @keyframes lpBlobB {
    0%   { transform: translate(0,0) scale(1); }
    100% { transform: translate(-60px,-50px) scale(.9); }
  }
  @keyframes lpBlobC {
    0%   { transform: translate(0,0) scale(1); }
    100% { transform: translate(-40px,30px) scale(1.15); }
  }

  /* Responsive */
  @media (max-width: 640px) {
    .lp-topbar { padding: 20px; }
    .lp-topbar-right { gap: 12px; }
    .lp-topbar-right a:not(.lp-topbar-right .lp-status-pill + a) { display: none; }
    .lp-card { padding: 32px 24px 24px; border-radius: 12px; }
    .lp-footer { flex-direction: column; align-items: flex-start; gap: 6px; padding: 0 20px 20px; }
  }
`;

function LoginPageInner() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LOGIN_CSS }} />
      <div className="lp-page">
        <MotionGradient />

        {/* Topbar */}
        <header className="lp-topbar">
          <a href="/" className="lp-logo" aria-label="Dealer Addendums home">
            <img src="/images/login-logo.svg" alt="Dealer Addendums" />
          </a>
          <div className="lp-topbar-right">
            <span className="lp-status-pill">
              <span className="lp-live-dot" aria-hidden />
              All systems normal
            </span>
            <a href="mailto:support@dealeraddendums.com">Help</a>
            <a href="https://status.dealeraddendums.com" target="_blank" rel="noopener noreferrer">Status</a>
          </div>
        </header>

        {/* Card */}
        <main className="lp-card-wrap">
          <div className="lp-card">
            <h1 className="lp-card-title">Sign in</h1>
            <p className="lp-card-sub">Welcome back. Pick up where your team left off.</p>
            <Suspense fallback={<div style={{ height: 320 }} />}>
              <LoginForm />
            </Suspense>
          </div>
        </main>

        {/* Footer */}
        <footer className="lp-footer">
          <div>
            © {new Date().getFullYear()} Dealer Addendums ·{" "}
            <a href="/terms">Terms</a> ·{" "}
            <a href="/privacy">Privacy</a>
          </div>
          <div className="lp-footer-version">v {APP_VERSION} · build {BUILD_NUMBER}</div>
        </footer>
      </div>
    </>
  );
}

export default function LoginPage() {
  return <LoginPageInner />;
}
