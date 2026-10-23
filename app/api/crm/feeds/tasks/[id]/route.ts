import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { UUID } from "@/lib/crm/feeds/http";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** PATCH /api/crm/feeds/tasks/[id] { status: done | open | cancelled } — feed-order tasks (full task UI arrives in phase 5). */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  if (!UUID.test(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const b = await req.json().catch(() => ({}));
  if (!["done", "open", "cancelled"].includes(b?.status)) return NextResponse.json({ error: "Bad status" }, { status: 400 });
  const { error: upErr } = await (createAdminSupabaseClient() as any).from("crm_tasks")
    .update({ status: b.status, completed_at: b.status === "open" ? null : new Date().toISOString() }).eq("id", params.id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
