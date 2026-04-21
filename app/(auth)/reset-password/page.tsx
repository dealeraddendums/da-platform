"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      // Clear the force_password_reset flag via API
      const res = await fetch("/api/auth/clear-force-reset", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Failed to clear reset flag");
      }

      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
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
          <div
            className="w-8 h-8 rounded flex items-center justify-center font-bold text-white text-sm"
            style={{ background: "var(--orange)" }}
          >
            D
          </div>
          <span className="font-semibold text-base" style={{ color: "var(--text-primary)" }}>
            DA Platform
          </span>
        </div>

        <h1 className="text-xl font-semibold mb-1" style={{ color: "var(--text-primary)" }}>
          Set your password
        </h1>
        <p className="text-sm mb-6" style={{ color: "var(--text-secondary)" }}>
          Your account requires a new password before continuing.
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

          <button
            type="submit"
            disabled={loading}
            className="w-full font-medium text-sm rounded text-white"
            style={{
              height: 36,
              background: loading ? "#a5d6a7" : "var(--success)",
              cursor: loading ? "not-allowed" : "pointer",
              border: "none",
            }}
          >
            {loading ? "Saving…" : "Set password & continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
