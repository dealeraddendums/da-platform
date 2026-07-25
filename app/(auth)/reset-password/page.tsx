"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

/**
 * Dual-purpose password page:
 *   - FORCED reset (app_metadata.force_password_reset) — middleware pins the
 *     user here until they set a password; continue to /dashboard.
 *   - VOLUNTARY change — reached via the profile "Change Password →" link;
 *     returns to /profile?tab=security with an explicit success state.
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [forced, setForced] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    void supabase.auth.getSession().then(({ data: { session } }) => {
      setForced(session?.user.app_metadata?.force_password_reset === true);
    });
  }, []);

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

      // Clear the force_password_reset flag via API (no-op when not forced)
      const res = await fetch("/api/auth/clear-force-reset", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Failed to clear reset flag");
      }

      setSuccess(true);
      setTimeout(() => {
        router.push(forced ? "/dashboard" : "/profile?tab=security");
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
          {forced ? "Set your password" : "Change your password"}
        </h1>
        <p className="text-sm mb-6" style={{ color: "var(--text-secondary)" }}>
          {forced
            ? "Your account requires a new password before continuing."
            : "Choose a new password for your account."}
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
            {success ? "Password updated ✓" : loading ? "Saving…" : forced ? "Set password & continue" : "Change password"}
          </button>

          {!forced && !success && (
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
