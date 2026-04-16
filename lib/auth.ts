import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "./db";
import type { UserRole } from "./db";

export type JwtClaims = {
  sub: string;
  email: string;
  role: UserRole;
  dealer_id: string | null;
};

/** Extract session and custom claims from the Supabase cookie session. */
export async function getJwtClaims(): Promise<JwtClaims | null> {
  const supabase = createServerSupabaseClient();
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session) return null;

  const appMeta = session.user.app_metadata as Partial<JwtClaims>;
  const userMeta = session.user.user_metadata as Partial<JwtClaims>;

  return {
    sub: session.user.id,
    email: session.user.email ?? "",
    role: (appMeta.role ?? userMeta.role ?? "dealer_user") as UserRole,
    dealer_id: (appMeta.dealer_id ?? userMeta.dealer_id ?? null) as string | null,
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
