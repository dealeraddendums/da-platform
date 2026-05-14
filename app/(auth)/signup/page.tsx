"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

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
  if (pw.length < 8) return { pct: 25, label: "Too short", color: "#ff5252" };
  if (score <= 2) return { pct: 40, label: "Weak", color: "#f57c00" };
  if (score === 3) return { pct: 65, label: "Fair", color: "#fbc02d" };
  if (score === 4) return { pct: 85, label: "Strong", color: "#4caf50" };
  return { pct: 100, label: "Excellent", color: "#2e7d32" };
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
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match. Please re-enter."); return; }
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

    if (password !== confirm) { setError("Passwords do not match."); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }

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

  const logo = (
    <div className="text-center mb-8">
      <div className="inline-flex items-center gap-2">
        <img src="/images/da-logo.png" alt="DA" width={32} height={32} style={{ borderRadius: "50%" }} />
        <span className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>DA Platform</span>
      </div>
    </div>
  );

  const footer = (
    <p className="mt-6 text-center text-xs" style={{ color: "rgba(255,255,255,0.45)" }}>
      © {new Date().getFullYear()} DealerAddendums. All rights reserved.
    </p>
  );

  // ── Invite flow ──────────────────────────────────────────────────────────────
  if (inviteToken) {
    if (inviteLoading) {
      return (
        <div className="w-full max-w-sm">
          {logo}
          <div className="card p-8 text-center" style={{ color: "var(--text-muted)", fontSize: 14 }}>
            Loading invitation…
          </div>
          {footer}
        </div>
      );
    }

    if (inviteError) {
      return (
        <div className="w-full max-w-sm">
          {logo}
          <div className="card p-8 text-center">
            <p style={{ color: "#c62828", fontSize: 14, marginBottom: 16 }}>{inviteError}</p>
            <Link href="/login" style={{ color: "var(--blue)", fontSize: 14 }}>Go to login</Link>
          </div>
          {footer}
        </div>
      );
    }

    const strength = passwordStrength(password);
    const passwordsMatch = password.length > 0 && password === confirm;
    const ready = !loading && password.length >= 8 && passwordsMatch;

    return (
      <div className="w-full max-w-sm">
        {logo}
        <div className="card p-8">
          <h1 className="text-xl font-semibold mb-1" style={{ color: "var(--text-primary)" }}>
            Welcome to DA Platform
          </h1>
          <p className="text-sm mb-1" style={{ color: "var(--text-secondary)" }}>
            Create a password to complete your account setup
          </p>
          {inviteDetails && (
            <p className="text-xs mt-3 mb-6 px-3 py-2 rounded" style={{ background: "var(--bg-subtle)", color: "var(--text-secondary)" }}>
              Invited to <strong>{inviteDetails.dealerName}</strong> as{" "}
              <strong>{inviteDetails.role.replace(/_/g, " ")}</strong>.
            </p>
          )}

          <form onSubmit={e => void handleInviteSubmit(e)} noValidate>
            <div className="mb-4">
              <label className="label">Email address</label>
              <input className="input" type="email" value={email} readOnly
                style={{ background: "var(--bg-subtle)", color: "var(--text-muted)", cursor: "not-allowed" }} />
            </div>

            <div className="mb-3">
              <label className="label" htmlFor="inv-password">New Password</label>
              <input
                id="inv-password"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                placeholder="At least 8 characters"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
              {password.length > 0 && (
                <div className="mt-1 flex items-center gap-2" style={{ fontSize: 11 }}>
                  <div style={{ flex: 1, height: 4, background: "var(--bg-subtle)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{
                      width: `${strength.pct}%`,
                      height: "100%",
                      background: strength.color,
                      transition: "width 150ms, background 150ms",
                    }} />
                  </div>
                  <span style={{ color: strength.color, fontWeight: 500, minWidth: 56, textAlign: "right" }}>
                    {strength.label}
                  </span>
                </div>
              )}
            </div>

            <div className="mb-2">
              <label className="label" htmlFor="inv-confirm">Confirm Password</label>
              <input
                id="inv-confirm"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                placeholder="Repeat password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                style={{
                  borderColor: confirm.length > 0 && !passwordsMatch ? "#ff5252" : undefined,
                }}
              />
              {confirm.length > 0 && !passwordsMatch && (
                <p className="text-xs mt-1" style={{ color: "#ff5252" }}>Passwords don&apos;t match</p>
              )}
              {passwordsMatch && (
                <p className="text-xs mt-1" style={{ color: "var(--success)" }}>✓ Passwords match</p>
              )}
            </div>

            {error && (
              <div className="mt-4 mb-2 px-3 py-2 rounded text-sm"
                style={{ background: "#ffebee", color: "#c62828", border: "1px solid #ffcdd2" }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary w-full mt-4"
              disabled={!ready}
              style={{ opacity: ready ? 1 : 0.5, cursor: ready ? "pointer" : "not-allowed" }}
            >
              {loading ? "Creating password…" : "Create Password & Sign In"}
            </button>
          </form>
        </div>
        {footer}
      </div>
    );
  }

  // ── Standard signup flow ─────────────────────────────────────────────────────
  return (
    <div className="w-full max-w-sm">
      {logo}
      <div className="card p-8">
        {done ? (
          <div className="text-center">
            <div className="text-2xl mb-3" style={{ color: "var(--success)" }}>✓</div>
            <h2 className="text-lg font-semibold mb-2">Check your email</h2>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              We sent a confirmation link to <strong>{email}</strong>. Click it to activate your account.
            </p>
          </div>
        ) : (
          <>
            <h1 className="text-lg font-semibold mb-6" style={{ color: "var(--text-primary)" }}>
              Create your account
            </h1>

            <form onSubmit={e => void handleSubmit(e)} noValidate>
              <div className="mb-4">
                <label className="label" htmlFor="fullName">Full name</label>
                <input id="fullName" className="input" type="text" autoComplete="name" required
                  placeholder="Jane Smith" value={fullName} onChange={e => setFullName(e.target.value)} />
              </div>

              <div className="mb-4">
                <label className="label" htmlFor="email">Email address</label>
                <input id="email" className="input" type="email" autoComplete="email" required
                  placeholder="you@dealership.com" value={email} onChange={e => setEmail(e.target.value)} />
              </div>

              <div className="mb-4">
                <label className="label" htmlFor="password">Password</label>
                <input id="password" className="input" type="password" autoComplete="new-password" required
                  placeholder="Min. 6 characters" value={password} onChange={e => setPassword(e.target.value)} />
              </div>

              <div className="mb-6">
                <label className="label" htmlFor="confirm">Confirm password</label>
                <input id="confirm" className="input" type="password" autoComplete="new-password" required
                  placeholder="Repeat password" value={confirm} onChange={e => setConfirm(e.target.value)} />
              </div>

              {error && (
                <div className="mb-4 px-3 py-2 rounded text-sm"
                  style={{ background: "#ffebee", color: "#c62828", border: "1px solid #ffcdd2" }}>
                  {error}
                </div>
              )}

              <button type="submit" className="btn btn-primary w-full"
                disabled={loading || !fullName || !email || !password || !confirm}>
                {loading ? "Creating account…" : "Create account"}
              </button>
            </form>

            <p className="mt-6 text-center text-sm" style={{ color: "var(--text-secondary)" }}>
              Already have an account?{" "}
              <Link href="/login" style={{ color: "var(--blue)" }}>Sign in</Link>
            </p>
          </>
        )}
      </div>
      {footer}
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2">
            <img src="/images/da-logo.png" alt="DA" width={32} height={32} style={{ borderRadius: "50%" }} />
            <span className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>DA Platform</span>
          </div>
        </div>
        <div className="card p-8 text-center" style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading…</div>
      </div>
    }>
      <SignupPageInner />
    </Suspense>
  );
}
