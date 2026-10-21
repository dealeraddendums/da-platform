import { NextRequest, NextResponse } from "next/server";
import { dialpadConfigured, listDialpadCalls } from "@/lib/crm/dialpad";
import { ingestDialpadEvent } from "@/lib/crm/dialpad-ingest";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 600;

/**
 * POST /api/cron/crm-dialpad-reconcile (X-Cron-Secret) — nightly DA-CRM
 * backstop. Pulls every concluded Dialpad call from the last 24h (?hours= to
 * widen, max 168) and feeds each through the same idempotent ingest the
 * webhook uses, so calls the webhook missed appear and partial ones (no
 * recording / transcript / summary yet) fill in.
 *
 * Fire-and-forget like the other crons: 200 at once, work continues in the
 * background. ?sync=1 runs inline and returns the counts (manual runs).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!dialpadConfigured()) return NextResponse.json({ error: "DIALPAD_API_KEY not set" }, { status: 503 });

  const hours = Math.min(168, Math.max(1, Number(req.nextUrl.searchParams.get("hours")) || 24));
  const run = reconcile(hours);
  if (req.nextUrl.searchParams.get("sync") === "1") return NextResponse.json(await run);
  run.then(
    (r) => console.log("[crm-dialpad-reconcile]", JSON.stringify(r)),
    (e) => console.error("[crm-dialpad-reconcile] failed:", e instanceof Error ? e.message : e),
  );
  return NextResponse.json({ status: "started", hours });
}

async function reconcile(hours: number) {
  const before = Date.now();
  const after = before - hours * 3600_000;
  const counts = { seen: 0, created: 0, updated: 0, errors: 0 };
  for await (const call of listDialpadCalls(after, before)) {
    counts.seen++;
    try {
      const r = await ingestDialpadEvent(call, { source: "reconcile" });
      if (r.status === "ok") {
        if (r.created) counts.created++; else counts.updated++;
        await r.followUp;
      }
    } catch (e) {
      counts.errors++;
      console.error(`[crm-dialpad-reconcile] call ${String(call.call_id)}:`, e instanceof Error ? e.message : e);
    }
  }
  return { hours, ...counts };
}
