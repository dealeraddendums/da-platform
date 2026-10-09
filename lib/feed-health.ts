// Inventory feed health — ONE definition shared by Steven's get_feed_provider
// tool and the fleet stale-feed scan / daily digest (2026-10-08).
//
// What counts as a LIVE feed:
//   • a roster row (fortellis_dealers enabled, cdk_dealers NEW <> 'Off',
//     tekion_dealers), or
//   • active vehicles written by a pipeline that is still running:
//     FORTELLIS_* / CDK_* (Fortellis + CDK) and automatic<N> (ETL2 SFTP jobs).
// NOT a live feed: `VIN API` (the 4.0 pipeline's copy — dormant in 5.0 since
// mid-2026), `csv_import`, `APP`, NULL (vehicles added by hand with the VIN
// decoder). Burns Honda (2026-10-08) read as a "stale feed" only because
// `VIN API` used to count; it has never had a feed — staff add every car by
// hand and nothing retires them.
// lib/dealer-feed-status.ts deliberately keeps VIN API as feed-owned: that file
// answers "may a rename deactivate this row", a different, safety-first question.
//
// Freshness is the SHARE of feed vehicles touched recently, never "newest
// updated_at": a print stamps updated_at on one row, a feed sync on nearly all.
//
// STALE (the alert definition): a store with feed vehicles where NONE was
// refreshed in the last 3 days AND the newest feed-added vehicle is more than
// 7 days old (or there is none).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { providerLabel } from "@/lib/inventory-providers";

export const FRESH_DAYS = 3;
export const STALE_NEWEST_DAYS = 7;
export const LIVE_FEED_OR = "created_by.like.FORTELLIS_*,created_by.like.CDK_*,created_by.like.automatic*";

export type FeedHealth = "updating" | "stale" | "feed_no_vehicles" | "no_live_feed";

export const FEED_HEALTH_MEANING: Record<FeedHealth, string> = {
  updating: `the feed is refreshing this store's vehicles`,
  stale: `the feed hasn't refreshed any of this store's vehicles in over ${FRESH_DAYS} days and hasn't added a new one in over ${STALE_NEWEST_DAYS} days — it may be disconnected; contact support`,
  feed_no_vehicles: "a feed is configured but none of the current vehicles came from it — contact support",
  no_live_feed: "no automatic feed delivers inventory; vehicles are added by hand (VIN decoder or spreadsheet)",
};

type Admin = any;

export interface Rosters { fortellis: Set<string>; cdk: Set<string>; tekion: Set<string> }

/** All three ingest rosters in one go (the fleet scan reuses this per dealer). */
export async function loadRosters(admin: Admin): Promise<Rosters> {
  const [f, c, t] = await Promise.all([
    admin.from("fortellis_dealers").select("dealer_id").eq("enabled", true),
    admin.from("cdk_dealers").select("DEALER_ID, NEW"),
    admin.from("tekion_dealers").select("dealer_id"),
  ]);
  return {
    fortellis: new Set(((f.data ?? []) as any[]).map((r) => String(r.dealer_id))),
    cdk: new Set(((c.data ?? []) as any[]).filter((r) => String(r.NEW ?? "").trim().toLowerCase() !== "off").map((r) => String(r.DEALER_ID))),
    tekion: new Set(((t.data ?? []) as any[]).map((r) => String(r.dealer_id))),
  };
}

export interface DealerFeedHealth {
  provider: string | null;            // on file, or inferred from the roster / feed rows; null = unknown
  providerSource: "on_file" | "inferred" | "unknown";
  feedSource: string | null;          // where the rows come from: "Fortellis", "CDK", "ETL2 job 40", …
  feedDealerId: string | null;
  roster: { fortellis: boolean; cdk: boolean; tekion: boolean };
  activeVehicles: number;
  feedVehicles: number;
  feedRefreshedLast3d: number;
  refreshedPct: number | null;        // of feed vehicles
  newestFeedAdded: string | null;     // YYYY-MM-DD
  daysSinceNewestFeedAdded: number | null;
  health: FeedHealth;
  lastPrintDate: string | null;       // any document, 5.0 or synced 4.0 print
  printedLast14d: number;
  handAddedActive: number;            // active vehicles not from a live feed
  handAddedOlderThan180d: number;     // never-retired risk for no-feed stores
}

const iso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function sourceOf(createdBy: string): string | null {
  if (/^FORTELLIS_/i.test(createdBy)) return "Fortellis";
  if (/^CDK_/i.test(createdBy)) return "CDK";
  const m = /^automatic(\d+)$/i.exec(createdBy);
  return m ? `ETL2 job ${m[1]}` : null;
}

export async function dealerFeedHealth(
  admin: Admin,
  dealer: { dealer_id: string; inventory_dealer_id: string | null; inventory_provider: string | null },
  rosters?: Rosters,
): Promise<DealerFeedHealth> {
  const id = dealer.dealer_id;
  const ros = rosters ?? await loadRosters(admin);
  const ids = [id, dealer.inventory_dealer_id].filter(Boolean) as string[];
  const roster = {
    fortellis: ros.fortellis.has(id),
    cdk: ros.cdk.has(id),
    tekion: ids.some((x) => ros.tekion.has(x)),
  };
  const active = () => admin.from("dealer_vehicles").select("*", { count: "exact", head: true }).eq("dealer_id", id).eq("status", "active");
  const [all, feed, fresh, recentFeed, lastPrint, printed14] = await Promise.all([
    active(),
    active().or(LIVE_FEED_OR),
    active().or(LIVE_FEED_OR).gte("updated_at", iso(FRESH_DAYS)),
    admin.from("dealer_vehicles").select("created_by, date_added").eq("dealer_id", id).eq("status", "active").or(LIVE_FEED_OR)
      .order("date_added", { ascending: false, nullsFirst: false }).limit(50),
    admin.from("dealer_vehicles").select("print_date").eq("dealer_id", id).not("print_date", "is", null)
      .order("print_date", { ascending: false }).limit(1),
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true }).eq("dealer_id", id).gte("print_date", iso(14).slice(0, 10)),
  ]);
  for (const r of [all, feed, fresh, recentFeed, lastPrint, printed14]) if (r.error) throw new Error(r.error.message);

  const activeVehicles = all.count ?? 0;
  const feedVehicles = feed.count ?? 0;
  const feedRefreshedLast3d = fresh.count ?? 0;
  const rows = (recentFeed.data ?? []) as { created_by: string | null; date_added: string | null }[];
  const newest = rows[0]?.date_added ?? null;
  const daysSince = newest ? Math.floor((Date.now() - Date.parse(newest)) / 86_400_000) : null;

  const counts = new Map<string, number>();
  for (const r of rows) { const s = sourceOf(String(r.created_by ?? "")); if (s) counts.set(s, (counts.get(s) ?? 0) + 1); }
  const rowSource = Array.from(counts.entries()).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  const feedSource = roster.fortellis ? "Fortellis" : roster.tekion ? "Tekion" : roster.cdk ? "CDK" : rowSource;

  const onFile = providerLabel(dealer.inventory_provider);
  const inferred = onFile ? null
    : roster.fortellis || rowSource === "Fortellis" ? "CDK (via Fortellis)"
    : roster.tekion ? "Tekion"
    : roster.cdk || rowSource === "CDK" ? "CDK"
    : null; // an ETL2 job number is not a brand — don't guess one

  const configured = roster.fortellis || roster.cdk || roster.tekion;
  const health: FeedHealth = feedVehicles === 0
    ? (configured ? "feed_no_vehicles" : "no_live_feed")
    : feedRefreshedLast3d === 0 && (daysSince == null || daysSince > STALE_NEWEST_DAYS) ? "stale" : "updating";

  let handAddedOlderThan180d = 0;
  const handAddedActive = Math.max(0, activeVehicles - feedVehicles);
  if (handAddedActive > 0) {
    const { count, error } = await active().not("created_by", "like", "FORTELLIS_%").not("created_by", "like", "CDK_%")
      .not("created_by", "like", "automatic%").lt("date_added", iso(180));
    // NULL created_by isn't matched by NOT LIKE in SQL — count it separately.
    const nul = await active().is("created_by", null).lt("date_added", iso(180));
    if (!error && !nul.error) handAddedOlderThan180d = (count ?? 0) + (nul.count ?? 0);
  }

  return {
    provider: onFile ?? inferred,
    providerSource: onFile ? "on_file" : inferred ? "inferred" : "unknown",
    feedSource,
    feedDealerId: dealer.inventory_dealer_id ?? null,
    roster,
    activeVehicles,
    feedVehicles,
    feedRefreshedLast3d,
    refreshedPct: feedVehicles ? Math.round((feedRefreshedLast3d / feedVehicles) * 100) : null,
    newestFeedAdded: newest ? String(newest).slice(0, 10) : null,
    daysSinceNewestFeedAdded: daysSince,
    health,
    lastPrintDate: lastPrint.data?.[0]?.print_date ? String(lastPrint.data[0].print_date).slice(0, 10) : null,
    printedLast14d: printed14.count ?? 0,
    handAddedActive,
    handAddedOlderThan180d,
  };
}
