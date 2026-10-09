// Users-tab "Login code" for someone whose invite is (or must be) the dealer's
// MIGRATION invite — the dealer is still on 4.0 (2026-10-09, Allan). Before
// this the button refused ("use the Migration Console instead") and support
// read that as "login codes aren't being generated".
//
// No new credential: this is the Migration Console's own per-recipient writer,
// upsertRecipientInvite (lib/migration-invite-otp.ts — what Resend/phone-code
// produce), called without the email send. So the code is identical in every
// way that matters: 8 digits stored only as a SHA-256 hash, 14-day expiry,
// single use, redeemed at /migrate, and the FIRST redemption moves the dealer
// to 5.0 exactly as today (app/api/migrate/confirm). It replaces any emailed
// code (one invitation row per email+dealer). Never emailed, never logged.
//
// Guards (on top of the calling route's authorization):
//   • the migration must already be underway — the console has invited this
//     dealer (migration_status 'invited', or a migration invitation on file).
//     Otherwise a Users-tab click could migrate a dealer before the console's
//     readiness checks (billing, template) ever ran.
//   • dealer_admin only — migration invites are always dealer_admin, so issuing
//     one for a dealer_user would quietly promote them.
//   • never for someone who has completed a 5.0 login (account takeover), and
//     never for an invitation that was already accepted.
//   • admin_audit row written and AWAITED before the code exists.

import type { JwtClaims } from "@/lib/auth";
import type { createAdminSupabaseClient } from "@/lib/db";
import { MIGRATION_INVITE_TTL_MS, splitName, upsertRecipientInvite, type DealerRow } from "@/lib/migration-invite-otp";
import { neverSignedInResolver } from "@/lib/user-access";
import { isDealerMigratedOnV5 } from "@/lib/v5-usable";

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export type MigrationLoginCodeResult =
  | { ok: true; code: string; email: string; expiresAt: string; kind: "migration"; dealerName: string }
  | { ok: false; status: number; error: string };

export async function issueMigrationLoginCode(
  admin: Admin,
  claims: JwtClaims,
  opts: { dealerUuid: string; email: string; role: string; name: string | null; source: "invitation" | "user"; sourceId: string },
): Promise<MigrationLoginCodeResult> {
  const a = admin as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const email = opts.email.trim().toLowerCase();

  const { data: dealer } = await a.from("dealers")
    .select("id, dealer_id, name, inventory_dealer_id, primary_contact, primary_contact_email, migration_status, is_native")
    .eq("id", opts.dealerUuid).maybeSingle() as { data: (DealerRow & { migration_status: string | null; is_native: boolean | null }) | null };
  if (!dealer) return { ok: false, status: 404, error: "Dealer not found" };
  if (isDealerMigratedOnV5(dealer)) return { ok: false, status: 409, error: "This dealer is already on 5.0 — use a normal login code." };

  if (opts.role !== "dealer_admin") {
    return {
      ok: false, status: 409,
      error: `${dealer.name} is still on Platform 4.0, and only a dealer admin can receive its migration code. ` +
        "Make this person a dealer admin, or wait until the store has moved to 5.0 and then send their invite.",
    };
  }

  const { data: rows } = await a.from("invitations").select("id, email, purpose, accepted_at").eq("dealer_id", dealer.id) as {
    data: { id: string; email: string; purpose: string | null; accepted_at: string | null }[] | null;
  };
  const migrationUnderway = dealer.migration_status === "invited"
    || (rows ?? []).some((r) => r.purpose === "migration");
  if (!migrationUnderway) {
    return {
      ok: false, status: 409,
      error: `${dealer.name} hasn't been sent its migration invite yet, so there's no migration code to give out. ` +
        "Send it from the Migration Console first (that's where billing and template readiness are checked).",
    };
  }

  const own = (rows ?? []).find((r) => r.email.trim().toLowerCase() === email) ?? null;
  if (own?.accepted_at) return { ok: false, status: 409, error: `${email} already accepted this invite — they sign in normally now.` };

  const neverSignedIn = await neverSignedInResolver(admin);
  if (!neverSignedIn(email)) {
    return {
      ok: false, status: 409,
      error: "This email already belongs to someone who signs in to DealerAddendums, so a login code isn't available. " +
        "They can use \"Forgot password\" or an emailed sign-in code on the login page.",
    };
  }

  // Same audit action as the console's phone code, so one query shows every
  // migration code handed out; `via` says which screen.
  const { error: auditErr } = await a.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "migration_code_regenerated",
    target_dealer_id: dealer.dealer_id,
    metadata: {
      dealer_uuid: dealer.id,
      dealer_name: dealer.name,
      invitation_id: own?.id ?? null,
      recipient_email: email,
      converted_from_purpose: own && own.purpose !== "migration" ? own.purpose : null,
      source: opts.source,
      source_id: opts.sourceId,
      actor_role: claims.role,
      channel: "phone",
      via: "users_tab",
    },
  });
  if (auditErr) {
    console.error("[migration-login-code] audit write failed — no code generated:", auditErr.message);
    return { ok: false, status: 500, error: "Could not record the audit entry, so no code was generated. Try again." };
  }

  const name = (opts.name ?? "").trim();
  let code: string;
  try {
    ({ code } = await upsertRecipientInvite(admin, dealer, { email, name, ...splitName(name) }, claims.sub));
  } catch (e) {
    console.error("[migration-login-code] invitation write failed for", dealer.dealer_id, e instanceof Error ? e.message : e);
    return { ok: false, status: 500, error: "Could not set the new code. Try again." };
  }
  return { ok: true, code, email, expiresAt: new Date(Date.now() + MIGRATION_INVITE_TTL_MS).toISOString(), kind: "migration", dealerName: dealer.name };
}
