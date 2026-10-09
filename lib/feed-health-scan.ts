// Fleet stale-feed scan + daily digest (2026-10-08). Read-only over the fleet:
// it reads dealers + vehicles through lib/feed-health.ts (the same definition
// Steven's get_feed_provider uses) and, for the digest, writes only its own
// admin_settings state row and an email. Never touches feeds, vehicles, or
// anything a dealer sees.
//
// Digest de-dup: admin_settings `feed_health_alert_state` remembers which
// stores were stale at the last run. An email goes out only when a store
// BECOMES stale or RECOVERS; the still-stale list rides along in that email.
// A second run on the same day with no change sends nothing.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { dealerFeedHealth, loadRosters, type DealerFeedHealth } from "@/lib/feed-health";

export interface ScanRow extends DealerFeedHealth {
  dealerId: string;
  name: string;
  onV5: boolean;
}

const STATE_KEY = "feed_health_alert_state";
const LOCK_KEY = "feed_health_running";
const LOCK_MS = 30 * 60_000;
const CONCURRENCY = 6;

export async function scanFleet(): Promise<{ rows: ScanRow[]; errors: { dealerId: string; error: string }[] }> {
  const admin = createAdminSupabaseClient() as any;
  const dealers: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("dealers")
      .select("dealer_id, name, inventory_dealer_id, inventory_provider, migration_status, is_native")
      .eq("active", true).order("dealer_id").range(from, from + 999);
    if (error) throw new Error(error.message);
    dealers.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const rosters = await loadRosters(admin);
  const rows: ScanRow[] = [];
  const errors: { dealerId: string; error: string }[] = [];
  let i = 0;
  async function worker() {
    while (i < dealers.length) {
      const d = dealers[i++];
      try {
        const h = await dealerFeedHealth(admin, d, rosters);
        rows.push({ ...h, dealerId: d.dealer_id, name: d.name ?? d.dealer_id, onV5: d.migration_status === "migrated" || d.is_native === true || String(d.dealer_id).startsWith("ss_") });
      } catch (e) {
        errors.push({ dealerId: d.dealer_id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { rows, errors };
}

/** Worst first: actively printing while stale, then most days since the feed added anything. */
export function staleWorstFirst(rows: ScanRow[]): ScanRow[] {
  return rows.filter((r) => r.health === "stale").sort((a, b) =>
    (Number(b.printedLast14d > 0) - Number(a.printedLast14d > 0))
    || ((b.daysSinceNewestFeedAdded ?? 99999) - (a.daysSinceNewestFeedAdded ?? 99999))
    || b.activeVehicles - a.activeVehicles);
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function rowHtml(r: ScanRow): string {
  return `<tr><td>${esc(r.name)}</td><td>${esc(r.dealerId)}</td><td>${esc(r.provider ?? "unknown")}${r.feedSource ? ` <span style="color:#78828c">(${esc(r.feedSource)})</span>` : ""}</td>`
    + `<td>${esc(r.newestFeedAdded ?? "—")}${r.daysSinceNewestFeedAdded != null ? ` (${r.daysSinceNewestFeedAdded}d)` : ""}</td>`
    + `<td style="text-align:right">${r.feedVehicles}/${r.activeVehicles}</td><td>${r.onV5 ? "5.0" : "4.0"}</td>`
    + `<td>${r.printedLast14d > 0 ? `<strong>yes — ${r.printedLast14d} in 14d</strong>` : "no"}</td></tr>`;
}

function table(rows: ScanRow[]): string {
  if (!rows.length) return "<p style=\"color:#78828c\">None.</p>";
  return `<table cellpadding="6" style="border-collapse:collapse;font-size:13px;font-family:Roboto,Arial,sans-serif">`
    + `<tr style="background:#f5f6f7;text-align:left"><th>Store</th><th>Dealer ID</th><th>Provider</th><th>Newest feed vehicle</th><th>Feed / active</th><th>Platform</th><th>Printing</th></tr>`
    + rows.map(rowHtml).join("") + "</table>";
}

export async function runFeedHealthDigest(opts: { send?: boolean } = {}): Promise<{
  skipped?: string; stale: number; newly: number; recovered: number; emailed: boolean; errors: number;
}> {
  const admin = createAdminSupabaseClient() as any;
  const { data: lock } = await admin.from("admin_settings").select("value, updated_at").eq("key", LOCK_KEY).maybeSingle();
  if (lock?.value === "1" && lock.updated_at && Date.now() - Date.parse(lock.updated_at) < LOCK_MS) {
    return { skipped: "already running", stale: 0, newly: 0, recovered: 0, emailed: false, errors: 0 };
  }
  await admin.from("admin_settings").upsert({ key: LOCK_KEY, value: "1", updated_at: new Date().toISOString() }, { onConflict: "key" });
  try {
    const { rows, errors } = await scanFleet();
    const stale = staleWorstFirst(rows);
    const { data: st } = await admin.from("admin_settings").select("value").eq("key", STATE_KEY).maybeSingle();
    let prev: Record<string, { since: string }> = {};
    try { prev = st?.value ? JSON.parse(st.value).stale ?? {} : {}; } catch { prev = {}; }

    const now = new Date().toISOString();
    const nextState: Record<string, { since: string }> = {};
    for (const r of stale) nextState[r.dealerId] = { since: prev[r.dealerId]?.since ?? now };
    const newly = stale.filter((r) => !prev[r.dealerId]);
    const still = stale.filter((r) => prev[r.dealerId]);
    const byId = new Map(rows.map((r) => [r.dealerId, r]));
    const recovered = Object.keys(prev).filter((id) => !nextState[id]).map((id) => byId.get(id)).filter((r): r is ScanRow => !!r);

    let emailed = false;
    // An empty previous state is the first run: everything is "new", which is
    // the baseline report, not news — record it without emailing.
    const firstRun = !st?.value;
    if (opts.send !== false && !firstRun && (newly.length || recovered.length)) {
      const printing = stale.filter((r) => r.printedLast14d > 0).length;
      await sendMandrillEmail({
        subject: `Feed health: ${newly.length} newly stale, ${recovered.length} recovered (${stale.length} stale in total)`,
        from_email: "noreply@dealeraddendums.com",
        from_name: "DealerAddendums",
        to: [
          { email: "support@dealeraddendums.com", name: "Support", type: "to" },
          { email: "allan@dealeraddendums.com", name: "Allan Tone", type: "to" },
        ],
        html: `<div style="font-family:Roboto,Arial,sans-serif;font-size:14px;color:#2a2b3c">`
          + `<p>Daily inventory-feed check. <strong>Stale</strong> = a store with feed vehicles where none was refreshed in the last 3 days `
          + `and the feed hasn't added a vehicle in over 7 days. ${printing} of the ${stale.length} stale stores printed in the last 14 days (highest risk). `
          + `Stores with no automatic feed (vehicles added by hand) are never flagged here.</p>`
          + `<h3>Newly stale (${newly.length})</h3>${table(newly)}`
          + `<h3>Recovered (${recovered.length})</h3>${table(recovered)}`
          + `<h3>Still stale (${still.length})</h3>${table(still)}`
          + (errors.length ? `<p style="color:#78828c">${errors.length} store(s) couldn't be checked this run.</p>` : "")
          + `</div>`,
      });
      emailed = true;
    }
    await admin.from("admin_settings").upsert({ key: STATE_KEY, value: JSON.stringify({ stale: nextState, lastRunAt: now }), updated_at: now }, { onConflict: "key" });
    return { stale: stale.length, newly: newly.length, recovered: recovered.length, emailed, errors: errors.length };
  } finally {
    await admin.from("admin_settings").delete().eq("key", LOCK_KEY);
  }
}
