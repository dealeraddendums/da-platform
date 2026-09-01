import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { lastSignInByEmail, lastSignInByEmailStrict } from "@/lib/last-sign-in";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";
import { buildGroupAdminMigrationInviteEmail } from "@/lib/invite-email";
import { sendMandrillEmail } from "@/lib/mandrill";

export const dynamic = "force-dynamic";

// Group-level migration: group-admin candidates + migration-flavored invites.
// super_admin only (Migration Console).
//
// Candidate sources: existing group_admin profiles for the group (with
// auth/last-sign-in status via the GoTrue map) + the group's contact-on-file
// (groups.email) as a suggestion + free-form entries from the modal. NOTE:
// there is NO live Aurora candidate read — da-platform has no runtime Aurora
// client (mysql2 is scripts-only) and the profiles ETL job was retired
// 2026-06-05, so Aurora-only group users are covered by the free-form entry.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const groupId = (req.nextUrl.searchParams.get("group_id") || "").trim();
  if (!UUID_RE.test(groupId)) return NextResponse.json({ error: "group_id (uuid) required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: group } = await admin
    .from("groups")
    .select("id, name, email, billing_contact")
    .eq("id", groupId)
    .maybeSingle<{ id: string; name: string; email: string | null; billing_contact: string | null }>();
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

  const { data: profiles } = await admin
    .from("profiles")
    .select("id, email, full_name, active")
    .eq("group_id", groupId)
    .eq("role", "group_admin");

  // Two signals, deliberately distinct (see lib/last-sign-in.ts):
  //   strict  = "can this human log in to 5.0 RIGHT NOW" — impersonation-,
  //             recovery- and forced-reset-excluded, NO legacy fallback.
  //   display = "last seen", which for an impersonation-polluted account falls
  //             back to the 4.0-era Aurora profiles.last_login.
  // Gate A and the invite/skip decision MUST use strict. Using display here is
  // what showed Straub's michaelh@ as "Active ✓ · signed in 1/28/2024" — a 4.0
  // Aurora stamp from 27 months before his auth user even existed — and let the
  // group migrate on a premise no admin could actually satisfy (2026-09-01).
  const [signIns, seen] = await Promise.all([lastSignInByEmailStrict(), lastSignInByEmail()]);
  const admins = ((profiles ?? []) as { id: string; email: string | null; full_name: string | null; active: boolean | null }[])
    .filter((p) => p.email)
    .map((p) => {
      const email = (p.email as string).toLowerCase();
      const hasAuth = signIns.has(email);
      const lastSignIn = signIns.get(email) ?? null;
      const lastSeen = seen.get(email) ?? null;
      return {
        id: p.id, email, full_name: p.full_name, active: p.active !== false,
        has_auth: hasAuth,
        last_sign_in: lastSignIn,
        // Only surfaced when it ISN'T a verified 5.0 login, so the modal can say
        // "last seen X" honestly instead of dressing it up as a sign-in.
        last_seen: lastSignIn ? null : lastSeen,
      };
    });

  // Pending group_admin invitations (not accepted, not expired).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: pendingRaw } = await (admin as any)
    .from("invitations")
    .select("email, first_name, last_name, created_at, expires_at")
    .eq("group_id", groupId)
    .eq("role", "group_admin")
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString());

  const knownEmails = new Set(admins.map((a) => a.email));
  const suggestedEmail = group.email && !knownEmails.has(group.email.toLowerCase()) ? group.email.toLowerCase() : null;

  return NextResponse.json({
    group: { id: group.id, name: group.name },
    admins,
    pending: pendingRaw ?? [],
    suggested: suggestedEmail ? { email: suggestedEmail, name: group.billing_contact ?? null, source: "group contact on file" } : null,
    admin_active: admins.some((a) => a.active && a.last_sign_in),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { group_id?: string; invites?: Array<{ first_name?: string; last_name?: string; email?: string }> };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const groupId = (body.group_id || "").trim();
  if (!UUID_RE.test(groupId)) return NextResponse.json({ error: "group_id (uuid) required" }, { status: 400 });
  const invites = (body.invites ?? [])
    .map((i) => ({
      first_name: (i.first_name || "").trim(),
      last_name: (i.last_name || "").trim(),
      email: (i.email || "").trim().toLowerCase(),
    }))
    .filter((i) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(i.email));
  if (invites.length === 0 || invites.length > 10) {
    return NextResponse.json({ error: "1–10 invites with valid emails required." }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data: group } = await admin.from("groups").select("id, name").eq("id", groupId).maybeSingle<{ id: string; name: string }>();
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
  const { count: dealerCount } = await admin
    .from("dealers").select("id", { count: "exact", head: true })
    .eq("group_id", groupId).eq("active", true);

  // STRICT: an admin whose only "sign-in" is an impersonation mint, a consumed
  // recovery link, or who is still pinned to /reset-password has no working
  // credentials and MUST remain invitable.
  const signIns = await lastSignInByEmailStrict();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com";
  const results: Array<{ email: string; status: "sent" | "skipped" | "error"; detail?: string }> = [];

  for (const inv of invites) {
    // Skip ONLY users who have actually signed in — they have working
    // credentials, so there's nothing to invite them to. "Has an auth user"
    // is NOT enough: shuffled legacy admins have an ETL/migration-era auth user
    // but never signed in and don't know any credentials — they can and must be
    // (re-)invited. /api/invite/accept resolves the existing auth user and
    // updates its password on submit (no duplicate user is ever created).
    if (signIns.get(inv.email)) {
      results.push({ email: inv.email, status: "skipped", detail: "already active — has signed in, no invite needed" });
      continue;
    }

    const setupCode = generateSetupCode();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    // Same invitation shape as the group Users-tab flow (consumed by
    // /api/invite/accept). Unlike that flow we do NOT block on an existing
    // profiles row — legacy group admins often have an ETL-era profile with
    // no auth user, and this invite is exactly how they get one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: created, error: invErr } = await (admin as any)
      .from("invitations")
      .upsert({
        email: inv.email,
        first_name: inv.first_name || inv.email.split("@")[0],
        last_name: inv.last_name || "",
        role: "group_admin",
        group_id: groupId,
        dealer_id: null,
        invited_by: claims.sub,
        accepted_at: null,
        expires_at: expiresAt,
        setup_code_hash: hashSetupCode(setupCode),
        setup_code_expires_at: expiresAt,
      }, { onConflict: "email,group_id", ignoreDuplicates: false })
      .select("token")
      .single() as { data: { token: string } | null; error: { message: string } | null };
    if (invErr || !created) {
      results.push({ email: inv.email, status: "error", detail: invErr?.message ?? "invitation create failed" });
      continue;
    }

    try {
      await sendMandrillEmail({
        subject: `You're invited to manage ${group.name} on DealerAddendums Platform 5.0`,
        from_email: "noreply@dealeraddendums.com",
        from_name: "DealerAddendums",
        to: [{ email: inv.email, name: `${inv.first_name} ${inv.last_name}`.trim() || inv.email }],
        html: buildGroupAdminMigrationInviteEmail({
          firstName: inv.first_name || "there",
          groupName: group.name,
          dealerCount: dealerCount ?? 0,
          inviteUrl: `${appUrl}/signup?invite=${created.token}`,
          setupCode,
        }),
      });
      results.push({ email: inv.email, status: "sent" });
    } catch (e) {
      results.push({ email: inv.email, status: "error", detail: `invite created but email failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  return NextResponse.json({ ok: results.every((r) => r.status !== "error"), results });
}
