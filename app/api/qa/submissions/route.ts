import { NextRequest, NextResponse } from "next/server";
import { getServerProfile } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await getServerProfile();
  if (!ctx?.profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx.profile.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const area = searchParams.get("area");
  const result = searchParams.get("result");
  const resolvedParam = searchParams.get("resolved");
  const testerId = searchParams.get("tester_id");

  const admin = createAdminSupabaseClient();
  let query = (admin as any)
    .from("qa_submissions")
    .select("id, test_item_id, tester_id, tester_name, tested_as_role, result, notes, tips, area, resolved, developer_notes, created_at")
    .order("created_at", { ascending: false });

  if (area) query = query.eq("area", area);
  if (result && ["pass", "fail", "suggestion"].includes(result)) query = query.eq("result", result);
  if (resolvedParam === "true" || resolvedParam === "false") query = query.eq("resolved", resolvedParam === "true");
  if (testerId) query = query.eq("tester_id", testerId);

  type Submission = {
    id: string;
    test_item_id: string;
    tester_id: string | null;
    tester_name: string | null;
    tested_as_role: string | null;
    result: "pass" | "fail" | "suggestion";
    notes: string | null;
    tips: string | null;
    area: string | null;
    resolved: boolean;
    developer_notes: string | null;
    created_at: string;
  };
  type ItemRow = { id: string; title: string; area: string };

  const queryResp = await query;
  if (queryResp.error) {
    console.error("[qa/submissions] query failed:", queryResp.error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
  const submissions: Submission[] = queryResp.data ?? [];

  // Hydrate with test item titles for the dashboard.
  const itemIds = Array.from(new Set(submissions.map((s: Submission) => s.test_item_id)));
  const itemsResp = itemIds.length
    ? await (admin as any).from("qa_test_items").select("id, title, area").in("id", itemIds)
    : { data: [] as ItemRow[] };
  const items: ItemRow[] = itemsResp.data ?? [];
  const titleById = new Map(items.map((i: ItemRow) => [i.id, i.title]));

  const enriched = submissions.map((s: Submission) => ({
    ...s,
    test_title: titleById.get(s.test_item_id) ?? s.test_item_id,
  }));

  // Group by area for the dashboard view.
  const grouped: Record<string, typeof enriched> = {};
  for (const sub of enriched) {
    const key = sub.area || "Other";
    (grouped[key] ||= []).push(sub);
  }

  return NextResponse.json({ submissions: enriched, grouped });
}
