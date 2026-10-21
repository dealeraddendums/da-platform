import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/activities { company_id?, contact_id?, body, subject? } — a
 * staff note on the timeline (type 'note', direction 'internal'). A contact
 * implies its company.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const text = typeof b?.body === "string" ? b.body.trim() : "";
  if (!text) return NextResponse.json({ error: "Note text required" }, { status: 400 });
  if (text.length > 20_000) return NextResponse.json({ error: "Note too long" }, { status: 400 });

  const admin = createAdminSupabaseClient() as any;
  let companyId: string | null = typeof b?.company_id === "string" ? b.company_id : null;
  const contactId: string | null = typeof b?.contact_id === "string" ? b.contact_id : null;
  if (contactId) {
    const { data: c } = await admin.from("crm_contacts").select("company_id").eq("id", contactId).maybeSingle();
    if (!c) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    if (companyId && companyId !== c.company_id) return NextResponse.json({ error: "Contact not at that company" }, { status: 400 });
    companyId = c.company_id;
  }
  if (!companyId) return NextResponse.json({ error: "company_id or contact_id required" }, { status: 400 });

  const { data, error: insErr } = await admin.from("crm_activities").insert({
    company_id: companyId,
    contact_id: contactId,
    type: "note",
    direction: "internal",
    subject: typeof b?.subject === "string" && b.subject.trim() ? b.subject.trim().slice(0, 200) : "Note",
    body: text,
    actor_staff_id: claims.sub,
  }).select("id").single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}
