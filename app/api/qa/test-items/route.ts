import { NextRequest, NextResponse } from "next/server";
import { getServerProfile } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * GET /api/qa/test-items
 *
 * Returns the full qa_test_items catalogue. super_admin only -- the QA
 * dashboard at /qa uses this for the Total Test Items count and the
 * Tips for Help Center section, both of which need every row regardless
 * of role_required. The /api/qa/progress endpoint is intentionally
 * role-filtered (tester-facing) and would underreport here.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const ctx = await getServerProfile();
  if (!ctx?.profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx.profile.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  type Item = {
    id: string;
    area: string;
    title: string;
    role_required: string;
    faq_visible: boolean;
    sort_order: number;
  };

  const resp = await (admin as any)
    .from("qa_test_items")
    .select("id, area, title, role_required, faq_visible, sort_order")
    .order("sort_order", { ascending: true });

  if (resp.error) {
    console.error("[qa/test-items GET] query failed:", resp.error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  const items: Item[] = resp.data ?? [];
  return NextResponse.json({ items, total: items.length });
}
