import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "./db";
import type { UserRole } from "./db";

export type JwtClaims = {
  sub: string;
  email: string;
  user_type: UserRole;
  dealer_id: string;
  /** Present only during an active impersonation session */
  impersonating_dealer_id?: string;
  /** The original root_admin user id preserved during impersonation */
  real_user_id?: string;
};

/** Extract custom JWT claims from the Supabase session. */
export async function getJwtClaims(): Promise<JwtClaims | null> {
  const supabase = createServerSupabaseClient();
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session) return null;

  const metadata = session.user.user_metadata as Partial<JwtClaims>;
  const appMetadata = session.user.app_metadata as Partial<JwtClaims>;

  // app_metadata is set server-side and is authoritative for role/dealer_id
  return {
    sub: session.user.id,
    email: session.user.email ?? "",
    user_type: (appMetadata.user_type ?? metadata.user_type ?? "dealer") as UserRole,
    dealer_id: (appMetadata.dealer_id ?? metadata.dealer_id ?? "") as string,
    impersonating_dealer_id: appMetadata.impersonating_dealer_id as string | undefined,
    real_user_id: appMetadata.real_user_id as string | undefined,
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

/** Require root_admin role; return 403 otherwise. */
export async function requireRootAdmin(): Promise<
  { claims: JwtClaims; error: null } | { claims: null; error: NextResponse }
> {
  const result = await requireAuth();
  if (result.error) return result;

  if (result.claims.user_type !== "root_admin") {
    return {
      claims: null,
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return result;
}

/** Check whether a given role has admin-level platform access. */
export function isAdminRole(role: UserRole): boolean {
  return role === "root_admin" || role === "reseller_admin";
}

/** Map legacy USER_TYPE strings to our normalised UserRole enum. */
export function normaliseLegacyUserType(raw: string): UserRole {
  const map: Record<string, UserRole> = {
    RootAdmin: "root_admin",
    ResellerAdmin: "reseller_admin",
    ResellerUser: "reseller_user",
    GroupAdmin: "group_admin",
    GroupUser: "group_user",
    GroupUserRestricted: "group_user_restricted",
    Dealer: "dealer",
  };
  return map[raw] ?? "dealer";
}

/** Build a params object for a request from NextRequest searchParams. */
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
