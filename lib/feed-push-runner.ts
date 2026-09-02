// Shared "generate CSV + push + record result" runner for feed exports.
// Used by both the manual push route (/api/admin/feeds/[id]/push) and the
// scheduled cron route (/api/cron/push-feeds) so the two paths can't drift.

import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { generateFeedCsv, type FeedCompanyRow } from "@/lib/feed-export";
import { pushFeedCsv } from "@/lib/feed-push";
import { sendMandrillEmail } from "@/lib/mandrill";

// admin_audit.admin_user_id is NOT NULL (migration 127, no FK) — cron runs
// have no operator, so they log under a fixed system id.
export const CRON_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

export interface FeedPushRunResult {
  success: boolean;
  message: string;
  vehicleCount: number;
  dealerCount: number;
  /** Dealers that shipped at least one blank-GRAND_TOTAL (priceless) vehicle. */
  pricelessDealers?: number;
}

/**
 * A dealer whose EVERY exported vehicle has no base price ships a CSV with
 * GRAND_TOTAL and SELLING_PRICE blank on every row — which is what Homenet
 * reported for dealer 17093 on 2026-09-02. The blanking itself is correct
 * (a blank beats a wrong number), but it means the upstream feed ingest lost
 * that dealer's MSRP, and until now nothing said so: the push recorded
 * "success" and the bad CSV went out silently.
 *
 * So: log every priceless dealer, and email an alert when a WHOLE dealer is
 * priceless. Partial blanks are normal (a handful of genuinely unpriced
 * vehicles — ~8% of active inventory fleet-wide), so they only log.
 */
async function alertOnPricelessDealers(
  feedName: string,
  trigger: string,
  priceless: Array<{ dealerId: string; dealerName: string; vehicles: number; priceless: number }>,
): Promise<void> {
  if (priceless.length === 0) return;

  for (const p of priceless) {
    const whole = p.priceless === p.vehicles;
    console.warn(
      `[feed-push] ${feedName}: dealer ${p.dealerId} (${p.dealerName}) exported ` +
      `${p.priceless}/${p.vehicles} vehicles with NO base price — ` +
      `GRAND_TOTAL/SELLING_PRICE blank on those rows${whole ? " (ENTIRE DEALER)" : ""}`,
    );
  }

  const wholeDealers = priceless.filter((p) => p.priceless === p.vehicles);
  if (wholeDealers.length === 0) return;

  const list = wholeDealers
    .map((p) => `<li><strong>${p.dealerName}</strong> (<code>${p.dealerId}</code>) — all ${p.vehicles} exported vehicle(s)</li>`)
    .join("");
  await sendMandrillEmail({
    subject: `⚠️ Feed export "${feedName}": ${wholeDealers.length} dealer(s) shipped with no prices`,
    from_email: "noreply@dealeraddendums.com",
    from_name: "DealerAddendums",
    to: [{ email: "support@dealeraddendums.com", name: "DA Support" }, { email: "allan@dealeraddendums.com", name: "Allan Tone" }],
    html:
      `<p>The <strong>${feedName}</strong> feed export (${trigger}) shipped with <strong>GRAND_TOTAL and SELLING_PRICE blank</strong> ` +
      `for every vehicle belonging to these dealer(s), because <code>dealer_vehicles.msrp</code> is NULL or 0:</p>` +
      `<ul>${list}</ul>` +
      `<p>The export is behaving correctly (a blank beats a wrong number) — the base price is missing <em>upstream</em>, ` +
      `at feed ingest. Check the ETL2 job that writes this dealer's inventory (<code>created_by</code> on its ` +
      `<code>dealer_vehicles</code> rows names the job) and confirm its MSRP column mapping against the delivered feed file.</p>`,
  });
}

/**
 * Generates the feed's CSV, pushes it via FTP/SFTP, updates
 * last_push_at/last_push_status, and writes an admin_audit row.
 *
 * `opts.skipIfEmpty` (cron only): when the CSV has 0 vehicles, do NOT push —
 * an automated empty overwrite could wipe a provider's listings. The manual
 * Push button never skips (an operator clicking Push is explicit intent).
 *
 * Never throws — mirrors pushFeedCsv's contract.
 */
export async function runFeedPush(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  feed: FeedCompanyRow,
  actorUserId: string,
  opts?: { skipIfEmpty?: boolean; trigger?: "manual" | "cron" },
): Promise<FeedPushRunResult> {
  const trigger = opts?.trigger ?? "manual";
  try {
    const { csv, vehicleCount, dealerCount, pricelessByDealer } = await generateFeedCsv(feed.id);

    if (opts?.skipIfEmpty && vehicleCount === 0) {
      const message = "skipped — 0 vehicles (empty CSV not auto-pushed)";
      // Deliberately do NOT update last_push_at — the skip isn't a push.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("feed_companies")
        .update({ last_push_status: message })
        .eq("id", feed.id);
      return { success: false, message, vehicleCount, dealerCount, pricelessDealers: pricelessByDealer.length };
    }

    const result = await pushFeedCsv(feed, csv);
    const message = result.success
      ? `${result.message} — ${vehicleCount.toLocaleString("en-US")} vehicles across ${dealerCount} dealer(s)`
      : result.message;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from("feed_companies")
      .update({ last_push_at: new Date().toISOString(), last_push_status: result.success ? "success" : message.slice(0, 500) })
      .eq("id", feed.id);

    fireWrite(admin.from("admin_audit").insert({
      admin_user_id: actorUserId,
      action: "feed_push",
      metadata: { feed_id: feed.id, feed_name: feed.name, trigger, success: result.success, vehicles: vehicleCount, message: message.slice(0, 300) },
    }), "admin_audit");

    // Fire-and-forget: a missing-price alert must never fail or delay a push.
    await alertOnPricelessDealers(feed.name, trigger, pricelessByDealer)
      .catch((e) => console.error("[feed-push] priceless-dealer alert failed:", e instanceof Error ? e.message : e));

    return { success: result.success, message, vehicleCount, dealerCount, pricelessDealers: pricelessByDealer.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Feed push failed";
    // Surface generate/push crashes on the feed row too, so the /admin/feeds
    // list shows why a scheduled push didn't land.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from("feed_companies")
      .update({ last_push_status: message.slice(0, 500) })
      .eq("id", feed.id)
      .then(() => undefined, () => undefined);
    return { success: false, message, vehicleCount: 0, dealerCount: 0 };
  }
}
