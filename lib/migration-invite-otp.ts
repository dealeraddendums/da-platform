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

import { createAdminSupabaseClient } from "@/lib/db";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildMigrationInviteEmail, buildMigrationFollowUpEmail } from "@/lib/invite-email";

export interface MigrationInviteResult {
  ok: boolean;
  dealer_name: string;
  email: string | null;
  emailSent: boolean;
  warning?: string;
}

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14-day migration window

/**
 * Create (or refresh) a scanner-proof migration invite for one dealer and email
 * the dealer's primary contact an 8-digit code + an inert /migrate link. Stamps
 * dealers.migration_status='invited'. Resolves the dealer by inventory_dealer_id
 * (the text id ETL/profiles key on).
 */
export async function sendMigrationInvite(
  inventoryDealerId: string,
  adminUserId?: string,
  waveId?: string,
): Promise<MigrationInviteResult> {
  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, inventory_dealer_id, primary_contact, primary_contact_email")
    .eq("inventory_dealer_id", inventoryDealerId)
    .maybeSingle<{ id: string; dealer_id: string; name: string; inventory_dealer_id: string; primary_contact: string | null; primary_contact_email: string | null }>();
  if (!dealer) throw new Error(`Dealer not found: ${inventoryDealerId}`);

  // Recipient: the dealer's primary contact; fall back to a dealer_admin profile.
  let email = (dealer.primary_contact_email ?? "").trim().toLowerCase();
  let contactName = (dealer.primary_contact ?? "").trim();
  if (!email) {
    // profiles.dealer_id is the dealer's TEXT dealer_id (can differ from
    // inventory_dealer_id), so look up by dealer.dealer_id, not the param.
    const { data: prof } = await admin
      .from("profiles")
      .select("email, full_name")
      .eq("dealer_id", dealer.dealer_id)
      .eq("role", "dealer_admin")
      .limit(1)
      .maybeSingle<{ email: string | null; full_name: string | null }>();
    email = (prof?.email ?? "").trim().toLowerCase();
    if (!contactName) contactName = (prof?.full_name ?? "").trim();
  }
  if (!email) throw new Error(`No contact email for dealer "${dealer.name}" (${inventoryDealerId}) — cannot send migration invite`);

  const [firstName, ...rest] = (contactName || "there").split(/\s+/);
  const code = generateSetupCode();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const baseRow = {
    email,
    first_name: firstName || "there",
    last_name: rest.join(" "),
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
  // them. Resilient to migration 102 not being applied yet (falls back without
  // purpose so the invite still works; apply 102 for the cross-flow guard).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = (admin as any).from("invitations");
  const up = (row: Record<string, unknown>) => inv.upsert(row, { onConflict: "email,dealer_id", ignoreDuplicates: false }).select("token").single();
  // Try with purpose (migration 102) + wave_id (migration 103); fall back as
  // each column may be unapplied. purpose is the important marker, so drop
  // wave_id first, then purpose only if still erroring.
  let res = await up({ ...baseRow, purpose: "migration", ...(waveId ? { wave_id: waveId } : {}) });
  if (res.error && /wave_id/i.test(res.error.message ?? "")) res = await up({ ...baseRow, purpose: "migration" });
  if (res.error && /purpose/i.test(res.error.message ?? "")) res = await up(baseRow);
  if (res.error || !res.data) throw new Error(res.error?.message ?? "Failed to create migration invitation");
  const token: string = res.data.token;

  // Stamp invited (ETL keeps syncing until 'migrated'; 'invited' is just status).
  await admin
    .from("dealers")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ migration_status: "invited", invited_at: new Date().toISOString() } as any)
    .eq("id", dealer.id);

  const migrateUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/migrate?invite=${token}`;
  try {
    await sendMandrillEmail({
      subject: `You're invited to DealerAddendums Platform 5.0 — ${dealer.name}`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email, name: contactName || undefined }],
      html: buildMigrationInviteEmail({ firstName: firstName || "there", orgName: dealer.name, migrateUrl, setupCode: code }),
    });
  } catch (mailErr) {
    return { ok: true, dealer_name: dealer.name, email, emailSent: false, warning: `Invite row created, but the email could not be delivered: ${mailErr instanceof Error ? mailErr.message : String(mailErr)}` };
  }

  return { ok: true, dealer_name: dealer.name, email, emailSent: true };
}

/**
 * Send a follow-up migration invite for a dealer that hasn't migrated yet.
 * Generates a fresh code (14-day TTL, same invitations upsert as
 * sendMigrationInvite), sends the follow-up email with escalating urgency
 * copy, and sets dealers.invite_follow_up_count. Does NOT touch invited_at —
 * the drip clock stays anchored on the original invite.
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
    .maybeSingle<{ id: string; dealer_id: string; name: string; inventory_dealer_id: string | null; primary_contact: string | null; primary_contact_email: string | null; invited_at: string | null }>();
  if (!dealer) throw new Error(`Dealer not found: ${dealerUuid}`);
  if (!dealer.inventory_dealer_id) throw new Error(`No inventory_dealer_id for dealer "${dealer.name}"`);

  // Recipient resolution mirrors sendMigrationInvite: primary contact, else a
  // dealer_admin profile (profiles.dealer_id is the TEXT dealer_id).
  let email = (dealer.primary_contact_email ?? "").trim().toLowerCase();
  let contactName = (dealer.primary_contact ?? "").trim();
  if (!email) {
    const { data: prof } = await admin
      .from("profiles")
      .select("email, full_name")
      .eq("dealer_id", dealer.dealer_id)
      .eq("role", "dealer_admin")
      .limit(1)
      .maybeSingle<{ email: string | null; full_name: string | null }>();
    email = (prof?.email ?? "").trim().toLowerCase();
    if (!contactName) contactName = (prof?.full_name ?? "").trim();
  }
  if (!email) return { ok: false, email: null, emailSent: false, warning: `No contact email for "${dealer.name}"` };

  const [firstName, ...rest] = (contactName || "there").split(/\s+/);
  const code = generateSetupCode();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const baseRow = {
    email,
    first_name: firstName || "there",
    last_name: rest.join(" "),
    role: "dealer_admin" as const,
    dealer_id: dealer.id,        // invitations.dealer_id is the dealers.id UUID
    dealer_name: dealer.name,
    invited_by: adminUserId ?? null,
    accepted_at: null,
    expires_at: expiresAt,
    setup_code_hash: hashSetupCode(code),
    setup_code_expires_at: expiresAt,
    purpose: "migration",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = (admin as any).from("invitations");
  const res = await inv.upsert(baseRow, { onConflict: "email,dealer_id", ignoreDuplicates: false }).select("token").single();
  if (res.error || !res.data) return { ok: false, email, emailSent: false, warning: res.error?.message ?? "Failed to upsert invitation" };
  const token: string = res.data.token;

  const migrateUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/migrate?invite=${token}`;
  const invitedAt = dealer.invited_at ? new Date(dealer.invited_at) : new Date();

  const subjects: Record<number, string> = {
    1: `Your new platform account is waiting — ${dealer.name}`,
    2: `Still here when you're ready — ${dealer.name}`,
    3: `Platform 4.0 retiring soon — ${dealer.name}`,
    4: `60 days left — time to make the switch — ${dealer.name}`,
    5: `Last chance — Platform 4.0 retires in 30 days — ${dealer.name}`,
  };

  try {
    await sendMandrillEmail({
      subject: subjects[followUpNumber] ?? subjects[1],
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email, name: contactName || undefined }],
      html: buildMigrationFollowUpEmail({ firstName: firstName || "there", orgName: dealer.name, migrateUrl, setupCode: code, followUpNumber, invitedAt }),
    });
  } catch (mailErr) {
    return { ok: true, email, emailSent: false, warning: `Code refreshed but email failed: ${mailErr instanceof Error ? mailErr.message : String(mailErr)}` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin.from("dealers") as any).update({ invite_follow_up_count: followUpNumber }).eq("id", dealer.id);

  return { ok: true, email, emailSent: true };
}
