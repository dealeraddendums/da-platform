import { NextRequest, NextResponse } from "next/server";
import { getServerProfile } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const ctx = await getServerProfile();
  if (!ctx?.profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx.profile.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as {
    faq_visible?: boolean;
    tips?: string;
  };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.faq_visible === "boolean") patch.faq_visible = body.faq_visible;
  if (typeof body.tips === "string") patch.tips = body.tips;

  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: "No updatable fields supplied" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { error } = await (admin as any).from("qa_test_items").update(patch).eq("id", params.id);
  if (error) {
    console.error("[qa/test-items/PATCH] update failed:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
