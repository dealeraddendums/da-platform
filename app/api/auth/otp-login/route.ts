import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendOtpCode } from "@/lib/migration-invite";
import { rateLimit } from "@/lib/rate-limit";
import { resolveBrandForHost, normalizeHost } from "@/lib/brand";

// POST /api/auth/otp-login  { email }
// Passwordless sign-in fallback: emails a one-time code to an EXISTING auth
// user so they can sign in via /login's code step (then verifyOtp). Unauthed,
// so: rate-limited per IP and per email, guarded on user existence (generateLink
// would otherwise create a user), and ALWAYS returns { ok: true } regardless of
// whether the email has an account — no enumeration (mirrors /api/onboard/resend).
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`otp-login-ip:${ip}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many requests — please wait a moment." }, { status: 429 });
  }

  let email: string | undefined;
  try {
    ({ email } = (await req.json()) as { email?: string });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  email = email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }

  // Per-email throttle: silently drop (still { ok: true }) so a hammered email
  // neither leaks nor gets spammed.
  if (!rateLimit(`otp-login-email:${email}`, 3, 5 * 60_000)) {
    return NextResponse.json({ ok: true });
  }

  try {
    const admin = createAdminSupabaseClient();
    // Only send when a profile exists for this email — the don't-create-users
    // guard. (Don't query the `auth` schema: it isn't exposed to the data API,
    // so admin.schema("auth").from("users") always returns nothing — same root
    // cause as the Users-page "Last sign in: Never". The profiles table is the
    // reliable, case-insensitive existence signal.)
    const { data: profile } = await admin
      .from("profiles").select("full_name").ilike("email", email)
      .maybeSingle<{ full_name: string | null }>();

    if (profile) {
      // White-label: when the request originated on a reseller host, brand the
      // email to that host (name + login URL). Canonical/unknown hosts resolve
      // to the default DA brand and get the unchanged DealerAddendums email.
      const host = normalizeHost(req.headers.get("host"));
      const brand = await resolveBrandForHost(host);
      await sendOtpCode(email, {
        purpose: "login",
        fullName: profile.full_name,
        ...(brand.isDefault ? {} : { brandName: brand.displayName, loginUrl: `https://${host}/login` }),
      });
    }
  } catch (err) {
    console.error("[auth/otp-login] failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true });
}
