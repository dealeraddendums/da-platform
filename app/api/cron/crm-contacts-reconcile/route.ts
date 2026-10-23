import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { reconcileContacts } from "@/lib/crm/contacts-sync";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 600;

/**
 * POST /api/cron/crm-contacts-reconcile (X-Cron-Secret) — nightly, 01:45 PT. Re-applies the platform
 * users → crm_contacts rules (migration 188) and re-runs contact matching; anything it had to change is
 * drift the live triggers missed and is logged as such. ?dry=1 reports without writing. 200 at once, work
 * continues in the background; ?sync=1 runs inline and returns the report.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const run = reconcileContacts(createAdminSupabaseClient(), { apply: req.nextUrl.searchParams.get("dry") !== "1" });
  if (req.nextUrl.searchParams.get("sync") === "1") return NextResponse.json(await run);
  run.then(
    (r) => console[r.drift.total ? "warn" : "log"]("[crm-contacts-reconcile]", JSON.stringify(r)),
    (e) => console.error("[crm-contacts-reconcile] failed:", e instanceof Error ? e.message : e),
  );
  return NextResponse.json({ status: "started" });
}
