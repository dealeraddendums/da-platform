"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthShell } from "../shell";
import OtpCodeForm from "../OtpCodeForm";
import PasskeySetup from "../PasskeySetup";

function OnboardInner() {
  const searchParams = useSearchParams();
  const emailParam = searchParams.get("email") ?? "";
  const [step, setStep] = useState<"code" | "passkey">("code");

  if (step === "passkey") {
    return (
      <AuthShell title="Set up your passkey" subtitle="Sign in instantly next time with Face ID, Touch ID, or your device PIN — no password to remember.">
        <PasskeySetup
          onDone={() => { window.location.href = "/dashboard"; }}
          onSkip={() => { window.location.href = "/dashboard"; }}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Enter your code" subtitle="We emailed you a verification code to finish setting up your account.">
      <OtpCodeForm
        initialEmail={emailParam}
        resendEndpoint="/api/onboard/resend"
        onVerified={() => setStep("passkey")}
        footer={
          <p style={{ textAlign: "center", fontSize: 14, color: "var(--da-text-muted)" }}>
            Already set up? <Link href="/login" className="lp-btn-link">Sign in</Link>
          </p>
        }
      />
    </AuthShell>
  );
}

export default function OnboardPage() {
  return (
    <Suspense fallback={
      <AuthShell title="Welcome to DA Platform" subtitle="Loading…">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 0", color: "var(--da-text-soft)", fontSize: 14 }}>
          <span className="lp-spinner" style={{ marginRight: 8 }} />
          One moment…
        </div>
      </AuthShell>
    }>
      <OnboardInner />
    </Suspense>
  );
}
