"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    router.push(next);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
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

      <div className="mb-6">
        <div className="flex items-center justify-between mb-[6px]">
          <label className="label mb-0" htmlFor="password">
            Password
          </label>
          <a href="#" className="text-xs" style={{ color: "var(--blue)" }}>
            Forgot password?
          </a>
        </div>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete="current-password"
          required
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
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
        className="btn btn-success w-full"
        disabled={loading || !email || !password}
      >
        {loading ? "Signing in…" : "LOG IN"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="w-full max-w-sm">
      {/* Logo / wordmark */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center gap-2 mb-2">
          <div
            className="w-8 h-8 rounded flex items-center justify-center text-white font-bold text-lg"
            style={{ background: "var(--orange)" }}
          >
            D
          </div>
          <span
            className="text-xl font-semibold"
            style={{ color: "var(--text-inverse)" }}
          >
            DA Platform
          </span>
        </div>
        <p className="text-sm" style={{ color: "rgba(255,255,255,0.65)" }}>
          DealerAddendums
        </p>
      </div>

      {/* Card */}
      <div className="card p-8">
        <h1
          className="text-lg font-semibold mb-6"
          style={{ color: "var(--text-primary)" }}
        >
          Sign in to your account
        </h1>

        <Suspense fallback={<div className="h-40" />}>
          <LoginForm />
        </Suspense>

        <p
          className="mt-6 text-center text-sm"
          style={{ color: "var(--text-secondary)" }}
        >
          Don&apos;t have an account?{" "}
          <Link href="/signup" style={{ color: "var(--blue)" }}>
            Sign up
          </Link>
        </p>
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
