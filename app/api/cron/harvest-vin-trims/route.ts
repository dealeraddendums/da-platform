import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { harvestTrimsFromVins } from "@/lib/nhtsa-trim-harvester";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/cron/harvest-vin-trims
 * Daily cron that picks up vehicles added in the last ~25 hours and harvests
 * trim names from their VINs into nhtsa_trims via NHTSA's batch decoder.
 * x-cron-secret header auth, same as every other /api/cron/* route.
 *
 * Suggested EasyCron schedule: 0 3 * * *  (daily at 03:00 UTC, after the
 * nightly True ETL has finished pulling new dealer inventory).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sinceHours = Math.max(1, parseInt(req.nextUrl.searchParams.get("hours") ?? "25", 10));
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();

  const admin = createAdminSupabaseClient();

  const { data, error } = await admin
    .from("dealer_vehicles")
    .select("vin")
    .not("vin", "is", null)
    .neq("vin", "")
    .gte("date_added", since)
    .range(0, 99999);
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  const vins = ((data ?? []) as { vin: string | null }[])
    .map(r => r.vin ?? "")
    .filter(v => v.trim().length >= 11);

  // Fire-and-forget the harvest so the cron caller doesn't have to hold a
  // long connection while NHTSA is decoding. The response returns the input
  // size; the result counts land in console logs and the trims table.
  void (async () => {
    try {
      // Pass through the raw admin client; harvestTrimsFromVins works against
      // any SupabaseClient.
      const stats = await harvestTrimsFromVins(admin as never, vins);
      console.log(`[cron/harvest-vin-trims] done since=${since} stats=${JSON.stringify(stats)}`);
    } catch (err) {
      console.error("[cron/harvest-vin-trims] error:", err instanceof Error ? err.message : err);
    }
  })();

  return NextResponse.json({
    success: true,
    message: "Trim harvest started in background",
    since,
    vins_queued: vins.length,
  });
}
