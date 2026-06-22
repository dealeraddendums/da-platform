/* eslint-disable @typescript-eslint/no-explicit-any */
// passkeys / invitations aren't in the generated Supabase types — loose client.
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildInviteEmail } from "@/lib/invite-email";

export const dynamic = "force-dynamic";

/**
 * POST /api/users/invite-all-staff   { inventory_dealer_id: string }
 *
 * Bulk STAFF-LOGIN invite for one dealer: emails a scanner-proof login-setup
 * invite (→ /signup → /api/invite/accept) to every staff profile that cannot yet
 * authenticate, so they set a passkey/password on their EXISTING profile and land
 * in the dealer. This is NOT migration — purpose='user' (so /migrate rejects it),
 * no migration_status, no billing, no account_type change. Each invite PRESERVES
 * the user's existing role + dealer.
 *
 * Auth: super_admin (any) · group_admin (in-group) · group_user (in-group AND
 * tagged) — all via authorizeDealerAction. Dealer roles excluded (operator/group
 * action). Token/ETL path is NOT accepted here (that's the migration endpoint).
 *
 * Skip criterion ("can the user already authenticate", determined BY-ID per
 * dealer): skip a profile only if its auth user exists AND (last_sign_in_at set
 * OR a registered passkey). Everyone else is invited.
 *
 * Returns { invited, already_existed, failed }.
 */

const DEALER_ROLES = new Set(["dealer_admin", "dealer_user", "dealer_restricted"]);
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type StaffProfile = { id: string; email: string; full_name: string | null; role: string };

function roleLabelFor(role: string): string {
  if (role === "dealer_admin") return "Dealer Admin";
  if (role === "dealer_restricted") return "Dealer Restricted";
  if (role === "dealer_user") return "Dealer User";
  return "Team Member";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // Operator/group action — never a self-serve dealer one (mirrors the dealer
  // user-management routes). group_admin / group_user are scoped below.
  if (DEALER_ROLES.has(claims.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { inventory_dealer_id?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const invId = body.inventory_dealer_id?.trim();
  if (!invId) return NextResponse.json({ error: "inventory_dealer_id required" }, { status: 400 });

  const admin = createAdminSupabaseClient();

  // Resolve the dealer. The UI carries the dealer's TEXT dealer_id in this field
  // (often == inventory_dealer_id, but not always), so match either — by
  // inventory_dealer_id first, then dealer_id — to avoid a spurious 404.
  let { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name")
    .eq("inventory_dealer_id", invId)
    .maybeSingle<{ id: string; dealer_id: string; name: string }>();
  if (!dealer) {
    ({ data: dealer } = await admin
      .from("dealers")
      .select("id, dealer_id, name")
      .eq("dealer_id", invId)
      .maybeSingle<{ id: string; dealer_id: string; name: string }>());
  }
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  // Authorize against its TEXT dealer_id — authorizeDealerAction grants
  // super_admin any / group_admin in-group / group_user in-group AND tagged.

  const authz = await authorizeDealerAction(claims, dealer.dealer_id);
  if (!authz.ok) return authz.response;

  // The dealer's staff profiles (profiles.dealer_id is the TEXT dealer_id).
  const { data: profileRows } = await admin
    .from("profiles")
    .select("id, email, full_name, role")
    .eq("dealer_id", dealer.dealer_id);
  const profiles = (profileRows ?? []) as StaffProfile[];

  // Passkeys for these users in ONE query (a passkey = a usable credential).
  const ids = profiles.map((p) => p.id);
  const passkeyUserIds = new Set<string>();
  if (ids.length) {
    const { data: pk } = await (admin as any).from("passkeys").select("user_id").in("user_id", ids);
    for (const r of pk ?? []) passkeyUserIds.add(r.user_id as string);
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com";
  let invited = 0;
  let already_existed = 0;
  let failed = 0;

  for (const p of profiles) {
    try {
      // Can this user already authenticate? BY-ID auth lookup (authoritative;
      // the listUsers/by-email map is unreliable). profile.id IS the auth uid (FK).
      const { data: got } = await admin.auth.admin.getUserById(p.id);
      const authUser = got?.user ?? null;
      const canAuthenticate = !!authUser && (!!authUser.last_sign_in_at || passkeyUserIds.has(p.id));
      if (canAuthenticate) { already_existed++; continue; }

      // Otherwise send a scanner-proof login-setup invite (purpose defaults to
      // 'user' → /migrate rejects, /signup accepts). Preserve role + dealer.
      const email = p.email.trim().toLowerCase();
      const [firstName, ...rest] = (p.full_name || email).trim().split(/\s+/);
      const code = generateSetupCode();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

      const { data: invRow, error: invErr } = await (admin as any)
        .from("invitations")
        .upsert({
          email,
          first_name: firstName || email,
          last_name: rest.join(" "),
          role: p.role,            // PRESERVE existing role
          dealer_id: dealer.id,    // invitations.dealer_id is the dealers.id UUID
          dealer_name: dealer.name,
          invited_by: claims.sub,
          accepted_at: null,
          expires_at: expiresAt,
          setup_code_hash: hashSetupCode(code),
          setup_code_expires_at: expiresAt,
          // purpose intentionally omitted → DB default 'user' (NOT 'migration').
        }, { onConflict: "email,dealer_id", ignoreDuplicates: false })
        .select("token")
        .single();
      if (invErr || !invRow?.token) { failed++; continue; }

      await sendMandrillEmail({
        subject: `Set up your login for ${dealer.name} on DA Platform`,
        from_email: "noreply@dealeraddendums.com",
        from_name: "DealerAddendums",
        to: [{ email, name: p.full_name || undefined, type: "to" }],
        html: buildInviteEmail({
          firstName: firstName || "there",
          orgName: dealer.name,
          roleLabel: roleLabelFor(p.role),
          inviteUrl: `${appUrl}/signup?invite=${invRow.token}`,
          setupCode: code,
        }),
      });
      invited++;
    } catch (err) {
      console.error(`[invite-all-staff] failed for ${p.email}:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  return NextResponse.json({ invited, already_existed, failed });
}
