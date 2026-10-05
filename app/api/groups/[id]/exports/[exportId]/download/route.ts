import { NextRequest, NextResponse } from "next/server";
import { groupExportContext, loadOwnedGroupExport } from "@/lib/dealer-exports";
import { exportDownload } from "@/lib/export-download";

// "Download CSV" for a group export: ?dealer={dealer_uuid} → that dealership's
// file; ?dealer=all (or none) → a ZIP with one file per covered dealership
// (current membership) plus the combined file a push sends. Same access as
// Push now; never pushes, never records a push, never changes the schedule.
export const maxDuration = 300;

export async function GET(req: NextRequest, { params }: { params: { id: string; exportId: string } }): Promise<NextResponse> {
  const r = await groupExportContext(params.id);
  if ("response" in r) return r.response;
  const feed = await loadOwnedGroupExport(r.ctx, params.exportId);
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return exportDownload(feed, req.nextUrl.searchParams.get("dealer"));
}
