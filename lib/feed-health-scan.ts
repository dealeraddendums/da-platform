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
//
// Two kinds of broken feed, tracked separately (2026-10-10):
//   stale  — "feed stopped": nothing refreshed in 3 days (feed-health `health`)
//   frozen — "refreshing but no new inventory": rows refresh, but no new
//            vehicle in FROZEN_NEWEST_DAYS (feed-health `frozen`) — a provider
//            resending the same file. Feed-less stores are never either.
// Plus a third, feed-side list (lib/feed-unattached.ts): feed ids that are
// arriving but reach no ACTIVE store (deactivated store / no store at all).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { dealerFeedHealth, loadRosters, FROZEN_NEWEST_DAYS, type DealerFeedHealth } from "@/lib/feed-health";
import { scanUnattachedFeeds, checkFeedAliases, UNATTACHED_LABEL, MATCH_LABEL, type UnattachedFeed, type AliasProblem, type FeedAliases } from "@/lib/feed-unattached";

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

/** Frozen feeds, same ordering: printing first, then longest without a new vehicle. */
export function frozenWorstFirst(rows: ScanRow[]): ScanRow[] {
  return rows.filter((r) => r.frozen).sort((a, b) =>
    (Number(b.printedLast14d > 0) - Number(a.printedLast14d > 0))
    || ((b.daysSinceNewestFeedAdded ?? 0) - (a.daysSinceNewestFeedAdded ?? 0))
    || b.activeVehicles - a.activeVehicles);
}

type AlertMap = Record<string, { since: string }>;

/** Diff one category against the previous run's map. */
function diffAlerts(current: ScanRow[], prev: AlertMap, byId: Map<string, ScanRow>) {
  const now = new Date().toISOString();
  const next: AlertMap = {};
  for (const r of current) next[r.dealerId] = { since: prev[r.dealerId]?.since ?? now };
  return {
    next,
    newly: current.filter((r) => !prev[r.dealerId]),
    still: current.filter((r) => prev[r.dealerId]),
    recovered: Object.keys(prev).filter((id) => !next[id]).map((id) => byId.get(id)).filter((r): r is ScanRow => !!r),
  };
}

type UnattachedMap = Record<string, { since: string; label: string }>;

const unattachedLabel = (u: UnattachedFeed) =>
  `${u.bucket === "deactivated_store" ? `deactivated store: ${u.storeName}` : "no store"}${u.source ? ` · ${u.source}` : ""}`;

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

function unattachedTable(rows: UnattachedFeed[]): string {
  if (!rows.length) return "<p style=\"color:#78828c\">None.</p>";
  return `<table cellpadding="6" style="border-collapse:collapse;font-size:13px;font-family:Roboto,Arial,sans-serif">`
    + `<tr style="background:#f5f6f7;text-align:left"><th>Feed id</th><th>Source</th><th>Last delivery (UTC)</th><th>Newest vehicle</th><th style="text-align:right">Vehicles</th><th>${rows[0].bucket === "deactivated_store" ? "Deactivated store" : "Possible match (hint only)"}</th></tr>`
    + rows.map((u) => `<tr><td>${esc(u.feedId)}</td><td>${esc(u.source ?? "—")}</td><td>${esc(u.lastDelivery ?? "—")}</td><td>${esc(u.newestVehicleAdded ?? "—")}</td>`
      + `<td style="text-align:right">${u.vehicles}</td><td>${esc(u.bucket === "deactivated_store" ? u.storeName : (u.hints.join("; ") || "—"))}</td></tr>`).join("")
    + "</table>";
}

/** ETL2 feed-id alias status for the digest: problems in red, otherwise one muted line. */
function aliasNote(al: FeedAliases | null, problems: AliasProblem[]): string {
  if (!al) return "";
  if (al.unavailable) return `<p style="color:#78828c">ETL2 feed-id aliases: not known this run (${esc(al.unavailable)}) — aliased feeds are triaged as if they had no alias.</p>`;
  const head = `ETL2 feed-id aliases: ${al.map.size} in use (setting/dealer-id-aliases.json on the ETL2 box; mirrored ${esc((al.mirroredAt ?? "").slice(0, 16).replace("T", " "))} UTC).`;
  if (!problems.length) return `<p style="color:#78828c">${head}</p>`;
  return `<p style="color:#c62828">${head} ${problems.length} alias(es) point at no active store, so those feeds are filed where nobody sees them:</p><ul>`
    + problems.map((p) => `<li>${esc(p.feedId)} → ${esc(p.target)}: ${esc(p.problem)}</li>`).join("") + "</ul>";
}

/** Bucket B (split by triage) then bucket A, each with its own heading and action. */
function unattachedSection(rows: UnattachedFeed[]): string {
  const b = rows.filter((u) => u.bucket === "no_store");
  const a = rows.filter((u) => u.bucket === "deactivated_store");
  return `<p style="margin:10px 0 4px"><strong>B) ${esc(UNATTACHED_LABEL.no_store)}</strong> (${b.length})</p>`
    + (["store_unfed", "store_fed", "none", "pinned"] as const).map((m) => {
      const r = b.filter((u) => u.match === m);
      return r.length ? `<p style="margin:6px 0 4px 12px"><em>${esc(MATCH_LABEL[m])}</em> (${r.length})</p>${unattachedTable(r)}` : "";
    }).join("")
    + `<p style="margin:10px 0 4px"><strong>A) ${esc(UNATTACHED_LABEL.deactivated_store)}</strong> (${a.length})</p>${unattachedTable(a)}`;
}

export async function runFeedHealthDigest(opts: { send?: boolean } = {}): Promise<{
  skipped?: string; stale: number; newly: number; recovered: number;
  frozen: number; frozenNewly: number; frozenRecovered: number;
  unattached: number; unattachedNewly: number; unattachedGone: number; unattachedError?: string; aliasProblems?: number;
  emailed: boolean; errors: number;
}> {
  const admin = createAdminSupabaseClient() as any;
  const { data: lock } = await admin.from("admin_settings").select("value, updated_at").eq("key", LOCK_KEY).maybeSingle();
  if (lock?.value === "1" && lock.updated_at && Date.now() - Date.parse(lock.updated_at) < LOCK_MS) {
    return { skipped: "already running", stale: 0, newly: 0, recovered: 0, frozen: 0, frozenNewly: 0, frozenRecovered: 0, unattached: 0, unattachedNewly: 0, unattachedGone: 0, emailed: false, errors: 0 };
  }
  await admin.from("admin_settings").upsert({ key: LOCK_KEY, value: "1", updated_at: new Date().toISOString() }, { onConflict: "key" });
  try {
    // The unattached scan runs alongside; if it fails, the stopped/frozen
    // digest still goes out and the unattached state is left as it was.
    const [{ rows, errors }, ua] = await Promise.all([
      scanFleet(),
      checkFeedAliases(admin).then(async ({ aliases, problems }) => ({ list: await scanUnattachedFeeds(admin, aliases), aliases, problems, error: null as string | null }),
        (e) => ({ list: [] as UnattachedFeed[], aliases: null as FeedAliases | null, problems: [] as AliasProblem[], error: e instanceof Error ? e.message : String(e) })),
    ]);
    const stale = staleWorstFirst(rows);
    const frozen = frozenWorstFirst(rows);
    const { data: st } = await admin.from("admin_settings").select("value").eq("key", STATE_KEY).maybeSingle();
    let prevState: { stale?: AlertMap; frozen?: AlertMap; unattached?: UnattachedMap } = {};
    try { prevState = st?.value ? JSON.parse(st.value) : {}; } catch { prevState = {}; }

    const now = new Date().toISOString();
    const byId = new Map(rows.map((r) => [r.dealerId, r]));
    const s = diffAlerts(stale, prevState.stale ?? {}, byId);
    const f = diffAlerts(frozen, prevState.frozen ?? {}, byId);
    const { newly, still, recovered } = s;

    // Unattached feeds: keyed by feed id; state keeps a label so a feed that
    // stops being unattached (remapped, store reactivated, feed cancelled) can
    // still be named in the email.
    const prevUa = prevState.unattached ?? {};
    const uaNext: UnattachedMap = {};
    if (ua.error) Object.assign(uaNext, prevUa);
    else for (const u of ua.list) uaNext[u.feedId] = { since: prevUa[u.feedId]?.since ?? now, label: unattachedLabel(u) };
    const uaNewly = ua.error ? [] : ua.list.filter((u) => !prevUa[u.feedId]);
    const uaStill = ua.error ? [] : ua.list.filter((u) => prevUa[u.feedId]);
    const uaGone = ua.error ? [] : Object.keys(prevUa).filter((id) => !uaNext[id]).map((id) => ({ feedId: id, label: prevUa[id].label }));

    let emailed = false;
    // An empty previous state is the first run: everything is "new", which is
    // the baseline report, not news — record it without emailing. The same
    // goes for the frozen list the first time it's tracked (state saved before
    // frozen existed has no `frozen` key).
    const firstRun = !st?.value;
    const frozenBaseline = firstRun || !prevState.frozen;
    const frozenNews = !frozenBaseline && (f.newly.length > 0 || f.recovered.length > 0);
    const uaBaseline = firstRun || !prevState.unattached;
    const uaNews = !uaBaseline && !ua.error && (uaNewly.length > 0 || uaGone.length > 0);
    if (opts.send !== false && !firstRun && (newly.length || recovered.length || frozenNews || uaNews)) {
      const printing = stale.filter((r) => r.printedLast14d > 0).length;
      const frozenPrinting = frozen.filter((r) => r.printedLast14d > 0).length;
      await sendMandrillEmail({
        subject: `Feed health: ${newly.length} newly stopped, ${recovered.length} recovered (${stale.length} stopped)`
          + (frozenBaseline ? "" : ` · ${f.newly.length} newly frozen, ${f.recovered.length} unfrozen (${frozen.length} frozen)`)
          + (uaBaseline || ua.error ? "" : ` · ${uaNewly.length} newly unattached feed(s) (${ua.list.length} unattached)`),
        from_email: "noreply@dealeraddendums.com",
        from_name: "DealerAddendums",
        to: [
          { email: "support@dealeraddendums.com", name: "Support", type: "to" },
          { email: "allan@dealeraddendums.com", name: "Allan Tone", type: "to" },
        ],
        html: `<div style="font-family:Roboto,Arial,sans-serif;font-size:14px;color:#2a2b3c">`
          + `<p>Daily inventory-feed check. Two kinds of broken feed:</p><ul>`
          + `<li><strong>Feed stopped</strong> — none of the store's feed vehicles was refreshed in the last 3 days and the feed hasn't added a vehicle in over 7 days. `
          + `${printing} of the ${stale.length} printed in the last 14 days (highest risk).</li>`
          + `<li><strong>Frozen — refreshing but no new inventory</strong> — the feed keeps touching the store's vehicles, but hasn't added a NEW one in over ${FROZEN_NEWEST_DAYS} days `
          + `(usually the provider resending the same file). ${frozenPrinting} of the ${frozen.length} printed in the last 14 days.</li></ul>`
          + `<p>Stores with no automatic feed (vehicles added by hand) are never flagged here.</p>`
          + `<h2 style="font-size:16px">Feed stopped</h2>`
          + `<h3>Newly stopped (${newly.length})</h3>${table(newly)}`
          + `<h3>Recovered (${recovered.length})</h3>${table(recovered)}`
          + `<h3>Still stopped (${still.length})</h3>${table(still)}`
          + `<h2 style="font-size:16px">Frozen — refreshing but no new inventory</h2>`
          + (frozenBaseline
            ? `<p style="color:#78828c">First run tracking frozen feeds — the ${frozen.length} below are the baseline; from tomorrow only changes are reported.</p>${table(frozen)}`
            : `<h3>Newly frozen (${f.newly.length})</h3>${table(f.newly)}`
              + `<h3>No longer frozen (${f.recovered.length})</h3>${table(f.recovered)}`
              + `<h3>Still frozen (${f.still.length})</h3>${table(f.still)}`)
          + `<h2 style="font-size:16px">Unattached feeds — delivering data but not reaching a store</h2>`
          + `<p>Feed ids whose vehicles arrived in the last 3 days but don't belong to an active store, so nobody sees them. Surfaced only — nothing is remapped or cancelled automatically.</p>`
          + aliasNote(ua.aliases, ua.problems)
          + (ua.error
            ? `<p style="color:#c62828">The unattached-feed check failed this run (${esc(ua.error)}); the previous list is kept.</p>`
            : uaBaseline
              ? `<p style="color:#78828c">First run tracking unattached feeds — the ${ua.list.length} below are the baseline; from tomorrow only changes are reported.</p>${unattachedSection(ua.list)}`
              : `<h3>Newly unattached (${uaNewly.length})</h3>${uaNewly.length ? unattachedSection(uaNewly) : "<p style=\"color:#78828c\">None.</p>"}`
                + `<h3>No longer unattached (${uaGone.length})</h3>${uaGone.length ? `<ul>${uaGone.map((g) => `<li>${esc(g.feedId)} — was ${esc(g.label)}</li>`).join("")}</ul>` : "<p style=\"color:#78828c\">None.</p>"}`
                + `<h3>Still unattached (${uaStill.length})</h3>${uaStill.length ? unattachedSection(uaStill) : "<p style=\"color:#78828c\">None.</p>"}`)
          + (errors.length ? `<p style="color:#78828c">${errors.length} store(s) couldn't be checked this run.</p>` : "")
          + `</div>`,
      });
      emailed = true;
    }
    await admin.from("admin_settings").upsert({ key: STATE_KEY, value: JSON.stringify({ stale: s.next, frozen: f.next, unattached: uaNext, lastRunAt: now }), updated_at: now }, { onConflict: "key" });
    return {
      stale: stale.length, newly: newly.length, recovered: recovered.length,
      frozen: frozen.length, frozenNewly: frozenBaseline ? 0 : f.newly.length, frozenRecovered: frozenBaseline ? 0 : f.recovered.length,
      unattached: ua.list.length, unattachedNewly: uaBaseline ? 0 : uaNewly.length, unattachedGone: uaBaseline ? 0 : uaGone.length,
      ...(ua.error ? { unattachedError: ua.error } : {}),
      ...(ua.problems.length ? { aliasProblems: ua.problems.length } : {}),
      emailed, errors: errors.length,
    };
  } finally {
    await admin.from("admin_settings").delete().eq("key", LOCK_KEY);
  }
}
