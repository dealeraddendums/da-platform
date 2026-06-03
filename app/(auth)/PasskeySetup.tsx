"use client";

import { useState } from "react";

function IconAlert(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

/**
 * Shared passkey-registration step — reused by /onboard (after the onboarding
 * code) and login (offered after an OTP sign-in when the user has no passkey).
 * Requires an authenticated session (register-start reads the session cookie),
 * so only render after a successful verifyOtp. WebAuthn needs a user gesture, so
 * this is a button, with a skip. onDone fires on successful registration; onSkip
 * when the user defers.
 */
export default function PasskeySetup({
  onDone,
  onSkip,
}: {
  onDone: () => void;
  onSkip: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handlePasskey() {
    setError("");
    setLoading(true);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");

      const startRes = await fetch("/api/auth/passkey/register-start", { method: "POST" });
      if (!startRes.ok) {
        const d = await startRes.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Could not start passkey setup.");
      }
      const options = await startRes.json();

      let credential;
      try {
        credential = await startRegistration({ optionsJSON: options });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("cancelled") || msg.includes("NotAllowedError")) {
          throw new Error("Passkey setup was cancelled. Try again, or skip for now.");
        }
        throw err;
      }

      const completeRes = await fetch("/api/auth/passkey/register-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      if (!completeRes.ok) {
        const d = await completeRes.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Passkey setup failed.");
      }

      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey setup failed.");
      setLoading(false);
    }
  }

  return (
    <>
      {error && (
        <div role="alert" className="lp-server-error" style={{ marginBottom: 18 }}>
          <IconAlert style={{ marginTop: 2, flexShrink: 0, color: "var(--da-red)" }} />
          <span>{error}</span>
        </div>
      )}
      <button type="button" className="lp-btn lp-btn-primary" disabled={loading} onClick={() => void handlePasskey()}>
        {loading ? (<><span className="lp-spinner" /> Setting up…</>) : "Set up passkey"}
      </button>
      <p style={{ marginTop: 14, textAlign: "center", fontSize: 14 }}>
        <button type="button" className="lp-btn-link" onClick={onSkip} style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}>
          Skip for now
        </button>
      </p>
    </>
  );
}
