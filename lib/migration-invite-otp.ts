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
import { buildMigrationInviteEmail } from "@/lib/invite-email";

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
): Promise<MigrationInviteResult> {
  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, name, inventory_dealer_id, primary_contact, primary_contact_email")
    .eq("inventory_dealer_id", inventoryDealerId)
    .maybeSingle<{ id: string; name: string; inventory_dealer_id: string; primary_contact: string | null; primary_contact_email: string | null }>();
  if (!dealer) throw new Error(`Dealer not found: ${inventoryDealerId}`);

  // Recipient: the dealer's primary contact; fall back to a dealer_admin profile.
  let email = (dealer.primary_contact_email ?? "").trim().toLowerCase();
  let contactName = (dealer.primary_contact ?? "").trim();
  if (!email) {
    const { data: prof } = await admin
      .from("profiles")
      .select("email, full_name")
      .eq("dealer_id", inventoryDealerId)
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
  let res = await inv.upsert({ ...baseRow, purpose: "migration" }, { onConflict: "email,dealer_id", ignoreDuplicates: false }).select("token").single();
  if (res.error && /purpose/i.test(res.error.message ?? "")) {
    res = await inv.upsert(baseRow, { onConflict: "email,dealer_id", ignoreDuplicates: false }).select("token").single();
  }
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
      subject: `Action needed: migrate ${dealer.name} to the new DealerAddendums platform`,
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
