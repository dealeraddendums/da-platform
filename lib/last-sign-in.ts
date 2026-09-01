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
//
// IMPERSONATION EXCLUSION (2026-08-04): a super_admin impersonation mints a
// real GoTrue session (generateLink + /auth/v1/verify), which stamps
// auth.users.last_sign_in_at exactly like a human login. That polluted signal
// falsely satisfied group-migration Gate A, flipped the Invite-admins modal to
// "skip", and showed misleading dates in Users lists. Every impersonation
// endpoint writes an admin_audit row (action 'impersonate'/'impersonate_group',
// metadata.target_email) in the same request as the mint, so a sign-in within
// ±10 min of an impersonation event for the same email is treated as NOT a
// real sign-in. When the latest sign-in is excluded this way we fall back to
// legacy profiles.last_login (4.0-era data) if set, else null ("never") — for
// the gates, under-counting is the safe direction.

let cache: { at: number; maps: { display: Map<string, string | null>; strict: Map<string, string | null> } } | null = null;
const TTL_MS = 60_000;
const IMPERSONATION_WINDOW_MS = 10 * 60_000;
// RECOVERY EXCLUSION (2026-08-24, Burns Honda / chall@): consuming a
// password-recovery link stamps last_sign_in_at exactly like a login — and
// recovery links get consumed by mail-scanner prefetch or an abandoned
// reset-page visit without the human ever gaining a working login. A sign-in
// landing shortly AFTER recovery_sent_at is therefore NOT proof the user can
// log in; the STRICT map excludes it (display keeps it — "last seen" is fine).
// Any later real login moves the stamp out of the window and counts again.
const RECOVERY_WINDOW_MS = 30 * 60_000;
// FORCED-RESET EXCLUSION (2026-09-01, Straub / michaelh@): middleware pins any
// session whose app_metadata.force_password_reset is true to /reset-password —
// such a user cannot reach the dashboard at all, and completing a real sign-in
// clears the flag (POST /api/auth/clear-force-reset). So the flag being STILL
// SET is direct, non-heuristic proof the human has never completed a login,
// whatever last_sign_in_at says. Unlike the two time-window rules above this
// one cannot produce a false negative: a working login always clears it.

/**
 * Resolve an existing auth user's id by email via the GoTrue admin API. Used by
 * invite-accept to find a user from a prior partial attempt WITHOUT issuing a
 * sign-in token (generateLink would issue one that a later password change could
 * invalidate). Returns null if no such user.
 */
export async function getAuthUserIdByEmail(email: string): Promise<string | null> {
  const admin = createAdminSupabaseClient();
  const target = email.toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) { console.error("[get-auth-user-id] listUsers failed:", error.message); return null; }
    const users = data?.users ?? [];
    const hit = users.find(u => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit.id;
    if (users.length < 1000) return null;
  }
}

/** email (lowercase) → impersonation-mint timestamps (ms). */
async function impersonationEventsByEmail(
  admin: ReturnType<typeof createAdminSupabaseClient>,
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  for (let from = 0; ; from += 1000) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .from("admin_audit")
      .select("created_at, metadata")
      .in("action", ["impersonate", "impersonate_group"])
      .order("created_at", { ascending: true })
      .range(from, from + 999) as {
        data: { created_at: string | null; metadata: { target_email?: string } | null }[] | null;
        error: { message: string } | null;
      };
    if (error) {
      // admin_audit missing (pre-migration-127 env) → no exclusion, raw values.
      console.error("[last-sign-in] admin_audit read failed:", error.message);
      break;
    }
    for (const row of data ?? []) {
      const email = (row.metadata?.target_email ?? "").trim().toLowerCase();
      const ts = row.created_at ? Date.parse(row.created_at) : NaN;
      if (!email || Number.isNaN(ts)) continue;
      const arr = map.get(email) ?? [];
      arr.push(ts);
      map.set(email, arr);
    }
    if ((data ?? []).length < 1000) break;
  }
  return map;
}

/**
 * email (lowercase) → last REAL sign-in (impersonation-minted sign-ins
 * excluded — see header comment). This is the platform-wide "has this human
 * ever signed in" signal: Gate A, the Invite-admins modal, invite-vs-reset
 * copy, and every Users-list display consume it.
 */
export async function lastSignInByEmail(): Promise<Map<string, string | null>> {
  return (await buildSignInMaps()).display;
}

/**
 * STRICT variant: last REAL 5.0 sign-in only — impersonation-coincident
 * sign-ins are excluded WITHOUT the legacy profiles.last_login fallback the
 * display variant applies. The fallback is right for "last seen" UI columns,
 * but a 4.0-era Aurora last_login stamp is NOT a working 5.0 login: using the
 * display variant in the migration-invite completed check made a never-
 * invited dealer's only recipient look "already accepted" the moment an
 * operator impersonated them (Myrtle Beach Hyundai, 2026-08-19). Consumers
 * deciding "can this human already log in to 5.0" must use THIS one.
 */
export async function lastSignInByEmailStrict(): Promise<Map<string, string | null>> {
  return (await buildSignInMaps()).strict;
}

async function buildSignInMaps(): Promise<{ display: Map<string, string | null>; strict: Map<string, string | null> }> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.maps;
  const admin = createAdminSupabaseClient();
  const raw = new Map<string, string | null>();
  const recoverySent = new Map<string, number>();
  const forceReset = new Set<string>();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) {
      console.error("[last-sign-in] listUsers failed:", error.message);
      break;
    }
    const users = data?.users ?? [];
    for (const u of users) {
      if (!u.email) continue;
      raw.set(u.email.toLowerCase(), u.last_sign_in_at ?? null);
      const rec = (u as { recovery_sent_at?: string | null }).recovery_sent_at;
      if (rec) {
        const ms = Date.parse(rec);
        if (!Number.isNaN(ms)) recoverySent.set(u.email.toLowerCase(), ms);
      }
      if ((u.app_metadata as { force_password_reset?: boolean } | undefined)?.force_password_reset === true) {
        forceReset.add(u.email.toLowerCase());
      }
    }
    if (users.length < 1000) break;
  }

  // Exclude impersonation-coincident sign-ins.
  const events = await impersonationEventsByEmail(admin);
  const polluted: string[] = [];
  events.forEach((timestamps: number[], email: string) => {
    const signIn = raw.get(email);
    if (!signIn) return;
    const signInMs = Date.parse(signIn);
    if (timestamps.some(t => Math.abs(signInMs - t) <= IMPERSONATION_WINDOW_MS)) {
      polluted.push(email);
    }
  });
  // STRICT map: polluted entries are simply null — no legacy fallback.
  const strict = new Map(raw);
  for (const email of polluted) strict.set(email, null);
  // STRICT-only: recovery-coincident sign-ins are not working logins either.
  recoverySent.forEach((sentMs: number, email: string) => {
    const signIn = strict.get(email);
    if (!signIn) return;
    const signInMs = Date.parse(signIn);
    if (signInMs >= sentMs && signInMs - sentMs <= RECOVERY_WINDOW_MS) strict.set(email, null);
  });
  // STRICT-only: a still-set force_password_reset flag means the human is
  // pinned to /reset-password and has never completed a login (see header).
  forceReset.forEach((email: string) => strict.set(email, null));

  if (polluted.length > 0) {
    // Display map only: best-effort fallback to legacy profiles.last_login for
    // the excluded set (an earlier REAL sign-in isn't recoverable from GoTrue —
    // it only keeps the latest). Missing fallback → null = "never signed in".
    const fallback = new Map<string, string | null>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: profs } = await (admin as any)
      .from("profiles")
      .select("email, last_login")
      .in("email", polluted) as { data: { email: string | null; last_login: string | null }[] | null };
    for (const p of profs ?? []) {
      if (p.email) fallback.set(p.email.toLowerCase(), p.last_login ?? null);
    }
    for (const email of polluted) {
      raw.set(email, fallback.get(email) ?? null);
    }
  }

  const maps = { display: raw, strict };
  cache = { at: Date.now(), maps };
  return maps;
}
