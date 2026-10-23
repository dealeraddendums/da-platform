import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { contactFields, linkPlatformUser } from "@/lib/crm/contact-input";
import { emitContact } from "@/lib/crm/companies";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * PATCH /api/crm/contacts/[id] — edit any of first_name, last_name, email,
 * phone, title, role_tag; { deleted: true } soft-deletes. Emits contact.updated.
 * A platform user's contact (user_id set) follows the user (migration 188): its email changes and its
 * removal happen on the platform, so both are refused here.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const admin = createAdminSupabaseClient() as any;
  const { data: c } = await admin.from("crm_contacts").select("id, company_id, user_id, email").eq("id", params.id).is("deleted_at", null).maybeSingle();
  if (!c) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  if (c.user_id && b?.deleted === true) {
    return NextResponse.json({ error: "This contact is a platform user — disable or remove the user in DA Users instead" }, { status: 409 });
  }

  const patch: Record<string, unknown> = {};
  if (b?.deleted === true) patch.deleted_at = new Date().toISOString();
  else {
    const parsed = contactFields(b, { requireFirstName: false });
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    if (c.user_id && "email" in parsed.fields && (parsed.fields.email ?? null) !== (c.email ?? null)) {
      return NextResponse.json({ error: "This contact is a platform user — change the email in DA Users" }, { status: 409 });
    }
    Object.assign(patch, parsed.fields);
    if (typeof parsed.fields.email === "string" && !c.user_id) patch.user_id = await linkPlatformUser(admin, c.company_id, parsed.fields.email);
  }
  if (!Object.keys(patch).length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const { error: upErr } = await admin.from("crm_contacts").update(patch).eq("id", c.id);
  if (upErr) {
    const dup = upErr.code === "23505";
    return NextResponse.json({ error: dup ? "A contact with that email already exists at this company" : upErr.message }, { status: dup ? 409 : 500 });
  }
  await emitContact(admin, "contact.updated", c.id);
  return NextResponse.json({ ok: true });
}
