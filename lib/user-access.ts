import { NextResponse } from "next/server";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeUserTarget } from "@/lib/user-authz";
import { lastSignInByEmailStrict } from "@/lib/last-sign-in";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";
import { DEALER_ROLES, isDealerMigratedOnV5 } from "@/lib/v5-usable";

// First-login access for an EXISTING user who has never signed in (2026-10-02):
// "Resend invite" (POST /api/users/[id]/send-invite) and "Login code"
// (POST /api/users/[id]/login-code). Both refresh the user's ONE invitation
// row, built from their CURRENT profile — so redeeming it at /signup (link, or
// email + code) rewrites the profile with the same role/dealer/group and
// updates an existing auth user in place (/api/invite/accept).
//
// Setup codes are stored only as a SHA-256 hash (lib/invite-code.ts), so a code
// that was emailed can never be shown again; "Login code" mints a new one and
// displays it once instead.

type Admin = ReturnType<typeof createAdminSupabaseClient>;

/** Who may run these on a user: the user's managing admins. dealer_user /
 *  dealer_restricted never manage users. group_user keeps the dealer_admin
 *  parity it already has over a scoped dealer's own staff. */
export const ACCESS_MANAGER_ROLES = new Set(["super_admin", "dealer_admin", "group_admin", "group_user"]);

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AccessTarget {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  dealer_id: string | null;
  group_id: string | null;
  active: boolean | null;
}

export interface AccessContext {
  target: AccessTarget;
  dealer: { id: string; name: string; dealer_id: string; migration_status: string | null; is_native: boolean | null } | null;
  groupName: string | null;
  /** Never completed a 5.0 login — see neverSignedInResolver (strict sign-in
   *  map + durable login evidence). */
  neverSignedIn: boolean;
  /** A dealer-role user whose dealer isn't usable on 5.0 yet. Their invite row
   *  is (or should be) the dealer's MIGRATION invitation — a plain "user"
   *  invite would overwrite it on the shared (email, dealer) row. */
  dealerNotOnV5: boolean;
}

// ── "Has this person EVER completed a 5.0 login?" ─────────────────────────────
// The strict last-sign-in map alone can't answer it. GoTrue keeps only the
// LATEST sign-in, so one impersonation after a real login reads as "never"
// (Toyota Carlsbad, Ariel Arce: real password login 10/01, Allan impersonated
// 10/02), and the strict map also nulls any sign-in that follows a recovery
// email — which every emailed-code (OTP) login does (Ray Nuqul, 10/01). Those
// are the safe direction for a migration gate and the WRONG direction here:
// they would offer an invite/login code to someone who already signs in.
// So a login also counts when there is durable evidence of one:
//   • a successful auth_events row for a real 5.0 credential (5.0 password,
//     emailed code, passkey, invite acceptance) — never the 4.0 handoff, and
//     impersonation/ghost never write these events; or
//   • an accepted invitation (accepted only on a human code/password submit,
//     which signs them in).
const LOGIN_EVENTS = ["password_verify", "otp_verify", "passkey_verify", "invite_accept"];
let loginEvidence: { at: number; emails: Set<string> } | null = null;
const EVIDENCE_TTL_MS = 60_000;

async function completedLoginEmails(admin: Admin): Promise<Set<string>> {
  if (loginEvidence && Date.now() - loginEvidence.at < EVIDENCE_TTL_MS) return loginEvidence.emails;
  const emails = new Set<string>();
  const add = (e: string | null | undefined) => { const k = (e ?? "").trim().toLowerCase(); if (k) emails.add(k); };
  // Paged — PostgREST clamps every read to 1,000 rows.
  for (let from = 0; ; from += 1000) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).from("auth_events")
      .select("email, detail").eq("result", "success").in("event", LOGIN_EVENTS)
      .range(from, from + 999) as { data: { email: string | null; detail: string | null }[] | null; error: { message: string } | null };
    if (error) { console.error("[user-access] auth_events read failed:", error.message); break; }
    for (const r of data ?? []) if (r.detail !== "4.0 handoff") add(r.email);
    if ((data ?? []).length < 1000) break;
  }
  for (let from = 0; ; from += 1000) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).from("invitations")
      .select("email").not("accepted_at", "is", null)
      .range(from, from + 999) as { data: { email: string | null }[] | null; error: { message: string } | null };
    if (error) { console.error("[user-access] invitations read failed:", error.message); break; }
    for (const r of data ?? []) add(r.email);
    if ((data ?? []).length < 1000) break;
  }
  loginEvidence = { at: Date.now(), emails };
  return emails;
}

/** (email) => true when the person has NEVER completed a 5.0 login. One
 *  resolver for the Users lists and the server gate, so a button can never
 *  show for someone the API would refuse (or the reverse). */
export async function neverSignedInResolver(admin?: Admin): Promise<(email: string | null | undefined) => boolean> {
  const db = admin ?? createAdminSupabaseClient();
  const [strict, evidence] = await Promise.all([lastSignInByEmailStrict(), completedLoginEmails(db)]);
  return (email) => {
    const k = (email ?? "").trim().toLowerCase();
    if (!k) return false;
    return !strict.get(k) && !evidence.has(k);
  };
}

export async function loadAccessContext(
  admin: Admin,
  claims: JwtClaims,
  targetId: string,
): Promise<{ ok: true; ctx: AccessContext } | { ok: false; response: NextResponse }> {
  if (!ACCESS_MANAGER_ROLES.has(claims.role)) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const authz = await authorizeUserTarget(admin, claims, targetId);
  if (!authz.ok) return { ok: false, response: authz.response };

  const { data: target } = await admin
    .from("profiles")
    .select("id, email, full_name, role, dealer_id, group_id, active")
    .eq("id", targetId)
    .maybeSingle<AccessTarget>();
  if (!target) return { ok: false, response: NextResponse.json({ error: "User not found" }, { status: 404 }) };
  if (!target.email) return { ok: false, response: NextResponse.json({ error: "User has no email address" }, { status: 400 }) };

  let dealer: AccessContext["dealer"] = null;
  let groupName: string | null = null;
  if (target.dealer_id) {
    const { data } = await admin
      .from("dealers")
      .select("id, name, dealer_id, migration_status, is_native")
      .eq("dealer_id", target.dealer_id)
      .maybeSingle<NonNullable<AccessContext["dealer"]>>();
    if (!data) {
      return { ok: false, response: NextResponse.json({ error: `Dealer "${target.dealer_id}" not found for this user` }, { status: 400 }) };
    }
    dealer = data;
  } else if (target.group_id) {
    const { data } = await admin.from("groups").select("name").eq("id", target.group_id).maybeSingle<{ name: string }>();
    groupName = data?.name ?? null;
  }

  const neverSignedIn = (await neverSignedInResolver(admin))(target.email);
  const dealerNotOnV5 = DEALER_ROLES.has(target.role) && !isDealerMigratedOnV5(dealer);

  return { ok: true, ctx: { target, dealer, groupName, neverSignedIn, dealerNotOnV5 } };
}

export const NOT_ON_V5_MESSAGE =
  "This dealer hasn't moved to Platform 5.0 yet, so this person's invite is the dealer's migration invite. " +
  "Use the Migration Console (resend / phone code) instead.";

/**
 * Refresh (or create) the user's invitation from their current profile with a
 * fresh setup code. Find-then-write rather than upsert: the (email, dealer_id) /
 * (email, group_id) unique indexes never fire on the staff scope (both NULL),
 * and a consumed (accepted) row would block a plain insert — so the existing
 * row for this email+scope is reopened (accepted_at cleared, new expiry).
 * Touches exactly that one row. Returns the code — never log it.
 */
export async function refreshUserInvitation(
  admin: Admin,
  ctx: AccessContext,
  actorId: string,
): Promise<{ token: string; code: string; expiresAt: string; orgName: string | null; invitationId: string }> {
  const { target, dealer, groupName } = ctx;
  const email = target.email.trim();
  const nameParts = (target.full_name ?? "").trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] ?? email.split("@")[0];
  const lastName = nameParts.slice(1).join(" "); // column is NOT NULL; "" is fine
  const orgName = dealer?.name ?? groupName ?? null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let existingQ = (admin as any).from("invitations").select("id, token").eq("email", email);
  if (dealer) existingQ = existingQ.eq("dealer_id", dealer.id);
  else if (target.group_id) existingQ = existingQ.eq("group_id", target.group_id);
  else existingQ = existingQ.is("dealer_id", null).is("group_id", null);
  const { data: existing } = await existingQ
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { id: string; token: string } | null };

  const code = generateSetupCode();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const fields = {
    email,
    first_name: firstName,
    last_name: lastName,
    role: target.role,
    dealer_id: dealer?.id ?? null,
    group_id: dealer ? null : (target.group_id ?? null),
    dealer_name: orgName ?? "DealerAddendums",
    invited_by: actorId,
    purpose: "user",
    accepted_at: null,
    created_at: new Date().toISOString(), // "last sent" — drives the invited-hint in the UI
    expires_at: expiresAt,
    setup_code_hash: hashSetupCode(code),
    setup_code_expires_at: expiresAt,
  };

  if (existing) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin as any).from("invitations").update(fields).eq("id", existing.id);
    if (error) throw new Error(error.message);
    return { token: existing.token, code, expiresAt, orgName, invitationId: existing.id };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inserted, error } = await (admin as any)
    .from("invitations").insert(fields).select("id, token").single() as
    { data: { id: string; token: string } | null; error: { message: string } | null };
  if (error || !inserted) throw new Error(error?.message ?? "Failed to create invitation");
  return { token: inserted.token, code, expiresAt, orgName, invitationId: inserted.id };
}
