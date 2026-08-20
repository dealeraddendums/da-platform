// Restyler/Upfitter account type (migration 149, Phase 1).
//
// A restyler group is a service-provider account (Dealer General shape) whose
// member stores are lightweight feed-less dealers. The flag drives:
//   * the locked "created using dealeraddendums.com" attribution on every
//     render from its stores (canvas + PDF — a forced element, not a widget),
//   * skipping per-store billing provisioning at store creation (one metered
//     group plan instead — Phase 2),
//   * exclusion from per-dealer subscription metrics + both trial funnels.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Is this group a Restyler account? null/undefined groupId → false. */
export async function isRestylerGroup(
  admin: SupabaseClient,
  groupId: string | null | undefined,
): Promise<boolean> {
  if (!groupId) return false;
  try {
    const { data } = await admin
      .from("groups")
      .select("is_restyler")
      .eq("id", groupId)
      .maybeSingle<{ is_restyler: boolean | null }>();
    return data?.is_restyler === true;
  } catch {
    return false; // column missing / transient error → behave as non-restyler
  }
}

/** Does the printing DEALER (text dealer_id) belong to a Restyler group? */
export async function dealerInRestylerGroup(
  admin: SupabaseClient,
  dealerTextId: string | null | undefined,
): Promise<boolean> {
  if (!dealerTextId) return false;
  try {
    const { data } = await admin
      .from("dealers")
      .select("group_id")
      .eq("dealer_id", dealerTextId)
      .maybeSingle<{ group_id: string | null }>();
    return isRestylerGroup(admin, data?.group_id ?? null);
  } catch {
    return false;
  }
}

/** All restyler group ids (for metric exclusions). Empty set on any error. */
export async function restylerGroupIds(admin: SupabaseClient): Promise<Set<string>> {
  try {
    const { data } = await admin
      .from("groups")
      .select("id")
      .eq("is_restyler", true);
    return new Set((data ?? []).map((g: { id: string }) => g.id));
  } catch {
    return new Set();
  }
}

/** The locked attribution line, single source of truth for canvas + PDF. */
export const RESTYLER_ATTRIBUTION_TEXT = "This addendum created using DealerAddendums.com";

// ── Movable-but-locked attribution geometry (2026-08-19 refinement) ─────────
// The element is MOVABLE per template (position saved as template_json.
// restylerAttrPos {x,y}) but its text/presence stay render-forced. Fixed
// footprint — no resize, no font controls.
export const RESTYLER_ATTR_W = 260;
export const RESTYLER_ATTR_H = 14;
/** The bottom of the sticker is the peel-off adhesive strip — anything placed
 *  there is discarded when the label is applied. Positions must sit fully
 *  above this reserve or they fall back to the default. */
export const RESTYLER_ATTR_BOTTOM_RESERVE = 24;

/**
 * Resolve the attribution's render position for a given paper size. The saved
 * position wins ONLY when it is fully on-canvas and above the adhesive-strip
 * reserve — anything else (missing, hand-edited off-bounds, bottom strip)
 * falls back to the default visible footer spot. The author controls WHERE
 * within the visible sticker, never WHETHER it shows.
 */
export function resolveRestylerAttrPos(
  pos: { x?: unknown; y?: unknown } | null | undefined,
  paperW: number,
  paperH: number,
): { x: number; y: number } {
  const maxY = paperH - RESTYLER_ATTR_H - RESTYLER_ATTR_BOTTOM_RESERVE;
  const def = {
    x: Math.max(0, Math.round((paperW - RESTYLER_ATTR_W) / 2)),
    // Default: visible footer area above the bottom strip (author fine-tunes).
    y: Math.max(0, paperH - RESTYLER_ATTR_H - 60),
  };
  const x = typeof pos?.x === "number" && Number.isFinite(pos.x) ? Math.round(pos.x as number) : NaN;
  const y = typeof pos?.y === "number" && Number.isFinite(pos.y) ? Math.round(pos.y as number) : NaN;
  const valid = !Number.isNaN(x) && !Number.isNaN(y)
    && x >= 0 && x + RESTYLER_ATTR_W <= paperW
    && y >= 0 && y <= maxY;
  return valid ? { x, y } : def;
}
