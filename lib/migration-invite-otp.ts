// Phase 13a.1 — scanner-proof OTP migration invite. SUPERSEDES the magic-link
// path (lib/migration-invite.ts inviteUsersForDealer), which emailed a Supabase
// generateLink OTP that mail scanners (Barracuda Safe Links) pre-consume →
// otp_expired. This uses a SELF-MANAGED 8-digit code (lib/invite-code.ts) stored
// as a hash on an `invitations` row — a scanner can pre-fetch the inert link but
// can't read+retype the code, so the invite is consumed only when the dealer
// submits it at /migrate (verify lands in 13a.2).
//
// Unlike the old path, this does NOT pre-create auth users: the dealer sets up
// their own 5.0 login (passkey/password) during the /migrate flow (13a.2b).
//
// MULTI-RECIPIENT (2026-08-04): invites go to EVERY active dealer_admin profile
// on the dealer PLUS the dealer's primary contact (deduped, capped). Each
// recipient gets their own invitation row + 8-digit code (one row per
// email+dealer — the unique-index upsert). The first person to complete
// /migrate migrates the dealer; the other codes stay usable as account-setup
// codes (confirm skips the migrate writes when the dealer is already migrated).

import { createAdminSupabaseClient } from "@/lib/db";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildMigrationInviteEmail, buildMigrationFollowUpEmail } from "@/lib/invite-email";
import { lastSignInByEmail } from "@/lib/last-sign-in";

export interface MigrationInviteResult {
  ok: boolean;
  dealer_name: string;
  /** Comma-joined EMAILED (pending) recipient list (kept as `email` for
   *  send-wave/resend compat). */
  email: string | null;
  emailSent: boolean;
  /** The recipients actually emailed this call (pending only, deduped). */
  recipients: string[];
  /** Recipients skipped because they already completed (accepted their invite
   *  or have a real, impersonation-safe sign-in). */
  skipped: string[];
  /** True when every resolved recipient had already completed — nothing was
   *  rotated or emailed. */
  allCompleted: boolean;
  emailsSent: number;
  warning?: string;
}

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14-day migration window
const MAX_RECIPIENTS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Recipient = { email: string; firstName: string; lastName: string; name: string };
type DealerRow = {
  id: string; dealer_id: string; name: string; inventory_dealer_id: string | null;
  primary_contact: string | null; primary_contact_email: string | null;
};

function splitName(name: string): { firstName: string; lastName: string } {
  const [first, ...rest] = (name || "there").trim().split(/\s+/);
  return { firstName: first || "there", lastName: rest.join(" ") };
}

/**
 * Recipient set for a dealer's migration emails: the primary contact (kept
 * first — preserves the original single-recipient behavior) plus every ACTIVE
 * dealer_admin profile, deduped case-insensitively, invalid emails skipped,
 * capped at MAX_RECIPIENTS (logged when the cap trims).
 */
async function resolveMigrationRecipients(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealer: DealerRow,
): Promise<Recipient[]> {
  const out: Recipient[] = [];
  const seen = new Set<string>();
  const push = (rawEmail: string | null | undefined, rawName: string | null | undefined) => {
    const email = (rawEmail ?? "").trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email) || seen.has(email)) return;
    seen.add(email);
    const name = (rawName ?? "").trim();
    out.push({ email, name, ...splitName(name) });
  };

  push(dealer.primary_contact_email, dealer.primary_contact);

  // profiles.dealer_id is the dealer's TEXT dealer_id (can differ from
  // inventory_dealer_id), so look up by dealer.dealer_id.
  const { data: profs } = await admin
    .from("profiles")
    .select("email, full_name, active")
    .eq("dealer_id", dealer.dealer_id)
    .eq("role", "dealer_admin");
  for (const p of profs ?? []) {
    if (p.active === false) continue;
    push(p.email, p.full_name);
  }

  if (out.length > MAX_RECIPIENTS) {
    console.warn(`[migration-invite] dealer "${dealer.name}" (${dealer.dealer_id}) has ${out.length} invite recipients — capping at ${MAX_RECIPIENTS}`);
    return out.slice(0, MAX_RECIPIENTS);
  }
  return out;
}

/**
 * Upsert one recipient's invitation row (fresh code, 14-day TTL) and return
 * {token, code}. onConflict email+dealer_id: a re-send refreshes the same row —
 * the OLD code dies (hash replaced), the link token stays stable.
 */
async function upsertRecipientInvite(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealer: DealerRow,
  r: Recipient,
  adminUserId?: string,
  waveId?: string,
): Promise<{ token: string; code: string }> {
  const code = generateSetupCode();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const baseRow = {
    email: r.email,
    first_name: r.firstName,
    last_name: r.lastName,
    role: "dealer_admin" as const,
    dealer_id: dealer.id,        // invitations.dealer_id is the dealers.id UUID
    dealer_name: dealer.name,
    invited_by: adminUserId ?? null,
    accepted_at: null,
    expires_at: expiresAt,
    setup_code_hash: hashSetupCode(code),
    setup_code_expires_at: expiresAt,
  };
  // Write purpose='migration' so /migrate accepts only these and /signup rejects
  // them. Resilient to migration 102/103 not being applied (falls back without
  // wave_id, then without purpose).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = (admin as any).from("invitations");
  const up = (row: Record<string, unknown>) => inv.upsert(row, { onConflict: "email,dealer_id", ignoreDuplicates: false }).select("token").single();
  let res = await up({ ...baseRow, purpose: "migration", ...(waveId ? { wave_id: waveId } : {}) });
  if (res.error && /wave_id/i.test(res.error.message ?? "")) res = await up({ ...baseRow, purpose: "migration" });
  if (res.error && /purpose/i.test(res.error.message ?? "")) res = await up(baseRow);
  if (res.error || !res.data) throw new Error(res.error?.message ?? "Failed to create migration invitation");
  return { token: res.data.token as string, code };
}

/**
 * THE per-recipient "completed" predicate — the single definition shared by
 * the initial send, manual Resend, and the follow-up drip. A recipient has
 * completed when EITHER:
 *   (a) their migration invitation for this dealer is consumed
 *       (invitations.accepted_at set), OR
 *   (b) they have a REAL sign-in per lastSignInByEmail — the impersonation-
 *       safe helper that excludes sign-ins within ±10 min of an impersonation
 *       admin_audit event, so an operator ghosting the account never marks
 *       the human as having accepted.
 * Completed recipients must never be re-emailed a "you're invited" + fresh
 * code. Note this is PER RECIPIENT, not "is the dealer migrated": on a
 * migrated dealer the not-yet-accepted admins still need their account-only
 * invites.
 */
async function completedRecipientEmails(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealerUuid: string,
  candidateEmails: string[],
): Promise<Set<string>> {
  const done = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: acceptedRows } = await (admin as any)
    .from("invitations")
    .select("email")
    .eq("dealer_id", dealerUuid)
    .eq("purpose", "migration")
    .not("accepted_at", "is", null) as { data: { email: string }[] | null };
  for (const r of acceptedRows ?? []) done.add(r.email.toLowerCase());
  try {
    const signIns = await lastSignInByEmail();
    for (const e of candidateEmails) {
      if (signIns.get(e)) done.add(e);
    }
  } catch (e) {
    // Best-effort: the accepted-invitation check above still applies.
    console.error("[migration-invite] lastSignInByEmail failed:", e instanceof Error ? e.message : e);
  }
  return done;
}

/**
 * Kill the codes on pending migration invitations for this dealer whose email
 * is no longer in the recipient set (e.g. a deactivated admin) — a resend
 * should leave no live stray codes. Best-effort.
 */
async function burnStaleRecipientCodes(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealerUuid: string,
  currentEmails: string[],
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q = (admin as any)
      .from("invitations")
      .update({ setup_code_hash: null })
      .eq("dealer_id", dealerUuid)
      .eq("purpose", "migration")
      .is("accepted_at", null);
    if (currentEmails.length > 0) {
      q = q.not("email", "in", `(${currentEmails.map(e => `"${e}"`).join(",")})`);
    }
    const { error } = await q;
    if (error) console.error("[migration-invite] stale-code burn failed:", error.message);
  } catch (e) {
    console.error("[migration-invite] stale-code burn failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Create (or refresh) scanner-proof migration invites for one dealer and email
 * each recipient (primary contact + all active dealer_admins) an 8-digit code
 * + an inert /migrate link. Stamps dealers.migration_status='invited'. Resolves
 * the dealer by inventory_dealer_id (the text id ETL/profiles key on).
 */
export async function sendMigrationInvite(
  inventoryDealerId: string,
  adminUserId?: string,
  waveId?: string,
): Promise<MigrationInviteResult> {
  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, inventory_dealer_id, primary_contact, primary_contact_email, active, migration_status")
    .eq("inventory_dealer_id", inventoryDealerId)
    .maybeSingle<DealerRow & { active: boolean | null; migration_status: string | null }>();
  if (!dealer) throw new Error(`Dealer not found: ${inventoryDealerId}`);
  // Deactivated dealers (e.g. Dealer General rooftops out of the paid+active
  // scope) must never receive migration invites — this guards every send path
  // (direct invite, wave-send, resend, follow-up drip).
  if (dealer.active === false) {
    throw new Error(`Dealer "${dealer.name}" (${inventoryDealerId}) is deactivated — migration invites are blocked`);
  }

  const resolved = await resolveMigrationRecipients(admin, dealer);
  if (resolved.length === 0) throw new Error(`No contact email for dealer "${dealer.name}" (${inventoryDealerId}) — cannot send migration invite`);

  // Per-recipient completed skip (shared predicate): never re-email someone
  // who already accepted / has a working login. On an already-migrated dealer
  // the pending admins still get their account-only invites.
  const done = await completedRecipientEmails(admin, dealer.id, resolved.map(r => r.email));
  const recipients = resolved.filter(r => !done.has(r.email));
  const skipped = resolved.filter(r => done.has(r.email)).map(r => r.email);

  if (recipients.length === 0) {
    // Everyone has accepted — nothing to rotate, nothing to email, and the
    // dealer's status/invited_at/codes stay exactly as they are.
    return {
      ok: true,
      dealer_name: dealer.name,
      email: null,
      emailSent: false,
      recipients: [],
      skipped,
      allCompleted: true,
      emailsSent: 0,
      warning: "All recipients have already accepted — nothing to resend.",
    };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com";
  const warnings: string[] = [];
  let emailsSent = 0;

  for (const r of recipients) {
    let token: string;
    let code: string;
    try {
      ({ token, code } = await upsertRecipientInvite(admin, dealer, r, adminUserId, waveId));
    } catch (e) {
      warnings.push(`${r.email}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    try {
      await sendMandrillEmail({
        subject: `You're invited to DealerAddendums Platform 5.0 — ${dealer.name}`,
        from_email: "noreply@dealeraddendums.com",
        from_name: "DealerAddendums",
        to: [{ email: r.email, name: r.name || undefined }],
        html: buildMigrationInviteEmail({ firstName: r.firstName, orgName: dealer.name, migrateUrl: `${appUrl}/migrate?invite=${token}`, setupCode: code }),
      });
      emailsSent++;
    } catch (mailErr) {
      warnings.push(`${r.email}: email not delivered (${mailErr instanceof Error ? mailErr.message : String(mailErr)})`);
    }
  }

  // Stamp invited — but NEVER regress an already-migrated dealer back to
  // 'invited' (that re-arms the /not-migrated gate and would lock out its
  // real users). Account-only resends on migrated dealers leave status alone.
  if (emailsSent > 0 && dealer.migration_status !== "migrated") {
    await admin
      .from("dealers")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update({ migration_status: "invited", invited_at: new Date().toISOString() } as any)
      .eq("id", dealer.id);
  }
  // Burn keys off the FULL resolved set (pending + completed): completion must
  // never burn someone's still-pending code — only genuinely removed
  // recipients (e.g. deactivated admins) lose theirs.
  await burnStaleRecipientCodes(admin, dealer.id, resolved.map(r => r.email));

  return {
    ok: true,
    dealer_name: dealer.name,
    email: recipients.map(r => r.email).join(", "),
    emailSent: emailsSent > 0,
    recipients: recipients.map(r => r.email),
    skipped,
    allCompleted: false,
    emailsSent,
    warning: warnings.length ? warnings.join(" · ") : undefined,
  };
}

/**
 * Send a follow-up migration invite for a dealer that hasn't migrated yet.
 * Goes to every current recipient (primary contact + active dealer_admins) who
 * hasn't already completed their invitation; each gets a fresh code (14-day
 * TTL, same invitations upsert as sendMigrationInvite). Sets
 * dealers.invite_follow_up_count. Does NOT touch invited_at — the drip clock
 * stays anchored on the original invite (the drip stops entirely once the
 * dealer migrates: the cron only selects migration_status='invited').
 * followUpNumber: 1–5 (1=Day 3, 2=Day 10, 3=Day 30, 4=Day 60, 5=Day 90)
 */
export async function sendMigrationFollowUp(
  dealerUuid: string,
  followUpNumber: 1 | 2 | 3 | 4 | 5,
  adminUserId?: string,
): Promise<{ ok: boolean; email: string | null; emailSent: boolean; warning?: string }> {
  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, inventory_dealer_id, primary_contact, primary_contact_email, invited_at")
    .eq("id", dealerUuid)
    .maybeSingle<DealerRow & { invited_at: string | null }>();
  if (!dealer) throw new Error(`Dealer not found: ${dealerUuid}`);
  if (!dealer.inventory_dealer_id) throw new Error(`No inventory_dealer_id for dealer "${dealer.name}"`);

  const all = await resolveMigrationRecipients(admin, dealer);
  if (all.length === 0) return { ok: false, email: null, emailSent: false, warning: `No contact email for "${dealer.name}"` };

  // Skip recipients who already completed (SAME shared predicate as the
  // initial send + manual Resend: accepted invitation OR real sign-in) — a
  // completed recipient must never be nagged.
  const done = await completedRecipientEmails(admin, dealer.id, all.map(r => r.email));
  const recipients = all.filter(r => !done.has(r.email));
  if (recipients.length === 0) return { ok: false, email: null, emailSent: false, warning: `All recipients for "${dealer.name}" already completed their invites` };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com";
  const invitedAt = dealer.invited_at ? new Date(dealer.invited_at) : new Date();
  const subjects: Record<number, string> = {
    1: `Your new platform account is waiting — ${dealer.name}`,
    2: `Still here when you're ready — ${dealer.name}`,
    3: `Platform 4.0 retiring soon — ${dealer.name}`,
    4: `60 days left — time to make the switch — ${dealer.name}`,
    5: `Last chance — Platform 4.0 retires in 30 days — ${dealer.name}`,
  };

  const warnings: string[] = [];
  let emailsSent = 0;
  for (const r of recipients) {
    let token: string;
    let code: string;
    try {
      ({ token, code } = await upsertRecipientInvite(admin, dealer, r, adminUserId));
    } catch (e) {
      warnings.push(`${r.email}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    try {
      await sendMandrillEmail({
        subject: subjects[followUpNumber] ?? subjects[1],
        from_email: "noreply@dealeraddendums.com",
        from_name: "DealerAddendums",
        to: [{ email: r.email, name: r.name || undefined }],
        html: buildMigrationFollowUpEmail({ firstName: r.firstName, orgName: dealer.name, migrateUrl: `${appUrl}/migrate?invite=${token}`, setupCode: code, followUpNumber, invitedAt }),
      });
      emailsSent++;
    } catch (mailErr) {
      warnings.push(`${r.email}: email failed (${mailErr instanceof Error ? mailErr.message : String(mailErr)})`);
    }
  }

  if (emailsSent > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin.from("dealers") as any).update({ invite_follow_up_count: followUpNumber }).eq("id", dealer.id);
  }

  return {
    ok: emailsSent > 0,
    email: recipients.map(r => r.email).join(", "),
    emailSent: emailsSent > 0,
    warning: warnings.length ? warnings.join(" · ") : undefined,
  };
}
