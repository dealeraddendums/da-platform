// Fortellis monthly API call-count tracking (2026-09-01).
//
// The signed Certification Report obligates DA to track its own per-API call
// counts — Fortellis reports only monthly totals per calendar month and will
// NOT warn when volume nears/exceeds contracted amounts. fortellis_api_log
// already records every transaction; this module aggregates it:
//   - countFortellisCalls(): per-endpoint counts for a UTC calendar-month
//     window (UTC = how Fortellis bills). Uses PostgREST exact HEAD counts —
//     aggregation happens in SQL, raw rows never leave the database, so the
//     1000-row clamp can't bite.
//   - rollupPriorMonthIfNeeded(): at month close, persists the prior month's
//     totals to admin_settings key `fortellis_call_counts_{YYYY-MM}` (history
//     survives the 90-day fortellis_api_log purge) and sends the monthly
//     usage email. Idempotent — keyed on the admin_settings row existing, so
//     it's safe whether the host cron runs daily or monthly.
//
// Endpoint classes (by URL, matching lib/fortellis-api.ts constants):
//   token         — identity.fortellis.io OAuth exchanges
//   subscriptions — subscriptions.fortellis.io lists
//   vehicle_search— merchandisable-vehicles (MVS2). NOTE: the "ping" probe is
//                   a minimal first-page search in prod flows (the literal
//                   /ping endpoint isn't used), so probes count here — which
//                   is correct: they're real MVS2 calls Fortellis meters.
//   ping          — literal …/ping URLs, if ever used
//   other         — anything else that lands in the log

import type { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export interface FortellisMonthCounts {
  month: string; // "YYYY-MM" (UTC calendar month)
  total: number;
  token: number;
  subscriptions: number;
  vehicle_search: number;
  ping: number;
  other: number;
  computed_at: string;
}

export const FORTELLIS_COUNTS_KEY_PREFIX = "fortellis_call_counts_";

/** UTC calendar-month window. monthOffset 0 = the month containing `now`,
 *  -1 = the prior month. End is exclusive. */
export function monthRangeUtc(now: Date, monthOffset = 0): { key: string; startIso: string; endIso: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset + 1, 1));
  const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { key, startIso: start.toISOString(), endIso: end.toISOString() };
}

async function countWhere(
  admin: Admin,
  startIso: string,
  endIso: string,
  urlPattern: string | null,
): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (admin as any)
    .from("fortellis_api_log")
    .select("*", { count: "exact", head: true })
    .gte("at", startIso)
    .lt("at", endIso);
  if (urlPattern) q = q.ilike("url", urlPattern);
  const { count, error } = await q;
  if (error) throw new Error(`fortellis_api_log count failed: ${error.message}`);
  return count ?? 0;
}

/** Per-endpoint call counts for [startIso, endIso). SQL-side exact counts. */
export async function countFortellisCalls(
  admin: Admin,
  monthKey: string,
  startIso: string,
  endIso: string,
): Promise<FortellisMonthCounts> {
  const [total, token, subscriptions, merch, ping] = await Promise.all([
    countWhere(admin, startIso, endIso, null),
    countWhere(admin, startIso, endIso, "%identity.fortellis.io%"),
    countWhere(admin, startIso, endIso, "%subscriptions.fortellis.io%"),
    countWhere(admin, startIso, endIso, "%merchandisable-vehicles%"),
    countWhere(admin, startIso, endIso, "%/ping"),
  ]);
  const vehicle_search = Math.max(0, merch - ping); // a literal …/ping under the MVS2 path would match both
  return {
    month: monthKey,
    total,
    token,
    subscriptions,
    vehicle_search,
    ping,
    other: Math.max(0, total - token - subscriptions - vehicle_search - ping),
    computed_at: new Date().toISOString(),
  };
}

/** Read a persisted month rollup (null when absent). */
async function readPersistedMonth(admin: Admin, monthKey: string): Promise<FortellisMonthCounts | null> {
  const { data } = await admin
    .from("admin_settings")
    .select("value")
    .eq("key", `${FORTELLIS_COUNTS_KEY_PREFIX}${monthKey}`)
    .maybeSingle<{ value: string }>();
  if (!data?.value) return null;
  try { return JSON.parse(data.value) as FortellisMonthCounts; } catch { return null; }
}

function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function usageEmailHtml(counts: FortellisMonthCounts, trend: FortellisMonthCounts[]): string {
  const row = (label: string, n: number) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666">${label}</td><td style="text-align:right"><strong>${n.toLocaleString()}</strong></td></tr>`;
  const trendRows = trend
    .map((t) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${monthLabel(t.month)}</td><td style="text-align:right">${t.total.toLocaleString()}</td><td style="text-align:right;color:#666">${t.vehicle_search.toLocaleString()} searches</td></tr>`)
    .join("");
  return `<p><strong>Fortellis API usage — ${monthLabel(counts.month)}</strong> (UTC calendar month, from fortellis_api_log)</p>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
  ${row("Vehicle search (MVS2)", counts.vehicle_search)}
  ${row("Token exchanges", counts.token)}
  ${row("Subscription lookups", counts.subscriptions)}
  ${counts.ping ? row("Ping", counts.ping) : ""}
  ${counts.other ? row("Other", counts.other) : ""}
  ${row("TOTAL", counts.total)}
</table>
${trendRows ? `<p style="margin-top:14px"><strong>Trend</strong></p><table style="font-family:sans-serif;font-size:13px;border-collapse:collapse">${trendRows}</table>` : ""}
<p style="color:#888;font-size:12px;margin-top:14px">Fortellis reports only monthly totals and does not warn near contracted volume — this rollup is DA's own per-endpoint tracking (Certification Report obligation). History persists in admin_settings past the 90-day log retention.</p>`;
}

/**
 * Month-close rollup: persist the PRIOR UTC month's counts and send the
 * monthly usage email. Idempotent — no-op when the month's admin_settings key
 * already exists. Call from the purge cron BEFORE the fortellis_api_log purge.
 * `keySuffixOverride` + `skipEmail` exist for test simulation only.
 */
export async function rollupPriorMonthIfNeeded(
  admin: Admin,
  now: Date = new Date(),
  opts: { persistKey?: string; skipEmail?: boolean } = {},
): Promise<{ rolledUp: boolean; monthKey: string; counts?: FortellisMonthCounts }> {
  const { key: monthKey, startIso, endIso } = monthRangeUtc(now, -1);
  const persistKey = opts.persistKey ?? `${FORTELLIS_COUNTS_KEY_PREFIX}${monthKey}`;

  const { data: existing } = await admin
    .from("admin_settings")
    .select("key")
    .eq("key", persistKey)
    .maybeSingle<{ key: string }>();
  if (existing) return { rolledUp: false, monthKey };

  const counts = await countFortellisCalls(admin, monthKey, startIso, endIso);

  const { error: upErr } = await admin.from("admin_settings").upsert(
    { key: persistKey, value: JSON.stringify(counts), updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (upErr) throw new Error(`fortellis usage rollup upsert failed: ${upErr.message}`);

  if (!opts.skipEmail) {
    // Running 3-month trend from persisted keys (older→newer, incl. this one).
    const trend: FortellisMonthCounts[] = [];
    for (let off = -3; off <= -1; off++) {
      const prior = monthRangeUtc(now, off).key;
      const persisted = prior === monthKey ? counts : await readPersistedMonth(admin, prior);
      if (persisted) trend.push(persisted);
    }
    await sendMandrillEmail({
      subject: `Fortellis API usage — ${monthLabel(monthKey)}: ${counts.total.toLocaleString()} calls`,
      html: usageEmailHtml(counts, trend),
      from_email: "noreply@dealeraddendums.com",
      from_name: "DA Platform",
      to: [
        { email: "allan@dealeraddendums.com", name: "Allan Tone" },
        { email: process.env.SUPPORT_NOTIFICATION_EMAIL ?? "support@dealeraddendums.com", name: "DA Support" },
      ],
    }).catch((err) =>
      console.error("[fortellis-usage] monthly email failed (rollup persisted):", err instanceof Error ? err.message : err),
    );
  }

  return { rolledUp: true, monthKey, counts };
}
