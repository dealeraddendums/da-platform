// Is a dealer's inventory fed by a live feed, and which of its rows does a feed own?
//
// Why this exists: the inventory-ID rename endpoint used to DEACTIVATE every
// old-id vehicle on the premise that "the feed re-ingests them under the new
// id". That premise is false for a dealer with no live feed. It bit Riverside
// Ford Lincoln on 2026-09-03 (ss_1788270257880 -> MP2621): all 49 vehicles were
// created_by='csv_import' with no feed configured anywhere, so the rename left
// a live paying dealer with an empty dashboard and nothing to refill it. All 49
// had to be restored by hand.
//
// ─── What counts as a signal (verified against real data 2026-09-05) ─────────
//
// FEED CONFIG (primary): a per-dealer row in one of the ingest rosters —
// fortellis_dealers (enabled), cdk_dealers (NEW <> 'Off'), tekion_dealers.
//
// NOT a signal: `dealers.inventory_provider`. It is descriptive, not wiring.
// Riverside reads "Vauto" while having zero feed configuration of any kind, and
// so do several other feed-less dealers — keying on it would reintroduce the bug.
//
// NOT a signal: feed_companies / feed_company_dealers. Those are OUTBOUND feed
// EXPORTS (we push a CSV to Homenet et al. over FTP); they say nothing about
// inventory arriving.
//
// PROVENANCE (also sufficient on its own): dealer_vehicles.created_by. This
// cannot be demoted to "confirmation only" — the legacy ETL2 SFTP jobs keep
// their configuration in the Rails app's own database, OFF-platform, so an
// ETL2-fed dealer has NO Supabase roster row at all. Its only tell is that its
// rows say `automatic75` / `VIN API`. That is most of the fleet, so ignoring
// provenance would misclassify the majority as feed-less.

/**
 * created_by values that mean "a feed put this row here".
 *
 * Deliberately BROADER than fortellis-sync.ts's FEED_CREATED_BY
 * (/^(FORTELLIS_|CDK_)/), which is narrow on purpose: that one gates which rows
 * the Fortellis sync may overwrite, and it must never touch another feed's rows.
 * This one answers a different question — "did any feed create this?" — so it
 * also covers the legacy pipelines:
 *
 *   FORTELLIS_BULK / FORTELLIS_DELTA   Fortellis (CDK Drive MVS2)
 *   CDK_IMPORT / CDK_BULK_UPDATE       CDK PIP
 *   automatic<N>                       ETL2 SFTP jobs (automatic0/40/75/80/…)
 *   VIN API                            legacy 4.0 inventory pipeline
 *
 * Everything else is NOT feed-owned — `csv_import`, `APP` (manual add in the
 * app), NULL, and any value we do not recognise. Unknown values falling on the
 * not-feed-owned side is the safe direction: it means "keep it active".
 */
export const FEED_PROVENANCE = /^(FORTELLIS_|CDK_|automatic\d+$|VIN API$)/i;

/** Did a feed create this row? NULL/unknown → false (safe: keep it active). */
export function isFeedOwnedRow(createdBy: string | null | undefined): boolean {
  return FEED_PROVENANCE.test((createdBy ?? "").trim());
}

export interface DealerFeedStatus {
  hasLiveFeed: boolean;
  /** Human-readable signals, for the audit trail and the API response. */
  signals: {
    fortellis: number;
    cdk: number;
    tekion: number;
    feedOwnedVehicles: number;
    nonFeedVehicles: number;
    provenance: string[];
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Admin = any;

/**
 * Determine whether this dealer has a live inventory feed.
 *
 * `textId` is the dealer's text dealer_id (what dealer_vehicles keys on);
 * `inventoryId` is inventory_dealer_id, which is what the Tekion roster matches.
 *
 * Fails safe: on any lookup error it reports hasLiveFeed = FALSE, because the
 * false-negative (a feed dealer keeps a few stale-active rows, self-correcting
 * on its next sync) is far cheaper than the false-positive (a paying dealer's
 * dashboard is emptied with nothing to refill it).
 */
export async function getDealerFeedStatus(
  admin: Admin,
  textId: string,
  inventoryId: string | null,
): Promise<DealerFeedStatus> {
  const signals = {
    fortellis: 0, cdk: 0, tekion: 0,
    feedOwnedVehicles: 0, nonFeedVehicles: 0,
    provenance: [] as string[],
  };

  try {
    const [fort, cdk, tek] = await Promise.all([
      admin.from("fortellis_dealers").select("id").eq("dealer_id", textId).eq("enabled", true),
      admin.from("cdk_dealers").select("id, NEW").eq("DEALER_ID", textId),
      admin.from("tekion_dealers").select("id").in("dealer_id",
        Array.from(new Set([textId, inventoryId].filter(Boolean) as string[]))),
    ]);
    signals.fortellis = (fort?.data ?? []).length;
    // cdk_dealers.NEW is the on/off switch: 'Yes' = bulk, 'No' = hourly,
    // 'Off' = disabled. Only a non-Off row is a live feed.
    signals.cdk = (cdk?.data ?? []).filter(
      (r: { NEW?: string | null }) => String(r.NEW ?? "").trim().toLowerCase() !== "off",
    ).length;
    signals.tekion = (tek?.data ?? []).length;
  } catch {
    return { hasLiveFeed: false, signals };
  }

  // Provenance of the dealer's CURRENT active inventory. Capped — we only need
  // to know whether any feed-owned row exists, not to enumerate them all.
  try {
    const { data: veh } = await admin
      .from("dealer_vehicles")
      .select("created_by")
      .eq("dealer_id", textId)
      .eq("status", "active")
      .limit(2000);
    const seen = new Set<string>();
    for (const v of (veh ?? []) as Array<{ created_by: string | null }>) {
      seen.add((v.created_by ?? "(null)").trim());
      if (isFeedOwnedRow(v.created_by)) signals.feedOwnedVehicles++;
      else signals.nonFeedVehicles++;
    }
    signals.provenance = Array.from(seen).sort();
  } catch {
    return { hasLiveFeed: false, signals };
  }

  const hasConfig = signals.fortellis > 0 || signals.cdk > 0 || signals.tekion > 0;
  return { hasLiveFeed: hasConfig || signals.feedOwnedVehicles > 0, signals };
}
