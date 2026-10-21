import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { contactFields, linkPlatformUser } from "@/lib/crm/contact-input";
import { emitContact } from "@/lib/crm/companies";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/contacts — add a contact to a company.
 * { company_id, first_name, last_name?, email?, phone?, title?, role_tag? }
 * Phone is stored E.164 (rejected if it can't be normalized). Emits contact.created.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const companyId = typeof b?.company_id === "string" ? b.company_id : null;
  if (!companyId) return NextResponse.json({ error: "company_id required" }, { status: 400 });
  const parsed = contactFields(b, { requireFirstName: true });
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const admin = createAdminSupabaseClient() as any;
  const { data: company } = await admin.from("crm_companies").select("id").eq("id", companyId).maybeSingle();
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  const userId = parsed.fields.email ? await linkPlatformUser(admin, companyId, parsed.fields.email as string) : null;

  const { data, error: insErr } = await admin.from("crm_contacts")
    .insert({ company_id: companyId, user_id: userId, ...parsed.fields, source: "manual" })
    .select("id").single();
  if (insErr) {
    const dup = insErr.code === "23505";
    return NextResponse.json({ error: dup ? "A contact with that email already exists at this company" : insErr.message }, { status: dup ? 409 : 500 });
  }
  await emitContact(admin, "contact.created", data.id);
  return NextResponse.json({ ok: true, id: data.id });
}
