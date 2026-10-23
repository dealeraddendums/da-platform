import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { TABLE, workPatch, type WorkKind } from "@/lib/crm/work-items";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/work/{task|ticket} { company_id, title, description?, due_at? (task),
 * priority? (ticket), assigned_staff_id?, contact_id?, source_activity_id? } —
 * create, and note it on the company timeline.
 */
export async function POST(req: NextRequest, { params }: { params: { kind: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const kind = params.kind as WorkKind;
  if (kind !== "task" && kind !== "ticket") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const b = await req.json().catch(() => ({}));
  const parsed = workPatch(kind, b, true);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const admin = createAdminSupabaseClient() as any;
  const { data: co } = await admin.from("crm_companies").select("id").eq("id", b?.company_id).maybeSingle();
  if (!co) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  let sourceId: string | null = typeof b?.source_activity_id === "string" ? b.source_activity_id : null;
  if (!sourceId) {
    const { data: act } = await admin.from("crm_activities").insert({
      company_id: co.id, contact_id: b?.contact_id ?? null, type: kind, direction: "internal",
      subject: `${kind === "task" ? "Task" : "Ticket"} created: ${parsed.patch.title}`, body: parsed.patch.description ?? null,
      actor_staff_id: claims.sub,
    }).select("id").single();
    sourceId = act?.id ?? null;
  }
  const { data, error: insErr } = await admin.from(TABLE[kind]).insert({
    ...parsed.patch, company_id: co.id, contact_id: b?.contact_id ?? null, source_activity_id: sourceId, created_by: claims.sub,
  }).select("id").single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}
