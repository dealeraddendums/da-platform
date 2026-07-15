import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { generateFeedCsv, type FeedCompanyRow } from "@/lib/feed-export";
import { pushFeedCsv } from "@/lib/feed-push";

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

  try {
    const { csv, vehicleCount, dealerCount } = await generateFeedCsv(params.id);
    const result = await pushFeedCsv(feed, csv);
    const message = result.success
      ? `${result.message} — ${vehicleCount.toLocaleString("en-US")} vehicles across ${dealerCount} dealer(s)`
      : result.message;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from("feed_companies")
      .update({ last_push_at: new Date().toISOString(), last_push_status: result.success ? "success" : message.slice(0, 500) })
      .eq("id", params.id);
    fireWrite(admin.from("admin_audit").insert({
      admin_user_id: claims.sub,
      action: "feed_push",
      metadata: { feed_id: params.id, feed_name: feed.name, success: result.success, vehicles: vehicleCount, message: message.slice(0, 300) },
    }), "admin_audit");
    return NextResponse.json({ success: result.success, message });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Feed push failed";
    return NextResponse.json({ success: false, message });
  }
}
