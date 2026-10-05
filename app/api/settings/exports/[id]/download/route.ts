import { NextRequest, NextResponse } from "next/server";
import { exportContext, loadOwnedExport } from "@/lib/dealer-exports";
import { exportDownload } from "@/lib/export-download";

// "Download CSV" for a dealer-owned export — the file a push would send, from
// the SAVED config, as a download. Same access as Push now; never pushes,
// never records a push, never changes the schedule.
export const maxDuration = 300;

export async function GET(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const r = await exportContext(req);
  if ("response" in r) return r.response;
  const feed = await loadOwnedExport(r.ctx, params.id);
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return exportDownload(feed, null);
}
