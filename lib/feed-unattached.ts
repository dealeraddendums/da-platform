// Unattached feeds (2026-10-10): feed rows that are ARRIVING but don't reach an
// active store, so nobody sees those vehicles. Same hidden-inventory class that
// stranded ~760 cars before the DealersLink id fix. Read-only — this only
// surfaces the list; remapping is a per-case call for ops (never automatic).
//
// "Arriving" = active vehicles written by a live pipeline (lib/feed-health.ts
// LIVE_FEED_OR) and refreshed in the last FRESH_DAYS. Their dealer_id is the
// feed id. If it isn't an active store's dealer_id:
//   A) deactivated_store — a dealer row exists but active=false
//   B) no_store          — no dealer row; hints point at a likely store
//                          (inventory_dealer_id match, case-only difference,
//                          or a name that looks like the id) — hints only.
//      Triage within B (2026-10-10 live data: 318 B ids / ~100k vehicles —
//      ETL2 jobs import whole provider directories, so most are feeds for
//      non-customers or a second copy of a store's file):
//        store_unfed — the likely store gets NO fresh feed vehicles of its own:
//                      probably mis-keyed, that store is missing inventory (urgent)
//        store_fed   — the likely store is already fed under its own id: a
//                      duplicate copy (cleanup)
//        none        — no likely store: a non-customer feed, a store to
//                      onboard, or a dead feed
/* eslint-disable @typescript-eslint/no-explicit-any */

import { FRESH_DAYS, LIVE_FEED_OR } from "@/lib/feed-health";

type Admin = any;

export type UnattachedBucket = "deactivated_store" | "no_store";
export type UnattachedMatch = "store_unfed" | "store_fed" | "none";

export interface UnattachedFeed {
  feedId: string;
  bucket: UnattachedBucket;
  source: string | null;            // "ETL2 job 21", "CDK", "Fortellis"
  vehicles: number;                 // active rows refreshed in the last FRESH_DAYS
  lastDelivery: string | null;      // newest updated_at (YYYY-MM-DD HH:MM UTC)
  newestVehicleAdded: string | null;// newest date_added (YYYY-MM-DD)
  storeName: string | null;         // bucket A: the deactivated store
  hints: string[];                  // bucket B: possible matches, for triage only
  match: UnattachedMatch;           // bucket B triage (A is always "none")
}

export const MATCH_LABEL: Record<UnattachedMatch, string> = {
  store_unfed: "Likely mis-keyed — the matching store gets no feed of its own (missing inventory)",
  store_fed: "Duplicate — the matching store is already fed under its own id",
  none: "No matching store — non-customer feed, a store to onboard, or a dead feed",
};

export const UNATTACHED_LABEL: Record<UnattachedBucket, string> = {
  deactivated_store: "Feed delivers, but the store is DEACTIVATED — stop the feed or reactivate the store",
  no_store: "Feed id matches NO store — a new store to onboard, a mis-keyed store to remap, or a dead feed to cancel",
};

function sourceOf(createdBy: string): string | null {
  if (/^FORTELLIS_/i.test(createdBy)) return "Fortellis";
  if (/^CDK_/i.test(createdBy)) return "CDK";
  const m = /^automatic(\d+)$/i.exec(createdBy);
  return m ? `ETL2 job ${m[1]}` : null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Feed ids often carry a provider tag ("…DA", "DA…") — drop it before comparing names. */
const normFeedId = (s: string) => norm(s).replace(/^da(?=[a-z])/, "").replace(/da$/, "");

const HEX = "0123456789abcdef";
const PAGE = 1000;
const STREAMS = 8;

export async function scanUnattachedFeeds(admin: Admin): Promise<UnattachedFeed[]> {
  // Every dealer (active or not), for bucket A and the hints.
  const dealers: { dealer_id: string; name: string | null; active: boolean; inventory_dealer_id: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("dealers").select("dealer_id, name, active, inventory_dealer_id")
      .order("dealer_id").range(from, from + 999);
    if (error) throw new Error(error.message);
    dealers.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const byId = new Map(dealers.map((d) => [d.dealer_id, d]));
  const activeIds = new Set(dealers.filter((d) => d.active).map((d) => d.dealer_id));

  // Stream the arriving feed rows — keyset pagination per id-prefix slice
  // (uuid ids), so ~430k rows read in parallel without deep OFFSETs.
  const since = new Date(Date.now() - FRESH_DAYS * 86_400_000).toISOString();
  const agg = new Map<string, { n: number; upd: string; added: string; src: Map<string, number> }>();
  const fedActive = new Map<string, number>(); // fresh feed rows per ACTIVE store (for B triage)
  const slices = HEX.split("");
  let next = 0;
  async function stream() {
    while (next < slices.length) {
      const h = slices[next++];
      const lo = `${h}0000000-0000-0000-0000-000000000000`;
      const hi = h === "f" ? null : `${HEX[HEX.indexOf(h) + 1]}0000000-0000-0000-0000-000000000000`;
      let after = lo;
      let first = true;
      for (;;) {
        let q = admin.from("dealer_vehicles").select("id, dealer_id, created_by, date_added, updated_at")
          .eq("status", "active").or(LIVE_FEED_OR).gte("updated_at", since);
        q = first ? q.gte("id", after) : q.gt("id", after);
        if (hi) q = q.lt("id", hi);
        const { data, error } = await q.order("id").limit(PAGE);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as any[];
        for (const r of rows) {
          const id = String(r.dealer_id ?? "");
          if (activeIds.has(id)) { fedActive.set(id, (fedActive.get(id) ?? 0) + 1); continue; }
          const a = agg.get(id) ?? { n: 0, upd: "", added: "", src: new Map<string, number>() };
          a.n++;
          if ((r.updated_at ?? "") > a.upd) a.upd = r.updated_at ?? "";
          if ((r.date_added ?? "") > a.added) a.added = r.date_added ?? "";
          const s = sourceOf(String(r.created_by ?? ""));
          if (s) a.src.set(s, (a.src.get(s) ?? 0) + 1);
          agg.set(id, a);
        }
        if (rows.length < PAGE) break;
        after = rows[rows.length - 1].id;
        first = false;
      }
    }
  }
  await Promise.all(Array.from({ length: STREAMS }, stream));

  const out: UnattachedFeed[] = [];
  for (const [feedId, a] of Array.from(agg.entries())) {
    const d = byId.get(feedId);
    const hints: string[] = [];
    let match: UnattachedMatch = "none";
    if (!d) {
      const f = norm(feedId), fn = normFeedId(feedId);
      const matched: typeof dealers = [];
      for (const x of dealers) {
        if (hints.length >= 3) break;
        const fed = fedActive.get(x.dealer_id) ?? 0;
        const label = `${x.name ?? x.dealer_id} [${x.dealer_id}]${x.active ? (fed ? ` — fed (${fed})` : " — gets NO feed") : " (deactivated)"}`;
        let why: string | null = null;
        if (x.inventory_dealer_id && norm(x.inventory_dealer_id) === f) why = "inventory id matches";
        else if (norm(x.dealer_id) === f) why = "dealer id differs only in case/spacing from";
        else if (fn.length >= 6 && x.name) {
          const n = norm(x.name);
          if (n.length >= 6 && (n.includes(fn) || fn.includes(n))) why = "name looks like";
        }
        if (why) { hints.push(`${why} ${label}`); matched.push(x); }
      }
      const activeMatches = matched.filter((x) => x.active);
      if (activeMatches.some((x) => !fedActive.get(x.dealer_id))) match = "store_unfed";
      else if (activeMatches.length) match = "store_fed";
    }
    out.push({
      feedId,
      bucket: d ? "deactivated_store" : "no_store",
      source: Array.from(a.src.entries()).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
      vehicles: a.n,
      lastDelivery: a.upd ? a.upd.slice(0, 16).replace("T", " ") : null,
      newestVehicleAdded: a.added ? a.added.slice(0, 10) : null,
      storeName: d ? (d.name ?? d.dealer_id) : null,
      hints,
      match,
    });
  }
  // B first (nobody sees them): likely mis-keyed, then duplicates, then the
  // rest; then A. Most vehicles first within each.
  const rank = (u: UnattachedFeed) => u.bucket === "deactivated_store" ? 3 : u.match === "store_unfed" ? 0 : u.match === "store_fed" ? 1 : 2;
  return out.sort((x, y) => rank(x) - rank(y) || y.vehicles - x.vehicles);
}
