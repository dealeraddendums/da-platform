import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import {
  deltaDealer, DealerSyncError, markHealthy, markDown, notify401Dealers, isOutageSyncType,
  type FortellisDealerRow,
} from "@/lib/fortellis-sync";
import { fortellisConfigured } from "@/lib/fortellis-api";

export const dynamic = "force-dynamic";

const RUN_KEY = "fortellis_delta_running";
const STALE_LOCK_MS = 30 * 60 * 1000; // a lock older than this is treated as dead

/**
 * POST /api/cron/fortellis-delta
 * Auth: X-Cron-Secret. Hourly delta across enabled Fortellis dealers, 5:05am–9:05pm PT.
 *
 * Per dealer (watermark last_delta_at): adds new VINs, updates changed fields on
 * feed-owned unprinted rows, and marks sold/removed vehicles inactive. Advances the
 * watermark only on success. Refuses to overlap a running job. Fire-and-forget:
 * returns 200 immediately, runs in the background (parity with the other crons).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!fortellisConfigured()) {
    return NextResponse.json({ error: "Fortellis credentials not configured" }, { status: 500 });
  }

  const admin = createAdminSupabaseClient();

  // Overlap guard: refuse a second run while one is in flight (unless the lock is stale).
  const { data: lock } = await admin.from("admin_settings").select("value, updated_at").eq("key", RUN_KEY).maybeSingle<{ value: string; updated_at: string }>();
  if (lock?.value === "1" && lock.updated_at && Date.now() - new Date(lock.updated_at).getTime() < STALE_LOCK_MS) {
    return NextResponse.json({ status: "skipped", reason: "already running" }, { status: 409 });
  }
  await setLock(admin, true);

  runDelta().catch(err => console.error("[fortellis-delta] fatal:", err instanceof Error ? err.message : err));
  return NextResponse.json({ status: "started" });
}

async function runDelta(): Promise<void> {
  const admin = createAdminSupabaseClient();
  try {
    // enabled=true is the SOLE gate (2026-08-02): the hourly delta runs on EVERY
    // enabled row — including the "Allans Test Account" demo-store fixture — so
    // Fortellis can observe successful hourly runs during certification. The
    // disable path is the row's Enabled toggle in /admin/fortellis-dealers (the
    // old /(test|allan)/i name exclusion was removed at Allan's direction).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dealersRaw } = await (admin as any).from("fortellis_dealers").select("*").eq("enabled", true);
    const dealers = (dealersRaw ?? []) as FortellisDealerRow[];

    let added = 0, updated = 0, sold = 0, failed = 0, sawHealthy = false;
    const auth401: Array<{ dealer_name: string; subscription_id: string }> = [];
    const networkErrors: string[] = [];

    for (const dealer of dealers) {
      try {
        const r = await deltaDealer(admin, dealer);
        added += r.imported; updated += r.updated; sold += r.sold;
        sawHealthy = true;
      } catch (err) {
        failed++;
        const tagged = err instanceof DealerSyncError ? err : new DealerSyncError("other", err instanceof Error ? err.message : String(err));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (admin as any).from("fortellis_dealers").update({ last_status: tagged.message.slice(0, 300) }).eq("id", dealer.id);
        if (tagged.type === "auth_401") auth401.push({ dealer_name: dealer.dealer_name, subscription_id: dealer.subscription_id });
        else if (isOutageSyncType(tagged.type)) networkErrors.push(tagged.message);
      }
    }

    // Availability state machine: any success = up; an all-network/5xx run = down.
    if (sawHealthy) await markHealthy(admin);
    else if (dealers.length > 0 && failed === dealers.length && networkErrors.length > 0) {
      await markDown(admin, networkErrors[networkErrors.length - 1]);
    }
    if (auth401.length) await notify401Dealers(auth401);

    console.log(`[fortellis-delta] done: ${dealers.length} dealers, +${added} added, ${updated} updated, ${sold} sold, ${failed} failed`);
  } catch (err) {
    console.error("[fortellis-delta] run error:", err instanceof Error ? err.message : err);
  } finally {
    await setLock(admin, false);
  }
}

async function setLock(admin: ReturnType<typeof createAdminSupabaseClient>, on: boolean): Promise<void> {
  if (on) {
    await admin.from("admin_settings").upsert({ key: RUN_KEY, value: "1", updated_at: new Date().toISOString() }, { onConflict: "key" });
  } else {
    await admin.from("admin_settings").delete().eq("key", RUN_KEY);
  }
}
