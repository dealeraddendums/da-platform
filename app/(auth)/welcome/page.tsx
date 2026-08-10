// /welcome — landing target for Platform 4.0's per-dealership "Migrated"
// lockout redirect (spec-shawon-40-migrated-lockout.md):
//
//   https://app.dealeraddendums.com/welcome?from=40&email={user email}
//
// Audience: dealership staff who may have never logged into 5.0 — some have
// accounts (multi-admin invites), some have pending invitations, some have
// nothing. Public/unauthenticated; signed-in visitors are bounced straight to
// /dashboard by middleware (same as /login).
//
// Personalization: if the email resolves to a profile with a dealer, the
// headline names the dealership; otherwise generic copy. The sign-in path is
// the existing OTP flow (/api/auth/otp-login), which handles every account
// state non-enumerably (42be0f7): existing account → sign-in code, pending
// invitation → invite auto-resent, nothing → silence. Neutral copy either way.

import { headers } from "next/headers";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveBrandForHost } from "@/lib/brand";
import { AuthShell } from "../shell";
import WelcomeForm from "./WelcomeForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Welcome — DealerAddendums 5.0" };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// PostgREST ilike pattern escaping (same discipline as lib/invite-resend.ts —
// never let % or _ from a query param widen the match).
function escapeIlike(v: string): string {
  return v.replace(/([%_\\])/g, "\\$1");
}

async function resolveDealerName(email: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminSupabaseClient() as any;
    const { data: prof } = await admin
      .from("profiles")
      .select("dealer_id")
      .ilike("email", escapeIlike(email))
      .not("dealer_id", "is", null)
      .neq("dealer_id", "")
      .limit(1)
      .maybeSingle();
    if (!prof?.dealer_id) return null;
    const { data: dealer } = await admin
      .from("dealers")
      .select("name")
      .eq("dealer_id", prof.dealer_id)
      .maybeSingle();
    return (dealer?.name as string | undefined)?.trim() || null;
  } catch {
    return null; // resolution is best-effort — fall back to the generic headline
  }
}

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const rawEmail = typeof searchParams.email === "string" ? searchParams.email : "";
  const from = typeof searchParams.from === "string" ? searchParams.from : "";
  const email = rawEmail.trim().toLowerCase();
  const emailValid = EMAIL_RE.test(email);

  const dealerName = emailValid ? await resolveDealerName(email) : null;

  // Arrival tracking for the 4.0 lockout rollout — greppable in PM2:
  //   pm2 logs da-platform | grep "\[welcome\] arrival"
  console.log(
    `[welcome] arrival from=${from || "direct"} email=${emailValid ? email : "none"} dealer=${dealerName ?? "unresolved"}`,
  );

  const brand = await resolveBrandForHost(headers().get("host"));
  const platformName = brand.isDefault ? "DealerAddendums 5.0" : brand.displayName;

  const title = dealerName
    ? `${dealerName}’s addendum platform has moved`
    : `Your dealership has moved to ${platformName}`;

  return (
    <AuthShell
      title={title}
      subtitle="Everything came over with it — your products, templates, and printing all work the same. This is your team's new home for printing addendums, so bookmark this page."
    >
      <WelcomeForm initialEmail={emailValid ? email : ""} />
    </AuthShell>
  );
}
