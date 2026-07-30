import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { type FeedCompanyRow } from "@/lib/feed-export";
import { runFeedPush, CRON_SYSTEM_USER_ID } from "@/lib/feed-push-runner";

export const dynamic = "force-dynamic";

const STALE_LOCK_MS = 30 * 60 * 1000; // a lock older than this is treated as dead

/**
 * POST /api/cron/push-feeds?schedule={hourly|daily}
 * Auth: X-Cron-Secret. Pushes every feed_companies row whose push_schedule
 * matches the requested cadence. Registered as two EasyCron jobs:
 *   hourly → `5 * * * *`
 *   daily  → `0 12 * * *` UTC
 *
 * Fire-and-forget (parity with sync-hubspot-computed / fortellis-delta):
 * returns 200 with the queued count immediately and runs the FTP loop in the
 * background so slow provider servers can't 504 EasyCron behind the ALB's
 * 60s cap. Overlap-guarded per schedule via admin_settings.
 *
 * Safety: a scheduled run SKIPS a feed whose CSV has 0 vehicles (an automated
 * empty overwrite could wipe a provider's listings). The manual Push button
 * is unchanged and never skips.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const schedule = req.nextUrl.searchParams.get("schedule");
  if (schedule !== "hourly" && schedule !== "daily") {
    return NextResponse.json({ error: "schedule must be hourly or daily" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const runKey = `feed_push_running_${schedule}`;

  // Overlap guard: refuse a second run while one is in flight (unless stale).
  const { data: lock } = await admin.from("admin_settings").select("value, updated_at").eq("key", runKey).maybeSingle<{ value: string; updated_at: string }>();
  if (lock?.value === "1" && lock.updated_at && Date.now() - new Date(lock.updated_at).getTime() < STALE_LOCK_MS) {
    return NextResponse.json({ status: "skipped", reason: "already running" }, { status: 409 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: feedsRaw, error: dbErr } = await (admin as any)
    .from("feed_companies").select("*").eq("push_schedule", schedule).order("name") as { data: FeedCompanyRow[] | null; error: { message: string } | null };
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  const feeds = feedsRaw ?? [];
  if (feeds.length === 0) return NextResponse.json({ status: "done", queued: 0 });

  await setLock(admin, runKey, true);
  runPushes(schedule, feeds).catch(err => console.error(`[push-feeds:${schedule}] fatal:`, err instanceof Error ? err.message : err));
  return NextResponse.json({ status: "started", queued: feeds.length });
}

async function runPushes(schedule: string, feeds: FeedCompanyRow[]): Promise<void> {
  const admin = createAdminSupabaseClient();
  const runKey = `feed_push_running_${schedule}`;
  let ok = 0, failed = 0, skipped = 0;
  try {
    for (const feed of feeds) {
      const r = await runFeedPush(admin, feed, CRON_SYSTEM_USER_ID, { trigger: "cron", skipIfEmpty: true });
      if (r.success) ok++;
      else if (r.message.startsWith("skipped")) skipped++;
      else failed++;
      console.log(`[push-feeds:${schedule}] ${feed.name}: ${r.message}`);
    }
    console.log(`[push-feeds:${schedule}] done: ${feeds.length} feed(s) — ${ok} ok, ${skipped} skipped, ${failed} failed`);
  } catch (err) {
    console.error(`[push-feeds:${schedule}] run error:`, err instanceof Error ? err.message : err);
  } finally {
    await setLock(admin, runKey, false);
  }
}

async function setLock(admin: ReturnType<typeof createAdminSupabaseClient>, key: string, on: boolean): Promise<void> {
  if (on) {
    await admin.from("admin_settings").upsert({ key, value: "1", updated_at: new Date().toISOString() }, { onConflict: "key" });
  } else {
    await admin.from("admin_settings").delete().eq("key", key);
  }
}
