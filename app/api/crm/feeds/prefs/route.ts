import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** PATCH /api/crm/feeds/prefs { send_without_review } — the signed-in staff member's own preference. */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  if (typeof b?.send_without_review !== "boolean") return NextResponse.json({ error: "send_without_review required" }, { status: 400 });
  const { error: upErr } = await (createAdminSupabaseClient() as any).from("crm_staff_profiles")
    .upsert({ staff_id: claims.sub, feed_send_without_review: b.send_without_review }, { onConflict: "staff_id" });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
