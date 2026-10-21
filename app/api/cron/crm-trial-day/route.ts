import { NextRequest, NextResponse } from "next/server";
import { runTrialDayJob } from "@/lib/crm/trial";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300;

/**
 * POST /api/cron/crm-trial-day (X-Cron-Secret) — DA-CRM daily trial job,
 * EasyCron 06:00 America/Los_Angeles. Recomputes trial_day / trial_ends_on /
 * trial_flag on every company in the Trial stage and writes a status_change
 * activity at day 7, 14, 21 and expiry (lib/crm/trial.ts). Idempotent.
 * Fire-and-forget; ?sync=1 runs inline and returns counts.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const run = runTrialDayJob();
  if (req.nextUrl.searchParams.get("sync") === "1") return NextResponse.json(await run);
  run.then(
    (r) => console.log("[crm-trial-day]", JSON.stringify(r)),
    (e) => console.error("[crm-trial-day] failed:", e instanceof Error ? e.message : e),
  );
  return NextResponse.json({ status: "started" });
}
