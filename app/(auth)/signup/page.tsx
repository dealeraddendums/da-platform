"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const router = useRouter();

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setLoading(true);

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
      },
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    setDone(true);
    setLoading(false);
    // If email confirmation is disabled in Supabase, redirect immediately
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="w-full max-w-sm">
      {/* Logo */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center gap-2">
          <img
            src="/images/da-logo.png"
            alt="DA"
            width={32}
            height={32}
            style={{ borderRadius: "50%" }}
          />
          <span
            className="text-xl font-semibold"
            style={{ color: "var(--text-inverse)" }}
          >
            DA Platform
          </span>
        </div>
      </div>

      <div className="card p-8">
        {done ? (
          <div className="text-center">
            <div
              className="text-2xl mb-3"
              style={{ color: "var(--success)" }}
            >
              ✓
            </div>
            <h2 className="text-lg font-semibold mb-2">Check your email</h2>
            <p
              className="text-sm"
              style={{ color: "var(--text-secondary)" }}
            >
              We sent a confirmation link to{" "}
              <strong>{email}</strong>. Click it to activate your account.
            </p>
          </div>
        ) : (
          <>
            <h1
              className="text-lg font-semibold mb-6"
              style={{ color: "var(--text-primary)" }}
            >
              Create your account
            </h1>

            <form onSubmit={handleSubmit} noValidate>
              <div className="mb-4">
                <label className="label" htmlFor="fullName">
                  Full name
                </label>
                <input
                  id="fullName"
                  className="input"
                  type="text"
                  autoComplete="name"
                  required
                  placeholder="Jane Smith"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </div>

              <div className="mb-4">
                <label className="label" htmlFor="email">
                  Email address
                </label>
                <input
                  id="email"
                  className="input"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@dealership.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <div className="mb-4">
                <label className="label" htmlFor="password">
                  Password
                </label>
                <input
                  id="password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder="Min. 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              <div className="mb-6">
                <label className="label" htmlFor="confirm">
                  Confirm password
                </label>
                <input
                  id="confirm"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder="Repeat password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>

              {error && (
                <div
                  className="mb-4 px-3 py-2 rounded text-sm"
                  style={{
                    background: "#ffebee",
                    color: "#c62828",
                    border: "1px solid #ffcdd2",
                  }}
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={loading || !fullName || !email || !password || !confirm}
              >
                {loading ? "Creating account…" : "Create account"}
              </button>
            </form>

            <p
              className="mt-6 text-center text-sm"
              style={{ color: "var(--text-secondary)" }}
            >
              Already have an account?{" "}
              <Link href="/login" style={{ color: "var(--blue)" }}>
                Sign in
              </Link>
            </p>
          </>
        )}
      </div>

      <p
        className="mt-6 text-center text-xs"
        style={{ color: "rgba(255,255,255,0.45)" }}
      >
        © {new Date().getFullYear()} DealerAddendums. All rights reserved.
      </p>
    </div>
  );
}
