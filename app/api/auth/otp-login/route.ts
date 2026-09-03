import { NextRequest, NextResponse } from "next/server";
import { recordAuthEvent } from "@/lib/auth-events";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { sendOtpCode } from "@/lib/migration-invite";
import { rateLimit } from "@/lib/rate-limit";
import { resolveBrandForHost, normalizeHost } from "@/lib/brand";
import {
  PENDING_INVITATION_COLUMNS,
  isPendingInvitation,
  resendPendingInvitationEmail,
  type PendingInvitationRow,
} from "@/lib/invite-resend";

// Zero-UUID system actor for admin_audit rows with no human admin behind them
// (same convention as CRON_SYSTEM_USER_ID in lib/feed-push-runner.ts).
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

// POST /api/auth/otp-login  { email }
// Passwordless sign-in fallback: emails a one-time code to an EXISTING auth
// user so they can sign in via /login's code step (then verifyOtp). Unauthed,
// so: rate-limited per IP and per email, guarded on user existence (generateLink
// would otherwise create a user), and ALWAYS returns { ok: true } regardless of
// whether the email has an account — no enumeration (mirrors /api/onboard/resend).
//
// PENDING-INVITATION FALLBACK: an invitee who hasn't set up their account yet
// (no profile/auth user) but HAS a live invitation almost always lands here
// first — they got the invite email, then went to the login page and asked for
// a code that can never arrive. Instead of the silent dead-end, re-send their
// invitation (fresh setup code, same email template) so the email that shows
// up actually gets them in. The response stays identical either way — the
// client's neutral copy covers both the account and invitation cases, so
// nothing is enumerable.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`otp-login-ip:${ip}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many requests — please wait a moment." }, { status: 429 });
  }

  let email: string | undefined;
  let next: string | undefined;
  try {
    ({ email, next } = (await req.json()) as { email?: string; next?: string });
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
    recordAuthEvent({ event: "otp_code_requested", result: "failure", email, detail: "per-email throttle", req });
    return NextResponse.json({ ok: true });
  }

  // A sign-in code was asked for. This is NOT a login — the verify happens
  // client-side and reports separately as otp_verify — but it is the signal the
  // 2026-09-03 investigation had to reconstruct from Mandrill, so record it.
  // Logged regardless of whether the address turns out to exist, because the
  // route's response is deliberately non-enumerable either way.
  recordAuthEvent({ event: "otp_code_requested", result: "success", email, req });

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
        ...(next ? { next } : {}),
        ...(brand.isDefault ? {} : { brandName: brand.displayName, loginUrl: `https://${host}/login` }),
      });
    } else {
      // No profile → no account to send a login code to. If this email has a
      // live pending invitation (staff/dealer/group/migration — they all share
      // the invitations store), auto-re-send it so the invitee isn't stranded.
      // Escape ilike wildcards — the lookup must be an exact (case-insensitive)
      // match, never a pattern an attacker could use to fuzzy-probe invitations.
      const exactEmail = email.replace(/[\\%_]/g, (m) => `\\${m}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: inv } = await (admin as any)
        .from("invitations")
        .select(PENDING_INVITATION_COLUMNS)
        .ilike("email", exactEmail)
        .is("accepted_at", null)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle() as { data: PendingInvitationRow | null };

      // Expired/consumed/absent invitations stay silent (same as unknown email).
      // Throttle the auto-resend hard (once per 10 min, keyed on the MATCHED
      // invitation) so hammering the OTP form can't spam an invitee's inbox.
      // The in-memory limiter is per-worker (PM2 cluster runs 2), so the real
      // gate is the audit ledger: a successful otp_fallback resend in the last
      // 10 min blocks another, cluster-wide. (No audit row is written when the
      // send fails, so a transient email failure stays retryable.)
      let recentlyResent = false;
      if (isPendingInvitation(inv)) {
        const { data: recent } = await admin
          .from("admin_audit")
          .select("id")
          .eq("action", "invitation_resent")
          .contains("metadata", { invitation_id: inv.id })
          .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString())
          .limit(1)
          .maybeSingle();
        recentlyResent = !!recent;
      }
      if (isPendingInvitation(inv) && !recentlyResent && rateLimit(`otp-login-invite-resend:${inv.id}`, 1, 10 * 60_000)) {
        await resendPendingInvitationEmail(admin, inv);
        fireWrite(admin.from("admin_audit").insert({
          admin_user_id: SYSTEM_USER_ID,
          action: "invitation_resent",
          metadata: {
            source: "otp_fallback",
            email,
            invitation_id: inv.id,
            role: inv.role,
            purpose: inv.purpose ?? "standard",
            dealer_uuid: inv.dealer_id,
            group_id: inv.group_id,
          },
        }), "admin_audit");
      }
    }
  } catch (err) {
    console.error("[auth/otp-login] failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true });
}
