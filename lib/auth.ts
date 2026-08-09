import { NextRequest, NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { createServerSupabaseClient, createAdminSupabaseClient } from "./db";
import type { UserRole } from "./db";
import { verifyGhostToken } from "./ghost";

export type JwtClaims = {
  sub: string;
  email: string;
  role: UserRole;
  dealer_id: string | null;
  group_id: string | null;
  impersonating_dealer_id: string | null;
  /** UUID of the dealer a group_admin has switched into; null otherwise. */
  active_dealer_id: string | null;
  /** True when super_admin is in ghost mode (no real dealer user session). */
  is_ghost: boolean;
  /** UUID of the dealer being ghosted; null otherwise. */
  ghost_dealer_uuid: string | null;
  /**
   * UUID of the GROUP being ghosted (groups.id); null otherwise. Group ghost
   * deliberately does NOT set is_ghost — every existing is_ghost consumer
   * means "operating in a DEALER context" (pairs it with claims.dealer_id),
   * and group ghost historically left those untouched. Routes that need
   * group-ghost awareness read this field explicitly.
   */
  ghost_group_uuid: string | null;
  /**
   * Tag ids that scope a `group_user` (regional manager): they may only see /
   * manage in-group dealers carrying one of these tags. Empty ⇒ no dealers.
   * Always `[]` for other roles.
   */
  scope_tag_ids: string[];
};

export type ServerProfile = {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  dealer_id: string | null;
  group_id: string | null;
};

/**
 * Reads the current user's profile via admin client (bypasses RLS).
 * Use this in page server components instead of querying profiles with
 * the user-scoped client, which can return null if the JWT is stale.
 * Returns null if there is no active session.
 */
export async function getServerProfile(): Promise<{
  session: { user: { id: string; email?: string; app_metadata?: Record<string, unknown> } };
  profile: ServerProfile | null;
} | null> {
  const supabase = createServerSupabaseClient();
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) return null;

  const admin = createAdminSupabaseClient();
  const { data, error: dbError } = await admin
    .from("profiles")
    .select("id, email, full_name, role, dealer_id, group_id")
    .eq("id", session.user.id)
    .single();

  if (data) {
    return { session, profile: data as ServerProfile };
  }

  // DB query failed — fall back to JWT app_metadata (set when role changes)
  if (dbError) {
    const appMeta = session.user.app_metadata as Record<string, unknown> | undefined;
    const role = (appMeta?.role as UserRole | undefined) ?? "dealer_user";
    return {
      session,
      profile: {
        id: session.user.id,
        email: session.user.email ?? "",
        full_name: null,
        role,
        dealer_id: (appMeta?.dealer_id as string | null) ?? null,
        group_id: (appMeta?.group_id as string | null) ?? null,
      },
    };
  }

  return { session, profile: null };
}

/**
 * Headless-client fallback (mobile app, IOS-APP-SPEC §8.4): resolve the user
 * from an `Authorization: Bearer <supabase JWT>` header when there is no
 * cookie session. The token is verified server-side by GoTrue
 * (auth.getUser(jwt) checks signature + expiry) — no weakening vs cookies.
 */
async function getBearerUser(): Promise<{ id: string; email?: string; app_metadata?: Record<string, unknown> } | null> {
  try {
    const authz = headers().get("authorization") ?? "";
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const { data, error } = await createAdminSupabaseClient().auth.getUser(m[1]);
    if (error || !data.user) return null;
    return data.user as { id: string; email?: string; app_metadata?: Record<string, unknown> };
  } catch {
    return null; // headers() may throw outside a request context
  }
}

/** Extract session and custom claims from the Supabase cookie session,
 *  or from an Authorization: Bearer JWT (headless/mobile clients). */
export async function getJwtClaims(): Promise<JwtClaims | null> {
  const supabase = createServerSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  // Cookie session wins; Bearer is the headless path (mobile app).
  const user = session?.user ?? (await getBearerUser());
  if (!user) return null;

  // Impersonation: super_admin can impersonate a dealer via app_metadata
  const appMeta = user.app_metadata as Record<string, unknown> | undefined;
  const impersonatingDealerId = (appMeta?.impersonating_dealer_id as string | null) ?? null;

  // Use profiles table as source of truth for role/dealer_id/group_id
  // so changes take effect immediately without requiring re-login.
  const admin = createAdminSupabaseClient();
  const { data: profileById } = await admin
    .from("profiles")
    .select("id, role, dealer_id, group_id, active_dealer_id")
    .eq("id", user.id)
    .maybeSingle();

  // Fallback: ETL-synced profiles may have a legacy UUID as their id that doesn't
  // match the Supabase auth UUID returned after magic-link impersonation. Look up
  // by email so impersonated sessions get the correct role and dealer_id.
  let profile = profileById;
  if (!profile && user.email) {
    const { data: profileByEmail } = await admin
      .from("profiles")
      .select("id, role, dealer_id, group_id, active_dealer_id")
      .eq("email", user.email)
      .maybeSingle();
    profile = profileByEmail;
    if (profile) {
      console.log("[auth] profile resolved by email fallback — UUID mismatch", {
        authId: user.id,
        email: user.email,
        role: profile.role,
        dealer_id: profile.dealer_id,
      });
    }
  }

  const role = ((profile?.role as UserRole) ?? "dealer_user");
  let dealerId = profile?.dealer_id ?? null;
  let activeDealerUuid: string | null = null;

  // When a group_admin has an active dealer selected, resolve the dealer's
  // text dealer_id so all downstream routes work without special-casing.
  //
  // Session-layer group-level reset (#116): when a group is freshly impersonated,
  // entry sets the `da_group_level` cookie so we IGNORE the impersonated user's
  // persisted active_dealer_id and land at GROUP level — WITHOUT mutating their
  // profile. The cookie is cleared the moment they explicitly switch into a
  // dealer (/api/profiles/active-dealer) or exit impersonation.
  let groupLevelReset = false;
  try { groupLevelReset = cookies().get("da_group_level")?.value === "1"; } catch { /* no req ctx */ }
  // group_user (regional manager) switches into a tagged dealer the same way a
  // group_admin does — resolve the active dealer's text id for downstream routes.
  if ((role === "group_admin" || role === "group_user") && profile?.active_dealer_id && !groupLevelReset) {
    activeDealerUuid = profile.active_dealer_id;
    const { data: activeDlr } = await admin
      .from("dealers")
      .select("dealer_id")
      .eq("id", activeDealerUuid)
      .maybeSingle<{ dealer_id: string }>();
    if (activeDlr) dealerId = activeDlr.dealer_id;
  }

  // group_user scope: the tags assigned to this manager (user_tags). Keyed on
  // the resolved profile id (email-fallback aware). Empty ⇒ no dealers.
  let scopeTagIds: string[] = [];
  if (role === "group_user") {
    const uid = profile?.id ?? user.id;
    // user_tags isn't in the generated Supabase types yet (migration 109).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tagRows } = await (admin as any).from("user_tags").select("tag_id").eq("user_id", uid);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scopeTagIds = (tagRows ?? []).map((r: any) => r.tag_id as string);
  }

  // Ghost mode: super_admin operates in dealer context without a real session swap
  let isGhost = false;
  let ghostDealerUuid: string | null = null;
  let ghostGroupUuid: string | null = null;
  if (role === "super_admin") {
    try {
      const cookieStore = cookies();
      // Cookie (web admin panel) wins; the X-DA-Ghost-Token header is the
      // mobile operate-as path (IOS-APP-SPEC §8.4) — same token format, same
      // verifyGhostToken() verification, minted by POST /api/auth/ghost.
      let ghostToken = cookieStore.get("da_ghost_token")?.value;
      if (!ghostToken) {
        try { ghostToken = headers().get("x-da-ghost-token") ?? undefined; } catch { /* no req ctx */ }
      }
      if (ghostToken) {
        const ghostCtx = verifyGhostToken(ghostToken);
        if (ghostCtx?.dealer_text_id) {
          dealerId = ghostCtx.dealer_text_id;
          isGhost = true;
          ghostDealerUuid = ghostCtx.dealer_id ?? null;
        } else if (ghostCtx?.group_id) {
          // Group ghost: surface the group UUID only (is_ghost stays false —
          // see the JwtClaims field comment).
          ghostGroupUuid = ghostCtx.group_id;
        }
      }
    } catch {
      // cookies() may throw outside a request context — ignore
    }
  }

  return {
    sub: user.id,
    email: user.email ?? "",
    role,
    dealer_id: dealerId,
    group_id: profile?.group_id ?? null,
    impersonating_dealer_id: impersonatingDealerId,
    active_dealer_id: activeDealerUuid,
    is_ghost: isGhost,
    ghost_dealer_uuid: ghostDealerUuid,
    ghost_group_uuid: ghostGroupUuid,
    scope_tag_ids: scopeTagIds,
  };
}

/** Require an authenticated session; return 401 if missing. */
export async function requireAuth(): Promise<
  { claims: JwtClaims; error: null } | { claims: null; error: NextResponse }
> {
  const claims = await getJwtClaims();
  if (!claims) {
    return {
      claims: null,
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { claims, error: null };
}

/** Require super_admin role; return 403 otherwise. */
export async function requireSuperAdmin(): Promise<
  { claims: JwtClaims; error: null } | { claims: null; error: NextResponse }
> {
  const result = await requireAuth();
  if (result.error) return result;

  if (result.claims.role !== "super_admin") {
    return {
      claims: null,
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return result;
}

/** Check whether a role has platform-wide admin access. */
export function isAdminRole(role: UserRole): boolean {
  return role === "super_admin";
}

/** Check whether a role has group-level admin access. */
export function isGroupAdmin(role: UserRole): boolean {
  return role === "super_admin" || role === "group_admin";
}

/** Build a params object from NextRequest searchParams. */
export function parseQueryParams(
  req: NextRequest,
  keys: string[]
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const key of keys) {
    result[key] = req.nextUrl.searchParams.get(key) ?? undefined;
  }
  return result;
}
