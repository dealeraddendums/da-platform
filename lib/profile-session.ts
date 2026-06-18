import type { SupabaseClient, Session } from "@supabase/supabase-js";

/**
 * Resolve the signed-in user's profile row, mirroring `getJwtClaims`
 * (lib/auth.ts) EXACTLY: look up `profiles` by `id = session.user.id`; if that
 * misses AND the session has an email, fall back to `email = session.user.email`.
 *
 * Why the fallback: ETL/migrated profiles can carry a legacy UUID as their `id`
 * that doesn't match the Supabase auth uid returned after magic-link
 * impersonation. The API layer (requireAuth → getJwtClaims) already handles this;
 * server pages that resolved the profile by id only would mis-resolve such a
 * dealer under "Viewing as" (role→dealer_user, dealer_id→null). This shares the
 * SAME resolution so pages and the API agree.
 *
 * No authorization is loosened: the email fallback fires ONLY when the by-id
 * lookup misses, and the email comes from the authenticated session.
 *
 * `columns` defaults to the role/dealer/group set most pages need; callers that
 * select more (e.g. full_name, account_type) pass their own select string.
 */
const DEFAULT_COLUMNS = "role, dealer_id, group_id, active_dealer_id";

export async function resolveSessionProfile<T = {
  role: string | null;
  dealer_id: string | null;
  group_id: string | null;
  active_dealer_id: string | null;
}>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  session: Session,
  columns: string = DEFAULT_COLUMNS,
): Promise<T | null> {
  const { data: byId } = await admin
    .from("profiles")
    .select(columns)
    .eq("id", session.user.id)
    .maybeSingle();
  if (byId) return byId as unknown as T;

  if (session.user.email) {
    const { data: byEmail } = await admin
      .from("profiles")
      .select(columns)
      .eq("email", session.user.email)
      .maybeSingle();
    if (byEmail) {
      const p = byEmail as { role?: unknown; dealer_id?: unknown };
      console.log("[auth] profile resolved by email fallback — UUID mismatch", {
        authId: session.user.id,
        email: session.user.email,
        role: p.role,
        dealer_id: p.dealer_id,
      });
      return byEmail as unknown as T;
    }
  }
  return null;
}
