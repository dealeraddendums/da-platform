import { NextRequest, NextResponse } from "next/server";
import { recordAuthEvent } from "@/lib/auth-events";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { sendOtpCode } from "@/lib/migration-invite";
import { rateLimit } from "@/lib/rate-limit";
import { resolveBrandForHost, normalizeHost } from "@/lib/brand";
import {
  PENDING_INVITATION_COLUMNS,
  hasLiveSetupCode,
  isMigrationInvitation,
  isPendingInvitation,
  resendPendingInvitationEmail,
  sendInvitationReminderEmail,
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
// a code that can never arrive. Rather than the silent dead-end, get them to
// the flow their invitation actually belongs to.
//
// ⚠️ 2026-09-17: the original version of this fallback always called
// resendPendingInvitationEmail, which ROTATES the setup code — so asking for a
// sign-in code silently killed the code sitting in the invitee's inbox. They
// then typed that code and got "expired/invalid" minutes after being invited,
// and every re-visit cycled it again (Envision Ford of Oxnard needed a
// phone rescue; 9 occurrences across 5 invitees). A LIVE code is therefore
// never re-issued here now. Three branches:
//
//   • live code + migration invite → respond with a redirect to
//     /migrate?invite=<token>, where their existing code works. Deliberately
//     enumerable for THIS case only (Allan's call, 2026-09-17): the redirect
//     confirms a pending migration invite for the address. No code minted, no
//     email sent.
//   • live code + standard invite  → email a reminder pointing at
//     /signup?invite=<token> that explicitly says the original code still
//     works. Response stays the neutral { ok: true }, so nothing new is
//     enumerable for this case.
//   • EXPIRED code                 → re-issue + re-send, the fallback's
//     original purpose (there is no working code left to protect).
//
// Everything else — unknown address, no invitation, existing account — returns
// exactly what it returned before.
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

  // Per-email throttle. Gates everything that SENDS (sign-in code, invitation
  // re-send, reminder) so a hammered address can't be spammed. It no longer
  // returns early: the migration redirect below sends no email, and a customer
  // who reloads /login a few times should still be routed to their flow rather
  // than dropped onto the dead-end copy.
  const emailThrottled = !rateLimit(`otp-login-email:${email}`, 3, 5 * 60_000);
  if (emailThrottled) {
    recordAuthEvent({ event: "otp_code_requested", result: "failure", email, detail: "per-email throttle", req });
  } else {
    // A sign-in code was asked for. This is NOT a login — the verify happens
    // client-side and reports separately as otp_verify — but it is the signal the
    // 2026-09-03 investigation had to reconstruct from Mandrill, so record it.
    // Logged regardless of whether the address turns out to exist, because the
    // route's response is deliberately non-enumerable either way.
    recordAuthEvent({ event: "otp_code_requested", result: "success", email, req });
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
      if (!emailThrottled) {
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
      }
    } else {
      // No profile → no account to send a login code to. If this email has a
      // live pending invitation (staff/dealer/group/migration — they all share
      // the invitations store), get the invitee to their own flow instead of
      // leaving them on a dead end.
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
      if (isPendingInvitation(inv)) {
        const liveCode = hasLiveSetupCode(inv);
        const migration = isMigrationInvitation(inv);

        if (liveCode && migration) {
          // THE FIX. Their code still works — send them to the flow that
          // accepts it and touch nothing. No mint, no email, so no throttle
          // applies and no number of /login visits can cycle the code.
          fireWrite(admin.from("admin_audit").insert({
            admin_user_id: SYSTEM_USER_ID,
            action: "invitation_login_redirect",
            metadata: {
              source: "otp_fallback",
              outcome: "redirected_to_migrate",
              code_minted: false,
              email,
              invitation_id: inv.id,
              role: inv.role,
              purpose: inv.purpose ?? "standard",
              dealer_uuid: inv.dealer_id,
              group_id: inv.group_id,
            },
          }), "admin_audit");
          return NextResponse.json({ ok: true, redirect: `/migrate?invite=${encodeURIComponent(inv.token)}&from=login` });
        }

        // Anything that SENDS is throttled: once per 10 min per invitation, so
        // hammering the OTP form can't spam an invitee's inbox. The in-memory
        // limiter is per-worker (PM2 cluster runs 2), so the real gate is the
        // audit ledger — a send logged in the last 10 min blocks another,
        // cluster-wide. (No audit row is written when the send fails, so a
        // transient email failure stays retryable.)
        const { data: recent } = await admin
          .from("admin_audit")
          .select("id")
          .in("action", ["invitation_resent", "invitation_reminder_sent"])
          .contains("metadata", { invitation_id: inv.id })
          .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString())
          .limit(1)
          .maybeSingle();
        const sendAllowed =
          !emailThrottled && !recent && rateLimit(`otp-login-invite-resend:${inv.id}`, 1, 10 * 60_000);

        if (sendAllowed && liveCode) {
          // Standard (/signup) invitation with a working code: point them at
          // their setup page WITHOUT re-issuing — the reminder email says the
          // original code still stands. Response stays neutral, so this case
          // remains as non-enumerable as it was.
          await sendInvitationReminderEmail(admin, inv);
          fireWrite(admin.from("admin_audit").insert({
            admin_user_id: SYSTEM_USER_ID,
            action: "invitation_reminder_sent",
            metadata: {
              source: "otp_fallback",
              outcome: "reminder_emailed",
              code_minted: false,
              email,
              invitation_id: inv.id,
              role: inv.role,
              purpose: inv.purpose ?? "standard",
              dealer_uuid: inv.dealer_id,
              group_id: inv.group_id,
            },
          }), "admin_audit");
        } else if (sendAllowed) {
          // Code genuinely expired — re-issue and re-send. This is the
          // fallback's original job; there is no working code left to protect.
          await resendPendingInvitationEmail(admin, inv);
          fireWrite(admin.from("admin_audit").insert({
            admin_user_id: SYSTEM_USER_ID,
            action: "invitation_resent",
            metadata: {
              source: "otp_fallback",
              outcome: "code_reissued_expired",
              code_minted: true,
              email,
              invitation_id: inv.id,
              role: inv.role,
              purpose: inv.purpose ?? "standard",
              dealer_uuid: inv.dealer_id,
              group_id: inv.group_id,
            },
          }), "admin_audit");
        }

        // A migration invite whose code had expired now has a fresh one in the
        // mail — still route them to /migrate so they don't come back here.
        if (migration && !liveCode) {
          return NextResponse.json({ ok: true, redirect: `/migrate?invite=${encodeURIComponent(inv.token)}&from=login` });
        }
      }
    }
  } catch (err) {
    console.error("[auth/otp-login] failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true });
}
