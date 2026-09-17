// Shared "re-send a pending invitation" — one implementation for every place
// that needs to re-issue a fresh setup code and re-email an unconsumed
// invitation: POST /api/invite/resend (the invitee-facing "Resend code" button)
// and the /api/auth/otp-login fallback (an invitee who went to the LOGIN page
// and asked for a sign-in code before ever setting up their account — without
// this they wait forever for a code that can't come).
//
// Non-consuming and idempotent: never sets accepted_at, never creates an auth
// user — a repeat call just refreshes the code and sends another email.

import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildInviteEmail, buildInviteReminderEmail, buildMigrationInviteEmail } from "@/lib/invite-email";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";

export interface PendingInvitationRow {
  id: string;
  token: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  dealer_id: string | null;
  dealer_name: string | null;
  group_id: string | null;
  purpose: string | null;
  expires_at: string;
  accepted_at: string | null;
  setup_code_hash: string | null;
  setup_code_expires_at: string | null;
}

export const PENDING_INVITATION_COLUMNS =
  "id, token, email, first_name, last_name, role, dealer_id, dealer_name, group_id, purpose, expires_at, accepted_at, setup_code_hash, setup_code_expires_at";

/** True when the row is live: unconsumed and not past its expiry. */
export function isPendingInvitation(inv: PendingInvitationRow | null): inv is PendingInvitationRow {
  return !!inv && !inv.accepted_at && new Date(inv.expires_at) >= new Date();
}

/**
 * True when the 8-digit code currently in the invitee's inbox still works —
 * i.e. re-issuing one would DESTROY a working code rather than rescue anyone.
 * Mirrors the gate /api/migrate/verify and /api/invite/accept apply: a missing
 * hash or a past setup_code_expires_at means no usable code (absent expiry is
 * treated as expired there, so treat it the same here).
 */
export function hasLiveSetupCode(inv: PendingInvitationRow): boolean {
  if (!inv.setup_code_hash) return false;
  if (!inv.setup_code_expires_at) return false;
  return new Date(inv.setup_code_expires_at) >= new Date();
}

/**
 * True when this invitation is consumed at /migrate rather than /signup.
 * `purpose` is authoritative post-migration-102; a null purpose with a dealer
 * is an older migration invite (same tolerance as /api/migrate/verify).
 */
export function isMigrationInvitation(inv: PendingInvitationRow): boolean {
  return inv.purpose === "migration" || (inv.purpose == null && !!inv.dealer_id);
}

/** Dealer/group/account name to address the invitee's org by. */
async function resolveOrgName(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  inv: PendingInvitationRow,
  fallback: string,
): Promise<string> {
  if (inv.dealer_name) return inv.dealer_name;
  if (inv.group_id) {
    const { data: g } = await admin.from("groups").select("name").eq("id", inv.group_id).maybeSingle<{ name: string }>();
    return g?.name ?? "your group";
  }
  if (inv.dealer_id) {
    const { data: d } = await admin.from("dealers").select("name").eq("id", inv.dealer_id).maybeSingle<{ name: string }>();
    return d?.name ?? fallback;
  }
  return fallback;
}

/**
 * Point an invitee at the flow where the code they ALREADY have works, without
 * touching that code. For the invitee who went to /login instead of using their
 * invitation: re-issuing a code there silently killed the one in their inbox
 * (they then typed it and got "expired/invalid"), so this is the no-rotate
 * alternative — same destination, no new code, nothing to invalidate. The code
 * itself can't be reprinted (only its hash is stored), so the email says to use
 * the one already sent.
 */
export async function sendInvitationReminderEmail(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  inv: PendingInvitationRow,
): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com";
  const recipientName = `${inv.first_name} ${inv.last_name}`.trim() || inv.email;
  const migration = isMigrationInvitation(inv);
  const orgName = await resolveOrgName(admin, inv, migration ? "your dealership" : "your account");
  await sendMandrillEmail({
    subject: migration
      ? `Finish setting up DealerAddendums Platform 5.0 — ${orgName}`
      : `Finish setting up your DA Platform account — ${orgName}`,
    from_email: "noreply@dealeraddendums.com",
    from_name: "DealerAddendums",
    to: [{ email: inv.email, name: recipientName, type: "to" }],
    html: buildInviteReminderEmail({
      firstName: inv.first_name || "there",
      orgName,
      inviteUrl: migration
        ? `${appUrl}/migrate?invite=${inv.token}`
        : `${appUrl}/signup?invite=${inv.token}`,
      isMigration: migration,
    }),
  });
}

/**
 * Re-issue a fresh setup code on a PENDING invitation row and re-email it.
 * The caller is responsible for having checked isPendingInvitation() — this
 * function trusts the row. Branches on purpose: migration invites get the
 * Platform 5.0 email with the /migrate link (a /signup link would be rejected
 * by that flow); everything else gets the standard setup email.
 * Throws on failure — callers on unauthenticated paths should catch + swallow.
 *
 * ⚠️ This ROTATES the code: the one already in the invitee's inbox stops
 * working the moment this runs. That is correct for an explicit "resend" (the
 * invitee asked for a new one) and for an EXPIRED code, but never for a live
 * code on a path the invitee didn't ask for — see hasLiveSetupCode and
 * sendInvitationReminderEmail.
 */
export async function resendPendingInvitationEmail(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  inv: PendingInvitationRow,
): Promise<void> {
  const setupCode = generateSetupCode();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updErr } = await (admin as any).from("invitations")
    .update({ setup_code_hash: hashSetupCode(setupCode), setup_code_expires_at: inv.expires_at })
    .eq("id", inv.id);
  if (updErr) throw new Error(`setup-code refresh failed: ${updErr.message}`);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com";
  const recipientName = `${inv.first_name} ${inv.last_name}`.trim() || inv.email;

  if (inv.purpose === "migration") {
    // Migration invite (Phase 13) — self-managed code consumed at /migrate.
    let orgName = inv.dealer_name ?? "your dealership";
    if (!inv.dealer_name && inv.dealer_id) {
      const { data: d } = await admin.from("dealers").select("name").eq("id", inv.dealer_id).maybeSingle<{ name: string }>();
      orgName = d?.name ?? orgName;
    }
    await sendMandrillEmail({
      subject: `You're invited to DealerAddendums Platform 5.0 — ${orgName}`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email: inv.email, name: recipientName, type: "to" }],
      html: buildMigrationInviteEmail({
        firstName: inv.first_name || "there",
        orgName,
        migrateUrl: `${appUrl}/migrate?invite=${inv.token}`,
        setupCode,
      }),
    });
    return;
  }

  // Standard staff / dealer / group invitation — consumed at /signup.
  let orgName = inv.dealer_name ?? "your account";
  if (inv.group_id) {
    const { data: g } = await admin.from("groups").select("name").eq("id", inv.group_id).maybeSingle<{ name: string }>();
    orgName = g?.name ?? "your group";
  } else if (inv.dealer_id && !inv.dealer_name) {
    const { data: d } = await admin.from("dealers").select("name").eq("id", inv.dealer_id).maybeSingle<{ name: string }>();
    orgName = d?.name ?? "your dealership";
  }

  const roleLabel = inv.role.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  await sendMandrillEmail({
    subject: `Your DA Platform setup code — ${orgName}`,
    from_email: "noreply@dealeraddendums.com",
    from_name: "DealerAddendums",
    to: [{ email: inv.email, name: recipientName, type: "to" }],
    html: buildInviteEmail({
      firstName: inv.first_name,
      orgName,
      roleLabel,
      inviteUrl: `${appUrl}/signup?invite=${inv.token}`,
      setupCode,
    }),
  });
}
