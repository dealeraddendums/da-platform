"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { AuthShell } from "../shell";

type InviteDetails = {
  email: string;
  firstName: string;
  lastName: string;
  dealerName: string;
  role: string;
};

/**
 * Score a password on a simple 0-4 scale: length, mixed case, digit, symbol.
 * Renders the strength bar + label under the New Password input.
 */
function passwordStrength(pw: string): { pct: number; label: string; color: string } {
  if (!pw) return { pct: 0, label: "", color: "transparent" };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length < 8) return { pct: 25, label: "Too short", color: "#D03A2E" };
  if (score <= 2)    return { pct: 40, label: "Weak",      color: "#E9A23B" };
  if (score === 3)   return { pct: 65, label: "Fair",      color: "#E9A23B" };
  if (score === 4)   return { pct: 85, label: "Strong",    color: "#2E8B57" };
  return                    { pct: 100, label: "Excellent", color: "#2E8B57" };
}

function IconAlert(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function SignupPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get("invite");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const [inviteDetails, setInviteDetails] = useState<InviteDetails | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(!!inviteToken);

  useEffect(() => {
    if (!inviteToken) return;
    fetch(`/api/invite?token=${encodeURIComponent(inviteToken)}`)
      .then(r => r.json())
      .then((json: { data?: InviteDetails; error?: string }) => {
        if (json.error || !json.data) {
          setInviteError(json.error ?? "Invalid or expired invitation.");
        } else {
          setInviteDetails(json.data);
          setEmail(json.data.email);
        }
      })
      .catch(() => setInviteError("Failed to load invitation."))
      .finally(() => setInviteLoading(false));
  }, [inviteToken]);

  async function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8)   { setError("Password must be at least 8 characters.");  return; }
    if (password !== confirm)  { setError("Passwords don't match. Please re-enter.");  return; }
    setLoading(true);

    const res = await fetch("/api/invite/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: inviteToken, password }),
    });
    const json = await res.json() as { tokenHash?: string; error?: string };

    if (!res.ok || !json.tokenHash) {
      setError(json.error ?? "Failed to accept invitation.");
      setLoading(false);
      return;
    }

    const supabase = createClient();
    const { error: otpError } = await supabase.auth.verifyOtp({
      token_hash: json.tokenHash,
      type: "magiclink",
    });

    if (otpError) {
      setError(otpError.message);
      setLoading(false);
      return;
    }

    window.location.href = "/dashboard";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirm)  { setError("Passwords do not match.");                return; }
    if (password.length < 6)   { setError("Password must be at least 6 characters."); return; }

    setLoading(true);

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    setDone(true);
    setLoading(false);
    router.push("/dashboard");
    router.refresh();
  }

  // ── Invite flow ────────────────────────────────────────────────────────────

  if (inviteToken) {
    if (inviteLoading) {
      return (
        <AuthShell title="Welcome to DA Platform" subtitle="Loading your invitation…">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 0", color: "var(--da-text-soft)", fontSize: 14 }}>
            <span className="lp-spinner" style={{ marginRight: 8 }} />
            One moment…
          </div>
        </AuthShell>
      );
    }

    if (inviteError) {
      return (
        <AuthShell title="Invitation issue" subtitle="We couldn't load this invitation.">
          <div role="alert" className="lp-server-error" style={{ marginBottom: 18 }}>
            <IconAlert style={{ marginTop: 2, flexShrink: 0, color: "var(--da-red)" }} />
            <span>{inviteError}</span>
          </div>
          <Link href="/login" className="lp-btn lp-btn-passkey" style={{ textDecoration: "none" }}>
            Go to login
          </Link>
        </AuthShell>
      );
    }

    const strength = passwordStrength(password);
    const passwordsMatch = password.length > 0 && password === confirm;
    const ready = !loading && password.length >= 8 && passwordsMatch;

    return (
      <AuthShell
        title="Set your password"
        subtitle="Create a password to complete your account setup."
      >
        {inviteDetails && (
          <div className="lp-invite-badge">
            Invited to <strong>{inviteDetails.dealerName}</strong> as{" "}
            <strong>{inviteDetails.role.replace(/_/g, " ")}</strong>
          </div>
        )}

        <form onSubmit={e => void handleInviteSubmit(e)} noValidate style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <label className="lp-label" htmlFor="email">Email address</label>
            <input
              id="email"
              className="lp-input"
              type="email"
              value={email}
              readOnly
            />
          </div>

          <div>
            <label className="lp-label" htmlFor="inv-password">New password</label>
            <input
              id="inv-password"
              className="lp-input"
              type="password"
              autoComplete="new-password"
              required
              placeholder="At least 8 characters"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
            {password.length > 0 && (
              <div className="lp-strength">
                <div className="lp-strength-bar">
                  <div
                    className="lp-strength-fill"
                    style={{ width: `${strength.pct}%`, background: strength.color }}
                  />
                </div>
                <span className="lp-strength-label" style={{ color: strength.color }}>
                  {strength.label}
                </span>
              </div>
            )}
          </div>

          <div>
            <label className="lp-label" htmlFor="inv-confirm">Confirm password</label>
            <input
              id="inv-confirm"
              className={`lp-input${confirm.length > 0 && !passwordsMatch ? " lp-input-error" : ""}`}
              type="password"
              autoComplete="new-password"
              required
              placeholder="Repeat password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
            />
            {confirm.length > 0 && !passwordsMatch && (
              <div className="lp-match-hint fail">Passwords don&apos;t match</div>
            )}
            {passwordsMatch && (
              <div className="lp-match-hint ok">✓ Passwords match</div>
            )}
          </div>

          {error && (
            <div role="alert" className="lp-server-error">
              <IconAlert style={{ marginTop: 2, flexShrink: 0, color: "var(--da-red)" }} />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="lp-btn lp-btn-primary"
            disabled={!ready}
          >
            {loading ? (<><span className="lp-spinner" /> Creating password…</>) : "Create Password & Sign In"}
          </button>
        </form>
      </AuthShell>
    );
  }

  // ── Standard signup flow (no invite token) ─────────────────────────────────

  if (done) {
    return (
      <AuthShell title="Check your email" subtitle={`We sent a confirmation link to ${email}. Click it to activate your account.`}>
        <Link href="/login" className="lp-btn lp-btn-passkey" style={{ textDecoration: "none" }}>
          Back to login
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create your account" subtitle="Set up your DA Platform login.">
      <form onSubmit={e => void handleSubmit(e)} noValidate style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div>
          <label className="lp-label" htmlFor="fullName">Full name</label>
          <input
            id="fullName"
            className="lp-input"
            type="text"
            autoComplete="name"
            required
            placeholder="Jane Smith"
            value={fullName}
            onChange={e => setFullName(e.target.value)}
          />
        </div>

        <div>
          <label className="lp-label" htmlFor="email">Email address</label>
          <input
            id="email"
            className="lp-input"
            type="email"
            autoComplete="email"
            required
            placeholder="you@dealership.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
        </div>

        <div>
          <label className="lp-label" htmlFor="password">Password</label>
          <input
            id="password"
            className="lp-input"
            type="password"
            autoComplete="new-password"
            required
            placeholder="Min. 6 characters"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
        </div>

        <div>
          <label className="lp-label" htmlFor="confirm">Confirm password</label>
          <input
            id="confirm"
            className="lp-input"
            type="password"
            autoComplete="new-password"
            required
            placeholder="Repeat password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
          />
        </div>

        {error && (
          <div role="alert" className="lp-server-error">
            <IconAlert style={{ marginTop: 2, flexShrink: 0, color: "var(--da-red)" }} />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          className="lp-btn lp-btn-primary"
          disabled={loading || !fullName || !email || !password || !confirm}
        >
          {loading ? (<><span className="lp-spinner" /> Creating account…</>) : "Create account"}
        </button>

        <p style={{ marginTop: 8, textAlign: "center", fontSize: 14, color: "var(--da-text-muted)" }}>
          Already have an account?{" "}
          <Link href="/login" className="lp-btn-link">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={
      <AuthShell title="Welcome to DA Platform" subtitle="Loading…">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 0", color: "var(--da-text-soft)", fontSize: 14 }}>
          <span className="lp-spinner" style={{ marginRight: 8 }} />
          One moment…
        </div>
      </AuthShell>
    }>
      <SignupPageInner />
    </Suspense>
  );
}
