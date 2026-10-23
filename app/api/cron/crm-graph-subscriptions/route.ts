import { NextRequest, NextResponse } from "next/server";
import { graphConfigured } from "@/lib/crm/graph";
import { ensureSubscriptions } from "@/lib/crm/inbox-sync";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * POST /api/cron/crm-graph-subscriptions (X-Cron-Secret) — every 48 hours (any
 * shorter cadence is fine). Renews each mailbox's Inbox / Sent Items
 * change-notification subscription that expires within 30 h, and recreates
 * any Graph has dropped. Runs inline (a handful of Graph calls).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!graphConfigured()) return NextResponse.json({ error: "Microsoft Graph not configured" }, { status: 503 });
  const results = await ensureSubscriptions();
  const failed = results.filter((r) => r.action === "error");
  if (failed.length) console.error("[crm-graph-subscriptions]", JSON.stringify(failed));
  return NextResponse.json({ results }, { status: failed.length ? 207 : 200 });
}
