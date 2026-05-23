import { NextRequest, NextResponse } from "next/server";
import { getServerProfile } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const ctx = await getServerProfile();
  if (!ctx?.profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminSupabaseClient();

  type Item = { id: string; area: string; title: string; description: string | null; steps: string[]; tips: string | null; sort_order: number };
  type TipRow = { test_item_id: string; tips: string | null };

  const itemsResp = await (admin as any)
    .from("qa_test_items")
    .select("id, area, title, description, steps, tips, sort_order")
    .eq("faq_visible", true)
    .order("sort_order", { ascending: true });

  if (itemsResp.error) {
    console.error("[qa/help-center] query failed:", itemsResp.error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
  const items: Item[] = itemsResp.data ?? [];

  // Aggregate tester-submitted tips per item, dedup case-insensitively.
  const itemIds = items.map((i: Item) => i.id);
  const tipsResp = itemIds.length
    ? await (admin as any)
        .from("qa_submissions")
        .select("test_item_id, tips")
        .in("test_item_id", itemIds)
        .not("tips", "is", null)
    : { data: [] as TipRow[] };
  const subTips: TipRow[] = tipsResp.data ?? [];

  const tipsByItem = new Map<string, string[]>();
  for (const s of subTips) {
    if (!s.tips) continue;
    const arr = tipsByItem.get(s.test_item_id) ?? [];
    arr.push(s.tips.trim());
    tipsByItem.set(s.test_item_id, arr);
  }
  // Dedup per item.
  const dedupTipsByItem = new Map<string, string[]>();
  tipsByItem.forEach((arr, itemId) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of arr) {
      const key = t.toLowerCase();
      if (!seen.has(key) && t.length > 0) {
        seen.add(key);
        out.push(t);
      }
    }
    dedupTipsByItem.set(itemId, out);
  });

  const enriched = items.map((item: Item) => ({
    ...item,
    aggregated_tips: dedupTipsByItem.get(item.id) ?? [],
  }));

  // Group by area for the help page render.
  const grouped: Record<string, typeof enriched> = {};
  for (const item of enriched) {
    (grouped[item.area] ||= []).push(item);
  }

  return NextResponse.json({ items: enriched, grouped });
}
