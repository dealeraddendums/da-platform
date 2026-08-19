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
export const RESTYLER_ATTRIBUTION_TEXT = "This addendum created using dealeraddendums.com";
