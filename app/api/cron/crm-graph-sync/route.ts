import { NextRequest, NextResponse } from "next/server";
import { graphConfigured } from "@/lib/crm/graph";
import { syncAllMailboxes } from "@/lib/crm/inbox-sync";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 600;

/**
 * POST /api/cron/crm-graph-sync (X-Cron-Secret) — every 10 minutes. DA-CRM
 * Inbox fallback: Graph delta per active mailbox (Inbox + Sent Items) from the
 * saved deltaLink, so mail a change notification missed still arrives.
 * 200 at once, work continues in the background; ?sync=1 runs inline and
 * returns the counts.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!graphConfigured()) return NextResponse.json({ error: "Microsoft Graph not configured" }, { status: 503 });
  const run = syncAllMailboxes();
  if (req.nextUrl.searchParams.get("sync") === "1") return NextResponse.json({ results: await run });
  run.then(
    (r) => console.log("[crm-graph-sync]", JSON.stringify(r.map(({ mailbox, folder, seen, stored, failed, error }) => ({ mailbox, folder, seen, stored, failed, error })))),
    (e) => console.error("[crm-graph-sync] failed:", e instanceof Error ? e.message : e),
  );
  return NextResponse.json({ status: "started" });
}
