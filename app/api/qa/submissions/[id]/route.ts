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
    resolved?: boolean;
    developer_notes?: string;
  };

  const patch: Record<string, unknown> = {};
  if (typeof body.resolved === "boolean") patch.resolved = body.resolved;
  if (typeof body.developer_notes === "string") patch.developer_notes = body.developer_notes;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No updatable fields supplied" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { error } = await (admin as any).from("qa_submissions").update(patch).eq("id", params.id);
  if (error) {
    console.error("[qa/submissions/PATCH] update failed:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
