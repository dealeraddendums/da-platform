import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { TABLE, workPatch, type WorkKind } from "@/lib/crm/work-items";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** PATCH /api/crm/work/{task|ticket}/[id] — edit fields or change status (closing writes a timeline entry). */
export async function PATCH(req: NextRequest, { params }: { params: { kind: string; id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const kind = params.kind as WorkKind;
  if (kind !== "task" && kind !== "ticket") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const b = await req.json().catch(() => ({}));
  const parsed = workPatch(kind, b, false);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (!Object.keys(parsed.patch).length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });

  const admin = createAdminSupabaseClient() as any;
  const { data: row } = await admin.from(TABLE[kind]).select("id, company_id, title, status").eq("id", params.id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { error: upErr } = await admin.from(TABLE[kind]).update(parsed.patch).eq("id", row.id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  if (parsed.patch.status && parsed.patch.status !== row.status && row.company_id) {
    await admin.from("crm_activities").insert({
      company_id: row.company_id, type: kind, direction: "internal", actor_staff_id: claims.sub,
      subject: `${kind === "task" ? "Task" : "Ticket"} ${parsed.patch.status === "open" ? "reopened" : String(parsed.patch.status)}: ${row.title}`,
    });
  }
  return NextResponse.json({ ok: true });
}
