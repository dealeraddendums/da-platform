// Which assistant Steven is for THIS request — decided server-side from the
// session, never from the chat text or anything the client sends.
//
//   internal → a genuine super_admin in their OWN admin context. Steven may
//              retrieve audience='internal' articles and uses the staff prompt.
//   dealer   → everyone else, and a super_admin who is operating AS a dealer or
//              group (ghost / viewing-as, group ghost, impersonation). Exactly
//              today's dealer-facing assistant.
//
// SECURITY: this is the internal/dealer trust boundary. Every check below must
// pass; anything unexpected falls back to dealer mode.

import { cookies } from "next/headers";
import type { JwtClaims } from "@/lib/auth";

export type StevenMode = "internal" | "dealer";

export function resolveStevenMode(claims: JwtClaims): StevenMode {
  if (claims.role !== "super_admin") return "dealer";
  // Ghost / "Viewing as" a dealer (cookie or X-DA-Ghost-Token): dealer context.
  if (claims.is_ghost || claims.ghost_dealer_uuid) return "dealer";
  // Group ghost.
  if (claims.ghost_group_uuid) return "dealer";
  // Legacy app_metadata impersonation marker.
  if (claims.impersonating_dealer_id) return "dealer";
  // A super_admin profile carrying a dealer is operating in that dealer.
  if (claims.dealer_id) return "dealer";
  // Belt and braces: the Login (impersonate) flow sets this cookie. Those
  // sessions resolve to the dealer's own role already, but never go internal
  // while it is present.
  try { if (cookies().get("da_impersonating")?.value) return "dealer"; } catch { return "dealer"; }
  return "internal";
}

/** Article audiences Steven may RETRIEVE in a mode. The dealer list never contains 'internal'. */
export function stevenAudiences(mode: StevenMode): string[] {
  return mode === "internal" ? ["dealer", "all", "internal"] : ["dealer", "all"];
}
