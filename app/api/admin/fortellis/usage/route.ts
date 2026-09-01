import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { countFortellisCalls, monthRangeUtc, type FortellisMonthCounts } from "@/lib/fortellis-usage";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/fortellis/usage
 * super_admin. Live month-to-date Fortellis call counts (UTC calendar month —
 * how Fortellis bills), for the Fortellis Dealers tab's usage line. Cached
 * ~1h per PM2 worker — the counts back a muted informational line, and the
 * monthly rollup (purge cron) is the number of record.
 */

const CACHE_MS = 60 * 60 * 1000;
let cache: { at: number; monthKey: string; data: FortellisMonthCounts } | null = null;

export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const now = new Date();
  const { key, startIso, endIso } = monthRangeUtc(now, 0);
  if (cache && cache.monthKey === key && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json({ usage: cache.data, cached: true });
  }

  try {
    const admin = createAdminSupabaseClient();
    const data = await countFortellisCalls(admin, key, startIso, endIso);
    cache = { at: Date.now(), monthKey: key, data };
    return NextResponse.json({ usage: data, cached: false });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "usage count failed" },
      { status: 500 },
    );
  }
}
