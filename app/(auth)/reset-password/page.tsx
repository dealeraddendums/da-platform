"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Voluntary change-password page — reached via the profile "Change Password →"
 * link; returns to /profile?tab=security with an explicit success state.
 *
 * DealerAddendums never FORCES a password reset (Allan, 2026-10-12): nothing
 * pins users here any more. Saving a password still clears any leftover
 * force_password_reset flag, so the account reads as a normal one everywhere.
 */
export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const supabase = createClient();

      // Update the password
      const { error: updateErr } = await supabase.auth.updateUser({ password });
      if (updateErr) throw new Error(updateErr.message);

      // Clear any leftover force_password_reset flag (no-op when not set)
      const res = await fetch("/api/auth/clear-force-reset", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Your password was saved, but we couldn't finish setting up your account. Sign out and sign back in.");
      }

      // Refresh so the session cookie carries a token minted from the updated
      // user (app_metadata in the old token is stale), then a full page load.
      const { error: refreshErr } = await supabase.auth.refreshSession();
      if (refreshErr) {
        throw new Error("Your password was saved. Sign out and sign back in with your new password to continue.");
      }

      setSuccess(true);
      setTimeout(() => {
        window.location.assign("/profile?tab=security");
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: "var(--bg-app)" }}
    >
      <div
        className="w-full max-w-sm rounded-lg p-8"
        style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
      >
        {/* Logo */}
        <div className="flex items-center gap-2 mb-6">
          <img
            src="/images/da-logo.png"
            alt="DA"
            width={32}
            height={32}
            style={{ borderRadius: "50%" }}
          />
          <span className="font-semibold text-base" style={{ color: "var(--text-primary)" }}>
            DA Platform
          </span>
        </div>

        <h1 className="text-xl font-semibold mb-1" style={{ color: "var(--text-primary)" }}>
          Change your password
        </h1>
        <p className="text-sm mb-6" style={{ color: "var(--text-secondary)" }}>
          Choose a new password for your account.
        </p>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: "var(--text-primary)" }}>
              New password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoFocus
              placeholder="At least 8 characters"
              className="w-full px-3 text-sm rounded"
              style={{
                height: 36,
                border: "1px solid var(--border)",
                outline: "none",
                background: "var(--bg-subtle)",
                color: "var(--text-primary)",
              }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: "var(--text-primary)" }}>
              Confirm password
            </label>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              required
              placeholder="Repeat password"
              className="w-full px-3 text-sm rounded"
              style={{
                height: 36,
                border: "1px solid var(--border)",
                outline: "none",
                background: "var(--bg-subtle)",
                color: "var(--text-primary)",
              }}
            />
          </div>

          {error && (
            <p className="text-sm rounded px-3 py-2" style={{ background: "#ffebee", color: "#c62828" }}>
              {error}
            </p>
          )}
          {success && (
            <p className="text-sm rounded px-3 py-2" style={{ background: "#e8f5e9", color: "#2e7d32" }}>
              ✓ Password updated — taking you back…
            </p>
          )}

          <button
            type="submit"
            disabled={loading || success}
            className="w-full font-medium text-sm rounded text-white"
            style={{
              height: 36,
              background: loading || success ? "#a5d6a7" : "var(--success)",
              cursor: loading || success ? "not-allowed" : "pointer",
              border: "none",
            }}
          >
            {success ? "Password updated ✓" : loading ? "Saving…" : "Change password"}
          </button>

          {!success && (
            <a
              href="/profile?tab=security"
              className="block text-center text-sm"
              style={{ color: "#1976d2", textDecoration: "none" }}
            >
              ← Back to My Profile
            </a>
          )}
        </form>
      </div>
    </div>
  );
}
