"use client";

// /welcome sign-in form — one input, one button. Continue fires the existing
// OTP flow (/api/auth/otp-login), which is already correct and non-enumerable
// for every account state (existing account → sign-in code; pending
// invitation → invite auto-resent with its setup code; unknown → silence).
// Code entry happens inline (shared OtpCodeForm) so account-holders finish
// sign-in right here and land on the dashboard.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useBrand } from "@/contexts/Brand";
import OtpCodeForm from "../OtpCodeForm";

const APP_STORE_URL = "https://apps.apple.com/us/app/dealeraddendums-5-0/id6788451484";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function WelcomeForm({ initialEmail }: { initialEmail: string }) {
  const router = useRouter();
  const brand = useBrand();
  const [email, setEmail] = useState(initialEmail);
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<"start" | "code">("start");
  const [codeEmail, setCodeEmail] = useState("");

  const emailValid = EMAIL_RE.test(email.trim());
  const emailError = touched && !emailValid ? (email ? "Enter a valid email address" : "Email is required") : null;

  async function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!emailValid) return;
    setSending(true);
    const clean = email.trim().toLowerCase();
    try {
      await fetch("/api/auth/otp-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: clean }),
      });
    } catch {
      // otp-login always reports success; ignore transport errors and proceed
    }
    setCodeEmail(clean);
    setSending(false);
    setMode("code");
  }

  function goDashboard() {
    router.push("/dashboard");
    router.refresh();
  }

  if (mode === "code") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Neutral copy — identical whether the email has an account, a pending
            invitation (otp-login auto-resends it), or nothing. Never reveal which. */}
        <p style={{ fontSize: 14, color: "var(--da-text-soft)", margin: 0 }}>
          We&apos;ve sent a code to <strong>{codeEmail}</strong> — check for an email from
          DealerAddendums. Enter the sign-in code below. If you were invited to set up a new
          account, use the setup link in that email instead.
        </p>
        <OtpCodeForm
          initialEmail={codeEmail}
          resendEndpoint="/api/auth/otp-login"
          onVerified={goDashboard}
          footer={
            <p style={{ textAlign: "center", fontSize: 14, color: "var(--da-text-muted)" }}>
              <button
                type="button"
                onClick={() => setMode("start")}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--da-text-muted)", font: "inherit" }}
              >
                &larr; Use a different email
              </button>
            </p>
          }
        />
        <NoEmailHelp />
      </div>
    );
  }

  return (
    <form onSubmit={handleContinue} noValidate style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <label className="lp-label" htmlFor="welcome-email">Your work email</label>
        <input
          id="welcome-email"
          type="email"
          className={`lp-input${emailError ? " lp-input-error" : ""}`}
          placeholder="you@dealership.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setTouched(true)}
          autoComplete="email"
          inputMode="email"
        />
        {emailError && (
          <div className="lp-field-error"><span>{emailError}</span></div>
        )}
      </div>

      <button type="submit" className="lp-btn lp-btn-primary" disabled={sending}>
        {sending ? "Sending…" : "Continue"}
      </button>

      <p style={{ fontSize: 13, color: "var(--da-text-soft)", margin: 0 }}>
        We&apos;ll email you a sign-in code — no password needed. If you were invited but haven&apos;t
        set up your account yet, your invitation will be re-sent automatically.
      </p>

      <NoEmailHelp />

      {/* Footer row — DA-branded links, hidden on white-label hosts (same
          host-resolved discipline as AuthHeaderLinks / LoginFooter). */}
      {brand.isDefault && (
        <p style={{ display: "flex", gap: 14, justifyContent: "center", fontSize: 13, margin: 0, borderTop: "1px solid var(--da-line)", paddingTop: 14 }}>
          <a href={APP_STORE_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--da-blue)", textDecoration: "none" }}>
            Get the iPhone app
          </a>
          <span aria-hidden style={{ color: "var(--da-line-strong)" }}>·</span>
          <a href="mailto:support@dealeraddendums.com" style={{ color: "var(--da-blue)", textDecoration: "none" }}>
            Help
          </a>
        </p>
      )}
    </form>
  );
}

function NoEmailHelp() {
  const brand = useBrand();
  return (
    <details style={{ fontSize: 13, color: "var(--da-text-muted)" }}>
      <summary style={{ cursor: "pointer", userSelect: "none" }}>No email after a minute?</summary>
      <div style={{ paddingTop: 8, lineHeight: 1.5 }}>
        Check your spam folder first. Still nothing? You may not have an account yet — ask your
        manager to add you from their <strong>Users</strong> page
        {brand.isDefault ? (
          <>
            , or contact <a href="mailto:support@dealeraddendums.com" style={{ color: "var(--da-blue)" }}>support@dealeraddendums.com</a>{" "}
            / 801-415-9435.
          </>
        ) : (
          <> or your platform administrator.</>
        )}
      </div>
    </details>
  );
}
