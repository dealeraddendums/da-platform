import { Suspense } from "react";
import { AuthShell } from "../shell";
import { LoginForm } from "../LoginForm";

export default function LoginPage() {
  return (
    <AuthShell title="Sign in" subtitle="Welcome back. Pick up where your team left off.">
      <Suspense fallback={<div style={{ height: 320 }} />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
