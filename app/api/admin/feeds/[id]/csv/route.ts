import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { generateFeedCsv } from "@/lib/feed-export";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  try {
    const admin = createAdminSupabaseClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: feed } = await (admin as any)
      .from("feed_companies").select("filename").eq("id", params.id).maybeSingle();
    if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { csv } = await generateFeedCsv(params.id);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${String(feed.filename).replace(/[^\w.-]/g, "_")}.csv"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "CSV generation failed" }, { status: 400 });
  }
}
