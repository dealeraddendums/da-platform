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
//
// CDK stores are judged differently (2026-10-21): ETL2's upsert leaves
// updated_at alone on an unchanged car, so a quiet CDK store looked untouched
// while its pulls were succeeding. For a store on the CDK roster (and not on
// Fortellis/Tekion) STALE = its cdk_dealers.LAST_DELTA is more than
// CDK_STALE_HOURS old (LAST_DELTA advances only on a successful pull) OR the
// latest ETL2 run reported its pull failed (admin_settings etl2_cdk_run_status,
// written by ETL2 after every delta and every 22:00 refresh).
//
// FROZEN (2026-10-10, fleet scan + digest only): the feed IS refreshing rows
// (so `health` stays "updating") but has added no NEW vehicle in more than
// FROZEN_NEWEST_DAYS — a provider resending the same file forever (the Job 21
// DealersLink stores, e.g. Harbin Ford, newest May 6, rows touched hourly).
// Kept OUT of `health` on purpose: Steven's get_feed_provider reports health
// to dealers, and this change is internal-only. Real data (2026-10-10): every
// live store had a new vehicle within ~30 days or none for 70+ days, so 21
// sits in the gap; tune here.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { providerLabel } from "@/lib/inventory-providers";

export const FRESH_DAYS = 3;
export const STALE_NEWEST_DAYS = 7;
export const FROZEN_NEWEST_DAYS = 21;
export const CDK_STALE_HOURS = 36;
export const CDK_RUN_STATUS_KEY = "etl2_cdk_run_status";
/** A run older than this is not "the latest run" any more — its failures are not trusted. */
const CDK_RUN_MAX_AGE_H = { delta: 6, refresh: 30 } as const;
export const LIVE_FEED_OR = "created_by.like.FORTELLIS_*,created_by.like.CDK_*,created_by.like.automatic*";

export type FeedHealth = "updating" | "stale" | "feed_no_vehicles" | "no_live_feed";

export const FEED_HEALTH_MEANING: Record<FeedHealth, string> = {
  updating: `the feed is refreshing this store's vehicles`,
  stale: "the feed has stopped refreshing this store's vehicles — it may be disconnected; contact support",
  feed_no_vehicles: "a feed is configured but none of the current vehicles came from it — contact support",
  no_live_feed: "no automatic feed delivers inventory; vehicles are added by hand (VIN decoder or spreadsheet)",
};

type Admin = any;

export interface Rosters { fortellis: Set<string>; cdk: Set<string>; tekion: Set<string>; cdkStatus: Map<string, CdkFeedStatus> }

/** One CDK roster row's pull health (ETL2 jobs 9/10 + the 22:00 refresh). */
export interface CdkFeedStatus {
  rosterId: number | null;             // cdk_dealers.id — DEALER_ID is NOT unique (3PA0003717 = Rick Case Mazda + Kia Duluth)
  cdkId: string;
  name: string | null;
  mode: string | null;                 // cdk_dealers.NEW: "No" = hourly delta, "Yes" = waiting for its first bulk
  lastDelta: string | null;            // ISO; advances only after a successful pull
  hoursSinceDelta: number | null;
  failing: boolean;                    // the latest delta or refresh run reported this dealer's pull failed
  error: string | null;                // e.g. "HTTP 401: Dealer 3PA… is not subscribed to …"
  lastRunAt: string | null;            // when ETL2 last reported on this dealer
  retired: number | null;              // sold cars retired by the latest refresh
  keptPrinted: number | null;          // absent from CDK but printed, so kept active
  stale: boolean;
  reason: string | null;               // why stale, in plain words
  /** Other roster rows with the same DEALER_ID (the map holds the healthiest one). */
  duplicates: CdkFeedStatus[];
}

const hoursSince = (iso: string | null) => iso && !Number.isNaN(Date.parse(iso)) ? (Date.now() - Date.parse(iso)) / 3_600_000 : null;

/**
 * Every live (NEW <> 'Off') cdk_dealers row with its pull health, keyed by
 * DEALER_ID. Rows come from cdk_dealers itself, so a roster entry with no 5.0
 * store still appears. When several rows share a DEALER_ID the store is judged by
 * the healthiest one; the rest ride along in `duplicates` (still reported).
 */
export async function loadCdkFeedStatus(admin: Admin, roster?: any[]): Promise<Map<string, CdkFeedStatus>> {
  const out = new Map<string, CdkFeedStatus>();
  for (const c of await cdkRosterStatuses(admin, roster)) {
    const cur = out.get(c.cdkId);
    if (!cur) { out.set(c.cdkId, c); continue; }
    const [keep, other] = cur.stale && !c.stale ? [c, cur] : [cur, c];
    keep.duplicates = [...cur.duplicates, ...c.duplicates, other].filter((x) => x !== keep).map((x) => ({ ...x, duplicates: [] }));
    out.set(c.cdkId, keep);
  }
  return out;
}

/** One status per cdk_dealers row (NEW <> 'Off'). */
export async function cdkRosterStatuses(admin: Admin, roster?: any[]): Promise<CdkFeedStatus[]> {
  const [rows, st] = await Promise.all([
    roster ? Promise.resolve({ data: roster, error: null }) : admin.from("cdk_dealers").select("id, DEALER_ID, DEALER_NAME, NEW, LAST_DELTA"),
    admin.from("admin_settings").select("value").eq("key", CDK_RUN_STATUS_KEY).maybeSingle(),
  ]);
  if (rows.error) throw new Error(rows.error.message);
  let runs: any = {};
  try { runs = st.data?.value ? JSON.parse(st.data.value) : {}; } catch { runs = {}; }
  const current = (kind: "delta" | "refresh") => {
    const run = runs?.[kind];
    const age = hoursSince(run?.at ?? null);
    return age != null && age <= CDK_RUN_MAX_AGE_H[kind] ? run : null;
  };
  const delta = current("delta");
  const refresh = current("refresh");
  const out: CdkFeedStatus[] = [];
  for (const r of (rows.data ?? []) as any[]) {
    const mode = r.NEW == null ? null : String(r.NEW).trim();
    if ((mode ?? "").toLowerCase() === "off") continue;
    const cdkId = String(r.DEALER_ID);
    const lastDelta = r.LAST_DELTA && !Number.isNaN(Date.parse(r.LAST_DELTA)) ? new Date(Date.parse(r.LAST_DELTA)).toISOString() : null;
    const h = hoursSince(lastDelta);
    const d = delta?.dealers?.[cdkId];
    const f = refresh?.dealers?.[cdkId];
    const failed = [d, f].find((x) => x && x.ok === false) ?? null;
    const failing = !!failed;
    const old = h == null || h > CDK_STALE_HOURS;
    const waiting = (mode ?? "").toLowerCase() === "yes";
    out.push({
      rosterId: r.id ?? null,
      cdkId,
      name: r.DEALER_NAME ?? null,
      mode,
      lastDelta,
      hoursSinceDelta: h == null ? null : Math.round(h),
      failing,
      error: failed?.error ?? null,
      lastRunAt: (d ? delta?.at : f ? refresh?.at : null) ?? null,
      retired: typeof f?.retired === "number" ? f.retired : null,
      keptPrinted: typeof f?.kept_printed === "number" ? f.kept_printed : null,
      stale: failing || old,
      reason: failing ? `CDK pull failing: ${failed?.error ?? "error"}`
        : old ? (h == null ? (waiting ? "waiting for its first CDK bulk — none has succeeded" : "never had a successful CDK pull") : `no successful CDK pull in ${Math.round(h)}h`)
        : null,
      duplicates: [],
    });
  }
  return out;
}

/** All three ingest rosters in one go (the fleet scan reuses this per dealer). */
export async function loadRosters(admin: Admin): Promise<Rosters> {
  const [f, c, t] = await Promise.all([
    admin.from("fortellis_dealers").select("dealer_id").eq("enabled", true),
    admin.from("cdk_dealers").select("id, DEALER_ID, DEALER_NAME, NEW, LAST_DELTA"),
    admin.from("tekion_dealers").select("dealer_id"),
  ]);
  if (c.error) throw new Error(c.error.message);
  const cdkStatus = await loadCdkFeedStatus(admin, c.data ?? []);
  return {
    fortellis: new Set(((f.data ?? []) as any[]).map((r) => String(r.dealer_id))),
    cdk: new Set(cdkStatus.keys()),
    tekion: new Set(((t.data ?? []) as any[]).map((r) => String(r.dealer_id))),
    cdkStatus,
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
  /** Why `health` is "stale", when known (CDK stores). */
  staleReason: string | null;
  /** CDK roster pull health, for a store judged by its CDK pulls. */
  cdk: CdkFeedStatus | null;
  /** Refreshing but no new vehicle in > FROZEN_NEWEST_DAYS (scan/digest only — not in `health`). */
  frozen: boolean;
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
  const cdk = roster.cdk && !roster.fortellis && !roster.tekion ? ros.cdkStatus.get(id) ?? null : null;
  const health: FeedHealth = cdk
    ? (cdk.stale ? "stale" : feedVehicles === 0 ? "feed_no_vehicles" : "updating")
    : feedVehicles === 0
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
    staleReason: health === "stale" ? (cdk?.reason ?? null) : null,
    cdk,
    frozen: health === "updating" && daysSince != null && daysSince > FROZEN_NEWEST_DAYS,
    lastPrintDate: lastPrint.data?.[0]?.print_date ? String(lastPrint.data[0].print_date).slice(0, 10) : null,
    printedLast14d: printed14.count ?? 0,
    handAddedActive,
    handAddedOlderThan180d,
  };
}
