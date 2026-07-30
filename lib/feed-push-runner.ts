// Shared "generate CSV + push + record result" runner for feed exports.
// Used by both the manual push route (/api/admin/feeds/[id]/push) and the
// scheduled cron route (/api/cron/push-feeds) so the two paths can't drift.

import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { generateFeedCsv, type FeedCompanyRow } from "@/lib/feed-export";
import { pushFeedCsv } from "@/lib/feed-push";

// admin_audit.admin_user_id is NOT NULL (migration 127, no FK) — cron runs
// have no operator, so they log under a fixed system id.
export const CRON_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

export interface FeedPushRunResult {
  success: boolean;
  message: string;
  vehicleCount: number;
  dealerCount: number;
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
    const { csv, vehicleCount, dealerCount } = await generateFeedCsv(feed.id);

    if (opts?.skipIfEmpty && vehicleCount === 0) {
      const message = "skipped — 0 vehicles (empty CSV not auto-pushed)";
      // Deliberately do NOT update last_push_at — the skip isn't a push.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("feed_companies")
        .update({ last_push_status: message })
        .eq("id", feed.id);
      return { success: false, message, vehicleCount, dealerCount };
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

    return { success: result.success, message, vehicleCount, dealerCount };
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
