import { NextRequest, NextResponse } from "next/server";
import { runFeedHealthDigest, scanFleet, staleWorstFirst } from "@/lib/feed-health-scan";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 600;

/**
 * POST /api/cron/feed-health (X-Cron-Secret) — daily stale-feed digest
 * (lib/feed-health-scan.ts). Fire-and-forget: 200 at once, the scan runs in
 * the background and emails support@ + allan@ only when a store becomes stale
 * or recovers. Also kicked daily from /api/cron/harvest-vin-trims; overlapping
 * or repeated runs are harmless (run lock + alert state).
 *
 * ?report=1 — synchronous, READ-ONLY: returns the full scan as JSON, no email,
 * no state write. Used for the fleet report (docs/stale-feed-scan-*.md).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (req.nextUrl.searchParams.get("report") === "1") {
    const { rows, errors } = await scanFleet();
    return NextResponse.json({ generatedAt: new Date().toISOString(), stale: staleWorstFirst(rows).map((r) => r.dealerId), rows, errors });
  }
  runFeedHealthDigest().then(
    (r) => console.log("[feed-health] digest:", JSON.stringify(r)),
    (e) => console.error("[feed-health] digest failed:", e instanceof Error ? e.message : e),
  );
  return NextResponse.json({ status: "started" });
}
