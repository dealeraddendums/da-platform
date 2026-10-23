import { NextRequest, NextResponse } from "next/server";
import { runStallJob } from "@/lib/crm/feeds/stall";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 600;

/**
 * POST /api/cron/crm-feed-stalls (X-Cron-Secret) — daily, 07:00 PT. DA-CRM
 * feed-order stalls: follow-ups, call tasks, needs-info escalation, and
 * assigned → done on the first import (lib/crm/feeds/stall.ts). Skips weekends
 * and US holidays (?force=1 runs anyway). 200 at once, work continues in the
 * background; ?sync=1 runs inline and returns the counts.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const run = runStallJob(undefined, new Date(), { force: req.nextUrl.searchParams.get("force") === "1" });
  if (req.nextUrl.searchParams.get("sync") === "1") return NextResponse.json(await run);
  run.then(
    (r) => console.log("[crm-feed-stalls]", JSON.stringify(r)),
    (e) => console.error("[crm-feed-stalls] failed:", e instanceof Error ? e.message : e),
  );
  return NextResponse.json({ status: "started" });
}
