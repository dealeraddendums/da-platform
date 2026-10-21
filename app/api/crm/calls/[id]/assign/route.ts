import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { normalizePhone } from "@/lib/crm/phone";
import { ROLE_TAGS, emitContact } from "@/lib/crm/companies";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/calls/[id]/assign — file a call (usually from the Unmatched
 * bucket) under a company, optionally a contact.
 * Body: { company_id, contact_id?, save_phone? } or { company_id, new_contact:
 * { first_name, last_name?, title?, role_tag? } } — a new contact gets the
 * caller's number so the next call from it matches automatically.
 * `save_phone` stores the number on an existing contact that has none.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const body = await req.json().catch(() => ({}));
  const companyId = typeof body?.company_id === "string" ? body.company_id : null;
  if (!companyId) return NextResponse.json({ error: "company_id required" }, { status: 400 });

  const admin = createAdminSupabaseClient() as any;
  const { data: call } = await admin.from("crm_calls").select("id, activity_id, direction, from_number, to_number").eq("id", params.id).maybeSingle();
  if (!call) return NextResponse.json({ error: "Call not found" }, { status: 404 });
  const { data: company } = await admin.from("crm_companies").select("id").eq("id", companyId).maybeSingle();
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const otherParty = normalizePhone(call.direction === "inbound" ? call.from_number : call.to_number);
  let contactId: string | null = typeof body?.contact_id === "string" ? body.contact_id : null;
  let contactEvent: "contact.created" | "contact.updated" | null = null;

  if (contactId) {
    const { data: c } = await admin.from("crm_contacts").select("id, company_id, phone").eq("id", contactId).is("deleted_at", null).maybeSingle();
    if (!c || c.company_id !== companyId) return NextResponse.json({ error: "Contact not at that company" }, { status: 400 });
    if (body?.save_phone && !c.phone && otherParty) {
      await admin.from("crm_contacts").update({ phone: otherParty }).eq("id", c.id);
      contactEvent = "contact.updated";
    }
  } else if (body?.new_contact && typeof body.new_contact === "object") {
    const n = body.new_contact;
    const first = String(n.first_name ?? "").trim();
    if (!first) return NextResponse.json({ error: "new_contact.first_name required" }, { status: 400 });
    const { data: created, error: insErr } = await admin.from("crm_contacts").insert({
      company_id: companyId,
      first_name: first,
      last_name: String(n.last_name ?? "").trim() || null,
      title: String(n.title ?? "").trim() || null,
      role_tag: (ROLE_TAGS as readonly string[]).includes(n.role_tag) ? n.role_tag : null,
      phone: otherParty,
      source: "dialpad",
    }).select("id").single();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });
    contactId = created.id;
    contactEvent = "contact.created";
  }

  const { error: callErr } = await admin.from("crm_calls").update({ company_id: companyId, contact_id: contactId }).eq("id", call.id);
  if (callErr) return NextResponse.json({ error: callErr.message }, { status: 500 });
  const { data: act } = await admin.from("crm_activities").select("metadata").eq("id", call.activity_id).maybeSingle();
  await admin.from("crm_activities").update({
    company_id: companyId,
    contact_id: contactId,
    metadata: { ...(act?.metadata ?? {}), assigned_by: claims.sub, assigned_at: new Date().toISOString() },
  }).eq("id", call.activity_id);
  if (contactId && contactEvent) await emitContact(admin, contactEvent, contactId);

  return NextResponse.json({ ok: true, company_id: companyId, contact_id: contactId });
}
