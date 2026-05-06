import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
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

/** Extract session and custom claims from the Supabase cookie session. */
export async function getJwtClaims(): Promise<JwtClaims | null> {
  const supabase = createServerSupabaseClient();
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session) return null;

  // Impersonation: super_admin can impersonate a dealer via app_metadata
  const appMeta = session.user.app_metadata as Record<string, unknown> | undefined;
  const impersonatingDealerId = (appMeta?.impersonating_dealer_id as string | null) ?? null;

  // Use profiles table as source of truth for role/dealer_id/group_id
  // so changes take effect immediately without requiring re-login.
  const admin = createAdminSupabaseClient();
  const { data: profileById } = await admin
    .from("profiles")
    .select("role, dealer_id, group_id, active_dealer_id")
    .eq("id", session.user.id)
    .maybeSingle();

  // Fallback: ETL-synced profiles may have a legacy UUID as their id that doesn't
  // match the Supabase auth UUID returned after magic-link impersonation. Look up
  // by email so impersonated sessions get the correct role and dealer_id.
  let profile = profileById;
  if (!profile && session.user.email) {
    const { data: profileByEmail } = await admin
      .from("profiles")
      .select("role, dealer_id, group_id, active_dealer_id")
      .eq("email", session.user.email)
      .maybeSingle();
    profile = profileByEmail;
    if (profile) {
      console.log("[auth] profile resolved by email fallback — UUID mismatch", {
        authId: session.user.id,
        email: session.user.email,
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
  if (role === "group_admin" && profile?.active_dealer_id) {
    activeDealerUuid = profile.active_dealer_id;
    const { data: activeDlr } = await admin
      .from("dealers")
      .select("dealer_id")
      .eq("id", activeDealerUuid)
      .maybeSingle<{ dealer_id: string }>();
    if (activeDlr) dealerId = activeDlr.dealer_id;
  }

  // Ghost mode: super_admin operates in dealer context without a real session swap
  let isGhost = false;
  let ghostDealerUuid: string | null = null;
  if (role === "super_admin") {
    try {
      const cookieStore = cookies();
      const ghostToken = cookieStore.get("da_ghost_token")?.value;
      if (ghostToken) {
        const ghostCtx = verifyGhostToken(ghostToken);
        if (ghostCtx?.dealer_text_id) {
          dealerId = ghostCtx.dealer_text_id;
          isGhost = true;
          ghostDealerUuid = ghostCtx.dealer_id ?? null;
        }
      }
    } catch {
      // cookies() may throw outside a request context — ignore
    }
  }

  return {
    sub: session.user.id,
    email: session.user.email ?? "",
    role,
    dealer_id: dealerId,
    group_id: profile?.group_id ?? null,
    impersonating_dealer_id: impersonatingDealerId,
    active_dealer_id: activeDealerUuid,
    is_ghost: isGhost,
    ghost_dealer_uuid: ghostDealerUuid,
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
