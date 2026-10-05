import { NextRequest, NextResponse } from "next/server";
import { exportContext, exportCoverage, loadOwnedExport } from "@/lib/dealer-exports";
import { runFeedPush } from "@/lib/feed-push-runner";

// "Push now" for a dealer-owned export — the same generate + push + record
// runner the SuperAdmin Push button and the hourly/daily cron use.
export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const r = await exportContext(req);
  if ("response" in r) return r.response;
  const { ctx } = r;
  const feed = await loadOwnedExport(ctx, params.id);
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const covering = await exportCoverage(ctx.admin, ctx.dealer.id);
  if (covering.length > 0 && !ctx.isSuperAdmin) {
    return NextResponse.json({ error: `This dealership's export is managed by ${covering[0].managed_by}; dealer exports are paused.` }, { status: 409 });
  }
  const result = await runFeedPush(ctx.admin, feed, ctx.userId, { trigger: "manual" });
  return NextResponse.json(result, { status: result.success ? 200 : 502 });
}
