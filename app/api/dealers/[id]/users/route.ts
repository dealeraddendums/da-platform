import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildInviteEmail } from "@/lib/invite-email";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { lastSignInByEmail } from "@/lib/last-sign-in";

type Params = { params: { id: string } };

const DEALER_ROLES = new Set(["dealer_admin", "dealer_user", "dealer_restricted"]);

/**
 * GET /api/dealers/[id]/users
 * Returns all profiles whose `dealer_id` matches this dealer's
 * platform-side text id (the `dealer_id` column, not the UUID).
 *
 * Auth:
 *   - super_admin: any dealer
 *   - group_admin: dealers in their group only
 *   - dealer_admin: their own dealer only
 *   - dealer_user / dealer_restricted: 403
 */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  // Look up the dealer once — we need both the text dealer_id (the
  // profiles.dealer_id FK convention) and the group_id for auth.
  const { data: dealerRow } = await admin
    .from("dealers")
    .select("id, dealer_id, group_id")
    .eq("id", params.id)
    .maybeSingle<{ id: string; dealer_id: string; group_id: string | null }>();
  if (!dealerRow) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  if (claims.role === "super_admin") {
    /* allowed */
  } else if (claims.role === "group_admin") {
    if (!dealerRow.group_id || dealerRow.group_id !== claims.group_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (claims.role === "dealer_admin") {
    if (dealerRow.dealer_id !== claims.dealer_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error: dbError } = await admin
    .from("profiles")
    .select("id, email, full_name, role, active, last_login, created_at")
    .eq("dealer_id", dealerRow.dealer_id)
    .in("role", ["dealer_admin", "dealer_user", "dealer_restricted"])
    .order("full_name");
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });

  // Merge last_sign_in_at from Supabase Auth via the GoTrue admin API, keyed by
  // email (same pattern as the group + main users routes). The `auth` schema
  // isn't exposed to PostgREST, so the old admin.schema("auth").from("users")
  // query always returned nothing → "Last sign in: Never" for every dealer user.
  const lastSignIn = await lastSignInByEmail();
  const enriched = (data ?? []).map(r => ({
    ...r,
    source: "dealer" as const,
    last_sign_in_at: lastSignIn.get((r.email ?? "").toLowerCase()) ?? null,
  }));

  // ── Group-scoped users (2026-08-12): group_users of this dealer's group
  // whose scope includes THIS dealer, shown read-only for transparency.
  // Reverse scope resolution: both named tags AND direct-dealer system tags
  // (migration 142) live in dealer_tags, so "this dealer's tags → user_tags
  // carrying any of them → group_user profiles of the same group" resolves
  // the canonical scope regardless of how it was authored.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminAny = admin as any;
  type GroupScopedRow = {
    id: string; email: string; full_name: string | null; role: string;
    active: boolean; last_login: string | null; created_at: string;
  };
  let groupScoped: Array<GroupScopedRow & { source: "group"; group_name: string | null; last_sign_in_at: string | null }> = [];
  let dealerTagIds: string[] = [];
  let groupName: string | null = null;
  if (dealerRow.group_id) {
    const { data: dts } = await adminAny
      .from("dealer_tags").select("tag_id").eq("dealer_id", dealerRow.id);
    dealerTagIds = ((dts ?? []) as Array<{ tag_id: string }>).map(r => r.tag_id);
    const { data: groupRow } = await admin
      .from("groups").select("name").eq("id", dealerRow.group_id).maybeSingle<{ name: string }>();
    groupName = groupRow?.name ?? null;
    if (dealerTagIds.length) {
      const { data: uts } = await adminAny
        .from("user_tags").select("user_id").in("tag_id", dealerTagIds);
      const userIds = Array.from(new Set(((uts ?? []) as Array<{ user_id: string }>).map(r => r.user_id)));
      if (userIds.length) {
        const { data: gu } = await admin
          .from("profiles")
          .select("id, email, full_name, role, active, last_login, created_at")
          .in("id", userIds)
          .eq("role", "group_user")
          .eq("group_id", dealerRow.group_id);
        // Don't double-count someone who is also a native dealer user — the
        // native row (editable) wins.
        const nativeEmails = new Set(enriched.map(r => (r.email ?? "").toLowerCase()));
        groupScoped = ((gu ?? []) as GroupScopedRow[])
          .filter(g => !nativeEmails.has((g.email ?? "").toLowerCase()))
          .map(g => ({
            ...g,
            source: "group" as const,
            group_name: groupName,
            last_sign_in_at: lastSignIn.get((g.email ?? "").toLowerCase()) ?? null,
          }))
          .sort((a, b) => (a.full_name ?? "").localeCompare(b.full_name ?? ""));
      }
    }
  }

  // Pending invitations for this dealer (invitations.dealer_id is the UUID).
  const { data: pending } = await adminAny
    .from("invitations")
    .select("id, email, first_name, last_name, role, created_at, expires_at")
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .eq("dealer_id", dealerRow.id)
    .order("created_at", { ascending: false });
  const pendingRows = ((pending ?? []) as Array<Record<string, unknown>>)
    .map(p => ({ ...p, source: "dealer" as const }));

  // Pending GROUP invitations that would grant access to this dealer: a
  // group_user invite whose carried scope (direct dealer picks and/or tags)
  // covers this dealer. Read-only here — resend/revoke live on the group tab.
  if (dealerRow.group_id) {
    const { data: ginvs } = await adminAny
      .from("invitations")
      .select("id, email, first_name, last_name, role, created_at, expires_at, scope_tag_ids, scope_dealer_ids")
      .eq("group_id", dealerRow.group_id)
      .eq("role", "group_user")
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    const tagSet = new Set(dealerTagIds);
    for (const inv of (ginvs ?? []) as Array<{ scope_tag_ids?: string[] | null; scope_dealer_ids?: string[] | null } & Record<string, unknown>>) {
      const covers =
        (inv.scope_dealer_ids ?? []).includes(dealerRow.id) ||
        (inv.scope_tag_ids ?? []).some(t => tagSet.has(t));
      if (!covers) continue;
      const { scope_tag_ids: _t, scope_dealer_ids: _d, ...rest } = inv;
      pendingRows.push({ ...rest, source: "group" as const, group_name: groupName } as never);
    }
  }

  return NextResponse.json({ data: [...enriched, ...groupScoped], pendingInvitations: pendingRows });
}

/**
 * POST /api/dealers/[id]/users
 * Invite a new dealer-side user (dealer_admin / dealer_user /
 * dealer_restricted). Creates a row in invitations + sends an email.
 *
 * Auth:
 *   - super_admin: any dealer
 *   - dealer_admin: their own dealer only
 *   - group_admin: dealers in their group (the member dealer they manage) —
 *     full dealer_admin parity, including inviting that dealer's users
 *   - dealer_user / dealer_restricted: 403
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // Write action: only admins of the dealer may invite. Dealer-scope (own /
  // in-group / any) is verified against the resolved dealer below. A group_user
  // (regional manager) flows through authorizeDealerAction → may manage staff of
  // their tagged dealers (full dealer parity); the role whitelist below still
  // limits them to DEALER_ROLES, so they can never mint a group-level user.
  if (claims.role === "dealer_user" || claims.role === "dealer_restricted") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { firstName?: string; lastName?: string; email?: string; role?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { firstName, lastName, email, role } = body;
  if (!firstName?.trim()) return NextResponse.json({ error: "First name required" }, { status: 400 });
  if (!lastName?.trim())  return NextResponse.json({ error: "Last name required" }, { status: 400 });
  if (!email?.trim())     return NextResponse.json({ error: "Email required" }, { status: 400 });
  if (!role || !DEALER_ROLES.has(role)) {
    return NextResponse.json({ error: "Role must be dealer_admin, dealer_user, or dealer_restricted" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name")
    .eq("id", params.id)
    .maybeSingle<{ id: string; dealer_id: string; name: string }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  // Dealer scope: dealer_admin → own; group_admin → in-group; super_admin → any.
  const authz = await authorizeDealerAction(claims, dealer.dealer_id);
  if (!authz.ok) return authz.response;
  // Only super_admin may mint another dealer_admin (dealer_admin and a
  // group_admin-as-dealer_admin are both barred).
  if (claims.role !== "super_admin" && role === "dealer_admin") {
    return NextResponse.json({ error: "Only super_admin can invite another dealer_admin" }, { status: 403 });
  }

  // Reject if already registered. (auth schema isn't on the data API — the old
  // admin.schema("auth") check silently returned null; a profile is the reliable
  // case-insensitive existence signal.)
  const { data: existingProfile } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", email.trim().toLowerCase())
    .maybeSingle<{ id: string }>();
  if (existingProfile) {
    return NextResponse.json({ error: "This email is already registered." }, { status: 409 });
  }

  const setupCode = generateSetupCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inv, error: invErr } = await (admin as any)
    .from("invitations")
    .upsert({
      email: email.trim().toLowerCase(),
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      role,
      dealer_id: dealer.id, // invitations.dealer_id is uuid REFERENCES dealers(id), not the TEXT code
      group_id: null,
      invited_by: claims.sub,
      accepted_at: null,
      expires_at: expiresAt,
      setup_code_hash: hashSetupCode(setupCode),
      setup_code_expires_at: expiresAt,
    }, { onConflict: "email,dealer_id", ignoreDuplicates: false })
    .select("token")
    .single() as { data: { token: string } | null; error: { message: string } | null };

  if (invErr || !inv) {
    return NextResponse.json({ error: invErr?.message ?? "Failed to create invitation" }, { status: 500 });
  }

  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/signup?invite=${inv.token}`;
  const fullName = `${firstName.trim()} ${lastName.trim()}`;
  const roleLabel = role === "dealer_admin" ? "Dealer Admin" : role === "dealer_restricted" ? "Dealer Restricted" : "Dealer User";

  try {
    await sendMandrillEmail({
      subject: `You've been invited to join ${dealer.name} on DA Platform`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email: email.trim(), name: fullName, type: "to" }],
      html: buildInviteEmail({ firstName: firstName.trim(), orgName: dealer.name, roleLabel, inviteUrl, setupCode }),
    });
  } catch (mailErr) {
    // Invitation row exists — surface the email failure but return 200 so the
    // operator knows the row was created. emailSent:false drives the UI warning.
    return NextResponse.json(
      { ok: true, emailSent: false, warning: `Invitation created, but the email could not be delivered: ${mailErr instanceof Error ? mailErr.message : String(mailErr)}` },
    );
  }

  return NextResponse.json({ ok: true, emailSent: true });
}
