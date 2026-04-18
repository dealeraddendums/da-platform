import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient, createAdminSupabaseClient } from "./db";
import type { UserRole } from "./db";

export type JwtClaims = {
  sub: string;
  email: string;
  role: UserRole;
  dealer_id: string | null;
  group_id: string | null;
  impersonating_dealer_id: string | null;
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
  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id, group_id")
    .eq("id", session.user.id)
    .single();

  return {
    sub: session.user.id,
    email: session.user.email ?? "",
    role: ((profile?.role as UserRole) ?? "dealer_user"),
    dealer_id: profile?.dealer_id ?? null,
    group_id: profile?.group_id ?? null,
    impersonating_dealer_id: impersonatingDealerId,
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
