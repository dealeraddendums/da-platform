// "Login code" on a PENDING INVITATION row (2026-10-08) — the invite-side twin
// of POST /api/users/[id]/login-code. Someone was invited but never accepted
// (no account yet) and the invite email isn't reaching them: the admin mints a
// fresh setup code on THAT invitation and reads it out. Nothing is emailed.
//
// Same mechanism and rules as the user-row Login code — no new credential:
//   • the invitation's own setup code (8 digits, stored only as a SHA-256 hash,
//     lib/invite-code.ts), 7-day expiry, single use (consumed on accept);
//   • it REPLACES the emailed code (that one stops working);
//   • admin_audit row written and AWAITED before the code exists — no audit,
//     no code — and the code value is never logged or audited;
//   • never for someone who has already completed a 5.0 login: redeeming an
//     invite updates an existing auth user in place (/api/invite/accept), so a
//     code for an existing account's email would let the admin sign in as them.
//     Locked-out active users use the login page's emailed code / Forgot
//     password (Allan's decision, 2026-10-08).
// Authorization stays with the calling route (the same guard as Resend/Revoke).

import type { JwtClaims } from "@/lib/auth";
import type { createAdminSupabaseClient } from "@/lib/db";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";
import { INVITE_TTL_MS, neverSignedInResolver } from "@/lib/user-access";
import { issueMigrationLoginCode } from "@/lib/migration-login-code";
import { DEALER_ROLES, isDealerMigratedOnV5 } from "@/lib/v5-usable";

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export type InviteLoginCodeResult =
  | { ok: true; code: string; email: string; expiresAt: string; kind?: "setup" | "migration"; dealerName?: string }
  | { ok: false; status: number; error: string };

export async function issueInvitationLoginCode(
  admin: Admin,
  claims: JwtClaims,
  invitationId: string,
  scope: { dealerUuid: string } | { groupId: string },
): Promise<InviteLoginCodeResult> {
  const a = admin as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let q = a.from("invitations")
    .select("id, email, first_name, last_name, role, dealer_id, group_id, purpose, accepted_at").eq("id", invitationId);
  q = "dealerUuid" in scope ? q.eq("dealer_id", scope.dealerUuid) : q.eq("group_id", scope.groupId);
  const { data: inv } = await q.maybeSingle() as {
    data: { id: string; email: string; first_name: string | null; last_name: string | null; role: string; dealer_id: string | null; group_id: string | null; purpose: string | null; accepted_at: string | null } | null;
  };
  if (!inv) return { ok: false, status: 404, error: "Invitation not found" };
  if (inv.accepted_at) return { ok: false, status: 409, error: "This invitation was already accepted — they have an account now." };

  let dealerTextId: string | null = null;
  let dealerOnV5 = true;
  if (inv.dealer_id) {
    const { data: d } = await a.from("dealers").select("dealer_id, migration_status, is_native").eq("id", inv.dealer_id).maybeSingle();
    dealerTextId = d?.dealer_id ?? null;
    dealerOnV5 = isDealerMigratedOnV5(d);
  }
  // A dealer still on 4.0 (2026-10-09): the code to give is the dealer's
  // MIGRATION code — the Migration Console's own mechanism (lib/migration-login-code.ts).
  // A migration invite on an already-migrated dealer is an account-only
  // migration invite and goes the same way (redeemed at /migrate).
  if (inv.dealer_id && (inv.purpose === "migration" || (DEALER_ROLES.has(inv.role) && !dealerOnV5))) {
    return issueMigrationLoginCode(admin, claims, {
      dealerUuid: inv.dealer_id, email: inv.email, role: inv.role,
      name: [inv.first_name, inv.last_name].filter(Boolean).join(" ") || null,
      source: "invitation", sourceId: inv.id,
    });
  }
  if (inv.purpose !== "user") return { ok: false, status: 409, error: "This invitation can't be given a login code here." };

  const neverSignedIn = await neverSignedInResolver(admin);
  if (!neverSignedIn(inv.email)) {
    return {
      ok: false, status: 409,
      error: "This email already belongs to someone who signs in to DealerAddendums, so a login code isn't available. " +
        "They can use \"Forgot password\" or an emailed sign-in code on the login page.",
    };
  }

  const { error: auditErr } = await a.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "invitation_login_code_generated",
    target_dealer_id: dealerTextId,
    metadata: {
      invitation_id: inv.id,
      email: inv.email,
      role: inv.role,
      invitation_dealer_uuid: inv.dealer_id,
      group_id: inv.group_id,
      actor_role: claims.role,
      channel: "phone",
    },
  });
  if (auditErr) {
    console.error("[invite-login-code] audit write failed — no code generated:", auditErr.message);
    return { ok: false, status: 500, error: "Could not record the audit entry, so no code was generated. Try again." };
  }

  const code = generateSetupCode();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const { error: upErr } = await a.from("invitations")
    .update({ expires_at: expiresAt, setup_code_hash: hashSetupCode(code), setup_code_expires_at: expiresAt })
    .eq("id", inv.id).is("accepted_at", null);
  if (upErr) {
    console.error("[invite-login-code] code rotation failed for invitation", inv.id, upErr.message);
    return { ok: false, status: 500, error: "Could not set the new code. Try again." };
  }
  return { ok: true, code, email: inv.email, expiresAt, kind: "setup" };
}
