import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { verifyGhostToken, type GhostContext } from "./ghost";
import type { JwtClaims } from "./auth";

/**
 * Ghost-session containment — the single place that answers "is this super_admin
 * operating inside a ghosted account, and is this thing in scope?"
 *
 * Ghost mode deliberately keeps the super_admin's real claims underneath (see
 * the JwtClaims.ghost_group_uuid comment), so every platform-admin surface will
 * happily render itself unless it asks. That is how a group ghost came to show
 * the full 234-group admin list — complete with Ghost/Login into OTHER groups —
 * behind a "Operating as Group Admin" banner.
 *
 * Two rules, applied here rather than re-derived per route:
 *   1. Nothing outside the ghosted scope is visible or actionable.
 *   2. No nested session starts from inside a ghost (ghost, impersonate).
 * "Exit ghost mode first" is always the answer; it is one click.
 */

export type GhostScope =
  | { kind: "none" }
  | { kind: "dealer"; dealerTextId: string; dealerUuid: string | null }
  | { kind: "group"; groupUuid: string };

/**
 * Reads the active ghost context in a server component / route handler: the
 * `da_ghost_token` cookie (web) or the `X-DA-Ghost-Token` header (mobile
 * operate-as) — same precedence as getJwtClaims(). Callers must already have
 * established that the session is super_admin; the token is only ever minted
 * for one.
 */
export function readGhostContext(): GhostContext | null {
  let token: string | undefined;
  try {
    token = cookies().get("da_ghost_token")?.value;
  } catch {
    // cookies() throws outside a request context
  }
  if (!token) {
    try {
      token = headers().get("x-da-ghost-token") ?? undefined;
    } catch {
      /* no request context */
    }
  }
  if (!token) return null;
  return verifyGhostToken(token);
}

/** The scope a set of claims is confined to. `none` ⇒ not a ghost session. */
export function ghostScope(claims: JwtClaims): GhostScope {
  if (claims.role !== "super_admin") return { kind: "none" };
  if (claims.ghost_group_uuid) {
    return { kind: "group", groupUuid: claims.ghost_group_uuid };
  }
  if (claims.is_ghost && claims.dealer_id) {
    return { kind: "dealer", dealerTextId: claims.dealer_id, dealerUuid: claims.ghost_dealer_uuid };
  }
  return { kind: "none" };
}

function forbidden(what: string): NextResponse {
  return NextResponse.json(
    { error: `Exit ghost mode to ${what}. A ghost session is scoped to the account you are operating as.` },
    { status: 403 }
  );
}

/**
 * Refuse a platform-wide admin action outright while any ghost session is
 * active — listing/creating/deleting accounts, or starting a nested session.
 * Returns null when the caller is not in a ghost session.
 */
export function refuseInGhost(claims: JwtClaims, what = "do this"): NextResponse | null {
  return ghostScope(claims).kind === "none" ? null : forbidden(what);
}

/**
 * Confine a group-scoped action to the ghosted group. A dealer ghost has no
 * group scope at all, so it is refused too. Returns null when not ghosting.
 */
export function requireGhostGroup(
  claims: JwtClaims,
  groupUuid: string | null,
  what = "act on another group"
): NextResponse | null {
  const scope = ghostScope(claims);
  if (scope.kind === "none") return null;
  if (scope.kind === "group" && groupUuid && scope.groupUuid === groupUuid) return null;
  return forbidden(what);
}
