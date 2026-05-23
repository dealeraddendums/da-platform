import { NextRequest, NextResponse } from "next/server";
import { getServerProfile } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await getServerProfile();
  if (!ctx?.profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    test_item_id?: string;
    result?: string;
    notes?: string;
    tips?: string;
  };
  const { test_item_id, result, notes, tips } = body;

  if (!test_item_id || !result || !["pass", "fail", "suggestion"].includes(result)) {
    return NextResponse.json({ error: "test_item_id and result (pass|fail|suggestion) are required" }, { status: 400 });
  }
  if (result === "fail" && !notes?.trim()) {
    return NextResponse.json({ error: "Notes are required when reporting a failure" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  const { data: item } = await (admin as any)
    .from("qa_test_items")
    .select("id, area")
    .eq("id", test_item_id)
    .maybeSingle();
  if (!item) return NextResponse.json({ error: "Unknown test_item_id" }, { status: 404 });

  const { data, error } = await (admin as any)
    .from("qa_submissions")
    .insert({
      test_item_id,
      tester_id: ctx.profile.id,
      tester_name: ctx.profile.full_name ?? ctx.profile.email,
      result,
      notes: notes?.trim() || null,
      tips: tips?.trim() || null,
      area: item.area,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[qa/submit] insert failed:", error);
    return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true, submission_id: data.id });
}
