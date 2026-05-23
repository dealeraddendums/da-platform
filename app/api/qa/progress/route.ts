import { NextRequest, NextResponse } from "next/server";
import { getServerProfile } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const ctx = await getServerProfile();
  if (!ctx?.profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = ctx.profile.role;
  const admin = createAdminSupabaseClient();

  type Item = {
    id: string;
    area: string;
    title: string;
    role_required: string;
    description: string | null;
    steps: string[];
    tips: string | null;
    faq_visible: boolean;
    sort_order: number;
  };
  type SubRow = { test_item_id: string; result: string; notes: string | null; tips: string | null; created_at: string };

  // Role-filtered test items: 'any' matches everyone, else exact role match.
  const itemsResp = await (admin as any)
    .from("qa_test_items")
    .select("id, area, title, role_required, description, steps, tips, faq_visible, sort_order")
    .or(`role_required.eq.any,role_required.eq.${role}`)
    .order("sort_order", { ascending: true });

  if (itemsResp.error) {
    console.error("[qa/progress] items query failed:", itemsResp.error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
  const items: Item[] = itemsResp.data ?? [];

  // Latest submission per item for THIS user.
  const subsResp = await (admin as any)
    .from("qa_submissions")
    .select("test_item_id, result, notes, tips, created_at")
    .eq("tester_id", ctx.profile.id)
    .order("created_at", { ascending: false });
  const subs: SubRow[] = subsResp.data ?? [];

  const latestByItem = new Map<string, { result: string; notes: string | null; tips: string | null; created_at: string }>();
  for (const s of subs) {
    if (!latestByItem.has(s.test_item_id)) {
      latestByItem.set(s.test_item_id, {
        result: s.result,
        notes: s.notes,
        tips: s.tips,
        created_at: s.created_at,
      });
    }
  }

  const enriched = items.map((item: Item) => ({
    ...item,
    last_submission: latestByItem.get(item.id) ?? null,
  }));

  return NextResponse.json({
    items: enriched,
    total: enriched.length,
    completed: enriched.filter(i => i.last_submission).length,
    role,
  });
}
