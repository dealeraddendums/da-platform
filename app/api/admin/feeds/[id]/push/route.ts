import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { type FeedCompanyRow } from "@/lib/feed-export";
import { runFeedPush } from "@/lib/feed-push-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: feed } = await (admin as any)
    .from("feed_companies").select("*").eq("id", params.id).maybeSingle() as { data: FeedCompanyRow | null };
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Manual push never skips on empty — the operator clicked Push deliberately.
  const result = await runFeedPush(admin, feed, claims.sub, { trigger: "manual" });
  return NextResponse.json({ success: result.success, message: result.message });
}
