"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthShell } from "../shell";

// Unified front door (Phase 2). One form for both platforms; routing happens
// server-side in POST /api/auth/login. The browser only ever posts to our own
// origin — the 4.0 API key and credentials never reach client JS.

function UnifiedLoginForm() {
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) { setError("Enter your username and password."); return; }
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password, next }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok && typeof data.redirect === "string") {
        // 5.0 success sets our session cookies on this response; 4.0 success
        // hands back the one-time redeem URL. Either way, navigate now.
        window.location.assign(data.redirect);
        return;
      }
      setError(data?.error || "Login failed. Please try again.");
    } catch {
      setError("Login failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="lp-field">
        <label className="lp-label" htmlFor="username">Username</label>
        <input
          id="username"
          type="text"
          autoComplete="username"
          className="lp-input"
          placeholder="Username or email"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
      </div>

      <div className="lp-field">
        <div className="lp-label-row">
          <label className="lp-label" htmlFor="password">Password</label>
          <a className="lp-btn-link" href="/reset-password">Forgot password?</a>
        </div>
        <div className="lp-pw-wrap">
          <input
            id="password"
            type={showPw ? "text" : "password"}
            autoComplete="current-password"
            className="lp-input"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="button" className="lp-pw-toggle" onClick={() => setShowPw((s) => !s)} aria-label={showPw ? "Hide password" : "Show password"}>
            {showPw ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {error && <div role="alert" className="lp-server-error">{error}</div>}

      <button type="submit" className="lp-btn lp-btn-primary" disabled={submitting}>
        {submitting ? <><span className="lp-spinner" /> Signing in…</> : "Sign in"}
      </button>
    </form>
  );
}

export default function UnifiedLoginPage() {
  return (
    <AuthShell title="Sign in" subtitle="Access your DealerAddendums account">
      <Suspense fallback={null}>
        <UnifiedLoginForm />
      </Suspense>
    </AuthShell>
  );
}
