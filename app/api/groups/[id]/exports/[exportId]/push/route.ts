import { NextResponse } from "next/server";
import { groupExportContext, loadOwnedGroupExport } from "@/lib/dealer-exports";
import { runFeedPush } from "@/lib/feed-push-runner";

// "Push now" for a group export — the shared generate + push + record runner.
export const maxDuration = 300;

export async function POST(_req: Request, { params }: { params: { id: string; exportId: string } }): Promise<NextResponse> {
  const r = await groupExportContext(params.id);
  if ("response" in r) return r.response;
  const feed = await loadOwnedGroupExport(r.ctx, params.exportId);
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const result = await runFeedPush(r.ctx.admin, feed, r.ctx.userId, { trigger: "manual" });
  return NextResponse.json(result, { status: result.success ? 200 : 502 });
}
