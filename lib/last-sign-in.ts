import { createAdminSupabaseClient } from "@/lib/db";

// The `auth` schema isn't exposed to PostgREST, so
// admin.schema("auth").from("users") returns nothing ("Invalid schema: auth")
// — every "Last sign in" rendered as Never (falling back to the legacy
// profiles.last_login). The GoTrue admin API is the only reliable source.
//
// listUsers returns ALL auth users, so we page through once and build an
// email → last_sign_in_at map, cached briefly so admin pages don't re-scan
// thousands of users on every request. Matching by EMAIL (not profiles.id)
// also survives ETL/legacy profiles whose id != their auth user id.

let cache: { at: number; map: Map<string, string | null> } | null = null;
const TTL_MS = 60_000;

export async function lastSignInByEmail(): Promise<Map<string, string | null>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const admin = createAdminSupabaseClient();
  const map = new Map<string, string | null>();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) {
      console.error("[last-sign-in] listUsers failed:", error.message);
      break;
    }
    const users = data?.users ?? [];
    for (const u of users) {
      if (u.email) map.set(u.email.toLowerCase(), u.last_sign_in_at ?? null);
    }
    if (users.length < 1000) break;
  }
  cache = { at: Date.now(), map };
  return map;
}
