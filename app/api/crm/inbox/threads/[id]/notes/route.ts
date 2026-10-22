import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/inbox/threads/[id]/notes { body } — internal note on a thread.
 * Stored as a timeline note (metadata.thread_id) on the thread's company —
 * never emailed. Works on Unassigned threads too (company null until linked).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const text = typeof b?.body === "string" ? b.body.trim() : "";
  if (!text) return NextResponse.json({ error: "Note text required" }, { status: 400 });
  if (text.length > 20_000) return NextResponse.json({ error: "Note too long" }, { status: 400 });
  const admin = createAdminSupabaseClient() as any;
  const { data: t } = await admin.from("crm_email_threads").select("id, company_id, contact_id, subject").eq("id", params.id).maybeSingle();
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { data, error: insErr } = await admin.from("crm_activities").insert({
    company_id: t.company_id, contact_id: t.contact_id, type: "note", direction: "internal",
    subject: `Note on email: ${t.subject ?? "(no subject)"}`.slice(0, 200), body: text,
    metadata: { thread_id: t.id }, actor_staff_id: claims.sub,
  }).select("id").single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}
