import { cookies, headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * SESSION-SCOPED active dealer — the single source of truth for "which dealer is
 * this session acting as".
 *
 * Why this exists (2026-10-19, Allan): the active dealer used to live in
 * `profiles.active_dealer_id`, a single PER-USER column. Two people signed into
 * the SAME account (shared user/pass — common for group operators) shared one
 * active dealer: when one switched dealerships, the other session's data
 * silently followed, while its already-rendered header still showed the old
 * dealer. That mismatch let a user print / add a vehicle against a dealer the
 * page wasn't showing — the wrong-rooftop class of bug (it produced the Kia
 * Telluride duplicate under M&L CDJR).
 *
 * The dealer context is now carried by an httpOnly cookie, so it is per
 * browser/device: switching in one session can never move another. Both the
 * chrome (nav/header, rendered by server pages) and the data/write paths (API
 * routes, via `getJwtClaims`) resolve through THIS module, so header and data
 * can never disagree again.
 *
 * SECURITY: the cookie is a *request*, never a grant. It is re-authorized from
 * the database on every single request (group membership for group_admin;
 * group membership AND tag scope for group_user) — identical to the checks
 * `authorizeDealerAction` applies per action, which still run on top of this.
 * A forged or stale cookie resolves to null (group level), never to access.
 * The value is additionally bound to the auth user id, so a cookie cannot carry
 * a dealer context across an identity change in the same browser (impersonation
 * entry/exit, or a different user signing in) — that also preserves the #116
 * "land at group level when a group is freshly impersonated" behavior.
 */

export const ACTIVE_DEALER_COOKIE = "da_active_dealer";

/**
 * Headless/mobile equivalent of the cookie (IOS-APP-SPEC §8.4 pattern — exactly
 * how ghost already pairs the `da_ghost_token` cookie with `X-DA-Ghost-Token`).
 * A native client that does not share the browser cookie jar sends the dealer
 * uuid it selected; it is re-authorized per request like any other source, so
 * this grants nothing the cookie path doesn't.
 */
export const ACTIVE_DEALER_HEADER = "x-da-active-dealer";

/** 30 days — "resume last dealer" is now a per-device memory, not a global one. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export const ACTIVE_DEALER_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: MAX_AGE_SECONDS,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roles that can hold an active dealer. Dealer roles are pinned to their own. */
function canHoldActiveDealer(role: string | null | undefined): boolean {
  return role === "group_admin" || role === "group_user";
}

/**
 * Cookie payload is `<authUserId>.<dealerUuid>` — binding the context to the
 * identity that chose it. Returns the dealer uuid only when the cookie belongs
 * to `userId`.
 */
export function encodeActiveDealerCookie(userId: string, dealerUuid: string): string {
  return `${userId}.${dealerUuid}`;
}

export function decodeActiveDealerCookie(raw: string | undefined, userId: string): string | null {
  if (!raw) return null;
  const idx = raw.indexOf(".");
  if (idx <= 0) return null;
  const owner = raw.slice(0, idx);
  const dealerUuid = raw.slice(idx + 1);
  if (owner !== userId) return null;              // different identity in this browser
  if (!UUID_RE.test(dealerUuid)) return null;     // junk / tampered
  return dealerUuid;
}

/**
 * Raw read of this session's requested dealer uuid. NOT yet authorized.
 * Cookie (browser) wins; the header is the headless/mobile path.
 */
export function readActiveDealerRequest(userId: string): string | null {
  try {
    const fromCookie = decodeActiveDealerCookie(cookies().get(ACTIVE_DEALER_COOKIE)?.value, userId);
    if (fromCookie) return fromCookie;
  } catch {
    // cookies() throws outside a request context — fall through to the header
  }
  try {
    const raw = headers().get(ACTIVE_DEALER_HEADER)?.trim();
    if (raw && UUID_RE.test(raw)) return raw;
  } catch {
    // headers() throws outside a request context
  }
  return null;
}

/** True when the #116 session-layer group-level reset flag is set. */
export function readGroupLevelReset(): boolean {
  try {
    return cookies().get("da_group_level")?.value === "1";
  } catch {
    return false;
  }
}

export type ActiveDealer = {
  /** dealers.id — null when this session is at group level. */
  uuid: string | null;
  /** dealers.dealer_id (text) — null when this session is at group level. */
  textId: string | null;
};

const NONE: ActiveDealer = { uuid: null, textId: null };

/**
 * Resolve — and RE-AUTHORIZE — this session's active dealer.
 *
 * Mirrors `authorizeDealerAction`'s rules exactly:
 *   group_admin → the dealer must be in the caller's group
 *   group_user  → in the caller's group AND carrying one of their scope tags
 *
 * Any failure resolves to group level (null) rather than erroring, so a stale
 * cookie degrades to "no dealer selected" instead of locking the user out.
 */
export type ActiveDealerArgs = {
  /** Supabase auth user id (claims.sub / session.user.id). */
  userId: string;
  role: string | null | undefined;
  groupId: string | null | undefined;
  /** Pass when already loaded (getJwtClaims); otherwise looked up for group_user. */
  scopeTagIds?: string[];
  /** Pass when already read, to avoid a second cookies() call. */
  groupLevelReset?: boolean;
};

export async function resolveActiveDealer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  args: ActiveDealerArgs,
): Promise<ActiveDealer> {
  const dealerUuid = readActiveDealerRequest(args.userId);
  const groupLevelReset = args.groupLevelReset ?? readGroupLevelReset();
  return authorizeActiveDealer(admin, { ...args, groupLevelReset }, dealerUuid);
}

/**
 * The gate itself, with the requested dealer passed in explicitly — this is the
 * security-critical half and is unit-tested directly
 * (scripts/active-dealer-verify-unit.ts).
 */
export async function authorizeActiveDealer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  args: ActiveDealerArgs,
  dealerUuid: string | null,
): Promise<ActiveDealer> {
  const { userId, role, groupId } = args;
  if (!canHoldActiveDealer(role)) return NONE;
  if (!groupId) return NONE;
  if (args.groupLevelReset) return NONE;
  if (!dealerUuid) return NONE;

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, group_id")
    .eq("id", dealerUuid)
    .maybeSingle<{ id: string; dealer_id: string; group_id: string | null }>();

  // In-group check (group_admin and group_user alike).
  if (!dealer || !dealer.group_id || dealer.group_id !== groupId) return NONE;

  // group_user (regional manager): the dealer must also carry one of their tags.
  if (role === "group_user") {
    let scopeTagIds = args.scopeTagIds;
    if (!scopeTagIds) scopeTagIds = await loadScopeTagIds(admin, userId);
    if (scopeTagIds.length === 0) return NONE;
    // dealer_tags isn't in the generated Supabase types yet (migration 108).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tagRow } = await (admin as any)
      .from("dealer_tags")
      .select("tag_id")
      .eq("dealer_id", dealer.id)
      .in("tag_id", scopeTagIds)
      .limit(1)
      .maybeSingle();
    if (!tagRow) return NONE;
  }

  return { uuid: dealer.id, textId: dealer.dealer_id };
}

/** Tag ids scoping a group_user (user_tags). Empty ⇒ no dealers. */
export async function loadScopeTagIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  userId: string,
): Promise<string[]> {
  // user_tags isn't in the generated Supabase types yet (migration 109).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any).from("user_tags").select("tag_id").eq("user_id", userId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((r: any) => r.tag_id as string);
}
