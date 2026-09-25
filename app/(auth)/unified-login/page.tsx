import { Suspense } from "react";
import { AuthShell } from "../shell";
import { LoginForm } from "../LoginForm";

// Unified front door (Phase 2). Same form as /login (password + passkey + OTP),
// but the password submit runs server-side (POST /api/auth/login) so it routes
// dealers to 4.0 or 5.0. When UNIFIED_LOGIN_LIVE is set, middleware redirects
// /login here; unset it to instantly fall back to the classic /login.
export default function UnifiedLoginPage() {
  return (
    <AuthShell title="Sign in" subtitle="Access your DealerAddendums account">
      <Suspense fallback={<div style={{ height: 320 }} />}>
        <LoginForm unified />
      </Suspense>
    </AuthShell>
  );
}
